import { App, Tags } from "aws-cdk-lib";
import { DropStack } from "../lib/drop-stack";

/**
 * The document drop site: npx cdk deploy -a "npx tsx bin/drop.ts"
 * One small stack, separate from the old platform app (bin/app.ts).
 */
const app = new App();
const region = "us-east-2"; // us-east-1 is blocked for workloads by the organization's SCP

/** Fixed AZs instead of a context lookup, so synth needs no AWS credentials and the AZs never shift. */
class FixedAzStack extends DropStack {
  get availabilityZones(): string[] {
    return [`${region}a`, `${region}b`];
  }
}

new FixedAzStack(app, "WeAchieveDrop", {
  env: { account: "324404179405", region },
  domainName: "abatreatmentplans.com",
  hostedZoneId: "Z09159851E73OBEY1WM92",
  alarmEmail: "shaya934@gmail.com",
});
Tags.of(app).add("app", "we-achieve-drop");
Tags.of(app).add("data-classification", "phi");
