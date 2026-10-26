import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as backup from "aws-cdk-lib/aws-backup";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as events from "aws-cdk-lib/aws-events";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { APPROVED_MODEL_IDS } from "@aba/config/models";
import type { EnvConfig } from "./config";

/**
 * Network, encryption keys, database, file storage, queue, auth and backups.
 * Everything holding PHI is encrypted with a customer-managed KMS key and sits
 * in private subnets; AWS services are reached through VPC endpoints.
 */
export class Foundation extends Construct {
  readonly vpc: ec2.Vpc;
  readonly key: kms.Key;
  readonly db: rds.DatabaseInstance;
  readonly dbSecurityGroup: ec2.SecurityGroup;
  readonly appDbSecret: secrets.Secret;
  readonly sessionSecret: secrets.Secret;
  readonly filesBucket: s3.Bucket;
  readonly logsBucket: s3.Bucket;
  readonly queue: sqs.Queue;
  readonly dlq: sqs.Queue;
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  readonly endpointSecurityGroup: ec2.SecurityGroup;
  /** ECS task role, defined here so grants on keys/buckets/secrets stay inside this stack. */
  readonly taskRole: iam.Role;

  constructor(scope: Construct, id: string, cfg: EnvConfig) {
    super(scope, id);
    const removal = cfg.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    this.key = new kms.Key(this, "PhiKey", {
      alias: `alias/aba-${cfg.name}-phi`,
      description: "ABA plan assistant: PHI encryption (RDS, S3, SQS, logs, backups)",
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.key.grantEncryptDecrypt(new iam.ServicePrincipal(`logs.${cfg.region}.amazonaws.com`));

    // ---------------- network ----------------
    this.vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: cfg.natGateways,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "app", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        { name: "data", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      flowLogs: { all: { trafficType: ec2.FlowLogTrafficType.REJECT } },
    });
    this.vpc.addGatewayEndpoint("S3Endpoint", { service: ec2.GatewayVpcEndpointAwsService.S3 });
    this.endpointSecurityGroup = new ec2.SecurityGroup(this, "EndpointSg", { vpc: this.vpc, description: "Interface VPC endpoints", allowAllOutbound: false });
    this.endpointSecurityGroup.addIngressRule(ec2.Peer.ipv4(this.vpc.vpcCidrBlock), ec2.Port.tcp(443), "HTTPS from VPC");
    const interfaceEndpoints: Record<string, ec2.InterfaceVpcEndpointAwsService> = {
      Bedrock: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
      Textract: ec2.InterfaceVpcEndpointAwsService.TEXTRACT,
      TranscribeStreaming: ec2.InterfaceVpcEndpointAwsService.TRANSCRIBE_STREAMING,
      SecretsManager: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      Sqs: ec2.InterfaceVpcEndpointAwsService.SQS,
      Kms: ec2.InterfaceVpcEndpointAwsService.KMS,
      Logs: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      EcrApi: ec2.InterfaceVpcEndpointAwsService.ECR,
      EcrDocker: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      Sts: ec2.InterfaceVpcEndpointAwsService.STS,
    };
    for (const [name, service] of Object.entries(interfaceEndpoints)) {
      this.vpc.addInterfaceEndpoint(`${name}Endpoint`, { service, privateDnsEnabled: true, securityGroups: [this.endpointSecurityGroup], subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS } });
    }
    // Cognito user pool API (no PHI) is the only service reached over NAT where no endpoint is available.

    // ---------------- logs bucket ----------------
    this.logsBucket = new s3.Bucket(this, "AccessLogs", {
      encryption: s3.BucketEncryption.S3_MANAGED, // ALB access logs require SSE-S3
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      lifecycleRules: [{ expiration: Duration.days(400) }],
      removalPolicy: removal,
      autoDeleteObjects: !cfg.retainData,
    });

    // ---------------- files bucket ----------------
    this.filesBucket = new s3.Bucket(this, "Files", {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.key,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      serverAccessLogsBucket: this.logsBucket,
      serverAccessLogsPrefix: "s3-files/",
      cors: [{ allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET], allowedOrigins: [`https://${cfg.domainName}`], allowedHeaders: ["Content-Type", "x-amz-server-side-encryption"], maxAge: 300 }],
      lifecycleRules: [
        { abortIncompleteMultipartUploadAfter: Duration.days(1) },
        { noncurrentVersionExpiration: Duration.days(30) },
        // Exports are regenerated on demand; source files follow the tenant retention job.
        { prefix: "tenants/", tagFilters: { kind: "export" }, expiration: Duration.days(30) },
      ],
      removalPolicy: removal,
      autoDeleteObjects: !cfg.retainData,
    });

    // ---------------- queue ----------------
    this.dlq = new sqs.Queue(this, "JobsDlq", { encryption: sqs.QueueEncryption.KMS, encryptionMasterKey: this.key, retentionPeriod: Duration.days(14), enforceSSL: true });
    this.queue = new sqs.Queue(this, "Jobs", {
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: this.key,
      visibilityTimeout: Duration.minutes(15),
      deadLetterQueue: { queue: this.dlq, maxReceiveCount: 3 },
      enforceSSL: true,
    });

    // ---------------- database ----------------
    this.dbSecurityGroup = new ec2.SecurityGroup(this, "DbSg", { vpc: this.vpc, description: "Postgres", allowAllOutbound: false });
    const params = new rds.ParameterGroup(this, "DbParams", {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      parameters: { "rds.force_ssl": "1", log_statement: "none", log_min_duration_statement: "-1" },
    });
    this.db = new rds.DatabaseInstance(this, "Db", {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      instanceType: new ec2.InstanceType(cfg.dbInstanceClass),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.dbSecurityGroup],
      databaseName: "aba",
      credentials: rds.Credentials.fromGeneratedSecret("aba_owner", { encryptionKey: this.key }),
      storageEncrypted: true,
      storageEncryptionKey: this.key,
      multiAz: cfg.multiAz,
      allocatedStorage: 50,
      maxAllocatedStorage: 500,
      backupRetention: Duration.days(35),
      deleteAutomatedBackups: false,
      deletionProtection: cfg.retainData,
      removalPolicy: cfg.retainData ? RemovalPolicy.SNAPSHOT : RemovalPolicy.DESTROY,
      parameterGroup: params,
      publiclyAccessible: false,
      enablePerformanceInsights: true,
      performanceInsightEncryptionKey: this.key,
      cloudwatchLogsExports: ["upgrade"],
      autoMinorVersionUpgrade: true,
      caCertificate: rds.CaCertificate.RDS_CA_RSA2048_G1,
    });
    // Runtime role (non-owner, subject to forced RLS). Created by the bootstrap step in the web container.
    this.appDbSecret = new secrets.Secret(this, "AppDbSecret", {
      description: "Password for the aba_app runtime database role",
      encryptionKey: this.key,
      generateSecretString: { secretStringTemplate: JSON.stringify({ username: "aba_app" }), generateStringKey: "password", excludePunctuation: true, passwordLength: 40 },
    });
    this.sessionSecret = new secrets.Secret(this, "SessionSecret", {
      description: "Signing key for session cookies",
      encryptionKey: this.key,
      generateSecretString: { excludePunctuation: true, passwordLength: 64 },
    });

    // ---------------- auth ----------------
    this.userPool = new cognito.UserPool(this, "Users", {
      userPoolName: `aba-${cfg.name}`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { sms: false, otp: true },
      passwordPolicy: { minLength: 12, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: true, tempPasswordValidity: Duration.days(3) },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      deletionProtection: cfg.retainData,
      removalPolicy: removal,
      featurePlan: cognito.FeaturePlan.PLUS,
      standardThreatProtectionMode: cognito.StandardThreatProtectionMode.FULL_FUNCTION,
    });
    for (const g of ["super_admin", "company_admin", "clinical_director", "bcba", "read_only"]) new cognito.CfnUserPoolGroup(this, `Group-${g}`, { userPoolId: this.userPool.userPoolId, groupName: g });
    this.userPoolClient = this.userPool.addClient("Web", {
      authFlows: { userPassword: true, userSrp: true },
      generateSecret: false,
      preventUserExistenceErrors: true,
      idTokenValidity: Duration.minutes(60),
      accessTokenValidity: Duration.minutes(60),
      refreshTokenValidity: Duration.hours(12),
    });

    // ---------------- backups (tested restore documented in docs/RESTORE.md) ----------------
    const vault = new backup.BackupVault(this, "Vault", { encryptionKey: this.key, removalPolicy: RemovalPolicy.RETAIN });
    const plan = new backup.BackupPlan(this, "BackupPlan", { backupVault: vault });
    plan.addRule(new backup.BackupPlanRule({ ruleName: "daily", scheduleExpression: events.Schedule.cron({ hour: "6", minute: "0" }), deleteAfter: Duration.days(35) }));
    plan.addRule(new backup.BackupPlanRule({ ruleName: "monthly", scheduleExpression: events.Schedule.cron({ day: "1", hour: "7", minute: "0" }), moveToColdStorageAfter: Duration.days(30), deleteAfter: Duration.days(2555) }));
    plan.addSelection("Data", { resources: [backup.BackupResource.fromRdsDatabaseInstance(this.db), backup.BackupResource.fromArn(this.filesBucket.bucketArn)] });
      // ---------------- ECS task role (least privilege) ----------------
    const taskRole = new iam.Role(this, "TaskRole", { assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com") });
    this.taskRole = taskRole;
    this.filesBucket.grantReadWrite(taskRole);
    this.filesBucket.grantDelete(taskRole);
    this.key.grantEncryptDecrypt(taskRole);
    this.queue.grantSendMessages(taskRole);
    this.queue.grantConsumeMessages(taskRole);
    this.appDbSecret.grantRead(taskRole);
    this.sessionSecret.grantRead(taskRole);
    this.db.secret!.grantRead(taskRole); // owner credentials: used only by the bootstrap/migration step at web startup
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "BedrockApprovedModelsOnly",
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: APPROVED_MODEL_IDS.flatMap((id) => [`arn:aws:bedrock:${cfg.region}:${Stack.of(this).account}:inference-profile/${id}`, `arn:aws:bedrock:*::foundation-model/${id.replace(/^us\./, "")}`]),
      }),
    );
    taskRole.addToPolicy(new iam.PolicyStatement({ actions: ["textract:StartDocumentTextDetection", "textract:GetDocumentTextDetection", "textract:DetectDocumentText"], resources: ["*"] }));
    taskRole.addToPolicy(new iam.PolicyStatement({ actions: ["transcribe:StartMedicalStreamTranscription", "transcribe:StartMedicalStreamTranscriptionWebSocket"], resources: ["*"] }));
    taskRole.addToPolicy(new iam.PolicyStatement({ actions: ["cognito-idp:AdminCreateUser", "cognito-idp:AdminAddUserToGroup", "cognito-idp:AdminDisableUser", "cognito-idp:AdminGetUser"], resources: [this.userPool.userPoolArn] }));
  }
}
