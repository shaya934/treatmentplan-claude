import { many, one, type Tx } from "../db";
import { SafeError } from "../logger";
import { assertCan, can } from "../rbac";
import { cloneContent, type FieldValue, type PlanContent } from "../plan/content";
import { onFieldChanged } from "../plan/consistency";
import { validatePlan, type Violation } from "../plan/validation";
import { prefill, calcDerived } from "../pipeline/prefill";
import { applyChanges, proposeEdits, type Change, type EditProposal } from "../pipeline/edit";
import { assessAnswer, questionViews, type QuestionView } from "../pipeline/guided";
import { migrateContent } from "../template/diff";
import { findField, parseTemplate, type Template } from "../template/schema";
import type { BcbaAnswer, BcbaInfo, ClientRecord, Evidence, PlanRecord, ReviewItem } from "../types";
import { log, tx, type Svc } from "./context";

/** Plans: create, load, edit, versions, guided chat, chat edits, validation, finalize. */

export interface PlanRow extends PlanRecord {
  current_version: number;
  previous_plan_id: string | null;
  progress: { skipped?: string[]; followUps?: Record<string, number>; currentQuestion?: string; generated?: Record<string, boolean>; generatedAt?: string };
  generation_status: string;
  created_at: string;
  updated_at: string;
}

export interface PlanVersionRow {
  id: string;
  version: number;
  content_json: PlanContent;
  created_by: string | null;
  created_by_name?: string | null;
  created_at: string;
  change_summary: string;
  locked: boolean;
}

export interface ReviewRow extends ReviewItem {
  id: string;
  resolved_by: string | null;
  resolved_at: string | null;
}

export async function tenantPolicy(t: Tx) {
  const r = await one<{ settings: Record<string, unknown> }>(t, "SELECT settings FROM tenants WHERE id = app_tenant()");
  return { clinicalDirectorCanFinalize: !!r?.settings?.clinical_director_can_finalize, settings: r?.settings ?? {} };
}

export async function loadTemplateVersion(t: Tx, id: string): Promise<{ id: string; version: number; template_id: string; template: Template }> {
  const r = await one<{ id: string; version: number; template_id: string; schema_json: unknown }>(t, "SELECT id, version, template_id, schema_json FROM template_versions WHERE id = $1", [id]);
  if (!r) throw new SafeError("Template not found", 404);
  return { id: r.id, version: r.version, template_id: r.template_id, template: parseTemplate(r.schema_json) };
}

export async function latestTemplateVersionId(t: Tx): Promise<string> {
  const r = await one<{ current_version_id: string }>(t, "SELECT current_version_id FROM templates WHERE tenant_id = app_tenant() AND current_version_id IS NOT NULL ORDER BY created_at LIMIT 1");
  if (!r) throw new SafeError("No published template for this company", 409);
  return r.current_version_id;
}

export async function getPlanRow(t: Tx, planId: string): Promise<PlanRow> {
  const p = await one<PlanRow>(t, "SELECT * FROM plans WHERE id = $1", [planId]);
  if (!p) throw new SafeError("Plan not found", 404);
  return p;
}

export async function getClientRow(t: Tx, clientId: string): Promise<ClientRecord & { tenant_id: string; status: string; auth_end_date: string | null }> {
  const c = await one<ClientRecord & { tenant_id: string; status: string; auth_end_date: string | null }>(t, "SELECT * FROM clients WHERE id = $1", [clientId]);
  if (!c) throw new SafeError("Client not found", 404);
  return c;
}

export async function getBcbaInfo(t: Tx, userId: string | null): Promise<BcbaInfo | null> {
  if (!userId) return null;
  return one<BcbaInfo>(t, "SELECT name, credential, npi FROM users WHERE id = $1", [userId]);
}

export async function latestVersion(t: Tx, planId: string): Promise<PlanVersionRow> {
  const v = await one<PlanVersionRow>(t, "SELECT * FROM plan_versions WHERE plan_id = $1 ORDER BY version DESC LIMIT 1", [planId]);
  if (!v) throw new SafeError("Plan has no content", 409);
  return v;
}

export async function getEvidence(t: Tx, planId: string, includeDeleted = false): Promise<Evidence[]> {
  return many<Evidence>(
    t,
    `SELECT e.*, f.filename FROM evidence e LEFT JOIN files f ON f.id = e.file_id WHERE e.plan_id = $1 ${includeDeleted ? "" : "AND NOT e.deleted"} ORDER BY f.filename NULLS LAST, e.page, e.created_at`,
    [planId],
  );
}

export async function getAnswers(t: Tx, planId: string): Promise<BcbaAnswer[]> {
  return many<BcbaAnswer>(t, "SELECT id, question_id, answer_text, input_mode, created_at, is_follow_up FROM bcba_answers WHERE plan_id = $1 ORDER BY created_at", [planId]);
}

/** Save a new immutable version. Every save is a version (spec F7). */
export async function saveVersion(t: Tx, s: Svc, planId: string, content: PlanContent, summary: string): Promise<number> {
  // Row lock serializes concurrent saves (e.g. several extraction jobs finishing together).
  const plan = await one<PlanRow>(t, "SELECT * FROM plans WHERE id = $1 FOR UPDATE", [planId]);
  if (!plan) throw new SafeError("Plan not found", 404);
  if (plan.status === "final") throw new SafeError("This plan is finalized. Start a new version with \"Reopen as new version\".", 409);
  const next = plan.current_version + 1;
  await t.query("INSERT INTO plan_versions (tenant_id, plan_id, version, content_json, created_by, change_summary) VALUES ($1,$2,$3,$4,$5,$6)", [
    plan.tenant_id,
    planId,
    next,
    JSON.stringify(content),
    s.p.userId,
    summary.slice(0, 500),
  ]);
  await t.query("UPDATE plans SET current_version = $2, updated_at = now(), status = CASE WHEN status = 'review' THEN 'draft' ELSE status END WHERE id = $1", [planId, next]);
  return next;
}

export async function assertPlanEditable(t: Tx, s: Svc, planId: string) {
  const policy = await tenantPolicy(t);
  assertCan(s.p, "plan.edit", policy);
  const plan = await getPlanRow(t, planId);
  if (plan.status === "final") throw new SafeError("This plan is finalized and locked.", 409);
  return plan;
}

// ---------------------------------------------------------------------------

export interface CreatePlanInput {
  clientId: string;
  type: "initial" | "reassessment";
  periodStart: string;
  periodEnd: string;
  templateVersionId?: string;
}

export async function createPlan(s: Svc, input: CreatePlanInput): Promise<{ id: string }> {
  return tx(s, async (t) => {
    assertCan(s.p, "plan.create", await tenantPolicy(t));
    const client = await getClientRow(t, input.clientId);
    const tvId = input.templateVersionId ?? (await latestTemplateVersionId(t));
    const { template } = await loadTemplateVersion(t, tvId);
    let previous: PlanContent | null = null;
    let previousId: string | null = null;
    if (input.type === "reassessment") {
      const prev = await one<{ id: string }>(t, "SELECT id FROM plans WHERE client_id = $1 AND status = 'final' ORDER BY final_date DESC NULLS LAST, updated_at DESC LIMIT 1", [client.id]);
      if (prev) {
        previousId = prev.id;
        const pv = await one<{ content_json: PlanContent }>(t, "SELECT content_json FROM plan_versions WHERE plan_id = $1 AND locked ORDER BY version DESC LIMIT 1", [prev.id]);
        previous = pv?.content_json ?? null;
      }
    }
    const row = await one<{ id: string }>(
      t,
      "INSERT INTO plans (tenant_id, client_id, template_version_id, type, period_start, period_end, previous_plan_id, created_by) VALUES (app_tenant(),$1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [client.id, tvId, input.type, input.periodStart, input.periodEnd, previousId, s.p.userId],
    );
    const plan = await getPlanRow(t, row!.id);
    const bcba = await getBcbaInfo(t, client.assigned_bcba_id);
    const content = prefill({ template, plan, client, bcba, evidence: [], previous });
    await t.query("INSERT INTO plan_versions (tenant_id, plan_id, version, content_json, created_by, change_summary) VALUES (app_tenant(),$1,1,$2,$3,$4)", [
      plan.id,
      JSON.stringify(content),
      s.p.userId,
      previous ? "Plan started; content carried forward from the previous finalized plan" : "Plan started",
    ]);
    await t.query("UPDATE plans SET current_version = 1 WHERE id = $1", [plan.id]);
    if (previous) {
      for (const [fid, e] of Object.entries(content)) {
        if (e.status === "carried_forward") {
          await t.query("INSERT INTO review_items (tenant_id, plan_id, field_id, kind, detail) VALUES (app_tenant(),$1,$2,'carried_forward',$3)", [plan.id, fid, "Carried forward - confirm"]);
        }
      }
    }
    await log(t, s, "create", "plan", plan.id, { type: input.type });
    return { id: plan.id };
  });
}

export interface PlanBundle {
  plan: PlanRow;
  client: ClientRecord & { status: string; auth_end_date: string | null };
  template: Template;
  templateVersion: number;
  latestTemplateVersion: number;
  version: PlanVersionRow;
  evidence: Evidence[];
  answers: BcbaAnswer[];
  review: ReviewRow[];
  files: Array<{ id: string; filename: string; mime: string; pages: number | null; extraction_status: string; uploaded_at: string; size_bytes: number; purpose: "source" | "previous_plan" }>;
  vars: Record<string, string>;
  permissions: { edit: boolean; finalize: boolean; export: boolean; reopen: boolean };
}

export async function getPlanBundle(s: Svc, planId: string): Promise<PlanBundle> {
  return tx(s, async (t) => {
    const policy = await tenantPolicy(t);
    assertCan(s.p, "plan.view", policy);
    const plan = await getPlanRow(t, planId);
    const client = await getClientRow(t, plan.client_id);
    const tv = await loadTemplateVersion(t, plan.template_version_id);
    const latest = await one<{ version: number }>(t, "SELECT tv.version FROM templates tt JOIN template_versions tv ON tv.id = tt.current_version_id WHERE tt.id = $1", [tv.template_id]);
    const version = await latestVersion(t, planId);
    const evidence = s.p.role === "read_only" ? [] : await getEvidence(t, planId);
    const answers = s.p.role === "read_only" ? [] : await getAnswers(t, planId);
    const review = await many<ReviewRow>(t, "SELECT id, field_id, kind, detail, resolved_by, resolved_at FROM review_items WHERE plan_id = $1 ORDER BY resolved_at NULLS FIRST, created_at", [planId]);
    const files = s.p.role === "read_only" ? [] : await many<PlanBundle["files"][number]>(t, "SELECT id, filename, mime, pages, extraction_status, uploaded_at, size_bytes, purpose FROM files WHERE plan_id = $1 ORDER BY uploaded_at", [planId]);
    await log(t, s, "view", "plan", planId);
    const { displayName, firstName } = await import("../types");
    const content = version.content_json;
    const vars = {
      first_name: firstName(client.name),
      full_name: displayName(client.name),
      age: String(content.age?.value ?? ""),
      gender: String(content.gender?.value ?? "").toLowerCase(),
      diagnosis: String(content.diagnosis?.value ?? ""),
      company: tv.template.branding.companyName,
    };
    const ownClient = s.p.role !== "bcba" || client.assigned_bcba_id === s.p.userId;
    return {
      plan,
      client,
      template: tv.template,
      templateVersion: tv.version,
      latestTemplateVersion: latest?.version ?? tv.version,
      version,
      evidence,
      answers,
      review,
      files,
      vars,
      permissions: {
        edit: can(s.p, "plan.edit", policy) && plan.status !== "final",
        finalize: can(s.p, "plan.finalize", policy) && ownClient && plan.status !== "final",
        export: can(s.p, "plan.export", policy),
        reopen: can(s.p, "plan.edit", policy) && ownClient && plan.status === "final",
      },
    };
  });
}

/** Direct field edits from the editor. Returns linked-field proposals from the consistency engine. */
export async function saveFieldEdits(
  s: Svc,
  planId: string,
  edits: Record<string, FieldValue>,
  summary?: string,
): Promise<{ version: number; linked: Array<{ group: string; changes: Change[]; flagged: Array<{ fieldId: string; reason: string }> }> }> {
  return tx(s, async (t) => {
    const plan = await assertPlanEditable(t, s, planId);
    const { template } = await loadTemplateVersion(t, plan.template_version_id);
    const cur = await latestVersion(t, planId);
    const before = cur.content_json;
    let next = cloneContent(before);
    const linked: Array<{ group: string; changes: Change[]; flagged: Array<{ fieldId: string; reason: string }> }> = [];
    for (const [fid, value] of Object.entries(edits)) {
      const f = findField(template, fid);
      if (!f || f.type === "static") throw new SafeError(`Unknown field ${fid}`);
      const prev = next;
      next = cloneContent(next);
      next[fid] = { value, status: "complete", sources: Array.from(new Set([...(prev[fid]?.sources ?? []), "bcba_edit"])) };
      for (const r of onFieldChanged(template, prev, next, fid)) {
        linked.push({
          group: r.group,
          changes: r.changes.map((c, i) => ({ id: `lnk_${Date.now().toString(36)}_${i}`, fieldId: c.fieldId, fieldLabel: findField(template, c.fieldId)!.label, before: c.before as FieldValue, after: c.after as FieldValue, summary: c.reason, linked: true })),
          flagged: r.flagged,
        });
      }
    }
    calcDerived(template, next);
    const labels = Object.keys(edits).map((id) => findField(template, id)?.label.split("(")[0]!.trim()).join(", ");
    const v = await saveVersion(t, s, planId, next, summary ?? `Edited ${labels}`);
    await resolvePlaceholderItems(t, planId, next);
    await log(t, s, "update", "plan", planId, { version: v, fields: Object.keys(edits).length });
    return { version: v, linked };
  });
}

/** Placeholders that no longer appear are auto-resolved in the review list. */
async function resolvePlaceholderItems(t: Tx, planId: string, content: PlanContent) {
  const open = await many<{ id: string; field_id: string; detail: string; kind: string }>(t, "SELECT id, field_id, detail, kind FROM review_items WHERE plan_id = $1 AND resolved_at IS NULL AND kind IN ('placeholder','carried_forward')", [planId]);
  for (const item of open) {
    const entry = content[item.field_id];
    const text = JSON.stringify(entry?.value ?? "");
    const gone = item.kind === "placeholder" ? !text.includes(item.detail.replace(/"/g, '\\"')) : entry?.status !== "carried_forward";
    if (gone) await t.query("UPDATE review_items SET resolved_at = now(), resolved_by = app_user() WHERE id = $1", [item.id]);
  }
}

export async function restoreVersion(s: Svc, planId: string, version: number): Promise<number> {
  return tx(s, async (t) => {
    await assertPlanEditable(t, s, planId);
    const v = await one<PlanVersionRow>(t, "SELECT * FROM plan_versions WHERE plan_id = $1 AND version = $2", [planId, version]);
    if (!v) throw new SafeError("Version not found", 404);
    const n = await saveVersion(t, s, planId, v.content_json, `Restored version ${version}`);
    await log(t, s, "restore_version", "plan", planId, { from: version, to: n });
    return n;
  });
}

export async function listVersions(s: Svc, planId: string): Promise<Omit<PlanVersionRow, "content_json">[]> {
  return tx(s, async (t) => {
    assertCan(s.p, "plan.view");
    await getPlanRow(t, planId);
    return many(t, "SELECT v.id, v.version, v.created_by, u.name AS created_by_name, v.created_at, v.change_summary, v.locked FROM plan_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.plan_id = $1 ORDER BY v.version DESC", [planId]);
  });
}

export async function getVersion(s: Svc, planId: string, version: number): Promise<PlanVersionRow> {
  return tx(s, async (t) => {
    assertCan(s.p, "plan.view");
    await getPlanRow(t, planId);
    const v = await one<PlanVersionRow>(t, "SELECT * FROM plan_versions WHERE plan_id = $1 AND version = $2", [planId, version]);
    if (!v) throw new SafeError("Version not found", 404);
    return v;
  });
}

// --------------------------- evidence ---------------------------------------

export async function updateEvidence(s: Svc, planId: string, id: string, patch: Partial<Pick<Evidence, "fact_text" | "value" | "unit" | "source_date" | "category">> & { deleted?: boolean; confirmed?: boolean }) {
  return tx(s, async (t) => {
    await assertPlanEditable(t, s, planId);
    const r = await t.query(
      `UPDATE evidence SET
        fact_text = coalesce($3, fact_text), value = CASE WHEN $4::boolean THEN $5 ELSE value END, unit = CASE WHEN $6::boolean THEN $7 ELSE unit END,
        source_date = CASE WHEN $8::boolean THEN $9::date ELSE source_date END, category = coalesce($10, category),
        deleted = coalesce($11, deleted), confirmed_by_bcba = coalesce($12, confirmed_by_bcba),
        edited_by_bcba = edited_by_bcba OR ($3 IS NOT NULL OR $4::boolean OR $6::boolean OR $8::boolean)
       WHERE id = $1 AND plan_id = $2`,
      [id, planId, patch.fact_text ?? null, "value" in patch, patch.value ?? null, "unit" in patch, patch.unit ?? null, "source_date" in patch, patch.source_date || null, patch.category ?? null, patch.deleted ?? null, patch.confirmed ?? null],
    );
    if (r.rowCount !== 1) throw new SafeError("Fact not found", 404);
    await log(t, s, patch.deleted ? "delete" : "update", "evidence", id);
  });
}

export async function addEvidence(s: Svc, planId: string, e: Pick<Evidence, "fact_text" | "category" | "value" | "unit" | "source_date">) {
  return tx(s, async (t) => {
    await assertPlanEditable(t, s, planId);
    const r = await one<{ id: string }>(t, "INSERT INTO evidence (tenant_id, plan_id, fact_text, category, value, unit, source_date, confirmed_by_bcba, edited_by_bcba) VALUES (app_tenant(),$1,$2,$3,$4,$5,$6,true,true) RETURNING id", [
      planId,
      e.fact_text,
      e.category,
      e.value,
      e.unit,
      e.source_date || null,
    ]);
    await log(t, s, "create", "evidence", r!.id);
    return r!;
  });
}

export async function confirmAllEvidence(s: Svc, planId: string) {
  return tx(s, async (t) => {
    await assertPlanEditable(t, s, planId);
    const r = await t.query("UPDATE evidence SET confirmed_by_bcba = true WHERE plan_id = $1 AND NOT deleted", [planId]);
    await log(t, s, "update", "evidence", planId, { confirmed: r.rowCount ?? 0 });
  });
}

/** Re-run pre-fill after files or facts change. BCBA-completed fields are never overwritten. */
export async function runPrefill(s: Svc | null, planId: string, t: Tx, userId?: string | null): Promise<number> {
  // Lock first so evidence committed by a concurrent job is visible to the reads below.
  await t.query("SELECT 1 FROM plans WHERE id = $1 FOR UPDATE", [planId]);
  const plan = await getPlanRow(t, planId);
  if (plan.status === "final") return plan.current_version;
  const { template } = await loadTemplateVersion(t, plan.template_version_id);
  const client = await getClientRow(t, plan.client_id);
  const bcba = await getBcbaInfo(t, client.assigned_bcba_id);
  const evidence = await getEvidence(t, planId);
  const cur = await latestVersion(t, planId);
  const content = prefill({ template, plan, client, bcba, evidence, existing: cur.content_json });
  if (JSON.stringify(content) === JSON.stringify(cur.content_json)) return cur.version;
  const fake: Svc = s ?? { p: { userId: userId ?? "", tenantId: plan.tenant_id, role: "bcba" }, meta: {} };
  return saveVersion(t, fake, planId, content, "Pre-filled from files");
}

export async function prefillPlan(s: Svc, planId: string) {
  return tx(s, async (t) => {
    await assertPlanEditable(t, s, planId);
    return runPrefill(s, planId, t);
  });
}

// --------------------------- guided chat ------------------------------------

export async function getQuestions(s: Svc, planId: string): Promise<{ questions: QuestionView[]; current: string | null }> {
  return tx(s, async (t) => {
    assertCan(s.p, "plan.view");
    const plan = await getPlanRow(t, planId);
    const { template } = await loadTemplateVersion(t, plan.template_version_id);
    const v = await latestVersion(t, planId);
    const qs = questionViews(template, v.content_json, await getEvidence(t, planId), await getAnswers(t, planId), plan.progress.skipped ?? []);
    const current = plan.progress.currentQuestion ?? qs.find((q) => q.status === "open" || q.status === "partial")?.id ?? null;
    return { questions: qs, current };
  });
}

export async function answerQuestion(
  s: Svc,
  planId: string,
  questionId: string,
  text: string,
  mode: "typed" | "voice",
): Promise<{ complete: boolean; followUp: string | null; next: string | null }> {
  const { qv, followUps, ctxTenant, complex } = await tx(s, async (t) => {
    const plan = await assertPlanEditable(t, s, planId);
    const { template } = await loadTemplateVersion(t, plan.template_version_id);
    const v = await latestVersion(t, planId);
    const qs = questionViews(template, v.content_json, await getEvidence(t, planId), await getAnswers(t, planId), plan.progress.skipped ?? []);
    const qv = qs.find((q) => q.id === questionId);
    if (!qv) throw new SafeError("Unknown question", 404);
    const followUps = plan.progress.followUps?.[questionId] ?? 0;
    await t.query("INSERT INTO bcba_answers (tenant_id, plan_id, question_id, answer_text, input_mode, is_follow_up, created_by) VALUES (app_tenant(),$1,$2,$3,$4,$5,$6)", [
      planId,
      questionId,
      text,
      mode,
      followUps > 0,
      s.p.userId,
    ]);
    await log(t, s, "create", "bcba_answer", planId, { question: questionId, mode });
    return { qv, followUps, ctxTenant: plan.tenant_id, complex: plan.complex_case };
  });

  // AI call outside the DB transaction.
  const all = await tx(s, (t) => getAnswers(t, planId));
  const combined = all.filter((a) => a.question_id === questionId).map((a) => a.answer_text).join("\n");
  const res = await assessAnswer({ tenantId: ctxTenant, planId, complexCase: complex }, qv, qv.known, combined, followUps);

  return tx(s, async (t) => {
    const plan = await getPlanRow(t, planId);
    const progress = { ...plan.progress, followUps: { ...(plan.progress.followUps ?? {}) } };
    let next: string | null = questionId;
    if (!res.complete && res.follow_up) {
      progress.followUps![questionId] = followUps + 1;
      await t.query("INSERT INTO chat_messages (tenant_id, plan_id, channel, role, content, metadata) VALUES (app_tenant(),$1,'guided','assistant',$2,$3)", [planId, res.follow_up, JSON.stringify({ questionId })]);
    } else {
      const { template } = await loadTemplateVersion(t, plan.template_version_id);
      const v = await latestVersion(t, planId);
      const qs = questionViews(template, v.content_json, await getEvidence(t, planId), await getAnswers(t, planId), plan.progress.skipped ?? []);
      const idx = qs.findIndex((q) => q.id === questionId);
      next = qs.slice(idx + 1).find((q) => q.status === "open" || q.status === "partial")?.id ?? qs.find((q) => q.status === "open" || q.status === "partial")?.id ?? null;
    }
    progress.currentQuestion = next ?? undefined;
    await t.query("UPDATE plans SET progress = $2, updated_at = now() WHERE id = $1", [planId, JSON.stringify(progress)]);
    return { complete: res.complete, followUp: res.complete ? null : (res.follow_up ?? null), next };
  });
}

export async function setCurrentQuestion(s: Svc, planId: string, questionId: string, skip = false) {
  return tx(s, async (t) => {
    const plan = await assertPlanEditable(t, s, planId);
    const progress = { ...plan.progress };
    if (skip) {
      progress.skipped = Array.from(new Set([...(progress.skipped ?? []), questionId]));
      const { template } = await loadTemplateVersion(t, plan.template_version_id);
      const v = await latestVersion(t, planId);
      const qs = questionViews(template, v.content_json, await getEvidence(t, planId), await getAnswers(t, planId), progress.skipped);
      const idx = qs.findIndex((q) => q.id === questionId);
      progress.currentQuestion = qs.slice(idx + 1).find((q) => q.status === "open" || q.status === "partial")?.id;
    } else progress.currentQuestion = questionId;
    await t.query("UPDATE plans SET progress = $2 WHERE id = $1", [planId, JSON.stringify(progress)]);
    return progress.currentQuestion ?? null;
  });
}

export async function getGuidedMessages(s: Svc, planId: string) {
  return tx(s, async (t) => {
    await getPlanRow(t, planId);
    return many<{ content: string; metadata: { questionId?: string }; created_at: string }>(t, "SELECT content, metadata, created_at FROM chat_messages WHERE plan_id = $1 AND channel = 'guided' ORDER BY created_at", [planId]);
  });
}

// --------------------------- chat edits -------------------------------------

export async function chatEdit(s: Svc, planId: string, request: string, mode: "typed" | "voice" = "typed"): Promise<EditProposal & { messageId: string }> {
  const { template, content, tenantId, complex } = await tx(s, async (t) => {
    const plan = await assertPlanEditable(t, s, planId);
    const { template } = await loadTemplateVersion(t, plan.template_version_id);
    const v = await latestVersion(t, planId);
    await t.query("INSERT INTO chat_messages (tenant_id, plan_id, channel, role, content, metadata, created_by) VALUES (app_tenant(),$1,'edit','user',$2,$3,$4)", [planId, request, JSON.stringify({ mode }), s.p.userId]);
    return { template, content: v.content_json, tenantId: plan.tenant_id, complex: plan.complex_case };
  });
  const proposal = await proposeEdits({ tenantId, planId, complexCase: complex }, template, content, request);
  return tx(s, async (t) => {
    const m = await one<{ id: string }>(t, "INSERT INTO chat_messages (tenant_id, plan_id, channel, role, content, metadata) VALUES (app_tenant(),$1,'edit','assistant',$2,$3) RETURNING id", [
      planId,
      proposal.message,
      JSON.stringify({ proposal, decided: {} }),
    ]);
    await log(t, s, "chat_edit", "plan", planId, { changes: proposal.changes.length });
    return { ...proposal, messageId: m!.id };
  });
}

export async function getEditMessages(s: Svc, planId: string) {
  return tx(s, async (t) => {
    await getPlanRow(t, planId);
    return many<{ id: string; role: string; content: string; metadata: Record<string, unknown>; created_at: string }>(t, "SELECT id, role, content, metadata, created_at FROM chat_messages WHERE plan_id = $1 AND channel = 'edit' ORDER BY created_at", [planId]);
  });
}

/** Accept or reject each proposed change. Accepted changes become one new version. */
export async function decideChanges(s: Svc, planId: string, messageId: string, accept: string[], reject: string[]): Promise<{ version: number | null }> {
  return tx(s, async (t) => {
    await assertPlanEditable(t, s, planId);
    const m = await one<{ metadata: { proposal: EditProposal; decided: Record<string, "accepted" | "rejected"> } }>(t, "SELECT metadata FROM chat_messages WHERE id = $1 AND plan_id = $2", [messageId, planId]);
    if (!m) throw new SafeError("Proposal not found", 404);
    const decided = { ...(m.metadata.decided ?? {}) };
    const toApply = m.metadata.proposal.changes.filter((c) => accept.includes(c.id) && !decided[c.id]);
    for (const id of accept) decided[id] = "accepted";
    for (const id of reject) decided[id] = "rejected";
    // chat_messages are insert-only for the app; decisions are recorded as a follow-up system message.
    await t.query("INSERT INTO chat_messages (tenant_id, plan_id, channel, role, content, metadata) VALUES (app_tenant(),$1,'edit','system',$2,$3)", [
      planId,
      `${toApply.length} change(s) accepted, ${reject.length} rejected`,
      JSON.stringify({ decisionFor: messageId, decided }),
    ]);
    let version: number | null = null;
    if (toApply.length) {
      const plan = await getPlanRow(t, planId);
      const { template } = await loadTemplateVersion(t, plan.template_version_id);
      const cur = await latestVersion(t, planId);
      const next = applyChanges(cur.content_json, toApply);
      calcDerived(template, next);
      version = await saveVersion(t, s, planId, next, `Chat edit: ${toApply.map((c) => c.summary).join("; ").slice(0, 300)}`);
      await resolvePlaceholderItems(t, planId, next);
    }
    await log(t, s, "accept_change", "plan", planId, { accepted: toApply.length, rejected: reject.length });
    return { version };
  });
}

// --------------------------- review / validation / finalize -----------------

export async function resolveReviewItem(s: Svc, planId: string, itemId: string, resolved = true) {
  return tx(s, async (t) => {
    await assertPlanEditable(t, s, planId);
    await t.query(resolved ? "UPDATE review_items SET resolved_at = now(), resolved_by = app_user() WHERE id = $1 AND plan_id = $2" : "UPDATE review_items SET resolved_at = NULL, resolved_by = NULL WHERE id = $1 AND plan_id = $2", [itemId, planId]);
    await log(t, s, "update", "review_item", itemId, { resolved });
  });
}

export async function validate(s: Svc, planId: string): Promise<{ violations: Violation[]; openReview: number }> {
  return tx(s, async (t) => {
    assertCan(s.p, "plan.view");
    const plan = await getPlanRow(t, planId);
    const { template } = await loadTemplateVersion(t, plan.template_version_id);
    const v = await latestVersion(t, planId);
    const violations = validatePlan(template, v.content_json, { periodStart: plan.period_start, periodEnd: plan.period_end, planDate: plan.period_start });
    const open = await one<{ n: string }>(t, "SELECT count(*) AS n FROM review_items WHERE plan_id = $1 AND resolved_at IS NULL AND kind IN ('conflict','carried_forward','mismatch','unsupported','needs_ocr')", [planId]);
    const n = Number(open?.n ?? 0);
    if (n > 0) violations.push({ ruleId: "review_list", message: `${n} review item(s) still need a decision (conflicts, carried-forward content, mismatches)`, severity: "error" });
    if (plan.status === "draft" && violations.length === 0) await t.query("UPDATE plans SET status = 'review' WHERE id = $1", [planId]);
    return { violations, openReview: n };
  });
}

export async function finalize(s: Svc, planId: string, today = new Date().toISOString().slice(0, 10)): Promise<{ version: number }> {
  const { violations } = await validate(s, planId);
  if (violations.some((v) => v.severity === "error")) throw new SafeError(`This plan cannot be finalized yet: ${violations.length} check(s) failing.`, 422);
  return tx(s, async (t) => {
    const policy = await tenantPolicy(t);
    assertCan(s.p, "plan.finalize", policy);
    const plan = await getPlanRow(t, planId);
    const client = await getClientRow(t, plan.client_id);
    if (s.p.role === "bcba" && client.assigned_bcba_id !== s.p.userId) throw new SafeError("Only the assigned BCBA can finalize this plan.", 403);
    if (plan.status === "final") throw new SafeError("Already finalized", 409);
    const { template } = await loadTemplateVersion(t, plan.template_version_id);
    const cur = await latestVersion(t, planId);
    const content = cloneContent(cur.content_json);
    const us = `${Number(today.slice(5, 7))}/${Number(today.slice(8, 10))}/${today.slice(0, 4)}`;
    if (findField(template, "plan_final_date")) content.plan_final_date = { value: us, status: "calculated", sources: ["plan_record"] };
    const next = plan.current_version + 1;
    await t.query("INSERT INTO plan_versions (tenant_id, plan_id, version, content_json, created_by, change_summary, locked) VALUES (app_tenant(),$1,$2,$3,$4,$5,true)", [
      planId,
      next,
      JSON.stringify(content),
      s.p.userId,
      `Finalized ${us}`,
    ]);
    await t.query("UPDATE plans SET status = 'final', final_date = $2, current_version = $3, updated_at = now() WHERE id = $1", [planId, today, next]);
    if (plan.period_end) await t.query("UPDATE clients SET auth_end_date = $2 WHERE id = $1", [plan.client_id, plan.period_end]);
    await log(t, s, "finalize", "plan", planId, { version: next });
    return { version: next };
  });
}

/** Later edits to a finalized plan create a new draft version on top of the locked one. */
export async function reopen(s: Svc, planId: string): Promise<{ version: number }> {
  return tx(s, async (t) => {
    assertCan(s.p, "plan.edit", await tenantPolicy(t));
    const plan = await getPlanRow(t, planId);
    if (plan.status !== "final") throw new SafeError("Plan is not finalized", 409);
    const cur = await latestVersion(t, planId);
    await t.query("UPDATE plans SET status = 'draft', updated_at = now() WHERE id = $1", [planId]);
    const v = await saveVersion(t, s, planId, cur.content_json, `Reopened after finalization (v${cur.version} stays locked)`);
    await log(t, s, "update", "plan", planId, { reopened: true });
    return { version: v };
  });
}

/** Move an in-progress draft to the latest template version, migrating matching fields. */
export async function updateToLatestTemplate(s: Svc, planId: string): Promise<{ version: number; dropped: string[]; added: string[] }> {
  return tx(s, async (t) => {
    const plan = await assertPlanEditable(t, s, planId);
    const tv = await loadTemplateVersion(t, plan.template_version_id);
    const latest = await one<{ current_version_id: string }>(t, "SELECT current_version_id FROM templates WHERE id = $1", [tv.template_id]);
    if (!latest || latest.current_version_id === plan.template_version_id) throw new SafeError("Already on the latest template", 409);
    const to = await loadTemplateVersion(t, latest.current_version_id);
    const cur = await latestVersion(t, planId);
    const m = migrateContent(cur.content_json, to.template);
    await t.query("UPDATE plans SET template_version_id = $2 WHERE id = $1", [planId, to.id]);
    const v = await saveVersion(t, s, planId, m.content, `Updated to template v${to.version} (${m.added.length} new field(s), ${m.dropped.length} removed)`);
    await log(t, s, "update", "plan", planId, { template_version: to.version });
    return { version: v, ...m };
  });
}

export async function setComplexCase(s: Svc, planId: string, on: boolean) {
  return tx(s, async (t) => {
    if (s.p.role !== "company_admin") throw new SafeError("Only a company admin can change the model setting.", 403);
    await t.query("UPDATE plans SET complex_case = $2 WHERE id = $1", [planId, on]);
    await log(t, s, "update", "plan", planId, { complex_case: on });
  });
}
