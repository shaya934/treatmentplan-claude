import { ai, type AiContext } from "../ai/client";
import { PLAN_IMPORT_SYSTEM } from "../ai/prompts";
import { ImportOutput } from "../ai/schemas";
import { cloneContent, isEmptyValue, type FieldEntry, type PlanContent } from "../plan/content";
import type { Field, Template } from "../template/schema";
import { lengthGuide, normalizeValue } from "./generate";
import type { PageText } from "./text";

/**
 * Previous-plan import: copy last period's plan (Word/PDF made outside the app)
 * into a reassessment, field by field, marked carried_forward for the BCBA to
 * confirm or change. The same rules as carry-forward from a plan finalized in
 * the app: fields marked carryForward=false (names, dates, signatures) are
 * never copied, and nothing the BCBA or this period's files filled is overwritten.
 */

/** Longest document text sent; ~75k tokens, plenty for a 30-40 page plan. */
const MAX_CHARS = 300_000;

export function fillable(f: Field, e: FieldEntry | undefined): boolean {
  if (f.type === "static" || f.calc || f.carryForward === false) return false;
  if (!e) return true;
  return e.status === "needs_bcba" || e.status === "carried_forward" || isEmptyValue(f, e.value);
}

export async function importPreviousPlan(
  ctx: AiContext,
  t: Template,
  filename: string,
  pages: PageText[],
  current: PlanContent,
): Promise<Record<string, FieldEntry>> {
  const doc = pages
    .filter((p) => p.text.trim())
    .map((p) => `<page number="${p.page}">\n${p.text}\n</page>`)
    .join("\n")
    .slice(0, MAX_CHARS);
  const content = cloneContent(current);
  const updates: Record<string, FieldEntry> = {};
  if (!doc) return updates;
  const client = await ai();
  for (const s of t.sections) {
    const fields = s.fields.filter((f) => fillable(f, content[f.id]));
    if (!fields.length) continue;
    const out = await client.structured({
      step: "plan_import",
      ctx,
      system: PLAN_IMPORT_SYSTEM,
      // The document is the stable part across sections, so it sits before the cache point.
      cachedContext: `<document name="${filename.replace(/"/g, "")}">\n${doc}\n</document>`,
      user: `New plan section: ${s.title}\n${lengthGuide(fields)}\nCopy the previous plan's content for these fields.`,
      toolName: "import_section",
      toolDescription: "Return each field's content as written in the previous plan.",
      schema: ImportOutput,
      mockInput: { fields, pages },
      maxTokens: 8000,
    });
    const allowed = new Map(fields.map((f) => [f.id, f]));
    for (const o of out.fields) {
      const f = allowed.get(o.field_id);
      if (!f) continue; // never write outside the requested fields
      const value = normalizeValue(f, o.value, content[f.id]?.value ?? null);
      if (isEmptyValue(f, value)) continue;
      updates[f.id] = content[f.id] = { value, status: "carried_forward", sources: ["previous_plan"] };
    }
  }
  return updates;
}

/** Apply imported values onto the latest content, skipping fields filled since the import started. */
export function applyImport(t: Template, latest: PlanContent, updates: Record<string, FieldEntry>): { content: PlanContent; filled: string[] } {
  const content = cloneContent(latest);
  const filled: string[] = [];
  for (const [id, entry] of Object.entries(updates)) {
    const f = t.sections.flatMap((s) => s.fields).find((x) => x.id === id);
    if (!f || !fillable(f, content[id])) continue;
    content[id] = entry;
    filled.push(id);
  }
  return { content, filled };
}
