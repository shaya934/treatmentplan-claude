import { setUsageSink } from "../ai/client";
import { audit, type AuditAction, type RequestMeta } from "../audit";
import { getPool, withCtx, type DbCtx, type Tx } from "../db";
import type { Principal } from "../rbac";

/** Request-scoped service context: who is acting, and request metadata for the audit log. */
export interface Svc {
  p: Principal;
  meta: RequestMeta;
}

export function dbCtx(p: Principal): DbCtx {
  return { tenantId: p.tenantId, userId: p.userId, role: p.role };
}

export function tx<T>(s: Svc, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withCtx(dbCtx(s.p), fn);
}

export function sysTx<T>(tenantId: string, userId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withCtx({ tenantId, userId, role: "system" }, fn);
}

export async function log(t: Tx, s: Svc, action: AuditAction, entity: string, entityId?: string | null, detail?: Record<string, string | number | boolean | null>) {
  await audit(t, { tenantId: s.p.tenantId, userId: s.p.userId, action, entity, entityId, detail }, s.meta);
}

let sinkInstalled = false;
/** Persist AI usage (tokens, model, est. cost) for the cost dashboard. Never stores prompt text. */
export function installUsageSink() {
  if (sinkInstalled) return;
  sinkInstalled = true;
  setUsageSink(async (u) => {
    // Platform-level calls (e.g. converting the standard template) belong to no company;
    // they are still in the ai_call log line, just not on a company's cost dashboard.
    if (!u.tenantId) return;
    const c = await getPool().connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.role', 'system', true)", [u.tenantId]);
      await c.query("INSERT INTO ai_usage (tenant_id, plan_id, step, model, input_tokens, output_tokens, est_cost, latency_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [
        u.tenantId,
        u.planId ?? null,
        u.step,
        u.model,
        u.inputTokens,
        u.outputTokens,
        u.estCost,
        u.latencyMs,
      ]);
      await c.query("COMMIT");
    } catch {
      await c.query("ROLLBACK").catch(() => {});
    } finally {
      c.release();
    }
  });
}
