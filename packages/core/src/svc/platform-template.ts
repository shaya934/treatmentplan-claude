import { randomUUID } from "node:crypto";
import { audit } from "../audit";
import { one, withCtx, type Tx } from "../db";
import { SafeError } from "../logger";
import { assertCan } from "../rbac";
import { importDocxTemplate } from "../pipeline/template-chat";
import { parseTemplate, type Template } from "../template/schema";
import { WE_ACHIEVE_FORM_TEMPLATE as BUILT_IN } from "../template/we-achieve-form";
import type { Svc } from "./context";

/**
 * The platform standard template (platform owner only): the template every newly
 * onboarded company gets a copy of. Existing companies keep their own copies.
 */

export interface PlatformTemplateInfo {
  template: Template;
  version: number | null;
  builtIn: boolean;
  publishedAt: string | null;
  changeReason: string | null;
}

const ownerCtx = (s: Svc) => ({ tenantId: null, userId: s.p.userId, role: "super_admin" as const });

/** The standard a new company starts from: the newest published version, else the built-in template. */
export async function standardTemplate(t: Tx): Promise<PlatformTemplateInfo> {
  const r = await one<{ version: number; schema_json: unknown; published_at: string; change_reason: string }>(
    t,
    "SELECT version, schema_json, published_at, change_reason FROM platform_templates ORDER BY version DESC LIMIT 1",
  );
  if (!r) return { template: BUILT_IN, version: null, builtIn: true, publishedAt: null, changeReason: null };
  return { template: parseTemplate(r.schema_json), version: r.version, builtIn: false, publishedAt: r.published_at, changeReason: r.change_reason };
}

export async function getPlatformTemplate(s: Svc): Promise<PlatformTemplateInfo> {
  assertCan(s.p, "tenant.manage");
  return withCtx(ownerCtx(s), standardTemplate);
}

/** Convert an uploaded Word template into a draft standard. Nothing is saved until publish. */
export async function convertPlatformTemplate(s: Svc, bytes: Buffer): Promise<{ draft: Template }> {
  assertCan(s.p, "tenant.manage");
  if (bytes.length > 20 * 1024 * 1024) throw new SafeError("Template files must be under 20 MB.");
  const branding = (await getPlatformTemplate(s)).template.branding;
  const draft = await importDocxTemplate({ tenantId: "" }, bytes, branding);
  return { draft: { ...draft, name: "Platform standard template" } };
}

/**
 * Give an existing company the current standard as a new version of its template
 * (audited in its log, revertible from its version history). The company keeps its own
 * name and footer; plans already started keep their template version.
 */
export async function applyStandardToTenant(s: Svc, tenantId: string): Promise<{ version: number }> {
  assertCan(s.p, "tenant.manage");
  const std = (await getPlatformTemplate(s)).template;
  return withCtx({ tenantId, userId: s.p.userId, role: "system" }, async (t) => {
    const cur = await one<{ id: string; schema_json: unknown }>(
      t,
      "SELECT tt.id, tv.schema_json FROM templates tt JOIN template_versions tv ON tv.id = tt.current_version_id WHERE tt.tenant_id = $1 ORDER BY tt.created_at LIMIT 1",
      [tenantId],
    );
    if (!cur) throw new SafeError("That company has no template yet.", 404);
    const old = parseTemplate(cur.schema_json).branding;
    const template = { ...std, branding: { ...std.branding, companyName: old.companyName, footer: old.footer || std.branding.footer } };
    const max = await one<{ v: number }>(t, "SELECT max(version) AS v FROM template_versions WHERE template_id = $1", [cur.id]);
    const version = (max?.v ?? 0) + 1;
    const id = randomUUID();
    await t.query(
      "INSERT INTO template_versions (id, tenant_id, template_id, version, status, schema_json, published_by, published_at, change_reason) VALUES ($1, $2, $3, $4, 'published', $5, $6, now(), $7)",
      [id, tenantId, cur.id, version, JSON.stringify(template), s.p.userId, "Platform standard template applied by the platform owner"],
    );
    await t.query("UPDATE templates SET current_version_id = $2, name = $3 WHERE id = $1", [cur.id, id, template.name]);
    await audit(t, { tenantId, userId: s.p.userId, action: "template_publish", entity: "template", entityId: cur.id, detail: { version, platform_standard: true } }, s.meta);
    return { version };
  });
}

export async function publishPlatformTemplate(s: Svc, input: { template: unknown; changeReason: string } | { builtIn: true; changeReason: string }): Promise<{ version: number }> {
  assertCan(s.p, "tenant.manage");
  const reason = input.changeReason.trim();
  if (!reason) throw new SafeError("Describe the change before publishing.");
  const template = "builtIn" in input ? BUILT_IN : parseTemplate(input.template);
  if (!template.sections.some((sec) => sec.fields.some((f) => f.type !== "static"))) throw new SafeError("The template has no fields to fill.");
  return withCtx(ownerCtx(s), async (t) => {
    const next = ((await one<{ v: number | null }>(t, "SELECT max(version) AS v FROM platform_templates"))?.v ?? 0) + 1;
    await t.query("INSERT INTO platform_templates (version, schema_json, change_reason, published_by) VALUES ($1, $2, $3, $4)", [next, JSON.stringify(template), reason.slice(0, 500), s.p.userId]);
    await audit(t, { tenantId: null, userId: s.p.userId, action: "template_publish", entity: "platform_template", entityId: null, detail: { version: next, builtIn: "builtIn" in input } }, s.meta);
    return { version: next };
  });
}
