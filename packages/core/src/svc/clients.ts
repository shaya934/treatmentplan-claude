import { many, one } from "../db";
import { SafeError } from "../logger";
import { assertCan } from "../rbac";
import { log, tx, type Svc } from "./context";

/** Clients (spec F1). BCBAs see only clients assigned to them (enforced by RLS). */

export interface ClientInput {
  name: string;
  dob: string | null;
  gender?: string | null;
  medicaidId: string | null;
  payer: string | null;
  diagnosis: string | null;
  assignedBcbaId: string | null;
}

export interface ClientListRow {
  id: string;
  name: string;
  dob: string | null;
  payer: string | null;
  assigned_bcba_id: string | null;
  bcba_name: string | null;
  status: string;
  auth_end_date: string | null;
  latest_plan_id: string | null;
  latest_plan_status: string | null;
  latest_plan_type: string | null;
}

export async function listClients(s: Svc): Promise<ClientListRow[]> {
  return tx(s, async (t) => {
    assertCan(s.p, "client.view");
    const rows = await many<ClientListRow>(
      t,
      `SELECT c.id, c.name, c.dob, c.payer, c.assigned_bcba_id, u.name AS bcba_name, c.status, c.auth_end_date,
              lp.id AS latest_plan_id, lp.status AS latest_plan_status, lp.type AS latest_plan_type
         FROM clients c
         LEFT JOIN users u ON u.id = c.assigned_bcba_id
         LEFT JOIN LATERAL (SELECT id, status, type FROM plans p WHERE p.client_id = c.id ORDER BY created_at DESC LIMIT 1) lp ON true
        WHERE c.status <> 'archived'
        ORDER BY c.name`,
    );
    await log(t, s, "view", "client_list", null, { count: rows.length });
    return rows;
  });
}

export async function getClient(s: Svc, id: string) {
  return tx(s, async (t) => {
    assertCan(s.p, "client.view");
    const c = await one(t, "SELECT c.*, u.name AS bcba_name FROM clients c LEFT JOIN users u ON u.id = c.assigned_bcba_id WHERE c.id = $1", [id]);
    if (!c) throw new SafeError("Client not found", 404);
    const plans = await many(t, "SELECT id, type, status, period_start, period_end, final_date, current_version, created_at FROM plans WHERE client_id = $1 ORDER BY created_at DESC", [id]);
    await log(t, s, "view", "client", id);
    return { client: c, plans };
  });
}

function check(input: ClientInput) {
  if (!input.name?.trim()) throw new SafeError("Name is required");
  if (input.dob && !/^\d{4}-\d{2}-\d{2}$/.test(input.dob)) throw new SafeError("Date of birth must be YYYY-MM-DD");
}

export async function createClient(s: Svc, input: ClientInput): Promise<{ id: string }> {
  check(input);
  return tx(s, async (t) => {
    assertCan(s.p, "client.create");
    const assigned = s.p.role === "bcba" ? s.p.userId : input.assignedBcbaId;
    if (assigned) {
      const b = await one<{ role: string }>(t, "SELECT role FROM users WHERE id = $1 AND tenant_id = app_tenant() AND active", [assigned]);
      if (!b || !["bcba", "clinical_director", "company_admin"].includes(b.role)) throw new SafeError("Assigned BCBA not found");
    }
    const r = await one<{ id: string }>(
      t,
      "INSERT INTO clients (tenant_id, name, dob, gender, medicaid_id, payer, diagnosis, assigned_bcba_id) VALUES (app_tenant(),$1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [input.name.trim(), input.dob || null, input.gender ?? null, input.medicaidId, input.payer, input.diagnosis, assigned],
    );
    await log(t, s, "create", "client", r!.id);
    return r!;
  });
}

export async function updateClient(s: Svc, id: string, input: Partial<ClientInput>) {
  return tx(s, async (t) => {
    assertCan(s.p, "client.create");
    if ("assignedBcbaId" in input && s.p.role === "bcba") throw new SafeError("Only an admin or clinical director can reassign clients.", 403);
    const r = await t.query(
      `UPDATE clients SET name = coalesce($2, name), dob = coalesce($3::date, dob), gender = coalesce($4, gender), medicaid_id = coalesce($5, medicaid_id),
              payer = coalesce($6, payer), diagnosis = coalesce($7, diagnosis) WHERE id = $1`,
      [id, input.name ?? null, input.dob ?? null, input.gender ?? null, input.medicaidId ?? null, input.payer ?? null, input.diagnosis ?? null],
    );
    if (r.rowCount !== 1) throw new SafeError("Client not found", 404);
    await log(t, s, "update", "client", id);
  });
}

export async function reassignClient(s: Svc, id: string, bcbaId: string) {
  return tx(s, async (t) => {
    assertCan(s.p, "client.reassign");
    const b = await one(t, "SELECT id FROM users WHERE id = $1 AND tenant_id = app_tenant() AND active AND role IN ('bcba','clinical_director','company_admin')", [bcbaId]);
    if (!b) throw new SafeError("BCBA not found");
    const r = await t.query("UPDATE clients SET assigned_bcba_id = $2 WHERE id = $1", [id, bcbaId]);
    if (r.rowCount !== 1) throw new SafeError("Client not found", 404);
    await log(t, s, "update", "client", id, { reassigned: true });
  });
}

export async function listBcbas(s: Svc) {
  return tx(s, (t) => many<{ id: string; name: string; credential: string | null }>(t, "SELECT id, name, credential FROM users WHERE tenant_id = app_tenant() AND active AND role IN ('bcba','clinical_director') ORDER BY name"));
}
