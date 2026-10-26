import { join } from "node:path";
import { CfnOutput, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as r53targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as cr from "aws-cdk-lib/custom-resources";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";
import type { EnvConfig } from "./config";
import type { Foundation } from "./foundation-stack";

const ABA_VOCABULARY = ["VB-MAPP", "ABLLS-R", "Vineland", "mand", "mands", "tact", "tacts", "intraverbal", "intraverbals", "echoic", "BCBA", "RBT", "BIP", "FBA", "STO", "LTG", "BST", "DTT", "FCT", "DRA", "DRO", "titration", "stereotypy", "elopement", "Trillium"];

/**
 * Web (Next.js) and worker on ECS Fargate in private subnets, behind an
 * HTTPS-only (TLS 1.2+) Application Load Balancer with AWS WAF.
 */
export class AppService extends Construct {
  constructor(scope: Construct, id: string, cfg: EnvConfig, f: Foundation) {
    super(scope, id);
    const repoRoot = join(import.meta.dirname, "..", "..");
    const exclude = ["**/node_modules", "**/.next", "**/cdk.out", ".git", ".localdata", "**/.localdata", "fixtures/out", "**/*.log", ".env*"];

    const cluster = new ecs.Cluster(this, "Cluster", { vpc: f.vpc, containerInsightsV2: ecs.ContainerInsights.ENABLED });
    const logGroup = new logs.LogGroup(this, "AppLogs", { encryptionKey: f.key, retention: logs.RetentionDays.ONE_YEAR, removalPolicy: cfg.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY });

    // ---------- Transcribe custom vocabulary for ABA terms ----------
    const vocabBucket = new s3.Bucket(this, "Vocab", { blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, enforceSSL: true, encryption: s3.BucketEncryption.S3_MANAGED, removalPolicy: RemovalPolicy.DESTROY, autoDeleteObjects: true });
    const vocabDeploy = new s3deploy.BucketDeployment(this, "VocabFile", { destinationBucket: vocabBucket, sources: [s3deploy.Source.data("aba-terms.txt", ABA_VOCABULARY.join("\n"))] });
    const vocabName = `aba-terms-${cfg.name}`;
    const vocab = new cr.AwsCustomResource(this, "MedicalVocabulary", {
      onCreate: { service: "Transcribe", action: "createMedicalVocabulary", parameters: { VocabularyName: vocabName, LanguageCode: "en-US", VocabularyFileUri: `s3://${vocabBucket.bucketName}/aba-terms.txt` }, physicalResourceId: cr.PhysicalResourceId.of(vocabName) },
      onUpdate: { service: "Transcribe", action: "updateMedicalVocabulary", parameters: { VocabularyName: vocabName, LanguageCode: "en-US", VocabularyFileUri: `s3://${vocabBucket.bucketName}/aba-terms.txt` }, physicalResourceId: cr.PhysicalResourceId.of(vocabName) },
      onDelete: { service: "Transcribe", action: "deleteMedicalVocabulary", parameters: { VocabularyName: vocabName } },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({ actions: ["transcribe:CreateMedicalVocabulary", "transcribe:UpdateMedicalVocabulary", "transcribe:DeleteMedicalVocabulary"], resources: ["*"] }),
        new iam.PolicyStatement({ actions: ["s3:GetObject"], resources: [vocabBucket.arnForObjects("*")] }),
      ]),
      installLatestAwsSdk: false,
    });
    vocab.node.addDependency(vocabDeploy);

    const taskRole = f.taskRole;

    const environment = {
      ABA_MODE: "aws",
      AWS_REGION: cfg.region,
      FILES_BUCKET: f.filesBucket.bucketName,
      JOBS_QUEUE_URL: f.queue.queueUrl,
      COGNITO_USER_POOL_ID: f.userPool.userPoolId,
      COGNITO_CLIENT_ID: f.userPoolClient.userPoolClientId,
      TRANSCRIBE_VOCABULARY: vocabName,
      APP_URL: `https://${cfg.domainName}`,
      SESSION_IDLE_MINUTES: "15",
      OWNER_EMAIL: cfg.ownerEmail,
      DB_HOST: f.db.dbInstanceEndpointAddress,
      DB_PORT: f.db.dbInstanceEndpointPort,
      DB_NAME: "aba",
      NODE_ENV: "production",
    };
    const secrets = {
      DB_APP_PASSWORD: ecs.Secret.fromSecretsManager(f.appDbSecret, "password"),
      SESSION_SECRET: ecs.Secret.fromSecretsManager(f.sessionSecret),
    };

    // ---------- web ----------
    const webSg = new ec2.SecurityGroup(this, "WebSg", { vpc: f.vpc, description: "Web tasks" });
    const workerSg = new ec2.SecurityGroup(this, "WorkerSg", { vpc: f.vpc, description: "Worker tasks" });
    for (const sg of [webSg, workerSg]) {
      f.dbSecurityGroup.addIngressRule(sg, ec2.Port.tcp(5432), "Postgres from app");
    }
    const webTask = new ecs.FargateTaskDefinition(this, "WebTask", { cpu: 1024, memoryLimitMiB: 2048, taskRole, runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX } });
    webTask.addContainer("web", {
      image: ecs.ContainerImage.fromAsset(repoRoot, { file: "Dockerfile", target: "web", exclude, platform: Platform.LINUX_AMD64 }),
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "web" }),
      environment,
      secrets: { ...secrets, DB_OWNER_PASSWORD: ecs.Secret.fromSecretsManager(f.db.secret!, "password") },
      portMappings: [{ containerPort: 3000 }],
      readonlyRootFilesystem: false,
      healthCheck: { command: ["CMD-SHELL", "wget -qO- http://localhost:3000/api/health || exit 1"], interval: Duration.seconds(30), startPeriod: Duration.seconds(90) },
    });
    const web = new ecs.FargateService(this, "WebService", {
      cluster,
      taskDefinition: webTask,
      desiredCount: cfg.webDesiredCount,
      securityGroups: [webSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
    });

    // ---------- worker ----------
    const workerTask = new ecs.FargateTaskDefinition(this, "WorkerTask", { cpu: 2048, memoryLimitMiB: 4096, taskRole, ephemeralStorageGiB: 30 });
    const workerImage = ecs.ContainerImage.fromAsset(repoRoot, { file: "Dockerfile", target: "worker", exclude, platform: Platform.LINUX_AMD64 });
    workerTask.addContainer("worker", { image: workerImage, logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "worker" }), environment, secrets });
    new ecs.FargateService(this, "WorkerService", {
      cluster,
      taskDefinition: workerTask,
      desiredCount: cfg.workerDesiredCount,
      securityGroups: [workerSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
    });

    // Daily retention purge (per-tenant retention days).
    const retentionTask = new ecs.FargateTaskDefinition(this, "RetentionTask", { cpu: 512, memoryLimitMiB: 1024, taskRole });
    retentionTask.addContainer("retention", { image: workerImage, command: ["--retention"], logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "retention" }), environment, secrets });
    new events.Rule(this, "RetentionSchedule", {
      schedule: events.Schedule.cron({ hour: "8", minute: "17" }),
      targets: [new targets.EcsTask({ cluster, taskDefinition: retentionTask, subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }, securityGroups: [workerSg] })],
    });

    // ---------- load balancer: the only public entry point ----------
    const zone =
      cfg.hostedZoneId && cfg.hostedZoneName ? route53.HostedZone.fromHostedZoneAttributes(this, "Zone", { hostedZoneId: cfg.hostedZoneId, zoneName: cfg.hostedZoneName }) : undefined;
    const cert = new acm.Certificate(this, "Cert", { domainName: cfg.domainName, validation: zone ? acm.CertificateValidation.fromDns(zone) : acm.CertificateValidation.fromDns() });
    const albSg = new ec2.SecurityGroup(this, "AlbSg", { vpc: f.vpc, description: "Public HTTPS" });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS");
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "Redirect to HTTPS");
    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", { vpc: f.vpc, internetFacing: true, securityGroup: albSg, dropInvalidHeaderFields: true, idleTimeout: Duration.seconds(300) });
    alb.logAccessLogs(f.logsBucket, "alb");
    alb.addRedirect({ sourcePort: 80, targetPort: 443 });
    const https = alb.addListener("Https", { port: 443, certificates: [cert], sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS, open: false });
    https.addTargets("Web", {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [web],
      healthCheck: { path: "/api/health", healthyHttpCodes: "200" },
      stickinessCookieDuration: Duration.hours(1), // keeps the voice WebSocket on one task
      deregistrationDelay: Duration.seconds(30),
    });
    webSg.addIngressRule(albSg, ec2.Port.tcp(3000), "From ALB");
    if (zone) new route53.ARecord(this, "Alias", { zone, recordName: cfg.domainName, target: route53.RecordTarget.fromAlias(new r53targets.LoadBalancerTarget(alb)) });

    // ---------- WAF ----------
    const managed = (name: string, priority: number) => ({
      name,
      priority,
      overrideAction: { none: {} },
      statement: { managedRuleGroupStatement: { vendorName: "AWS", name } },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: name, sampledRequestsEnabled: false },
    });
    const rate = (name: string, priority: number, path: string, limit: number) => ({
      name,
      priority,
      action: { block: {} },
      statement: {
        rateBasedStatement: {
          limit,
          evaluationWindowSec: 300,
          aggregateKeyType: "IP",
          scopeDownStatement: { byteMatchStatement: { fieldToMatch: { uriPath: {} }, positionalConstraint: "STARTS_WITH", searchString: path, textTransformations: [{ priority: 0, type: "NONE" }] } },
        },
      },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: name, sampledRequestsEnabled: false },
    });
    const acl = new wafv2.CfnWebACL(this, "Waf", {
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: "aba-waf", sampledRequestsEnabled: false },
      rules: [
        rate("LoginRateLimit", 0, "/api/auth/", 100),
        rate("UploadRateLimit", 1, "/api/plans/", 2000),
        managed("AWSManagedRulesCommonRuleSet", 2),
        managed("AWSManagedRulesKnownBadInputsRuleSet", 3),
        managed("AWSManagedRulesAmazonIpReputationList", 4),
        managed("AWSManagedRulesSQLiRuleSet", 5),
      ],
    });
    // Sampled requests are off so request bodies (PHI) never land in WAF logs.
    new wafv2.CfnWebACLAssociation(this, "WafAssoc", { resourceArn: alb.loadBalancerArn, webAclArn: acl.attrArn });

    new CfnOutput(this, "Url", { value: `https://${cfg.domainName}` });
    new CfnOutput(this, "AlbDns", { value: alb.loadBalancerDnsName, description: "Point the domain's DNS at this (CNAME/alias) if no hosted zone is configured" });
  }
}
