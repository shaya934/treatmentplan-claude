import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as r53targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import type { Construct } from "constructs";
import { join } from "node:path";

export interface DropProps extends StackProps {
  domainName: string;
  hostedZoneId: string;
  alarmEmail: string;
}

/**
 * HIPAA-minded setup for the document drop site:
 * - files: S3, encrypted with a customer KMS key, TLS only, no public access, deleted after 1 day
 * - sign-in: Cognito, invite only, authenticator-app MFA required, strong passwords
 * - app: one Fargate task reachable only through an HTTPS load balancer with WAF
 * - AI: Amazon Bedrock and Textract in this account (covered by the AWS BAA); nothing leaves AWS
 * - audit: app audit events and load balancer / S3 access logs kept for 6 years
 * No database: nothing about a client is kept beyond the 24-hour file window.
 */
export class DropStack extends Stack {
  constructor(scope: Construct, id: string, p: DropProps) {
    super(scope, id, p);

    const key = new kms.Key(this, "Key", { enableKeyRotation: true, description: "We Achieve drop site: documents, logs, secrets", removalPolicy: RemovalPolicy.RETAIN });
    key.grantEncryptDecrypt(new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`));

    // ---------- storage ----------
    const logsBucket = new s3.Bucket(this, "AccessLogs", {
      encryption: s3.BucketEncryption.S3_MANAGED, // load balancer access logs cannot use KMS
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      lifecycleRules: [{ expiration: Duration.days(2192) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const bucket = new s3.Bucket(this, "Files", {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      serverAccessLogsBucket: logsBucket,
      serverAccessLogsPrefix: "files/",
      lifecycleRules: [{ expiration: Duration.days(1), abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---------- sign-in ----------
    const url = `https://${p.domainName}`;
    const pool = new cognito.UserPool(this, "Users", {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: { minLength: 14, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: true, tempPasswordValidity: Duration.days(3) },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      userInvitation: {
        emailSubject: "Your We Achieve treatment plan sign-in",
        emailBody: `You can now sign in at ${url}<br><br>Email: {username}<br>Temporary password: {####}<br><br>You will choose your own password and set up an authenticator app the first time you sign in. The temporary password expires in 3 days.`,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const client = pool.addClient("Web", {
      authFlows: { userPassword: true },
      generateSecret: false,
      preventUserExistenceErrors: true,
      idTokenValidity: Duration.hours(1),
      accessTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.hours(12),
    });
    const sessionSecret = new secrets.Secret(this, "SessionSecret", { encryptionKey: key, generateSecretString: { passwordLength: 64, excludePunctuation: true } });

    // ---------- network: public subnets only, no NAT; the task only accepts traffic from the load balancer ----------
    const vpc = new ec2.Vpc(this, "Vpc", { maxAzs: 2, natGateways: 0, subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC }] });
    vpc.addGatewayEndpoint("S3", { service: ec2.GatewayVpcEndpointAwsService.S3 });
    vpc.addFlowLog("FlowLogs", { destination: ec2.FlowLogDestination.toS3(logsBucket, "vpc/"), trafficType: ec2.FlowLogTrafficType.REJECT });

    // ---------- app ----------
    const logGroup = new logs.LogGroup(this, "AppLogs", { retention: logs.RetentionDays.SIX_YEARS, encryptionKey: key, removalPolicy: RemovalPolicy.RETAIN });
    const cluster = new ecs.Cluster(this, "Cluster", { vpc, containerInsightsV2: ecs.ContainerInsights.ENABLED });
    const task = new ecs.FargateTaskDefinition(this, "Task", { cpu: 1024, memoryLimitMiB: 3072, runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX } });
    task.addContainer("app", {
      image: ecs.ContainerImage.fromAsset(join(import.meta.dirname, "..", ".."), { file: "apps/drop/Dockerfile", platform: ecrAssets.Platform.LINUX_AMD64 }),
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "app" }),
      portMappings: [{ containerPort: 8080 }],
      readonlyRootFilesystem: false,
      environment: { NODE_ENV: "production", PORT: "8080", AWS_REGION: this.region, BUCKET: bucket.bucketName, USER_POOL_ID: pool.userPoolId, USER_POOL_CLIENT_ID: client.userPoolClientId },
      secrets: { SESSION_SECRET: ecs.Secret.fromSecretsManager(sessionSecret) },
    });
    bucket.grantReadWrite(task.taskRole);
    bucket.grantDelete(task.taskRole);
    key.grantEncryptDecrypt(task.taskRole);
    task.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: ["arn:aws:bedrock:*::foundation-model/anthropic.*", `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.anthropic.*`],
      }),
    );
    task.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ["textract:DetectDocumentText", "textract:StartDocumentTextDetection", "textract:GetDocumentTextDetection"], resources: ["*"] }));

    const appSg = new ec2.SecurityGroup(this, "AppSg", { vpc, description: "App task: from the load balancer only" });
    const service = new ecs.FargateService(this, "Service", {
      cluster,
      taskDefinition: task,
      desiredCount: 1,
      assignPublicIp: true, // outbound to AWS APIs without a NAT gateway; inbound is closed by the security group
      securityGroups: [appSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });

    // ---------- HTTPS entry point ----------
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", { hostedZoneId: p.hostedZoneId, zoneName: p.domainName });
    const cert = new acm.Certificate(this, "Cert", { domainName: p.domainName, validation: acm.CertificateValidation.fromDns(zone) });
    const albSg = new ec2.SecurityGroup(this, "AlbSg", { vpc, description: "Public HTTPS" });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS");
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "Redirect to HTTPS");
    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", { vpc, internetFacing: true, securityGroup: albSg, dropInvalidHeaderFields: true, idleTimeout: Duration.seconds(300) });
    alb.logAccessLogs(logsBucket, "alb");
    alb.addRedirect({ sourcePort: 80, targetPort: 443 });
    const https = alb.addListener("Https", { port: 443, certificates: [cert], sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS, open: false });
    https.addTargets("App", { port: 8080, protocol: elbv2.ApplicationProtocol.HTTP, targets: [service], healthCheck: { path: "/health" }, deregistrationDelay: Duration.seconds(30) });
    appSg.addIngressRule(albSg, ec2.Port.tcp(8080), "From the load balancer");
    new route53.ARecord(this, "Alias", { zone, target: route53.RecordTarget.fromAlias(new r53targets.LoadBalancerTarget(alb)) });

    // ---------- WAF ----------
    const visibility = (metricName: string) => ({ cloudWatchMetricsEnabled: true, metricName, sampledRequestsEnabled: false }); // no samples: bodies are PHI
    // Uploads are binary documents, so body-inspecting rules would block them; they only count.
    const bodyRules = ["SizeRestrictions_BODY", "GenericLFI_BODY", "GenericRFI_BODY", "CrossSiteScripting_BODY", "EC2MetaDataSSRF_BODY"];
    const acl = new wafv2.CfnWebACL(this, "Waf", {
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      visibilityConfig: visibility("drop-waf"),
      rules: [
        {
          name: "SignInRateLimit",
          priority: 0,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 50,
              evaluationWindowSec: 300,
              aggregateKeyType: "IP",
              scopeDownStatement: { byteMatchStatement: { fieldToMatch: { uriPath: {} }, positionalConstraint: "STARTS_WITH", searchString: "/api/login", textTransformations: [{ priority: 0, type: "NONE" }] } },
            },
          },
          visibilityConfig: visibility("SignInRateLimit"),
        },
        { name: "RateLimit", priority: 1, action: { block: {} }, statement: { rateBasedStatement: { limit: 3000, evaluationWindowSec: 300, aggregateKeyType: "IP" } }, visibilityConfig: visibility("RateLimit") },
        {
          name: "Common",
          priority: 2,
          overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: "AWS", name: "AWSManagedRulesCommonRuleSet", ruleActionOverrides: bodyRules.map((name) => ({ name, actionToUse: { count: {} } })) } },
          visibilityConfig: visibility("Common"),
        },
        { name: "KnownBad", priority: 3, overrideAction: { none: {} }, statement: { managedRuleGroupStatement: { vendorName: "AWS", name: "AWSManagedRulesKnownBadInputsRuleSet" } }, visibilityConfig: visibility("KnownBad") },
        { name: "IpReputation", priority: 4, overrideAction: { none: {} }, statement: { managedRuleGroupStatement: { vendorName: "AWS", name: "AWSManagedRulesAmazonIpReputationList" } }, visibilityConfig: visibility("IpReputation") },
      ],
    });
    new wafv2.CfnWebACLAssociation(this, "WafAssoc", { resourceArn: alb.loadBalancerArn, webAclArn: acl.attrArn });

    // ---------- alarms ----------
    const topic = new sns.Topic(this, "Alarms", { masterKey: key });
    topic.addSubscription(new subs.EmailSubscription(p.alarmEmail));
    key.grantEncryptDecrypt(new iam.ServicePrincipal("cloudwatch.amazonaws.com"));
    const unhealthy = new cloudwatch.Alarm(this, "Unhealthy", {
      metric: alb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { period: Duration.minutes(5) }),
      threshold: 10,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: "The drop site returned many errors",
    });
    unhealthy.addAlarmAction(new cwActions.SnsAction(topic));

    new CfnOutput(this, "Url", { value: url });
    new CfnOutput(this, "UserPoolId", { value: pool.userPoolId });
    new CfnOutput(this, "AuditLogGroup", { value: logGroup.logGroupName });
  }
}
