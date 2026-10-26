import pg from "pg";
import { migrate } from "@aba/core/db";

/**
 * AWS startup step (web container): ensure the non-owner runtime role exists with
 * the password from Secrets Manager, then apply migrations as the schema owner.
 * Idempotent; safe to run on every start.
 */
const host = process.env.DB_HOST!;
const port = process.env.DB_PORT ?? "5432";
const db = process.env.DB_NAME ?? "aba";
const ownerUrl = `postgres://aba_owner:${encodeURIComponent(process.env.DB_OWNER_PASSWORD!)}@${host}:${port}/${db}?sslmode=verify-full`;
const fs = await import("node:fs");
const ssl = process.env.RDS_CA_FILE ? { ca: fs.readFileSync(process.env.RDS_CA_FILE, "utf8"), rejectUnauthorized: true } : undefined;
const c = new pg.Client({ connectionString: ownerUrl.replace("?sslmode=verify-full", ""), ssl });
await c.connect();
const exists = await c.query("SELECT 1 FROM pg_roles WHERE rolname = 'aba_app'");
const pw = process.env.DB_APP_PASSWORD!.replace(/'/g, "''");
await c.query(exists.rowCount ? `ALTER ROLE aba_app WITH LOGIN NOBYPASSRLS PASSWORD '${pw}'` : `CREATE ROLE aba_app WITH LOGIN NOBYPASSRLS PASSWORD '${pw}'`);
await c.end();
await migrate(ownerUrl.replace("?sslmode=verify-full", ""), undefined, ssl);

// First login: create the platform owner (super admin) once, from OWNER_EMAIL.
// Cognito emails them a temporary password; MFA setup is required at first sign-in.
const ownerEmail = process.env.OWNER_EMAIL?.trim().toLowerCase();
if (ownerEmail && !ownerEmail.includes("replace-me")) {
  const o = new pg.Client({ connectionString: ownerUrl.replace("?sslmode=verify-full", ""), ssl });
  await o.connect();
  await o.query("SELECT set_config('app.role', 'super_admin', false)");
  const has = await o.query("SELECT 1 FROM users WHERE role = 'super_admin' LIMIT 1");
  if (!has.rowCount) {
    const { provisionIdentity } = await import("@aba/core/auth");
    const ident = await provisionIdentity(ownerEmail, "super_admin", "");
    await o.query("INSERT INTO users (tenant_id, email, role, name, cognito_sub) VALUES (NULL, $1, 'super_admin', 'Platform Owner', $2)", [ownerEmail, ident.cognitoSub]);
    console.log(JSON.stringify({ level: "info", event: "owner_created" }));
  }
  await o.end();
}
console.log(JSON.stringify({ level: "info", event: "db_bootstrap_done" }));
