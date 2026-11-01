import { randomUUID } from "node:crypto";
import { audit } from "../audit";
import { disableIdentity, provisionIdentity } from "../auth";
import { many, one, withCtx } from "../db";
import { SafeError } from "../logger";
import { assertCan } from "../rbac";
import { storage } from "../storage";
import type { Template } from "../template/schema";
import type { Role } from "../types";
import { log, tx, type Svc } from "./context";
import { deleteFigures, deleteObjects } from "./figures";
import { standardTemplate } from "./platform-template";

/** Users, audit search, usage, dashboards, tenants, support grants, retention. */

// ------------------------------- users -------------------------------------

export async function listUsers(s: Svc) {
  return tx(s, async (t) => {
    assertCan(s.p, "user.manage");
    return many(t, "SELECT id, email, role, name, credential, npi, active, created_at, (totp_secret IS NOT NULL OR cognito_sub IS NOT NULL) AS mfa FROM users WHERE tenant_id = app_tenant() ORDER BY name");
  });
}

export async function createUser(s: Svc, u: { email: string; name: string; role: Role; credential?: string; npi?: string; tempPassword: string }) {
  if (u.role === "super_admin") throw new SafeError("Not allowed", 403);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(u.email)) throw new SafeError("Enter a valid email");
  const ident = await provisionIdentity(u.email, u.role, u.tempPassword);
  return tx(s, async (t) => {
    assertCan(s.p, "user.manage");
    const exists = await one(t, "SELECT 1 FROM users WHERE lower(email) = lower($1)", [u.email]);
    if (exists) throw new SafeError("A user with that email already exists");
    const r = await one<{ id: string }>(t, "INSERT INTO users (tenant_id, email, role, name, credential, npi, cognito_sub, password_hash) VALUES (app_tenant(),$1,$2,$3,$4,$5,$6,$7) RETURNING id", [
      u.email.toLowerCase(),
      u.role,
      u.name,
      u.credential ?? null,
      u.npi ?? null,
      ident.cognitoSub,
      ident.passwordHash,
    ]);
    await log(t, s, "create", "user", r!.id, { role: u.role });
    return r!;
  });
}

export async function updateUser(s: Svc, id: string, patch: { role?: Role; active?: boolean; name?: string; credential?: string; npi?: string }) {
  if (patch.role === "super_admin") throw new SafeError("Not allowed", 403);
  const email = await tx(s, async (t) => {
    assertCan(s.p, "user.manage");
    if (id === s.p.userId && (patch.active === false || (patch.role && patch.role !== "company_admin"))) throw new SafeError("You cannot remove your own admin access.");
    const r = await one<{ email: string }>(
      t,
      "UPDATE users SET role = coalesce($2, role), active = coalesce($3, active), name = coalesce($4, name), credential = coalesce($5, credential), npi = coalesce($6, npi) WHERE id = $1 AND tenant_id = app_tenant() RETURNING email",
      [id, patch.role ?? null, patch.active ?? null, patch.name ?? null, patch.credential ?? null, patch.npi ?? null],
    );
    if (!r) throw new SafeError("User not found", 404);
    await log(t, s, "update", "user", id, { role: patch.role ?? null, active: patch.active ?? null });
    return r.email;
  });
  if (patch.active === false) await disableIdentity(email);
}

// ------------------------------- audit -------------------------------------

export async function searchAudit(s: Svc, q: { userId?: string; action?: string; entity?: string; entityId?: string; from?: string; to?: string; limit?: number }) {
  return tx(s, async (t) => {
    assertCan(s.p, "audit.view");
    const where = ["tenant_id = app_tenant()"];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (q.userId) add("user_id = ?", q.userId);
    if (q.action) add("action = ?", q.action);
    if (q.entity) add("entity = ?", q.entity);
    if (q.entityId) add("entity_id = ?", q.entityId);
    if (q.from) add("at >= ?::timestamptz", q.from);
    if (q.to) add("at < (?::date + 1)", q.to);
    params.push(Math.min(q.limit ?? 200, 1000));
    const rows = await many(
      t,
      `SELECT a.id, a.at, a.action, a.entity, a.entity_id, a.ip, a.user_agent, a.detail, u.name AS user_name, u.email AS user_email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE ${where.map((w) => "a." + w).join(" AND ")} ORDER BY a.at DESC LIMIT $${params.length}`,
      params,
    );
    return rows;
  });
}

// ------------------------------- usage -------------------------------------

export async function tenantUsage(s: Svc) {
  return tx(s, async (t) => {
    assertCan(s.p, "usage.view");
    const byMonth = await many<{ month: string; reports: string; generations: string; cost: string; input_tokens: string; output_tokens: string }>(
      t,
      `SELECT to_char(m, 'YYYY-MM') AS month,
              (SELECT count(*) FROM plans p WHERE p.status = 'final' AND date_trunc('month', p.final_date) = m) AS reports,
              (SELECT count(DISTINCT plan_id) FROM ai_usage u WHERE u.step = 'narrative' AND date_trunc('month', u.at) = m) AS generations,
              coalesce((SELECT sum(est_cost) FROM ai_usage u WHERE date_trunc('month', u.at) = m), 0) AS cost,
              coalesce((SELECT sum(input_tokens) FROM ai_usage u WHERE date_trunc('month', u.at) = m), 0) AS input_tokens,
              coalesce((SELECT sum(output_tokens) FROM ai_usage u WHERE date_trunc('month', u.at) = m), 0) AS output_tokens
         FROM generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') m
        ORDER BY m`,
    );
    const byStep = await many(t, "SELECT step, model, count(*) AS calls, sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens, sum(est_cost) AS cost FROM ai_usage WHERE at > now() - interval '30 days' GROUP BY step, model ORDER BY cost DESC");
    return { byMonth, byStep };
  });
}

// ----------------------------- dashboards ----------------------------------

export async function dashboard(s: Svc) {
  return tx(s, async (t) => {
    const plans = await many<{ id: string; client_id: string; client_name: string; type: string; status: string; period_start: string | null; period_end: string | null; updated_at: string; bcba_name: string | null; open_review: string }>(
      t,
      `SELECT p.id, p.client_id, c.name AS client_name, p.type, p.status, p.period_start, p.period_end, p.updated_at, u.name AS bcba_name,
              (SELECT count(*) FROM review_items r WHERE r.plan_id = p.id AND r.resolved_at IS NULL) AS open_review
         FROM plans p JOIN clients c ON c.id = p.client_id LEFT JOIN users u ON u.id = c.assigned_bcba_id
        ORDER BY p.updated_at DESC LIMIT 200`,
    );
    const alerts = await many<{ client_id: string; client_name: string; auth_end_date: string; days_left: number }>(
      t,
      `SELECT c.id AS client_id, c.name AS client_name, c.auth_end_date, (c.auth_end_date - current_date) AS days_left
         FROM clients c WHERE c.status = 'active' AND c.auth_end_date IS NOT NULL AND c.auth_end_date - current_date <= 60
        ORDER BY c.auth_end_date`,
    );
    return {
      plans: plans.map((p) => ({ ...p, display_status: p.status === "final" ? "Final" : Number(p.open_review) > 0 || p.status === "review" ? "Needs review" : "Draft" })),
      alerts: alerts.map((a) => ({ ...a, level: a.days_left <= 14 ? 14 : a.days_left <= 30 ? 30 : 60 })),
    };
  });
}

// --------------------------- tenants (super admin) -------------------------

export async function listTenants(s: Svc) {
  return tx(s, async (t) => {
    assertCan(s.p, "tenant.manage");
    return many(
      t,
      `SELECT tn.id, tn.name, tn.slug, tn.status, tn.created_at,
              (SELECT count(*) FROM users u WHERE u.tenant_id = tn.id) AS users,
              (SELECT coalesce(sum(est_cost), 0) FROM ai_usage a WHERE a.tenant_id = tn.id AND a.at > date_trunc('month', now())) AS ai_cost_month,
              (SELECT count(*) FROM ai_usage a WHERE a.tenant_id = tn.id AND a.step = 'narrative' AND a.at > date_trunc('month', now())) AS narrative_calls_month
         FROM tenants tn ORDER BY tn.name`,
    );
  });
}

/** Onboard a company: tenant, first admin, and a copy of the platform standard template. */
export async function createTenant(s: Svc, input: { name: string; slug: string; adminEmail: string; adminName: string; tempPassword: string; template?: Template }) {
  if (!/^[a-z0-9-]{2,40}$/.test(input.slug)) throw new SafeError("Slug must be lowercase letters, numbers and dashes");
  assertCan(s.p, "tenant.manage");
  const ident = await provisionIdentity(input.adminEmail, "company_admin", input.tempPassword);
  const tenantId = randomUUID();
  await withCtx({ tenantId: null, userId: s.p.userId, role: "super_admin" }, async (t) => {
    await t.query("INSERT INTO tenants (id, name, slug, branding) VALUES ($1,$2,$3,$4)", [tenantId, input.name, input.slug, JSON.stringify({ companyName: input.name })]);
    await t.query("INSERT INTO users (tenant_id, email, role, name, cognito_sub, password_hash) VALUES ($1,$2,'company_admin',$3,$4,$5)", [tenantId, input.adminEmail.toLowerCase(), input.adminName, ident.cognitoSub, ident.passwordHash]);
    await audit(t, { tenantId: null, userId: s.p.userId, action: "create", entity: "tenant", entityId: tenantId }, s.meta);
  });
  const template = input.template ?? (await withCtx({ tenantId: null, userId: s.p.userId, role: "super_admin" }, standardTemplate)).template;
  await seedTemplate(tenantId, { ...template, branding: { ...template.branding, companyName: input.name, footer: input.name } });
  return { id: tenantId };
}

export async function seedTemplate(tenantId: string, template: Template, userId: string | null = null) {
  await withCtx({ tenantId, userId, role: "system" }, async (t) => {
    const tid = randomUUID();
    const vid = randomUUID();
    await t.query("INSERT INTO templates (id, tenant_id, name) VALUES ($1, $2, $3)", [tid, tenantId, template.name]);
    await t.query("INSERT INTO template_versions (id, tenant_id, template_id, version, status, schema_json, published_by, published_at, change_reason) VALUES ($1,$2,$3,1,'published',$4,$5,now(),'Initial template')", [
      vid,
      tenantId,
      tid,
      JSON.stringify(template),
      userId,
    ]);
    await t.query("UPDATE templates SET current_version_id = $2 WHERE id = $1", [tid, vid]);
  });
}

export async function createSupportGrant(s: Svc, tenantId: string, reason: string, minutes: number) {
  assertCan(s.p, "support.grant");
  if (!reason.trim()) throw new SafeError("A reason is required");
  const m = Math.min(Math.max(minutes, 5), 240);
  return withCtx({ tenantId: null, userId: s.p.userId, role: "super_admin" }, async (t) => {
    const r = await one<{ id: string; expires_at: string }>(t, "INSERT INTO support_grants (tenant_id, granted_to, granted_by, reason, expires_at) VALUES ($1,$2,$2,$3, now() + make_interval(mins => $4)) RETURNING id, expires_at", [
      tenantId,
      s.p.userId,
      reason.trim(),
      m,
    ]);
    await audit(t, { tenantId: null, userId: s.p.userId, action: "support_grant", entity: "tenant", entityId: tenantId, detail: { minutes: m } }, s.meta);
    return r!;
  });
}

/** Validate a support grant before a super admin session enters a tenant. Logged in the tenant's audit log. */
export async function activeGrant(userId: string, grantId: string): Promise<{ tenantId: string; expiresAt: string } | null> {
  return withCtx({ tenantId: null, userId, role: "super_admin" }, async (t) => {
    const g = await one<{ tenant_id: string; expires_at: string }>(t, "SELECT tenant_id, expires_at FROM support_grants WHERE id = $1 AND granted_to = $2 AND revoked_at IS NULL AND expires_at > now()", [grantId, userId]);
    return g ? { tenantId: g.tenant_id, expiresAt: g.expires_at } : null;
  });
}

export async function logSupportAccess(userId: string, tenantId: string, grantId: string, meta: Svc["meta"]) {
  await withCtx({ tenantId, userId, role: "system" }, (t) => audit(t, { tenantId, userId, action: "support_access", entity: "support_grant", entityId: grantId }, meta));
}

export async function platformUsage(s: Svc) {
  return tx(s, async (t) => {
    assertCan(s.p, "platform.usage");
    return many(t, "SELECT tenant_id, to_char(date_trunc('month', at), 'YYYY-MM') AS month, count(*) AS calls, sum(est_cost) AS cost FROM ai_usage GROUP BY 1, 2 ORDER BY 2 DESC, 1");
  });
}

// ------------------------------- retention ---------------------------------

/**
 * Per-tenant retention: source files and non-final drafts older than
 * settings.retention_days are deleted (files from S3 too). Finalized plans are
 * kept for the full retention period, then purged. Audit log is never purged here.
 */
export async function runRetention(tenantId: string, now = new Date()): Promise<{ files: number; plans: number }> {
  return withCtx({ tenantId, userId: null, role: "system" }, async (t) => {
    const settings = (await one<{ settings: { retention_days?: number } }>(t, "SELECT settings FROM tenants WHERE id = $1", [tenantId]))?.settings ?? {};
    const days = Number(settings.retention_days ?? 2555);
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
    const files = await many<{ id: string; s3_key: string }>(t, "SELECT id, s3_key FROM files WHERE uploaded_at < $1", [cutoff]);
    for (const f of files) {
      await storage().delete(f.s3_key);
      await deleteObjects(await deleteFigures(t, "file_id", f.id));
      await t.query("UPDATE evidence SET file_id = NULL WHERE file_id = $1", [f.id]);
      await t.query("DELETE FROM files WHERE id = $1", [f.id]);
    }
    const plans = await many<{ id: string }>(t, "SELECT id FROM plans WHERE updated_at < $1", [cutoff]);
    await t.query("SELECT set_config('app.retention', 'on', true)");
    for (const p of plans) await purgePlan(t, p.id);
    await audit(t, { tenantId, userId: null, action: "retention_purge", entity: "tenant", entityId: tenantId, detail: { files: files.length, plans: plans.length, days } });
    return { files: files.length, plans: plans.length };
  });
}

async function purgePlan(t: import("../db").Tx, planId: string) {
  await deleteObjects(await deleteFigures(t, "plan_id", planId));
  for (const table of ["evidence", "bcba_answers", "review_items", "chat_messages", "plan_versions"]) {
    await t.query(`DELETE FROM ${table} WHERE plan_id = $1`, [planId]);
  }
  await t.query("UPDATE plans SET previous_plan_id = NULL WHERE previous_plan_id = $1", [planId]);
  await t.query("DELETE FROM jobs WHERE payload->>'planId' = $1", [planId]);
  await t.query("UPDATE ai_usage SET plan_id = NULL WHERE plan_id = $1", [planId]);
  await t.query("DELETE FROM plans WHERE id = $1", [planId]);
}

/** Client data deletion on request (HIPAA). Run by a company admin; audited. */
export async function deleteClientData(s: Svc, clientId: string) {
  if (s.p.role !== "company_admin") throw new SafeError("Only a company admin can delete client data.", 403);
  return withCtx({ tenantId: s.p.tenantId, userId: s.p.userId, role: "company_admin" }, async (t) => {
    const c = await one(t, "SELECT id FROM clients WHERE id = $1", [clientId]);
    if (!c) throw new SafeError("Client not found", 404);
    await t.query("SELECT set_config('app.role', 'system', true), set_config('app.retention', 'on', true)");
    const files = await many<{ s3_key: string }>(t, "SELECT s3_key FROM files WHERE client_id = $1", [clientId]);
    for (const f of files) await storage().delete(f.s3_key);
    await deleteObjects(await deleteFigures(t, "client", clientId));
    const plans = await many<{ id: string }>(t, "SELECT id FROM plans WHERE client_id = $1 ORDER BY created_at DESC", [clientId]);
    await t.query("UPDATE evidence SET file_id = NULL WHERE file_id IN (SELECT id FROM files WHERE client_id = $1)", [clientId]);
    await t.query("DELETE FROM files WHERE client_id = $1", [clientId]);
    for (const p of plans) await purgePlan(t, p.id);
    await t.query("DELETE FROM clients WHERE id = $1", [clientId]);
    await audit(t, { tenantId: s.p.tenantId, userId: s.p.userId, action: "delete", entity: "client", entityId: clientId, detail: { plans: plans.length, files: files.length } }, s.meta);
  });
}
