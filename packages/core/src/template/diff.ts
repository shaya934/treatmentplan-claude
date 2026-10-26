import type { TemplateOp } from "../ai/schemas";
import { cloneContent, emptyContent, type PlanContent } from "../plan/content";
import { CCP8F_TAG, Field, Rule, Section, allFields, parseTemplate, type Template } from "./schema";

/**
 * Structured template diffs (spec F10): apply ops to a template, report what
 * changed for the preview, and run the compliance guard on ccp8f_required fields.
 */

export interface ComplianceWarning {
  fieldId?: string;
  ruleId?: string;
  message: string;
}

export interface DiffResult {
  template: Template;
  changedSections: string[];
  warnings: ComplianceWarning[];
}

function locate(t: Template, fieldId: string) {
  for (const s of t.sections) {
    const i = s.fields.findIndex((f) => f.id === fieldId);
    if (i >= 0) return { section: s, index: i };
  }
  return null;
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 48) || "field";
}

export function applyTemplateOps(base: Template, ops: TemplateOp[]): DiffResult {
  const t: Template = JSON.parse(JSON.stringify(base));
  const changed = new Set<string>();
  const warnings: ComplianceWarning[] = [];

  const guardField = (before: Field, after: Field | null) => {
    if (!before.tags.includes(CCP8F_TAG)) return;
    if (!after) warnings.push({ fieldId: before.id, message: `Removing "${before.label}" removes a CCP 8F required field (${CCP8F_TAG}).` });
    else if (before.required && !after.required) warnings.push({ fieldId: before.id, message: `Making "${before.label}" optional loosens a CCP 8F required field (${CCP8F_TAG}).` });
    else if (!after.tags.includes(CCP8F_TAG)) warnings.push({ fieldId: before.id, message: `Removing the ${CCP8F_TAG} tag from "${before.label}" loosens a CCP 8F requirement.` });
  };

  for (const op of ops) {
    switch (op.op) {
      case "add_field": {
        const section = t.sections.find((s) => s.id === op.section_id) ?? t.sections.find((s) => s.title.toLowerCase() === String(op.section_id ?? "").toLowerCase());
        if (!section) throw new Error(`Unknown section ${op.section_id}`);
        const data = { ...(op.data ?? {}) } as Record<string, unknown>;
        let id = String(data.id ?? op.field_id ?? slug(String(data.label ?? "field")));
        while (allFields(t).some((f) => f.id === id)) id = `${id}_2`;
        const field = Field.parse({ type: "narrative", lengthType: "medium", ...data, id });
        const after = op.after_field_id ? section.fields.findIndex((f) => f.id === op.after_field_id) : -1;
        section.fields.splice(after >= 0 ? after + 1 : section.fields.length, 0, field);
        changed.add(section.id);
        break;
      }
      case "update_field": {
        const loc = locate(t, op.field_id ?? "");
        if (!loc) throw new Error(`Unknown field ${op.field_id}`);
        const before = loc.section.fields[loc.index]!;
        const after = Field.parse({ ...before, ...(op.data ?? {}), id: before.id });
        guardField(before, after);
        loc.section.fields[loc.index] = after;
        changed.add(loc.section.id);
        break;
      }
      case "remove_field": {
        const loc = locate(t, op.field_id ?? "");
        if (!loc) throw new Error(`Unknown field ${op.field_id}`);
        guardField(loc.section.fields[loc.index]!, null);
        loc.section.fields.splice(loc.index, 1);
        changed.add(loc.section.id);
        for (const r of t.rules) {
          if ("field" in r && r.field === op.field_id) warnings.push({ ruleId: r.id, message: `Rule "${r.id}" refers to the removed field.` });
        }
        break;
      }
      case "move_field": {
        const loc = locate(t, op.field_id ?? "");
        const dest = t.sections.find((s) => s.id === op.section_id);
        if (!loc || !dest) throw new Error("Unknown field or section");
        const [f] = loc.section.fields.splice(loc.index, 1);
        const after = op.after_field_id ? dest.fields.findIndex((x) => x.id === op.after_field_id) : -1;
        dest.fields.splice(after >= 0 ? after + 1 : dest.fields.length, 0, f!);
        changed.add(loc.section.id);
        changed.add(dest.id);
        break;
      }
      case "add_section": {
        const data = op.data ?? {};
        const s = Section.parse({ id: op.section_id ?? slug(String(data.title ?? "section")), fields: [], ...data });
        t.sections.push(s);
        changed.add(s.id);
        break;
      }
      case "update_section": {
        const s = t.sections.find((x) => x.id === op.section_id);
        if (!s) throw new Error(`Unknown section ${op.section_id}`);
        Object.assign(s, { title: op.data?.title ?? s.title, intro: op.data?.intro ?? s.intro });
        changed.add(s.id);
        break;
      }
      case "remove_section": {
        const i = t.sections.findIndex((x) => x.id === op.section_id);
        if (i < 0) throw new Error(`Unknown section ${op.section_id}`);
        for (const f of t.sections[i]!.fields) guardField(f, null);
        t.sections.splice(i, 1);
        changed.add(op.section_id!);
        break;
      }
      case "add_rule": {
        t.rules.push(Rule.parse({ ...(op.data ?? {}), id: op.rule_id ?? op.data?.id }));
        break;
      }
      case "update_rule": {
        const i = t.rules.findIndex((r) => r.id === op.rule_id);
        if (i < 0) throw new Error(`Unknown rule ${op.rule_id}`);
        const before = t.rules[i]!;
        const after = Rule.parse({ ...before, ...(op.data ?? {}), id: before.id, kind: before.kind });
        if ("min" in before && "min" in after && after.min < before.min) warnings.push({ ruleId: before.id, message: `Lowering the minimum in rule "${before.id}" from ${before.min} to ${after.min} loosens a CCP 8F check.` });
        t.rules[i] = after;
        break;
      }
      case "remove_rule": {
        const i = t.rules.findIndex((r) => r.id === op.rule_id);
        if (i < 0) throw new Error(`Unknown rule ${op.rule_id}`);
        warnings.push({ ruleId: op.rule_id, message: `Removing validation rule "${op.rule_id}" disables a CCP 8F check.` });
        t.rules.splice(i, 1);
        break;
      }
      case "update_branding": {
        Object.assign(t.branding, op.data ?? {});
        break;
      }
    }
  }
  return { template: parseTemplate(t), changedSections: Array.from(changed), warnings };
}

/**
 * Migrate an in-progress draft to a new template version (BCBA chose
 * "Update to latest template"): matching field ids are kept, new fields start empty.
 */
export function migrateContent(content: PlanContent, to: Template): { content: PlanContent; dropped: string[]; added: string[] } {
  const fresh = emptyContent(to);
  const next = cloneContent(fresh);
  const dropped: string[] = [];
  for (const [id, entry] of Object.entries(content)) {
    if (id in fresh) next[id] = entry;
    else dropped.push(id);
  }
  const added = Object.keys(fresh).filter((id) => !(id in content));
  return { content: next, dropped, added };
}
