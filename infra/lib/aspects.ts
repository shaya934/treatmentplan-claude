import { Annotations, type IAspect } from "aws-cdk-lib";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { IConstruct } from "constructs";

/** Synth-time guard: fail if any bucket allows public access or any database is public/unencrypted. */
export class NoPublicDataAspect implements IAspect {
  visit(node: IConstruct) {
    if (node instanceof s3.CfnBucket) {
      const b = node.publicAccessBlockConfiguration as s3.CfnBucket.PublicAccessBlockConfigurationProperty | undefined;
      if (!b || !b.blockPublicAcls || !b.blockPublicPolicy || !b.ignorePublicAcls || !b.restrictPublicBuckets) Annotations.of(node).addError("S3 buckets must block all public access");
    }
    if (node instanceof rds.CfnDBInstance) {
      if (node.publiclyAccessible) Annotations.of(node).addError("Database must not be publicly accessible");
      if (!node.storageEncrypted) Annotations.of(node).addError("Database storage must be encrypted");
    }
  }
}
