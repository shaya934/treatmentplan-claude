/** Settings come from the environment (ECS task definition; secrets from Secrets Manager). */
export const cfg = {
  region: process.env.AWS_REGION ?? "us-east-2",
  port: Number(process.env.PORT ?? 8080),
  /** Unset only for local development, where files are kept in memory. */
  bucket: process.env.BUCKET,
  userPoolId: process.env.USER_POOL_ID ?? "",
  clientId: process.env.USER_POOL_CLIENT_ID ?? "",
  sessionSecret: process.env.SESSION_SECRET ?? "",
  /** Local development only: skip Cognito. Refused when a bucket is configured. */
  devNoAuth: process.env.DEV_NO_AUTH === "1" && !process.env.BUCKET,
  secureCookie: process.env.NODE_ENV === "production",
};
if (!cfg.devNoAuth && (!cfg.userPoolId || !cfg.clientId || cfg.sessionSecret.length < 32)) {
  throw new Error("USER_POOL_ID, USER_POOL_CLIENT_ID and SESSION_SECRET (32+ chars) are required");
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Audit trail (CloudWatch, kept for years): who did what, when. Never file names or document text. */
export function audit(event: string, user: string, details: Record<string, string | number> = {}) {
  console.log(JSON.stringify({ type: "audit", event, user, at: new Date().toISOString(), ...details }));
}
