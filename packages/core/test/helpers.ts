import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import bcrypt from "bcryptjs";

/** Test database: a separate aba_test database, rebuilt from migrations per test file. SYNTHETIC data only. */
export const OWNER_URL = process.env.TEST_OWNER_URL ?? "postgres://aba_owner:aba_owner_local@127.0.0.1:5432/aba_test";
export const APP_URL = process.env.TEST_APP_URL ?? "postgres://aba_app:aba_app_local@127.0.0.1:5432/aba_test";

export async function setupTestEnv() {
  process.env.ABA_MODE = "local";
  process.env.DATABASE_URL = APP_URL;
  process.env.LOCAL_STORAGE_DIR = await mkdtemp(join(tmpdir(), "aba-test-files-"));
  process.env.SESSION_SECRET = "test-session-secret-0123456789-abcdefghijklmnop";
  const { resetEnvCache } = await import("../src/env");
  resetEnvCache();
  const { setStorage } = await import("../src/storage");
  setStorage(null);
  const { setAiClient } = await import("../src/ai/client");
  setAiClient(null);
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO aba_app;");
  await c.end();
  const { migrate } = await import("../src/db");
  await migrate(OWNER_URL);
}

export interface World {
  tenantA: string;
  tenantB: string;
  users: Record<string, { id: string; tenantId: string | null; role: string; credential?: string | null }>;
  clients: Record<string, string>;
}

/** Two tenants, one user per role, three clients. */
export async function seedWorld(): Promise<World> {
  const { withCtx } = await import("../src/db");
  const { seedTemplate } = await import("../src/svc/admin");
  const { WE_ACHIEVE_TEMPLATE } = await import("../src/template/we-achieve-template");
  const hash = await bcrypt.hash("Test-Passw0rd!", 4);
  const users: World["users"] = {};
  const mk = async (tenantId: string | null, key: string, role: string, credential: string | null = null) => {
    const r = await withCtx({ tenantId, userId: null, role: "super_admin" }, (t) =>
      t.query("INSERT INTO users (tenant_id, email, role, name, credential, npi, password_hash) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id", [tenantId, `${key}@test.test`, role, `User ${key}`, credential, "1234567890", hash]),
    );
    users[key] = { id: r.rows[0].id, tenantId, role, credential };
  };
  const tenant = async (name: string) =>
    (await withCtx({ tenantId: null, userId: null, role: "super_admin" }, (t) => t.query("INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id", [name, name.toLowerCase().replace(/\W+/g, "-")]))).rows[0].id as string;
  const tenantA = await tenant("Tenant A");
  const tenantB = await tenant("Tenant B");
  await mk(tenantA, "adminA", "company_admin");
  await mk(tenantA, "directorA", "clinical_director", "BCBA-D");
  await mk(tenantA, "bcba1", "bcba", "BCBA");
  await mk(tenantA, "bcba2", "bcba", "BCBA");
  await mk(tenantA, "qaA", "read_only");
  await mk(tenantB, "adminB", "company_admin");
  await mk(tenantB, "bcbaB", "bcba", "BCBA");
  await mk(null, "owner", "super_admin");
  await seedTemplate(tenantA, WE_ACHIEVE_TEMPLATE);
  await seedTemplate(tenantB, WE_ACHIEVE_TEMPLATE);
  const clients: Record<string, string> = {};
  const client = async (tenantId: string, key: string, name: string, bcba: string) => {
    const r = await withCtx({ tenantId, userId: null, role: "system" }, (t) =>
      t.query("INSERT INTO clients (tenant_id, name, dob, gender, medicaid_id, payer, diagnosis, assigned_bcba_id) VALUES ($1,$2,'2019-04-12','Female',$3,'Trillium','Autism Spectrum Disorder, Level 2 (F84.0)',$4) RETURNING id", [
        tenantId,
        name,
        `SYN${Math.floor(Math.random() * 1e7)}`,
        users[bcba]!.id,
      ]),
    );
    clients[key] = r.rows[0].id;
  };
  await client(tenantA, "ava", "Testcase, Ava", "bcba1");
  await client(tenantA, "noah", "Sample, Noah", "bcba2");
  await client(tenantB, "zed", "Othertenant, Zed", "bcbaB");
  return { tenantA, tenantB, users, clients };
}

export function svcFor(w: World, key: string) {
  const u = w.users[key]!;
  return { p: { userId: u.id, tenantId: u.tenantId, role: u.role as never, credential: u.credential }, meta: { ip: "127.0.0.1", userAgent: "vitest" } };
}

/** Run queued local jobs synchronously for deterministic tests. */
export async function installInlineJobs() {
  const { setLocalRunner } = await import("../src/jobs");
  const { runJob } = await import("../src/svc/work");
  const pending: Promise<void>[] = [];
  setLocalRunner(async (m) => {
    const p = runJob(m);
    pending.push(p.catch(() => {}));
    await p;
  });
  return async () => {
    // let setImmediate callbacks fire, then wait for all jobs
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const n = pending.length;
      await Promise.all(pending);
      if (pending.length === n) break;
    }
  };
}
