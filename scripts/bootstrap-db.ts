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
console.log(JSON.stringify({ level: "info", event: "db_bootstrap_done" }));
