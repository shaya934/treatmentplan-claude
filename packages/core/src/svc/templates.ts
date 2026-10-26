import { randomUUID } from "node:crypto";
import { many, one, type Tx } from "../db";
import { SafeError } from "../logger";
import { assertCan } from "../rbac";
import { emptyContent, type PlanContent } from "../plan/content";
import { importDocxTemplate, proposeTemplateDiff, type TemplateProposal } from "../pipeline/template-chat";
import { parseTemplate, type Template } from "../template/schema";
import { storage } from "../storage";
import { log, tx, type Svc } from "./context";

/** Admin template chatbot, versions, publish and rollback (spec F10). */

async function currentTemplate(t: Tx) {
  const r = await one<{ id: string; name: string; current_version_id: string; docx_s3_key: string | null; version: number; schema_json: unknown }>(
    t,
    "SELECT tt.id, tt.name, tt.current_version_id, tt.docx_s3_key, tv.version, tv.schema_json FROM templates tt JOIN template_versions tv ON tv.id = tt.current_version_id WHERE tt.tenant_id = app_tenant() ORDER BY tt.created_at LIMIT 1",
  );
  if (!r) throw new SafeError("No template", 404);
  return { ...r, template: parseTemplate(r.schema_json) };
}

export async function getCurrentTemplate(s: Svc) {
  return tx(s, async (t) => {
    assertCan(s.p, "template.view");
    const c = await currentTemplate(t);
    const versions = await many(
      t,
      "SELECT v.id, v.version, v.status, v.published_at, v.change_reason, v.compliance_override, u.name AS published_by_name FROM template_versions v LEFT JOIN users u ON u.id = v.published_by WHERE v.template_id = $1 ORDER BY v.version DESC",
      [c.id],
    );
    const drafts = await many<{ id: string; version: number; schema_json: unknown; change_reason: string | null; created_at: string }>(
      t,
      "SELECT id, version, schema_json, change_reason, created_at FROM template_versions WHERE template_id = $1 AND status = 'draft' ORDER BY version DESC LIMIT 1",
      [c.id],
    );
    return { templateId: c.id, name: c.name, version: c.version, versionId: c.current_version_id, template: c.template, versions, hasWordTemplate: !!c.docx_s3_key, draft: drafts[0] ?? null };
  });
}

export async function getTemplateVersion(s: Svc, versionId: string): Promise<Template> {
  return tx(s, async (t) => {
    assertCan(s.p, "template.view");
    const r = await one<{ schema_json: unknown }>(t, "SELECT schema_json FROM template_versions WHERE id = $1", [versionId]);
    if (!r) throw new SafeError("Not found", 404);
    return parseTemplate(r.schema_json);
  });
}

/** Admin chat: plain-language request -> structured diff + preview. Nothing changes until publish. */
export async function templateChat(
  s: Svc,
  request: string,
  opts: { baseVersionId?: string; baseTemplate?: unknown } = {},
): Promise<TemplateProposal & { messageId: string; baseVersionId: string }> {
  const { base, templateId, baseId } = await tx(s, async (t) => {
    assertCan(s.p, "template.edit");
    const c = await currentTemplate(t);
    const baseId = opts.baseVersionId ?? c.current_version_id;
    const b = await one<{ schema_json: unknown }>(t, "SELECT schema_json FROM template_versions WHERE id = $1 AND template_id = $2", [baseId, c.id]);
    if (!b) throw new SafeError("Base version not found", 404);
    await t.query("INSERT INTO chat_messages (tenant_id, template_id, channel, role, content, created_by) VALUES (app_tenant(),$1,'template','user',$2,$3)", [c.id, request, s.p.userId]);
    // An unpublished working draft (several chat changes before one publish) can be the base.
    return { base: opts.baseTemplate ? parseTemplate(opts.baseTemplate) : parseTemplate(b.schema_json), templateId: c.id, baseId };
  });
  const proposal = await proposeTemplateDiff({ tenantId: s.p.tenantId! }, base, request);
  return tx(s, async (t) => {
    const m = await one<{ id: string }>(t, "INSERT INTO chat_messages (tenant_id, template_id, channel, role, content, metadata) VALUES (app_tenant(),$1,'template','assistant',$2,$3) RETURNING id", [
      templateId,
      proposal.summary,
      JSON.stringify({ ops: proposal.ops, warnings: proposal.warnings, changedSections: proposal.changedSections, baseVersionId: baseId }),
    ]);
    await log(t, s, "template_draft", "template", templateId, { ops: proposal.ops.length });
    return { ...proposal, messageId: m!.id, baseVersionId: baseId };
  });
}

export async function templateMessages(s: Svc) {
  return tx(s, async (t) => {
    assertCan(s.p, "template.edit");
    const c = await currentTemplate(t);
    return many(t, "SELECT id, role, content, metadata, created_at FROM chat_messages WHERE template_id = $1 AND channel = 'template' ORDER BY created_at DESC LIMIT 50", [c.id]);
  });
}

/**
 * Publish a new template version. A compliance warning (removing/loosening a
 * ccp8f_required field or rule) requires the admin to type a reason.
 */
export async function publishTemplate(s: Svc, input: { template: Template; changeReason: string; complianceReason?: string; warnings?: Array<{ message: string }> }) {
  const template = parseTemplate(input.template);
  if (!input.changeReason?.trim()) throw new SafeError("Describe the change before publishing.");
  if (input.warnings?.length && !input.complianceReason?.trim()) throw new SafeError("This change loosens a CCP 8F requirement. Type a reason to continue.", 422);
  return tx(s, async (t) => {
    assertCan(s.p, "template.edit");
    const c = await currentTemplate(t);
    // Re-check compliance server-side; never trust the client's warning list.
    const server = complianceDelta(c.template, template);
    if (server.length && !input.complianceReason?.trim()) throw new SafeError(`Compliance guard: ${server[0]} Type a reason to continue.`, 422);
    const max = await one<{ v: number }>(t, "SELECT max(version) AS v FROM template_versions WHERE template_id = $1", [c.id]);
    const id = randomUUID();
    await t.query(
      "INSERT INTO template_versions (id, tenant_id, template_id, version, status, schema_json, published_by, published_at, change_reason, compliance_override) VALUES ($1, app_tenant(), $2, $3, 'published', $4, $5, now(), $6, $7)",
      [id, c.id, (max?.v ?? 0) + 1, JSON.stringify(template), s.p.userId, input.changeReason.trim(), server.length ? input.complianceReason!.trim() : null],
    );
    await t.query("UPDATE templates SET current_version_id = $2, name = $3 WHERE id = $1", [c.id, id, template.name]);
    await log(t, s, "template_publish", "template", c.id, { version: (max?.v ?? 0) + 1, compliance_override: server.length > 0 });
    return { versionId: id, version: (max?.v ?? 0) + 1 };
  });
}

/** Compare two templates for ccp8f_required fields removed or loosened, or CCP rules removed/lowered. */
export function complianceDelta(before: Template, after: Template): string[] {
  const out: string[] = [];
  const afterFields = new Map(after.sections.flatMap((s) => s.fields).map((f) => [f.id, f]));
  for (const f of before.sections.flatMap((s) => s.fields)) {
    if (!f.tags.includes("ccp8f_required")) continue;
    const a = afterFields.get(f.id);
    if (!a) out.push(`"${f.label}" (ccp8f_required) is removed.`);
    else if (f.required && !a.required) out.push(`"${f.label}" (ccp8f_required) is made optional.`);
    else if (!a.tags.includes("ccp8f_required")) out.push(`"${f.label}" loses its ccp8f_required tag.`);
  }
  const afterRules = new Map(after.rules.map((r) => [r.id, r]));
  for (const r of before.rules) {
    const a = afterRules.get(r.id);
    if (!a) out.push(`Validation rule "${r.id}" is removed.`);
    else if ("min" in r && "min" in a && (a as { min: number }).min < (r as { min: number }).min) out.push(`Rule "${r.id}" minimum is lowered.`);
  }
  return out;
}

export async function rollbackTemplate(s: Svc, versionId: string, reason: string) {
  return tx(s, async (t) => {
    assertCan(s.p, "template.edit");
    const c = await currentTemplate(t);
    const v = await one<{ schema_json: unknown; version: number }>(t, "SELECT schema_json, version FROM template_versions WHERE id = $1 AND template_id = $2 AND status = 'published'", [versionId, c.id]);
    if (!v) throw new SafeError("Version not found", 404);
    await t.query("UPDATE templates SET current_version_id = $2 WHERE id = $1", [c.id, versionId]);
    await log(t, s, "template_rollback", "template", c.id, { to_version: v.version, reason: reason.slice(0, 200) });
    return { version: v.version };
  });
}

/** Upload a company Word template (.docx) used for export, or convert one into a structured draft. */
export async function uploadWordTemplate(s: Svc, bytes: Buffer, mode: "export" | "convert") {
  if (bytes.length > 20 * 1024 * 1024) throw new SafeError("Template files must be under 20 MB.");
  if (mode === "convert") {
    const branding = await tx(s, async (t) => {
      assertCan(s.p, "template.edit");
      return (await currentTemplate(t)).template.branding;
    });
    const draft = await importDocxTemplate({ tenantId: s.p.tenantId! }, bytes, branding);
    return { draft };
  }
  const key = `tenants/${s.p.tenantId}/templates/word-${randomUUID()}.docx`;
  await storage().put(key, bytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  await tx(s, async (t) => {
    assertCan(s.p, "template.edit");
    const c = await currentTemplate(t);
    await t.query("UPDATE templates SET docx_s3_key = $2 WHERE id = $1", [c.id, key]);
    await log(t, s, "template_publish", "template", c.id, { word_template: true });
  });
  return { draft: null };
}

/** Sample rendered page for the preview: the changed sections with empty sample values. */
export function sampleContent(t: Template): PlanContent {
  return emptyContent(t);
}
