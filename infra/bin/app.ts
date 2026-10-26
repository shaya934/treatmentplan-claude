import { App, Aspects, Stack, Tags } from "aws-cdk-lib";
import { AppService } from "../lib/app-stack";
import { envConfig } from "../lib/config";
import { Foundation } from "../lib/foundation-stack";
import { SecurityStack } from "../lib/security-stack";
import { NoPublicDataAspect } from "../lib/aspects";

/**
 * cdk deploy --all -c env=dev     (synthetic data only; deploy freely)
 * cdk synth  --all -c env=prod    (defined, NOT deployed until the HIPAA consultant review)
 */
const app = new App();
const name = String(app.node.tryGetContext("env") ?? "dev");
const cfg = envConfig(name, (k) => app.node.tryGetContext(k));
const env = { account: cfg.account ?? process.env.CDK_DEFAULT_ACCOUNT, region: cfg.region };
const prefix = `Aba${name === "prod" ? "Prod" : "Dev"}`;

// One platform stack (network, data, auth, app) avoids cross-stack grant cycles on the KMS key.
const platform = new Stack(app, `${prefix}-Platform`, { env, terminationProtection: cfg.retainData });
const foundation = new Foundation(platform, "Foundation", cfg);
new AppService(platform, "App", cfg, foundation);
new SecurityStack(app, `${prefix}-Security`, cfg, foundation, { env, terminationProtection: cfg.retainData });

Tags.of(app).add("app", "aba-plan-assistant");
Tags.of(app).add("environment", name);
Tags.of(app).add("data-classification", name === "prod" ? "phi" : "synthetic");
Aspects.of(app).add(new NoPublicDataAspect());
