import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudtrail from "aws-cdk-lib/aws-cloudtrail";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as config from "aws-cdk-lib/aws-config";
import * as guardduty from "aws-cdk-lib/aws-guardduty";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as securityhub from "aws-cdk-lib/aws-securityhub";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";
import type { EnvConfig } from "./config";
import type { Foundation } from "./foundation-stack";

/** CloudTrail (all regions, log file validation), AWS Config, GuardDuty, Security Hub, alarms and budget alerts. */
export class SecurityStack extends Stack {
  constructor(scope: Construct, id: string, cfg: EnvConfig, f: Foundation, props?: StackProps) {
    super(scope, id, props);
    const topic = new sns.Topic(this, "Alerts", { masterKey: f.key });
    topic.addSubscription(new subs.EmailSubscription(cfg.alarmEmail));

    const trailBucket = new s3.Bucket(this, "TrailBucket", {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: f.key,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      objectLockEnabled: cfg.retainData,
      lifecycleRules: [{ expiration: Duration.days(2555) }],
      removalPolicy: cfg.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !cfg.retainData,
    });
    f.key.grantEncryptDecrypt(new iam.ServicePrincipal("cloudtrail.amazonaws.com"));
    const trail = new cloudtrail.Trail(this, "Trail", {
      bucket: trailBucket,
      encryptionKey: f.key,
      isMultiRegionTrail: true,
      includeGlobalServiceEvents: true,
      enableFileValidation: true,
      sendToCloudWatchLogs: false,
    });
    trail.addS3EventSelector([{ bucket: f.filesBucket }], { readWriteType: cloudtrail.ReadWriteType.ALL, includeManagementEvents: false });

    if (cfg.enableAccountSecurityServices) {
      new guardduty.CfnDetector(this, "GuardDuty", {
        enable: true,
        features: [
          { name: "S3_DATA_EVENTS", status: "ENABLED" },
          { name: "RDS_LOGIN_EVENTS", status: "ENABLED" },
          { name: "RUNTIME_MONITORING", status: "ENABLED", additionalConfiguration: [{ name: "ECS_FARGATE_AGENT_MANAGEMENT", status: "ENABLED" }] },
        ],
      });
      const hub = new securityhub.CfnHub(this, "SecurityHub", { enableDefaultStandards: true, controlFindingGenerator: "SECURITY_CONTROL" });
      void hub;

      const configBucket = new s3.Bucket(this, "ConfigBucket", { encryption: s3.BucketEncryption.S3_MANAGED, blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, enforceSSL: true, removalPolicy: cfg.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY, autoDeleteObjects: !cfg.retainData });
      const configRole = new iam.Role(this, "ConfigRole", { assumedBy: new iam.ServicePrincipal("config.amazonaws.com"), managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWS_ConfigRole")] });
      configBucket.grantReadWrite(configRole);
      const recorder = new config.CfnConfigurationRecorder(this, "Recorder", { roleArn: configRole.roleArn, recordingGroup: { allSupported: true, includeGlobalResourceTypes: true } });
      const channel = new config.CfnDeliveryChannel(this, "Delivery", { s3BucketName: configBucket.bucketName });
      const rules = [
        config.ManagedRuleIdentifiers.S3_BUCKET_PUBLIC_READ_PROHIBITED,
        config.ManagedRuleIdentifiers.S3_BUCKET_SSL_REQUESTS_ONLY,
        config.ManagedRuleIdentifiers.S3_BUCKET_SERVER_SIDE_ENCRYPTION_ENABLED,
        config.ManagedRuleIdentifiers.RDS_STORAGE_ENCRYPTED,
        config.ManagedRuleIdentifiers.RDS_INSTANCE_PUBLIC_ACCESS_CHECK,
        config.ManagedRuleIdentifiers.RDS_DB_INSTANCE_BACKUP_ENABLED,
        config.ManagedRuleIdentifiers.CLOUD_TRAIL_ENABLED,
        config.ManagedRuleIdentifiers.CLOUD_TRAIL_LOG_FILE_VALIDATION_ENABLED,
        config.ManagedRuleIdentifiers.ALB_HTTP_TO_HTTPS_REDIRECTION_CHECK,
        config.ManagedRuleIdentifiers.GUARDDUTY_ENABLED_CENTRALIZED,
        config.ManagedRuleIdentifiers.CMK_BACKING_KEY_ROTATION_ENABLED,
        config.ManagedRuleIdentifiers.IAM_ROOT_ACCESS_KEY_CHECK,
        config.ManagedRuleIdentifiers.ROOT_ACCOUNT_MFA_ENABLED,
      ];
      for (const r of rules) {
        const rule = new config.ManagedRule(this, `Rule-${r}`, { identifier: r });
        rule.node.addDependency(recorder);
        rule.node.addDependency(channel);
      }
    }

    // Alarms (PHI-free metrics only).
    const alarm = (id: string, metric: cloudwatch.IMetric, threshold: number) => {
      const a = new cloudwatch.Alarm(this, id, { metric, threshold, evaluationPeriods: 1, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING });
      a.addAlarmAction(new cwActions.SnsAction(topic));
    };
    alarm("DlqMessages", f.dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }), 1);
    alarm("DbCpu", f.db.metricCPUUtilization({ period: Duration.minutes(5) }), 85);
    alarm("DbStorageLow", new cloudwatch.MathExpression({ expression: "-m", usingMetrics: { m: f.db.metricFreeStorageSpace({ period: Duration.minutes(15), statistic: "Minimum" }) } }), -10 * 1024 ** 3);

    new budgets.CfnBudget(this, "Budget", {
      budget: { budgetType: "COST", timeUnit: "MONTHLY", budgetLimit: { amount: cfg.monthlyBudgetUsd, unit: "USD" }, budgetName: `aba-${cfg.name}` },
      notificationsWithSubscribers: [50, 80, 100].map((pct) => ({
        notification: { comparisonOperator: "GREATER_THAN", notificationType: pct === 100 ? "FORECASTED" : "ACTUAL", threshold: pct, thresholdType: "PERCENTAGE" },
        subscribers: [{ subscriptionType: "EMAIL", address: cfg.alarmEmail }],
      })),
    });
  }
}
