import type { MockHandler } from "./client";
import type { ExtractedFact, TemplateOp } from "./schemas";
import type { SectionInput } from "../pipeline/generate";
import type { PageText } from "../pipeline/text";
import { placeholder, valueToText, type PlanContent, type TableRow } from "../plan/content";
import { allFields, CCP8F_TAG, type Field, type Template } from "../template/schema";
import type { BcbaAnswer, Evidence } from "../types";

/**
 * Deterministic stand-in for Bedrock used in local mode and tests. It follows
 * the same contracts and the same clinical integrity rules (never invents
 * numbers; missing data becomes a placeholder), so the pipeline and its
 * guarantees can be tested end to end with synthetic data.
 */

function usToIso(s: string): string | null {
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  const iso = s.match(/(\d{4}-\d{2}-\d{2})/);
  return iso ? iso[1]! : null;
}

const firstNum = (s: string) => s.match(/-?\d+(?:\.\d+)?/)?.[0] ?? null;

export function mockExtractLine(line: string, page: number): ExtractedFact | null {
  const m = line.match(/^\s*([^:]{2,80}):\s*(.+?)\s*$/);
  if (!m) return null;
  let key = m[1]!.trim();
  let rest = m[2]!.trim();
  let date: string | null = null;
  const dm = rest.match(/\((?:date|as of|on)?:?\s*([\d/-]{8,10})\)\s*$/i);
  if (dm) {
    date = usToIso(dm[1]!);
    rest = rest.slice(0, dm.index).trim();
  }
  const k = key.toLowerCase();
  const parts = rest.split("|").map((s) => s.trim());
  const f = (category: ExtractedFact["category"], value: string | null, unit: string | null = null, text = key): ExtractedFact => ({ fact_text: text, category, value, unit, source_date: date, page });

  if (/vineland|vb-mapp|ablls|abas|dp-4|esdm|standard score/.test(k)) {
    key = key.replace(/^prior\s+/i, "");
    return f("score", firstNum(rest), /standard score/i.test(key) ? "SS" : null, key);
  }
  if (/\brate\b|per hour|per session/.test(k + " " + rest.toLowerCase()) && /aggress|self-inj|elope|tantrum|destruct|behavior|sib/.test(k)) {
    const unit = rest.match(/per (hour|session|day|week)/i)?.[0] ?? null;
    return f("rate", firstNum(rest), unit);
  }
  if (/^medication/.test(k)) return f("medication", parts[1] ?? null, parts[2] ?? null, `Medication: ${parts[0]}`);
  if (/^service/.test(k)) return f("service", parts[1] ?? null, null, parts[0]);
  if (/authori[sz]ed|hours used|payer|authorization/.test(k)) return f("authorization", /payer/.test(k) ? rest : firstNum(rest) ?? rest);
  if (/diagnos|physician|onset/.test(k)) {
    if (/date of diagnosis|onset/.test(k)) return { ...f("diagnosis", rest, null, "Onset of diagnosis"), source_date: usToIso(rest) ?? date };
    if (/by|physician/.test(k)) return f("diagnosis", rest, null, "Diagnosed by physician");
    return f("diagnosis", rest);
  }
  if (/school|daycare|iep/.test(k)) return f("iep", rest, null, /name/.test(k) ? "School name" : key);
  if (/start date|fba completed|data collection began/.test(k)) return { ...f("date", rest), source_date: usToIso(rest) ?? date };
  if (/caregiver|parent training|sessions delivered/.test(k)) return f("caregiver", rest);
  if (/name|date of birth|dob|gender|member id|medicaid id/.test(k)) return f("demographic", rest);
  if (/goal|target|mastered/.test(k)) return f("goal", rest);
  return f("other", rest);
}

const extract: MockHandler = (input) => {
  const { pages } = input as { pages: PageText[] };
  const facts: ExtractedFact[] = [];
  for (const p of pages) {
    for (const line of p.text.split(/\n/)) {
      const fact = mockExtractLine(line, p.page);
      if (fact && fact.fact_text.length > 1) facts.push(fact);
    }
  }
  return { facts };
};

const VAGUE = /^(fine|good|ok|okay|n\/?a|not sure|same|no change|same as before|nothing|none|idk|doing well|progressing)\.?$/i;

const assessAnswer: MockHandler = (input) => {
  const { question, answer } = input as { question: { text: string }; answer: string };
  const a = answer.trim();
  const needsNumbers = /how many|hours|rate|percent|fidelity|numbers|baseline|scores?\b|range/i.test(question.text);
  const words = a.split(/\s+/).filter(Boolean).length;
  if (VAGUE.test(a) || words < 4) return { complete: false, follow_up: "Could you say a bit more? Please describe it in observable terms, with an example or data from this period." };
  if (needsNumbers && !/\d/.test(a)) return { complete: false, follow_up: "Can you give the specific numbers for that (for example a rate per hour, hours per week, or dates)?" };
  return { complete: true, follow_up: null };
};

function isoToUs(d: string | null) {
  const m = d?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[2])}/${Number(m[3])}/${m[1]}` : "";
}

function evidenceSentence(e: Evidence): string {
  return `${e.fact_text}: ${e.value ?? ""}${e.unit ? " " + e.unit : ""}${e.source_date ? ` (${isoToUs(e.source_date)})` : ""}.`.replace(/\s+/g, " ");
}

function thirdPerson(answer: string, first: string): string {
  const t = answer.trim().replace(/\s+/g, " ");
  const s = t.charAt(0).toUpperCase() + t.slice(1);
  const withName = s.replace(/\b(she|he|they)\b/i, first);
  return /[.!?]$/.test(withName) ? withName : withName + ".";
}

const writeSection: MockHandler = (input) => {
  const { fields, evidence, answers, clientFirstName } = input as SectionInput;
  const out: Array<{ field_id: string; value: unknown; sentences: Array<{ text: string; sources: string[] }> }> = [];
  const usedAnswers = new Set<string>();
  for (const f of fields) {
    const qid = f.questionId ?? (f.question ? f.id : null);
    const ans = qid ? answers.filter((a) => a.question_id === qid) : [];
    const ev = evidence.filter((e) => f.sourceHints.includes(e.category));
    if (f.type === "narrative") {
      const sentences: Array<{ text: string; sources: string[] }> = [];
      // A grouped answer is used once, in the first narrative field of its group.
      for (const a of ans) {
        if (usedAnswers.has(a.question_id + a.answer_text)) continue;
        if (VAGUE.test(a.answer_text.trim()) || a.answer_text.trim().split(/\s+/).length < 4) continue; // superseded by follow-up answers
        usedAnswers.add(a.question_id + a.answer_text);
        sentences.push({ text: thirdPerson(a.answer_text, clientFirstName), sources: [`bcba_answer:${a.question_id}`] });
      }
      const evLimit = f.lengthType === "narrative" ? 4 : 2;
      for (const e of ev.slice(0, evLimit)) sentences.push({ text: evidenceSentence(e), sources: [e.id] });
      if (!sentences.length) sentences.push({ text: placeholder(f.label), sources: [] });
      out.push({ field_id: f.id, value: sentences.map((s) => s.text).join(" "), sentences });
    } else if (f.type === "text" || f.type === "date" || f.type === "number" || f.type === "select") {
      const own = ans.find((a) => !usedAnswers.has(a.question_id + a.answer_text) && (f.question || f.questionId === undefined));
      if (own && f.type === "number") {
        const n = firstNum(own.answer_text);
        out.push({ field_id: f.id, value: n ?? placeholder(f.label), sentences: n ? [{ text: n, sources: [`bcba_answer:${own.question_id}`] }] : [] });
      } else if (own && f.type === "text" && f.question) {
        out.push({ field_id: f.id, value: own.answer_text.trim().slice(0, 240), sentences: [{ text: own.answer_text, sources: [`bcba_answer:${own.question_id}`] }] });
      } else if (f.required) {
        out.push({ field_id: f.id, value: placeholder(f.label), sentences: [] });
      }
    }
    // Tables, booleans and multiselects are left to pre-fill and direct BCBA editing in local mode.
  }
  return { fields: out };
};

const review: MockHandler = (input) => {
  const { evidence, answers } = input as { evidence: Evidence[]; answers: BcbaAnswer[]; content: PlanContent };
  const conflicts: Array<{ field_id: string; detail: string }> = [];
  const byKey = new Map<string, Evidence[]>();
  for (const e of evidence) {
    if (e.deleted || !e.value || !/^-?\d/.test(e.value)) continue;
    if (e.category !== "score" && e.category !== "rate") continue;
    const key =
      e.category === "score"
        ? e.fact_text.replace(/vineland-?3?|vb-mapp|ablls-?r?|abas-?3?|prior|standard score|score|:/gi, "").trim().split(/\s+/).slice(0, 2).join(" ")
        : e.fact_text.replace(/rate|frequency|:/gi, "").trim().split(/\s+/)[0]!;
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(e);
  }
  for (const [key, list] of byKey) {
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`${esc}[^.\\d]{0,50}?(\\d+(?:\\.\\d+)?)`, "i");
    for (const a of answers) {
      const m = a.answer_text.match(re);
      if (!m) continue;
      const n = Number(m[1]);
      if (list.some((e) => Number(firstNum(e.value!)) === n)) continue;
      const latest = list.slice().sort((x, y) => (y.source_date ?? "").localeCompare(x.source_date ?? ""))[0]!;
      conflicts.push({
        field_id: latest.category === "score" ? "score_summary" : "behavior_benchmarks",
        detail: `Files say ${latest.fact_text} = ${latest.value}${latest.unit ? " " + latest.unit : ""}${latest.source_date ? ` (${isoToUs(latest.source_date)})` : ""}; BCBA answer says ${m[0].trim()}. BCBA version kept.`,
      });
    }
  }
  return { conflicts, unsupported: [] };
};

const editFields: MockHandler = (input) => {
  const { request, targets, content } = input as { request: string; targets: string[]; content: PlanContent };
  const hours = request.match(/(9715[1-8]|H0032)\b[^\d]{0,30}?(?:to|=|at)\s*(\d+(?:\.\d+)?)/i);
  if (hours) {
    const [, code, n] = hours;
    const rows = ((content.requested_services?.value as TableRow[]) ?? []).map((r) => ({ ...r }));
    const row = rows.find((r) => r.code === code);
    if (row) row.hrs_week = n!;
    else rows.push({ code: code!, hrs_week: n! });
    return { changes: [{ field_id: "requested_services", new_value: rows, summary: `Set ${code} to ${n} hrs/week` }], message: `Updated ${code} to ${n} hrs/week. Linked fields are shown below for confirmation.` };
  }
  const detail = request.match(/make (?:the )?(.+?) (?:more detailed|longer|more specific)/i);
  if (detail && targets[0]) {
    const cur = valueToText(content[targets[0]]?.value ?? null);
    return {
      changes: [{ field_id: targets[0], new_value: `${cur} ${placeholder(`additional detail for ${detail[1]} (antecedents, consequences, data with dates)`)}`.trim(), summary: `Expanded ${detail[1]}` }],
      message: "Local mode cannot write new clinical detail; I added a placeholder where more detail is needed.",
    };
  }
  return { changes: [], message: "I could not map that request to a field in local mode. Click the field to edit it directly." };
};

function findSection(t: Template, name: string) {
  const n = name.toLowerCase().replace(/[^a-z ]/g, "").trim();
  return t.sections.find((s) => s.title.toLowerCase().includes(n) || n.includes(s.title.toLowerCase().split(/[,&/]/)[0]!.trim()));
}

function findFieldByLabel(t: Template, name: string): Field | undefined {
  const n = name.toLowerCase().trim();
  return allFields(t).find((f) => f.id === n.replace(/\s+/g, "_")) ?? allFields(t).find((f) => f.label.toLowerCase().includes(n));
}

const templateDiff: MockHandler = (input) => {
  const { request, template } = input as { request: string; template: Template };
  const ops: TemplateOp[] = [];
  let m: RegExpMatchArray | null;
  if ((m = request.match(/add (?:a |an )?(.+?) field (?:under|to|in(?:to)?) (?:the )?(.+?)(?: section)?\.?$/i))) {
    const s = findSection(template, m[2]!);
    if (s) {
      const label = m[1]!.replace(/^["']|["']$/g, "");
      const nice = label.charAt(0).toUpperCase() + label.slice(1);
      ops.push({ op: "add_field", section_id: s.id, data: { label: nice, type: "narrative", lengthType: "medium", question: `What should be documented about ${label.toLowerCase()}?` } });
    }
  } else if ((m = request.match(/require (\d+) caregiver goals/i))) {
    ops.push({ op: "update_rule", rule_id: "caregiver_goals_min", data: { min: Number(m[1]), message: `At least ${m[1]} caregiver goals are required` } });
    ops.push({ op: "update_field", field_id: "caregiver_goals", data: { minRows: Number(m[1]), help: `At least ${m[1]}; at least one tied to how the primary caregiver supports service delivery.` } });
  } else if ((m = request.match(/remove (?:the )?(.+?)(?: field)?\.?$/i))) {
    const f = findFieldByLabel(template, m[1]!);
    if (f) ops.push({ op: "remove_field", field_id: f.id });
  } else if ((m = request.match(/make (?:the )?(.+?) (?:field )?optional/i))) {
    const f = findFieldByLabel(template, m[1]!);
    if (f) ops.push({ op: "update_field", field_id: f.id, data: { required: false, tags: f.tags.filter((t) => t !== CCP8F_TAG) } });
  }
  return { ops, summary: ops.length ? `${ops.length} change(s): ${ops.map((o) => o.op.replace("_", " ")).join(", ")}` : "I could not turn that request into a template change." };
};

const docxTemplate: MockHandler = (input) => {
  const { text } = input as { text: string };
  const sections: Array<{ id: string; title: string; fields: Array<Record<string, unknown>> }> = [];
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "x";
  const used = new Set<string>();
  const uid = (s: string) => {
    let id = slug(s);
    while (used.has(id)) id += "_2";
    used.add(id);
    return id;
  };
  for (const raw of text.split(/\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const isHeading = line.length < 60 && !/[.:]$/.test(line) && /^[A-Z]/.test(line) && line.split(" ").length <= 7 && !line.includes(":");
    if (isHeading || !sections.length) {
      sections.push({ id: uid(isHeading ? line : "general"), title: isHeading ? line : "General", fields: [] });
      if (isHeading) continue;
    }
    const sec = sections[sections.length - 1]!;
    const lab = line.match(/^(.{2,80}?):\s*(.*)$/);
    if (lab && !lab[2]) sec.fields.push({ id: uid(lab[1]!), label: lab[1], type: "narrative", lengthType: "medium", question: `${lab[1]}?`, required: /required/i.test(line) });
    else if (lab) sec.fields.push({ id: uid(lab[1]!), label: lab[1], type: "text", lengthType: "short", required: false });
    else sec.fields.push({ id: uid(line.slice(0, 30)), label: line.slice(0, 60), type: "static", text: line });
  }
  return { sections: sections.filter((s) => s.fields.length) };
};

/** Template outline: the same heading rule as docxTemplate, returned as section headings. */
const templateOutline: MockHandler = (input) => {
  const { text } = input as { text: string };
  const sections = text
    .split(/\n/)
    .map((l) => l.trim())
    .filter((line) => line && line.length < 60 && !/[.:]$/.test(line) && /^[A-Z]/.test(line) && line.split(" ").length <= 7 && !line.includes(":"))
    .map((line) => ({ title: line, heading: line }));
  return { sections };
};

/** Previous-plan import: copy any "Field label: text" line for text-like fields. */
const importSection: MockHandler = (input) => {
  const { fields, pages } = input as { fields: Field[]; pages: PageText[] };
  const lines = pages.flatMap((p) => p.text.split("\n"));
  const out: Array<{ field_id: string; value: string }> = [];
  for (const f of fields) {
    if (!["text", "narrative", "date", "number", "select"].includes(f.type)) continue;
    const label = f.label.toLowerCase();
    const line = lines.find((l) => l.toLowerCase().startsWith(`${label}:`));
    const value = line?.slice(f.label.length + 1).trim();
    if (value) out.push({ field_id: f.id, value });
  }
  return { fields: out };
};

/**
 * Graph reading: the mock cannot look at images, so it "finds" one graph per page only in
 * files named like graph exports (learning trees, graphs); other files have none, as a
 * scanned letter would for the real model.
 */
const readGraphs: MockHandler = (input) => {
  const { pages, filename } = input as { pages: number[]; filename: string };
  if (!/graph|learning/i.test(filename)) return { graphs: [] };
  return {
    graphs: pages.map((page) => ({
      page,
      title: `Program graph on page ${page}`,
      summary: "Mock reading (local mode): the trend is not analyzed; check the graph.",
      bbox: { x: 0.1, y: 0.05, w: 0.8, h: 0.4 },
      facts: [{ fact_text: `Graph: program trend on page ${page} (mock reading)`, category: "rate", value: null, unit: null, source_date: null }],
    })),
  };
};

export const mockHandlers: Record<string, MockHandler> = {
  import_section: importSection,
  record_graphs: readGraphs,
  template_outline: templateOutline,
  record_facts: extract,
  assess_answer: assessAnswer,
  write_section: writeSection,
  review_plan: review,
  edit_fields: editFields,
  template_diff: templateDiff,
  template_from_docx: docxTemplate,
};
