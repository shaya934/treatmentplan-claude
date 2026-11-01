import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedWorld, setupTestEnv, svcFor, type World } from "./helpers";

/** Tenant isolation and role permissions, enforced by Postgres RLS (Phase 9 "done when"). */

let w: World;
let db: typeof import("../src/db");
let clients: typeof import("../src/svc/clients");
let plans: typeof import("../src/svc/plans");
let admin: typeof import("../src/svc/admin");

beforeAll(async () => {
  await setupTestEnv();
  db = await import("../src/db");
  clients = await import("../src/svc/clients");
  plans = await import("../src/svc/plans");
  admin = await import("../src/svc/admin");
  w = await seedWorld();
});
afterAll(async () => db.closePool());

const ctx = (key: string) => {
  const u = w.users[key]!;
  return { tenantId: u.tenantId, userId: u.id, role: u.role as never };
};

describe("tenant isolation (RLS)", () => {
  it("a second company cannot see any of the first company's data, even with raw SQL", async () => {
    const tables = ["clients", "plans", "plan_versions", "files", "evidence", "bcba_answers", "review_items", "chat_messages", "templates", "template_versions", "ai_usage", "jobs"];
    // create some tenant A data
    await plans.createPlan(svcFor(w, "bcba1"), { clientId: w.clients.ava!, type: "initial", periodStart: "2026-11-01", periodEnd: "2027-01-29" });
    for (const t of tables) {
      const rows = await db.withCtx(ctx("adminB"), (tx) => tx.query(`SELECT tenant_id FROM ${t}`));
      expect(rows.rows.every((r) => r.tenant_id === w.tenantB), t).toBe(true);
    }
    const leak = await db.withCtx(ctx("adminB"), (tx) => tx.query("SELECT * FROM clients WHERE id = $1", [w.clients.ava]));
    expect(leak.rowCount).toBe(0);
  });

  it("cannot write into another tenant", async () => {
    await expect(
      db.withCtx(ctx("adminB"), (tx) => tx.query("INSERT INTO clients (tenant_id, name) VALUES ($1, 'Injected, X')", [w.tenantA])),
    ).rejects.toThrow(/row-level security/);
    const upd = await db.withCtx(ctx("adminB"), (tx) => tx.query("UPDATE clients SET name = 'pwned' WHERE id = $1", [w.clients.ava]));
    expect(upd.rowCount).toBe(0);
  });

  it("service layer: tenant B admin gets not-found for tenant A plans and clients", async () => {
    const { id } = await plans.createPlan(svcFor(w, "bcba1"), { clientId: w.clients.ava!, type: "initial", periodStart: "2026-11-01", periodEnd: "2027-01-29" });
    await expect(plans.getPlanBundle(svcFor(w, "adminB"), id)).rejects.toThrow(/not found/i);
    await expect(clients.getClient(svcFor(w, "adminB"), w.clients.ava!)).rejects.toThrow(/not found/i);
  });

  it("no tenant context sees nothing", async () => {
    const r = await db.withCtx({ tenantId: null, userId: null, role: "bcba" }, (tx) => tx.query("SELECT * FROM clients"));
    expect(r.rowCount).toBe(0);
  });

  it("super admin cannot read client data without a support grant", async () => {
    const r = await db.withCtx(ctx("owner"), (tx) => tx.query("SELECT * FROM clients"));
    expect(r.rowCount).toBe(0);
    const tenants = await admin.listTenants(svcFor(w, "owner"));
    expect(tenants.length).toBe(2);
  });

  it("support grant is time-limited and logged in the tenant's audit log", async () => {
    const g = await admin.createSupportGrant(svcFor(w, "owner"), w.tenantA, "Ticket 123: export failing", 15);
    const active = await admin.activeGrant(w.users.owner!.id, g.id);
    expect(active?.tenantId).toBe(w.tenantA);
    await admin.logSupportAccess(w.users.owner!.id, w.tenantA, g.id, {});
    const logs = await admin.searchAudit(svcFor(w, "adminA"), { action: "support_access" });
    expect(logs.length).toBe(1);
    await db.withCtx({ tenantId: null, userId: null, role: "super_admin" }, (tx) => tx.query("UPDATE support_grants SET expires_at = now() - interval '1 minute' WHERE id = $1", [g.id]));
    expect(await admin.activeGrant(w.users.owner!.id, g.id)).toBeNull();
  });
});

describe("role permissions", () => {
  it("BCBAs see only assigned clients", async () => {
    const list1 = await clients.listClients(svcFor(w, "bcba1"));
    expect(list1.map((c) => c.id)).toEqual([w.clients.ava]);
    const list2 = await clients.listClients(svcFor(w, "bcba2"));
    expect(list2.map((c) => c.id)).toEqual([w.clients.noah]);
    await expect(clients.getClient(svcFor(w, "bcba2"), w.clients.ava!)).rejects.toThrow(/not found/i);
    const dir = await clients.listClients(svcFor(w, "directorA"));
    expect(dir.length).toBe(2);
  });

  it("BCBA cannot create a client assigned to someone else, or reassign", async () => {
    const r = await clients.createClient(svcFor(w, "bcba2"), { name: "New, Kid", dob: "2020-01-01", medicaidId: "SYN1", payer: "Vaya", diagnosis: "F84.0", assignedBcbaId: w.users.bcba1!.id });
    const c = await db.withCtx(ctx("directorA"), (tx) => tx.query("SELECT assigned_bcba_id FROM clients WHERE id = $1", [r.id]));
    expect(c.rows[0].assigned_bcba_id).toBe(w.users.bcba2!.id); // forced to self
    await expect(clients.reassignClient(svcFor(w, "bcba2"), r.id, w.users.bcba1!.id)).rejects.toThrow(/permission/i);
    await clients.reassignClient(svcFor(w, "directorA"), r.id, w.users.bcba1!.id);
  });

  it("a company admin who sets a BCBA credential can be assigned clients and start plans", async () => {
    const { can } = await import("../src/rbac");
    const ids = async () => (await clients.listBcbas(svcFor(w, "adminA"))).map((b) => b.id);
    expect(await ids()).not.toContain(w.users.adminA!.id);
    expect(can({ ...svcFor(w, "adminA").p, credential: null } as never, "plan.create")).toBe(false);
    await admin.updateUser(svcFor(w, "adminA"), w.users.adminA!.id, { credential: "BCBA" });
    expect(await ids()).toContain(w.users.adminA!.id);
    expect(await ids()).toEqual(expect.arrayContaining([w.users.directorA!.id, w.users.bcba1!.id]));
    expect(can({ ...svcFor(w, "adminA").p, credential: "BCBA" } as never, "plan.create")).toBe(true);
    await admin.updateUser(svcFor(w, "adminA"), w.users.adminA!.id, { credential: "" });
    expect(await ids()).not.toContain(w.users.adminA!.id);
  });

  it("read-only users see finalized plans only and cannot edit", async () => {
    const { id } = await plans.createPlan(svcFor(w, "bcba1"), { clientId: w.clients.ava!, type: "initial", periodStart: "2026-11-01", periodEnd: "2027-01-29" });
    await expect(plans.getPlanBundle(svcFor(w, "qaA"), id)).rejects.toThrow(/not found/i);
    await expect(plans.saveFieldEdits(svcFor(w, "qaA"), id, { strengths: "x" })).rejects.toThrow();
    const raw = await db.withCtx(ctx("qaA"), (tx) => tx.query("UPDATE plans SET status = 'final' WHERE id = $1", [id]));
    expect(raw.rowCount).toBe(0);
  });

  it("admins cannot finalize unless also a BCBA; clinical directors cannot edit templates", async () => {
    const { id } = await plans.createPlan(svcFor(w, "bcba1"), { clientId: w.clients.ava!, type: "initial", periodStart: "2026-11-01", periodEnd: "2027-01-29" });
    await expect(plans.finalize(svcFor(w, "adminA"), id)).rejects.toThrow();
    const tmpl = await import("../src/svc/templates");
    await expect(tmpl.templateChat(svcFor(w, "directorA"), "Add a feeding concerns field under Developmental History")).rejects.toThrow(/permission/i);
    await expect(tmpl.templateChat(svcFor(w, "bcba1"), "Add a feeding concerns field under Developmental History")).rejects.toThrow(/permission/i);
  });
});

describe("append-only audit log and locked versions", () => {
  it("audit_log rejects update and delete, even for the owner", async () => {
    await expect(db.withCtx(ctx("adminA"), (tx) => tx.query("UPDATE audit_log SET action = 'x'"))).rejects.toThrow(/permission denied|append-only/);
    await expect(db.withCtx(ctx("adminA"), (tx) => tx.query("DELETE FROM audit_log"))).rejects.toThrow(/permission denied|append-only/);
    const pg = (await import("pg")).default;
    const { OWNER_URL } = await import("./helpers");
    const c = new pg.Client({ connectionString: OWNER_URL });
    await c.connect();
    // Owner: RLS is forced and no policy allows DELETE, so nothing is removed; TRUNCATE is blocked by trigger.
    await c.query("SELECT set_config('app.tenant_id', $1, false), set_config('app.role', 'company_admin', false)", [w.tenantA]);
    const before = (await c.query("SELECT count(*)::int AS n FROM audit_log")).rows[0].n;
    expect((await c.query("DELETE FROM audit_log")).rowCount).toBe(0);
    expect((await c.query("SELECT count(*)::int AS n FROM audit_log")).rows[0].n).toBe(before);
    await expect(c.query("TRUNCATE audit_log CASCADE")).rejects.toThrow(/append-only/);
    await c.end();
  });

  it("every view is audited", async () => {
    const { id } = await plans.createPlan(svcFor(w, "bcba1"), { clientId: w.clients.ava!, type: "initial", periodStart: "2026-11-01", periodEnd: "2027-01-29" });
    await plans.getPlanBundle(svcFor(w, "bcba1"), id);
    const logs = await admin.searchAudit(svcFor(w, "adminA"), { entity: "plan", entityId: id });
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(["create", "view"]));
  });

  it("BCBAs cannot read the audit log", async () => {
    await expect(admin.searchAudit(svcFor(w, "bcba1"), {})).rejects.toThrow(/permission/i);
    const r = await db.withCtx(ctx("bcba1"), (tx) => tx.query("SELECT * FROM audit_log"));
    expect(r.rowCount).toBe(0);
  });
});
