import { describe, expect, it } from "vitest";
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AppService } from "../lib/app-stack";
import { envConfig } from "../lib/config";
import { Foundation } from "../lib/foundation-stack";
import { SecurityStack } from "../lib/security-stack";

/** Infrastructure guarantees from the HIPAA section, checked against the synthesized templates. */
function synth(name: "dev" | "prod") {
  const app = new App({ context: { "@aws-cdk/core:defaultCrossStackReferences": "strong" } });
  const cfg = envConfig(name, () => undefined);
  const env = { account: "111111111111", region: "us-east-2" };
  const platform = new Stack(app, "P", { env });
  const f = new Foundation(platform, "Foundation", cfg);
  new AppService(platform, "App", cfg, f);
  const sec = new SecurityStack(app, "S", cfg, f, { env });
  return { p: Template.fromStack(platform), s: Template.fromStack(sec) };
}

const { p, s } = synth("prod");

describe("infrastructure (prod definition)", () => {
  it("database: encrypted with the CMK, private, Multi-AZ, 35-day backups, TLS forced", () => {
    p.hasResourceProperties("AWS::RDS::DBInstance", { StorageEncrypted: true, PubliclyAccessible: false, MultiAZ: true, BackupRetentionPeriod: 35, DeletionProtection: true, KmsKeyId: Match.anyValue() });
    p.hasResourceProperties("AWS::RDS::DBParameterGroup", { Parameters: Match.objectLike({ "rds.force_ssl": "1" }) });
  });

  it("buckets block all public access; files bucket uses SSE-KMS with versioning", () => {
    for (const b of Object.values(p.findResources("AWS::S3::Bucket"))) {
      expect((b as { Properties: { PublicAccessBlockConfiguration: Record<string, boolean> } }).Properties.PublicAccessBlockConfiguration).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
    }
    p.hasResourceProperties("AWS::S3::Bucket", { VersioningConfiguration: { Status: "Enabled" }, BucketEncryption: { ServerSideEncryptionConfiguration: [Match.objectLike({ ServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms", KMSMasterKeyID: Match.anyValue() } })] } });
  });

  it("queues are KMS-encrypted with a dead-letter queue", () => {
    p.hasResourceProperties("AWS::SQS::Queue", { KmsMasterKeyId: Match.anyValue(), RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }) });
  });

  it("only the load balancer is public, HTTPS on TLS 1.2+, with WAF", () => {
    p.resourceCountIs("AWS::ElasticLoadBalancingV2::LoadBalancer", 1);
    p.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", { Protocol: "HTTPS", SslPolicy: Match.stringLikeRegexp("TLS13-1-2") });
    p.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", { Protocol: "HTTP", DefaultActions: [Match.objectLike({ Type: "redirect", RedirectConfig: Match.objectLike({ Protocol: "HTTPS" }) })] });
    p.resourceCountIs("AWS::WAFv2::WebACLAssociation", 1);
    for (const svc of Object.values(p.findResources("AWS::ECS::Service"))) {
      expect(JSON.stringify(svc)).toContain('"AssignPublicIp":"DISABLED"');
    }
  });

  it("Cognito requires TOTP MFA and a strong password policy", () => {
    p.hasResourceProperties("AWS::Cognito::UserPool", { MfaConfiguration: "ON", EnabledMfas: ["SOFTWARE_TOKEN_MFA"], Policies: { PasswordPolicy: Match.objectLike({ MinimumLength: 12, RequireSymbols: true }) }, AdminCreateUserConfig: { AllowAdminCreateUserOnly: true } });
  });

  it("Bedrock access is scoped to approved model IDs only", () => {
    const json = JSON.stringify(p.findResources("AWS::IAM::Policy"));
    expect(json).toContain("BedrockApprovedModelsOnly");
    expect(json).not.toMatch(/"bedrock:\*"/);
    expect(json).not.toMatch(/fable|mythos/i);
  });

  it("services are reached through VPC endpoints", () => {
    const eps = JSON.stringify(p.findResources("AWS::EC2::VPCEndpoint"));
    for (const svc of ["bedrock-runtime", "textract", "transcribestreaming", "secretsmanager", "sqs", "kms", "s3"]) expect(eps).toContain(svc);
  });

  it("CloudTrail (all regions, validation), GuardDuty, Security Hub, Config and budget alerts", () => {
    s.hasResourceProperties("AWS::CloudTrail::Trail", { IsMultiRegionTrail: true, EnableLogFileValidation: true, KMSKeyId: Match.anyValue() });
    s.resourceCountIs("AWS::GuardDuty::Detector", 1);
    s.resourceCountIs("AWS::SecurityHub::Hub", 1);
    s.resourceCountIs("AWS::Config::ConfigurationRecorder", 1);
    s.resourceCountIs("AWS::Budgets::Budget", 1);
  });

  it("app logs are KMS-encrypted; secrets come from Secrets Manager, not plain env", () => {
    p.hasResourceProperties("AWS::Logs::LogGroup", { KmsKeyId: Match.anyValue() });
    const td = JSON.stringify(p.findResources("AWS::ECS::TaskDefinition"));
    expect(td).toContain("SESSION_SECRET");
    expect(td).not.toMatch(/"Name":"SESSION_SECRET","Value"/);
  });
});

describe("dev definition", () => {
  it("dev is single-AZ and not retained, but still encrypted and private", () => {
    const { p: d } = synth("dev");
    d.hasResourceProperties("AWS::RDS::DBInstance", { MultiAZ: false, StorageEncrypted: true, PubliclyAccessible: false });
  });
});
