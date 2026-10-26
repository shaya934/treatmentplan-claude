import { ai, type AiContext } from "../ai/client";
import { PLAN_EDIT_SYSTEM } from "../ai/prompts";
import { EditOutput } from "../ai/schemas";
import { onFieldChanged } from "../plan/consistency";
import { cloneContent, valueToText, type FieldValue, type PlanContent, type TableRow } from "../plan/content";
import type { Field, Template } from "../template/schema";
import { allFields } from "../template/schema";

/** Chat edits of a plan (spec F7): the AI edits only targeted fields; every change is accept/reject. */

export interface Change {
  id: string;
  fieldId: string;
  fieldLabel: string;
  before: FieldValue;
  after: FieldValue;
  summary: string;
  linked: boolean;
}

export interface EditProposal {
  message: string;
  changes: Change[];
  flags: Array<{ fieldId: string; reason: string }>;
}

const STOP = new Set(["the", "a", "an", "to", "of", "and", "make", "more", "less", "change", "in", "for", "on", "with", "please", "add", "this", "that", "is", "it"]);

export function rankFields(t: Template, content: PlanContent, request: string, limit = 12): Field[] {
  const words = request.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => !STOP.has(w) && w.length > 2) ?? [];
  const scored = allFields(t)
    .filter((f) => f.type !== "static")
    .map((f) => {
      const hay = `${f.id} ${f.label} ${valueToText(content[f.id]?.value ?? null).slice(0, 2000)}`.toLowerCase();
      const label = `${f.id} ${f.label}`.toLowerCase();
      let score = 0;
      for (const w of words) {
        if (label.includes(w)) score += 3;
        else if (hay.includes(w)) score += 1;
      }
      return { f, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.f);
}

function normalize(f: Field, v: unknown): FieldValue {
  if (f.type === "table") {
    if (!Array.isArray(v)) throw new Error("table value must be rows");
    const cols = f.columns!.map((c) => c.id);
    return (v as Array<Record<string, unknown>>).map((r) => Object.fromEntries(cols.map((c) => [c, String(r?.[c] ?? "")]))) as TableRow[];
  }
  if (f.type === "boolean") return Boolean(v);
  if (f.type === "multiselect") return Array.isArray(v) ? (v as string[]) : [String(v)];
  return typeof v === "string" ? v : JSON.stringify(v);
}

let seq = 0;
const cid = () => `chg_${Date.now().toString(36)}_${(seq++).toString(36)}`;

export async function proposeEdits(ctx: AiContext, t: Template, content: PlanContent, request: string): Promise<EditProposal> {
  const targets = rankFields(t, content, request);
  const index = allFields(t)
    .filter((f) => f.type !== "static")
    .map((f) => `${f.id}: ${f.label} (${f.type}${f.columns ? `; columns ${f.columns.map((c) => c.id).join(",")}` : ""})`)
    .join("\n");
  const fieldsXml = targets.map((f) => `<field id="${f.id}" type="${f.type}">${JSON.stringify(content[f.id]?.value ?? null)}</field>`).join("\n");
  const client = await ai();
  const out = await client.structured({
    step: "plan_edit",
    ctx,
    system: PLAN_EDIT_SYSTEM,
    cachedContext: `All template fields:\n${index}`,
    user: `<request>\n${request}\n</request>\nCurrent values of the most likely target fields:\n${fieldsXml || "(none matched)"}`,
    toolName: "edit_fields",
    toolDescription: "Return the new value for each field you change, and a one-line message to the BCBA.",
    schema: EditOutput,
    mockInput: { request, targets: targets.map((f) => f.id), content },
    maxTokens: 6000,
  });

  const byId = new Map(allFields(t).map((f) => [f.id, f]));
  const changes: Change[] = [];
  let working = cloneContent(content);
  const flags: EditProposal["flags"] = [];
  for (const c of out.changes) {
    const f = byId.get(c.field_id);
    if (!f || f.type === "static") continue;
    let after: FieldValue;
    try {
      after = normalize(f, c.new_value);
    } catch {
      continue;
    }
    const before = content[f.id]?.value ?? null;
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    changes.push({ id: cid(), fieldId: f.id, fieldLabel: f.label, before, after, summary: c.summary, linked: false });
    const prev = working;
    working = cloneContent(working);
    working[f.id] = { ...(working[f.id] ?? { status: "complete", sources: [] }), value: after };
    // Consistency engine: propose updates to linked fields, or flag them.
    for (const r of onFieldChanged(t, prev, working, f.id)) {
      for (const lc of r.changes) {
        if (changes.some((x) => x.fieldId === lc.fieldId)) continue;
        const lf = byId.get(lc.fieldId)!;
        changes.push({ id: cid(), fieldId: lc.fieldId, fieldLabel: lf.label, before: lc.before as FieldValue, after: lc.after as FieldValue, summary: lc.reason, linked: true });
        working[lc.fieldId] = { ...(working[lc.fieldId] ?? { status: "complete", sources: [] }), value: lc.after as FieldValue };
      }
      flags.push(...r.flagged);
    }
  }
  return { message: out.message, changes, flags };
}

/** Apply accepted changes; edited fields become BCBA-complete. */
export function applyChanges(content: PlanContent, changes: Change[]): PlanContent {
  const next = cloneContent(content);
  for (const c of changes) {
    const prev = next[c.fieldId];
    next[c.fieldId] = { value: c.after, status: "complete", sources: Array.from(new Set([...(prev?.sources ?? []), "bcba_edit"])), sentenceSources: undefined };
  }
  return next;
}
