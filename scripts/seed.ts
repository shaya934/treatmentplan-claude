import pg from "pg";
import bcrypt from "bcryptjs";
import { generateSecret } from "otplib";
import { migrate, withCtx, closePool } from "@aba/core/db";
import { seedTemplate } from "@aba/core/svc/admin";
import { WE_ACHIEVE_TEMPLATE } from "@aba/core/template/we-achieve-template";
import { SYNTHETIC_CLIENTS } from "@aba/core/fixtures";

/**
 * Seeds SYNTHETIC data for development: two tenants, one user per role,
 * and 3 fake clients. Run `pnpm fixtures` to write the matching fake PDFs.
 *   tsx scripts/seed.ts [--reset]
 * Local auth only: passwords and TOTP secrets are printed for the demo.
 */
const ownerUrl = process.env.MIGRATION_DATABASE_URL ?? "postgres://aba_owner:aba_owner_local@127.0.0.1:5432/aba";
if (process.env.ABA_MODE === "aws") throw new Error("Seed is for local/dev synthetic data only");

if (process.argv.includes("--reset")) {
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO aba_app;");
  await c.end();
}
await migrate(ownerUrl);

const PASSWORD = process.env.SEED_PASSWORD ?? "Demo-Passw0rd!";
const hash = await bcrypt.hash(PASSWORD, 10);

interface SeedUser {
  email: string;
  role: string;
  name: string;
  credential?: string;
  npi?: string;
}

async function tenant(name: string, slug: string, users: SeedUser[]) {
  const ids: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  const tenantId = await withCtx({ tenantId: null, userId: null, role: "super_admin" }, async (t) => {
    const r = await t.query("INSERT INTO tenants (name, slug, branding) VALUES ($1,$2,$3) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id", [name, slug, JSON.stringify({ companyName: name })]);
    const id = r.rows[0].id as string;
    for (const u of users) {
      const secret = generateSecret();
      const ur = await t.query(
        "INSERT INTO users (tenant_id, email, role, name, credential, npi, password_hash, totp_secret) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id, totp_secret",
        [id, u.email, u.role, u.name, u.credential ?? null, u.npi ?? null, hash, secret],
      );
      ids[u.email] = ur.rows[0].id;
      secrets[u.email] = ur.rows[0].totp_secret;
    }
    return id;
  });
  const hasTemplate = await withCtx({ tenantId, userId: null, role: "system" }, async (t) => (await t.query("SELECT 1 FROM templates")).rowCount);
  if (!hasTemplate) await seedTemplate(tenantId, { ...WE_ACHIEVE_TEMPLATE, branding: { ...WE_ACHIEVE_TEMPLATE.branding, companyName: name } });
  return { tenantId, ids, secrets };
}

const a = await tenant("We Achieve ABA (demo)", "we-achieve-demo", [
  { email: "admin@demo.test", role: "company_admin", name: "Casey Admin" },
  { email: "director@demo.test", role: "clinical_director", name: "Dana Director", credential: "BCBA-D", npi: "1000000001" },
  { email: "bcba1@demo.test", role: "bcba", name: "Riley Analyst", credential: "BCBA", npi: "1000000002" },
  { email: "bcba2@demo.test", role: "bcba", name: "Morgan Analyst", credential: "BCBA", npi: "1000000003" },
  { email: "qa@demo.test", role: "read_only", name: "Quinn Reviewer" },
]);
const b = await tenant("Second Test Company", "second-test", [{ email: "admin@second.test", role: "company_admin", name: "Other Admin" }, { email: "bcba@second.test", role: "bcba", name: "Other BCBA", credential: "BCBA" }]);

const superSecret = generateSecret();
const superRow = await withCtx({ tenantId: null, userId: null, role: "super_admin" }, (t) =>
  t.query("INSERT INTO users (tenant_id, email, role, name, password_hash, totp_secret) VALUES (NULL,'owner@platform.test','super_admin','Platform Owner',$1,$2) ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING totp_secret", [hash, superSecret]),
);

// Three synthetic clients in the demo tenant: two for bcba1, one for bcba2.
const assign = [a.ids["bcba1@demo.test"], a.ids["bcba1@demo.test"], a.ids["bcba2@demo.test"]];
await withCtx({ tenantId: a.tenantId, userId: null, role: "system" }, async (t) => {
  for (const [i, c] of SYNTHETIC_CLIENTS.entries()) {
    const exists = await t.query("SELECT 1 FROM clients WHERE medicaid_id = $1", [c.medicaidId]);
    if (exists.rowCount) continue;
    await t.query("INSERT INTO clients (tenant_id, name, dob, gender, medicaid_id, payer, diagnosis, assigned_bcba_id, auth_end_date) VALUES (app_tenant(),$1,$2,$3,$4,$5,$6,$7, current_date + $8::int)", [
      c.name,
      c.dob,
      c.gender,
      c.medicaidId,
      c.payer,
      c.diagnosis,
      assign[i],
      [25, 55, 12][i],
    ]);
  }
});
await withCtx({ tenantId: b.tenantId, userId: null, role: "system" }, (t) =>
  t.query("INSERT INTO clients (tenant_id, name, dob, medicaid_id, payer, diagnosis, assigned_bcba_id) SELECT app_tenant(), 'Othertenant, Zed', '2018-02-02', 'SYN0000900', 'Vaya', 'Autism Spectrum Disorder (F84.0)', $1 WHERE NOT EXISTS (SELECT 1 FROM clients)", [b.ids["bcba@second.test"]]),
);

await closePool();
console.log("\nSeeded SYNTHETIC data. Password for every user:", PASSWORD);
console.log("TOTP secrets (add to an authenticator app, or run: pnpm totp <secret>):");
for (const [email, secret] of Object.entries({ ...a.secrets, ...b.secrets, "owner@platform.test": superRow.rows[0].totp_secret })) console.log(`  ${email.padEnd(24)} ${secret}`);
