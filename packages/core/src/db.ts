import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { env } from "./env";
import type { Role } from "./types";

/**
 * Database access. Every query runs inside withCtx(), which opens a
 * transaction and sets app.tenant_id / app.user_id / app.role so Postgres
 * row-level security enforces tenant isolation and BCBA assignment in the
 * database, not only in application code.
 */

export interface DbCtx {
  tenantId: string | null;
  userId: string | null;
  role: Role | "system" | "auth" | "mfa_enroll";
}

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const url = env().databaseUrl;
    pool = new pg.Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX ?? 10), ssl: rdsSsl() });
    // Dates come back as 'YYYY-MM-DD' strings, never shifted by timezone.
    pg.types.setTypeParser(1082, (v) => v);
  }
  return pool;
}

/** TLS to RDS, verified against the RDS CA bundle baked into the image. */
export function rdsSsl(): pg.ClientConfig["ssl"] {
  if (env().mode !== "aws") return undefined;
  const file = process.env.RDS_CA_FILE;
  return { rejectUnauthorized: true, ca: file ? readFileSync(file, "utf8") : undefined };
}

export async function closePool() {
  await pool?.end();
  pool = null;
}

export type Tx = pg.PoolClient;

export async function withCtx<T>(ctx: DbCtx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.role', $3, true)", [
      ctx.tenantId ?? "",
      ctx.userId ?? "",
      ctx.role,
    ]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function one<T = Record<string, unknown>>(tx: Tx, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await tx.query(sql, params);
  return (r.rows[0] as T) ?? null;
}

export async function many<T = Record<string, unknown>>(tx: Tx, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await tx.query(sql, params);
  return r.rows as T[];
}

/** Apply SQL migrations in order, as the schema owner. */
export async function migrate(ownerUrl: string, dir = join(import.meta.dirname, "..", "migrations"), ssl?: pg.ClientConfig["ssl"]) {
  const client = new pg.Client({ connectionString: ownerUrl, ssl });
  await client.connect();
  try {
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name as string));
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(join(dir, f), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
}
