/**
 * Runtime configuration. Secrets are never hard-coded: in AWS they come from
 * Secrets Manager (injected into the ECS task as env by CDK); locally from .env.
 *
 * ABA_MODE=aws   -> real Bedrock, S3, Textract, Transcribe, Cognito, SQS
 * ABA_MODE=local -> local Postgres, filesystem storage, in-process queue, mock AI
 *                   (synthetic data only; for development and tests)
 */
export type Mode = "aws" | "local";

export interface AppEnv {
  mode: Mode;
  region: string;
  databaseUrl: string;
  sessionSecret: string;
  sessionIdleMinutes: number;
  bucket: string;
  queueUrl: string;
  cognitoUserPoolId: string;
  cognitoClientId: string;
  localStorageDir: string;
  appUrl: string;
  presignTtlSeconds: number;
}

let cached: AppEnv | null = null;

export function env(): AppEnv {
  if (cached) return cached;
  const mode = (process.env.ABA_MODE ?? "local") as Mode;
  const required = (k: string, fallback?: string) => {
    const v = process.env[k] ?? fallback;
    if (v === undefined || v === "") throw new Error(`Missing required env ${k}`);
    return v;
  };
  cached = {
    mode,
    region: process.env.AWS_REGION ?? "us-east-1",
    databaseUrl: required("DATABASE_URL", mode === "local" ? "postgres://aba_app:aba_app_local@127.0.0.1:5432/aba" : undefined),
    sessionSecret: required("SESSION_SECRET", mode === "local" ? "local-dev-only-session-secret-change-me-0123456789" : undefined),
    sessionIdleMinutes: Number(process.env.SESSION_IDLE_MINUTES ?? 15),
    bucket: process.env.FILES_BUCKET ?? "",
    queueUrl: process.env.JOBS_QUEUE_URL ?? "",
    cognitoUserPoolId: process.env.COGNITO_USER_POOL_ID ?? "",
    cognitoClientId: process.env.COGNITO_CLIENT_ID ?? "",
    localStorageDir: process.env.LOCAL_STORAGE_DIR ?? `${process.cwd()}/.localdata/files`,
    appUrl: process.env.APP_URL ?? "http://localhost:3000",
    presignTtlSeconds: Math.min(Number(process.env.PRESIGN_TTL_SECONDS ?? 300), 300),
  };
  if (mode === "aws") {
    for (const k of ["bucket", "queueUrl", "cognitoUserPoolId", "cognitoClientId"] as const) {
      if (!cached[k]) throw new Error(`Missing AWS config: ${k}`);
    }
  }
  return cached;
}

export function resetEnvCache() {
  cached = null;
}
