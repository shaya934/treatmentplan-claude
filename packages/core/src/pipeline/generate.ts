import { ai, type AiContext } from "../ai/client";
import { narrativeSystem, REVIEW_SYSTEM } from "../ai/prompts";
import { ReviewOutput, SectionOutput } from "../ai/schemas";
import { checkGroup, linkGroups } from "../plan/consistency";
import { findPlaceholders, HAS_PLACEHOLDER, isEmptyValue, placeholder, PLACEHOLDER_RE, valueToText, type FieldEntry, type FieldValue, type PlanContent, type TableRow } from "../plan/content";
import type { Field, Section, Template } from "../template/schema";
import { findField, guidedQuestions } from "../template/schema";
import { firstName, type BcbaAnswer, type ClientRecord, type Evidence, type ReviewItem } from "../types";
import { calcDerived } from "./prefill";

/** Narrative generation (spec F6), section by section. */

export interface SectionInput {
  section: Section;
  fields: Field[];
  evidence: Evidence[];
  answers: Array<BcbaAnswer & { question: string }>;
  current: Record<string, FieldValue>;
  clientFirstName: string;
}

/**
 * Which fields generation may write: never static, calculated, or BCBA-completed fields.
 * Content carried forward from the previous plan is kept as written unless the BCBA
 * answered a question about that field this time (an answer means they want it changed).
 */
export function generatableFields(section: Section, content: PlanContent, answeredFieldIds: Set<string> = new Set()): Field[] {
  return section.fields.filter((f) => {
    if (f.type === "static" || f.calc) return false;
    const e = content[f.id];
    if (e?.status === "complete" || e?.status === "calculated") return false;
    if (e?.status === "prefilled" && !isEmptyValue(f, e.value)) return false;
    if (e?.status === "carried_forward" && !isEmptyValue(f, e.value) && !answeredFieldIds.has(f.id)) return false;
    return true;
  });
}

/** Template fields covered by a question the BCBA has answered. */
export function answeredFields(t: Template, answers: BcbaAnswer[]): Set<string> {
  const answered = new Set(answers.map((a) => a.question_id));
  return new Set(guidedQuestions(t).filter((q) => answered.has(q.id)).flatMap((q) => q.fieldIds));
}

export function relevantEvidence(fields: Field[], evidence: Evidence[], limit = 60): Evidence[] {
  const hints = new Set(fields.flatMap((f) => f.sourceHints));
  const rel = evidence.filter((e) => !e.deleted && hints.has(e.category));
  return rel.slice(0, limit);
}

export function relevantAnswers(t: Template, section: Section, answers: BcbaAnswer[]): Array<BcbaAnswer & { question: string }> {
  const qs = guidedQuestions(t);
  const sectionFieldIds = new Set(section.fields.map((f) => f.id));
  const own = qs.filter((q) => q.fieldIds.some((id) => sectionFieldIds.has(id)));
  const needsAll = section.fields.some((f) => f.type !== "static" && !f.question && !f.questionId && !f.calc);
  const chosen = needsAll ? qs : own;
  const qmap = new Map(chosen.map((q) => [q.id, q.text]));
  return answers.filter((a) => qmap.has(a.question_id)).map((a) => ({ ...a, question: qmap.get(a.question_id)! }));
}

function lengthGuide(fields: Field[]): string {
  return "Fields to write:\n" + fields.map((f) => `- ${f.id} (${f.type}, length: ${f.lengthType}${f.required ? ", required" : ""}): ${f.label}${f.help ? ` — ${f.help}` : ""}${f.columns ? ` | columns: ${f.columns.map((c) => c.id).join(", ")}` : ""}${f.options ? ` | options: ${f.options.join(" / ")}` : ""}`).join("\n");
}

function normalizeValue(f: Field, v: unknown, current: FieldValue): FieldValue {
  if (f.type === "table") {
    if (!Array.isArray(v)) return current;
    const cols = (f.columns ?? []).map((c) => c.id);
    const rows = (v as Array<Record<string, unknown>>).filter((r) => r && typeof r === "object").map((r) => Object.fromEntries(cols.map((c) => [c, String(r[c] ?? "")])));
    if (f.fixedRows) {
      // keep fixed row labels in order; merge generated cells into them
      const first = cols[0]!;
      const base = (Array.isArray(current) ? (current as TableRow[]) : []).map((r) => ({ ...r }));
      for (const r of rows) {
        const target = base.find((b) => (b[first] ?? "").toLowerCase() === (r[first] ?? "").toLowerCase());
        if (target) for (const c of cols.slice(1)) if (r[c]) target[c] = r[c]!;
      }
      return base;
    }
    return rows;
  }
  if (f.type === "boolean") return typeof v === "boolean" ? v : current;
  if (f.type === "multiselect") return Array.isArray(v) ? (v as string[]).filter((x) => typeof x === "string" && (!f.options || f.options.includes(x))) : current;
  if (typeof v !== "string") return current;
  if (f.type === "select" && f.options && !f.options.includes(v) && !HAS_PLACEHOLDER.test(v)) return placeholder(f.label);
  return v;
}

export async function generateSection(
  ctx: AiContext,
  t: Template,
  section: Section,
  content: PlanContent,
  evidence: Evidence[],
  answers: BcbaAnswer[],
  client: ClientRecord,
): Promise<{ updates: Record<string, FieldEntry> }> {
  const fields = generatableFields(section, content, answeredFields(t, answers));
  if (!fields.length) return { updates: {} };
  const ev = relevantEvidence(fields, evidence);
  const ans = relevantAnswers(t, section, answers);
  const current = Object.fromEntries(section.fields.map((f) => [f.id, content[f.id]?.value ?? null]));
  const input: SectionInput = { section, fields, evidence: ev, answers: ans, current, clientFirstName: firstName(client.name) };

  const evidenceXml = ev.map((e) => `<row id="${e.id}" category="${e.category}" date="${e.source_date ?? ""}">${e.fact_text}: ${e.value ?? ""} ${e.unit ?? ""}</row>`).join("\n");
  const answersXml = ans.map((a) => `<answer id="bcba_answer:${a.question_id}" question="${a.question.replace(/"/g, "'")}">${a.answer_text}</answer>`).join("\n");
  const currentXml = section.fields.filter((f) => f.type !== "static" && !isEmptyValue(f, content[f.id]?.value)).map((f) => `<field id="${f.id}">${valueToText(content[f.id]!.value).slice(0, 1500)}</field>`).join("\n");

  const client_ = await ai();
  const updating = fields.filter((f) => content[f.id]?.status === "carried_forward").map((f) => f.id);
  const out = await client_.structured({
    step: "narrative",
    ctx,
    system: narrativeSystem(lengthGuide(fields)),
    cachedContext: `Template section: ${section.title}${section.intro ? `\n${section.intro}` : ""}`,
    user: `Client first name: ${input.clientFirstName}\n<evidence>\n${evidenceXml || "(none)"}\n</evidence>\n<answers>\n${answersXml || "(none)"}\n</answers>\n<current_fields>\n${currentXml || "(none)"}\n</current_fields>\nWrite the fields listed above. Use [BCBA to confirm: ...] for anything not supported by evidence or answers.${updating.length ? `\nThese fields hold last period's plan text: ${updating.join(", ")}. Keep that wording and change only what the BCBA's answers or new evidence update.` : ""}`,
    toolName: "write_section",
    toolDescription: "Return the written value for each field, with the evidence/answer IDs behind each sentence.",
    schema: SectionOutput,
    mockInput: input,
    maxTokens: 8000,
  });

  const allowedIds = new Set(fields.map((f) => f.id));
  const updates: Record<string, FieldEntry> = {};
  const validSources = new Set([...ev.map((e) => e.id), ...ans.map((a) => `bcba_answer:${a.question_id}`)]);
  for (const o of out.fields) {
    if (!allowedIds.has(o.field_id)) continue; // never write outside the requested fields
    const f = fields.find((x) => x.id === o.field_id)!;
    const value = normalizeValue(f, o.value, content[f.id]?.value ?? null);
    const sentenceSources = (o.sentences ?? []).map((s) => ({ sentence: s.text, sources: s.sources.filter((x) => validSources.has(x)) }));
    const sources = Array.from(new Set(sentenceSources.flatMap((s) => s.sources)));
    const text = valueToText(value);
    const status = HAS_PLACEHOLDER.test(text) || isEmptyValue(f, value) ? "needs_bcba" : sources.some((s) => s.startsWith("bcba_answer")) ? "complete" : "prefilled";
    updates[f.id] = { value, status, sources, sentenceSources };
  }
  // Required fields the model skipped become visible placeholders, never silent blanks.
  for (const f of fields) {
    if (updates[f.id] || !f.required || !isEmptyValue(f, content[f.id]?.value)) continue;
    updates[f.id] = { value: emptyPlaceholder(f, content[f.id]?.value ?? null), status: "needs_bcba", sources: [] };
  }
  return { updates };
}

export function emptyPlaceholder(f: Field, current: FieldValue): FieldValue {
  if (f.type === "boolean" || f.type === "multiselect") return current;
  if (f.type === "table") {
    // Fixed-row tables (codes, days, phases) keep their structure; the empty-required
    // check and the field's "Needs BCBA" status flag them instead of a stray cell placeholder.
    if (f.fixedRows?.length) return current;
    const cols = f.columns!.map((c) => c.id);
    return [{ ...Object.fromEntries(cols.map((c) => [c, ""])), [cols[0]!]: placeholder(f.label) }];
  }
  return placeholder(f.label);
}

/** Numbers in generated text that appear in no evidence row, BCBA answer, or existing value. */
export function unsupportedNumbers(text: string, corpus: string): string[] {
  const nums = text.replace(PLACEHOLDER_RE, "").match(/\b\d+(?:\.\d+)?\b/g) ?? [];
  const pool = new Set(corpus.match(/\b\d+(?:\.\d+)?\b/g) ?? []);
  return Array.from(new Set(nums.filter((n) => !pool.has(n) && !/^(19|20)\d\d$/.test(n) && Number(n) > 10 && !/^(9715[1-8]|0032)$/.test(n))));
}

/** Review list (spec F6): placeholders, conflicts, low BCBA input, unsupported numbers, link mismatches. */
export async function buildReviewList(
  ctx: AiContext,
  t: Template,
  content: PlanContent,
  evidence: Evidence[],
  answers: BcbaAnswer[],
  generatedSections: string[],
): Promise<ReviewItem[]> {
  const items: ReviewItem[] = [];
  for (const p of findPlaceholders(content)) items.push({ field_id: p.fieldId, kind: "placeholder", detail: p.text });

  for (const [id, e] of Object.entries(content)) {
    if (e.status === "carried_forward") items.push({ field_id: id, kind: "carried_forward", detail: "Carried forward from the previous plan - confirm" });
  }

  // Sections written mostly from files with little BCBA input.
  for (const s of t.sections) {
    if (!generatedSections.includes(s.id)) continue;
    const written = s.fields.filter((f) => f.type !== "static" && content[f.id] && !isEmptyValue(f, content[f.id]!.value));
    if (!written.length) continue;
    const fromBcba = written.filter((f) => content[f.id]!.sources.some((x) => x.startsWith("bcba_answer")) || content[f.id]!.status === "complete");
    if (fromBcba.length / written.length < 0.34 && written.some((f) => f.lengthType !== "short")) {
      items.push({ field_id: written[0]!.id, kind: "low_input", detail: `"${s.title}" was written mostly from files with little BCBA input` });
    }
  }

  for (const group of linkGroups(t).keys()) {
    const r = checkGroup(t, content, group);
    if (!r.consistent) items.push({ field_id: r.readings[0]?.fieldId ?? null, kind: "mismatch", detail: `${group.replace("hours_", "")} hours differ: ${r.readings.map((x) => `${x.fieldLabel.split("(")[0]!.trim()} = ${x.value ?? "missing"}`).join("; ")}` });
  }

  // Deterministic integrity check on numbers.
  const corpus = [...evidence.filter((e) => !e.deleted).map((e) => `${e.fact_text} ${e.value ?? ""} ${e.source_date ?? ""}`), ...answers.map((a) => a.answer_text)].join(" ");
  for (const [id, e] of Object.entries(content)) {
    if (!e.sentenceSources?.length) continue;
    const bad = unsupportedNumbers(valueToText(e.value), corpus);
    if (bad.length) items.push({ field_id: id, kind: "unsupported", detail: `Number(s) not found in files or BCBA answers: ${bad.join(", ")}` });
  }

  // AI cross-check pass for conflicts between files and BCBA answers.
  const client = await ai();
  const review = await client.structured({
    step: "review",
    ctx,
    system: REVIEW_SYSTEM,
    user: `<evidence>\n${evidence.filter((e) => !e.deleted).slice(0, 200).map((e) => `<row id="${e.id}" date="${e.source_date ?? ""}">${e.fact_text}: ${e.value ?? ""} ${e.unit ?? ""}</row>`).join("\n")}\n</evidence>\n<answers>\n${answers.map((a) => `<answer question="${a.question_id}">${a.answer_text}</answer>`).join("\n")}\n</answers>\n<draft>\n${Object.entries(content).filter(([, e]) => e.value !== null).map(([id, e]) => `<field id="${id}">${valueToText(e.value).slice(0, 1200)}</field>`).join("\n")}\n</draft>`,
    toolName: "review_plan",
    toolDescription: "Report conflicts and unsupported claims.",
    schema: ReviewOutput,
    mockInput: { evidence, answers, content },
    maxTokens: 3000,
  });
  for (const c of review.conflicts) items.push({ field_id: findField(t, c.field_id) ? c.field_id : null, kind: "conflict", detail: c.detail });
  for (const u of review.unsupported) items.push({ field_id: findField(t, u.field_id) ? u.field_id : null, kind: "unsupported", detail: u.detail });

  const seen = new Set<string>();
  return items.filter((i) => {
    const k = `${i.kind}|${i.field_id}|${i.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Generate the whole plan section by section, calling onSection after each so the UI can stream. */
export async function generatePlan(
  ctx: AiContext,
  t: Template,
  content: PlanContent,
  evidence: Evidence[],
  answers: BcbaAnswer[],
  client: ClientRecord,
  onSection?: (sectionId: string, updates: Record<string, FieldEntry>) => Promise<void> | void,
): Promise<{ content: PlanContent; review: ReviewItem[] }> {
  const next: PlanContent = JSON.parse(JSON.stringify(content));
  const generated: string[] = [];
  for (const s of t.sections) {
    const { updates } = await generateSection(ctx, t, s, next, evidence, answers, client);
    Object.assign(next, updates);
    if (Object.keys(updates).length) generated.push(s.id);
    await onSection?.(s.id, updates);
  }
  calcDerived(t, next);
  const review = await buildReviewList(ctx, t, next, evidence, answers, generated);
  return { content: next, review };
}
