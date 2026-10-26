import type { Template } from "../template/schema";
import { allFields, findField } from "../template/schema";
import { cloneContent, emptyContent, findRow, isEmptyValue, parseNumber, type PlanContent, type TableRow } from "../plan/content";
import { readLink } from "../plan/consistency";
import type { BcbaInfo, ClientRecord, Evidence, PlanRecord } from "../types";

/**
 * Pre-fill (spec F3). Deterministic mapping from the client record, the
 * confirmed evidence table and the previous finalized plan into template
 * fields. Every value is tagged with its source. The AI never fills a field
 * here, so no number can be invented at this step.
 */

const TOOL_RE = /(Vineland-?3?|VB-MAPP|ABLLS-?R?|ABAS-?3?|DP-?4|ESDM|SRS-?2|ADOS-?2?)/i;

function isoToUs(d: string | null | undefined): string {
  if (!d) return "";
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[2])}/${Number(m[3])}/${m[1]}` : d;
}

export function ageOn(dob: string, on: Date): number | null {
  const d = new Date(dob.slice(0, 10) + "T00:00:00Z");
  if (isNaN(+d)) return null;
  let age = on.getUTCFullYear() - d.getUTCFullYear();
  const m = on.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && on.getUTCDate() < d.getUTCDate())) age--;
  return age;
}

function set(c: PlanContent, id: string, value: PlanContent[string]["value"], status: PlanContent[string]["status"], sources: string[]) {
  c[id] = { value, status, sources };
}

function addRow(c: PlanContent, t: Template, fieldId: string, row: TableRow, sources: string[], matchKey?: string) {
  const f = findField(t, fieldId);
  if (!f) return;
  const entry = c[fieldId] ?? { value: [], status: "needs_bcba", sources: [] };
  const rows = ((entry.value as TableRow[]) ?? []).slice();
  const first = f.columns![0]!.id;
  const existing = matchKey ? findRow(f, rows, matchKey) : undefined;
  if (existing) Object.assign(existing, Object.fromEntries(Object.entries(row).filter(([, v]) => v !== "")));
  else {
    // fill the first empty non-fixed row, else append
    const empty = f.fixedRows ? undefined : rows.find((r) => Object.values(r).every((v) => !String(v).trim()));
    if (empty) Object.assign(empty, row);
    else rows.push(row[first] !== undefined ? row : { [first]: "", ...row });
  }
  c[fieldId] = { value: rows, status: "prefilled", sources: Array.from(new Set([...(entry.sources ?? []), ...sources])) };
}

export interface PrefillInput {
  template: Template;
  plan: PlanRecord;
  client: ClientRecord;
  bcba: BcbaInfo | null;
  evidence: Evidence[];
  previous?: PlanContent | null;
  existing?: PlanContent | null;
}

export function prefill(input: PrefillInput): PlanContent {
  const { template, existing } = input;
  if (!existing) return prefillFresh(input);
  // Re-run: rebuild everything derived from files, then keep what the BCBA or the AI wrote.
  const fresh = prefillFresh({ ...input, existing: null, previous: null });
  const out = cloneContent(existing);
  for (const f of allFields(template)) {
    if (f.type === "static") continue;
    const old = existing[f.id];
    const nu = fresh[f.id];
    const derived = (e: PlanContent[string] | undefined) => !!e && (e.status === "prefilled" || e.status === "calculated") && !e.sentenceSources?.length;
    if (old?.status === "complete") continue;
    if (nu && derived(nu) && !isEmptyValue(f, nu.value)) out[f.id] = nu;
    else if (!old || derived(old)) out[f.id] = nu ?? old!;
  }
  return out;
}

function prefillFresh({ template, plan, client, bcba, evidence, previous }: PrefillInput): PlanContent {
  const c: PlanContent = emptyContent(template);

  // 1. Carry forward from the previous finalized plan (reassessments).
  if (previous && plan.type === "reassessment") {
    for (const f of allFields(template)) {
      if (f.type === "static" || !f.carryForward) continue;
      const prev = previous[f.id];
      if (prev && !isEmptyValue(f, prev.value)) set(c, f.id, JSON.parse(JSON.stringify(prev.value)), "carried_forward", ["previous_plan"]);
    }
  }

  // 2. Client record.
  const rec = (id: string, v: string | null | undefined) => {
    if (v) set(c, id, v, "prefilled", ["client_record"]);
  };
  rec("client_name", client.name);
  rec("dob", isoToUs(client.dob));
  rec("member_id", client.medicaid_id);
  rec("insurance", client.payer);
  rec("diagnosis", client.diagnosis);
  rec("gender", client.gender ?? null);

  // 3. Calculated fields.
  const calcOn = plan.period_start ? new Date(plan.period_start + "T00:00:00Z") : new Date();
  if (client.dob) {
    const a = ageOn(client.dob, calcOn);
    if (a !== null) set(c, "age", String(a), "calculated", ["client_record"]);
  }
  if (bcba) {
    set(c, "supervising_bcba", `${bcba.name}${bcba.credential ? ", " + bcba.credential : ""}`, "calculated", ["user_record"]);
    if (bcba.npi) set(c, "bcba_npi", bcba.npi, "calculated", ["user_record"]);
  }
  if (plan.period_start && plan.period_end) set(c, "auth_period_requested", `${isoToUs(plan.period_start)} - ${isoToUs(plan.period_end)}`, "calculated", ["plan_record"]);
  if (plan.final_date) set(c, "plan_final_date", isoToUs(plan.final_date), "calculated", ["plan_record"]);

  // 4. Evidence table (only rows not deleted by the BCBA).
  const ev = evidence.filter((e) => !e.deleted);
  const scores = new Map<string, Evidence[]>();
  for (const e of ev) {
    const text = e.fact_text;
    const src = [e.id];
    if (e.category === "score") {
      const tool = text.match(TOOL_RE)?.[1] ?? "";
      const domain = text
        .replace(TOOL_RE, "")
        .replace(/standard score|scaled score|score|\bSS\b|milestones?|level \d/gi, "")
        .replace(/[:\-–]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const k = `${tool.toLowerCase()}|${domain.toLowerCase()}`;
      if (!scores.has(k)) scores.set(k, []);
      scores.get(k)!.push({ ...e, fact_text: `${tool}|${domain}` });
    } else if (e.category === "medication") {
      addRow(c, template, "medications", { medication: text.replace(/^medication:?\s*/i, ""), dosage: e.value ?? "", frequency: e.unit ?? "", notes: "" }, src);
    } else if (e.category === "authorization") {
      const code = text.match(/\b(9715[1-8]|H0032)\b/)?.[1];
      const n = parseNumber(e.value);
      if (code && n !== null && /authori[sz]ed/i.test(text)) addRow(c, template, "utilization", { code, hours_authorized: String(n) }, src, code);
      else if (code && n !== null && /used|delivered|rendered/i.test(text)) addRow(c, template, "utilization", { code, hours_used: String(n) }, src, code);
      else if (/payer|plan type/i.test(text) && e.value) set(c, "payer_type", e.value, "prefilled", src);
      else if (/authori[sz]ation (dates|period)/i.test(text) && e.value) set(c, "current_auth_dates", e.value, "prefilled", src);
      else if (/parent training sessions authori[sz]ed/i.test(text) && n !== null) set(c, "pt_sessions_authorized", String(n), "prefilled", src);
    } else if (e.category === "rate" || e.category === "behavior") {
      const beh = text.match(/^(aggression|self-injur\w*(?: behavior)?|sib|elopement|property destruction|tantrum\w*|[\w -]+?)(?: rate| frequency|:|$)/i)?.[1]?.trim();
      if (beh && e.value && e.category === "rate") {
        const name = beh.charAt(0).toUpperCase() + beh.slice(1);
        addRow(c, template, "behavior_benchmarks", { target_behavior: name, baseline_rate: `${e.value} ${e.unit ?? ""}${e.source_date ? ` (${isoToUs(e.source_date)})` : ""}`.trim() }, src, name);
      }
    } else if (e.category === "diagnosis") {
      if (/onset|diagnosed on/i.test(text) && e.source_date) set(c, "onset_of_diagnosis", isoToUs(e.source_date), "prefilled", src);
      else if (/physician|diagnosed by|psychologist/i.test(text) && e.value) set(c, "diagnosing_physician", e.value, "prefilled", src);
      else if (/F84|autism/i.test(`${text} ${e.value ?? ""}`)) {
        if (isEmptyValue(findField(template, "diagnosis")!, c.diagnosis?.value)) set(c, "diagnosis", e.value ?? text, "prefilled", src);
      } else if (e.value) {
        const prev = c.additional_diagnoses?.status === "prefilled" ? String(c.additional_diagnoses.value ?? "") : "";
        set(c, "additional_diagnoses", prev ? `${prev}; ${e.value}` : e.value, "prefilled", [...(c.additional_diagnoses?.status === "prefilled" ? c.additional_diagnoses.sources : []), ...src]);
      }
    } else if (e.category === "service") {
      addRow(c, template, "other_services", { service: text.replace(/^service:?\s*/i, ""), frequency: e.value ?? "" }, src);
    } else if (e.category === "iep" && /school|daycare/i.test(text) && e.value && /name/i.test(text)) {
      set(c, "school_name", e.value, "prefilled", src);
    } else if (e.category === "date" && e.source_date) {
      if (/treatment start|services (began|started)/i.test(text)) set(c, "treatment_start_date", isoToUs(e.source_date), "prefilled", src);
      else if (/FBA/i.test(text)) set(c, "fba_completed_on", isoToUs(e.source_date), "prefilled", src);
      else if (/97156 data/i.test(text)) set(c, "pt_data_start", isoToUs(e.source_date), "prefilled", src);
    } else if (e.category === "caregiver") {
      const n = parseNumber(e.value);
      if (/sessions delivered/i.test(text) && n !== null) set(c, "pt_sessions_delivered", String(n), "prefilled", src);
      else if (/caregiver name|parent name/i.test(text) && e.value) set(c, "caregiver_name", e.value, "prefilled", src);
    }
  }

  // Scores: latest = current, earlier = prior, change calculated.
  for (const list of scores.values()) {
    list.sort((a, b) => (a.source_date ?? "").localeCompare(b.source_date ?? ""));
    const cur = list[list.length - 1]!;
    const prior = list.length > 1 ? list[list.length - 2]! : null;
    const [tool, domain] = cur.fact_text.split("|");
    const cv = parseNumber(cur.value);
    const pv = prior ? parseNumber(prior.value) : null;
    addRow(
      c,
      template,
      "score_summary",
      {
        tool: tool ?? "",
        domain: domain ?? "",
        current_score: cur.value ?? "",
        date: isoToUs(cur.source_date),
        prior_score: prior?.value ?? "",
        prior_date: isoToUs(prior?.source_date),
        change: cv !== null && pv !== null ? `${cv - pv >= 0 ? "+" : ""}${cv - pv}` : "",
      },
      [cur.id, ...(prior ? [prior.id] : [])],
    );
  }
  // Drop blank seed rows that remain in non-fixed tables after prefill.
  for (const f of allFields(template)) {
    if (f.type !== "table" || f.fixedRows) continue;
    const rows = c[f.id]?.value as TableRow[] | null;
    if (Array.isArray(rows)) c[f.id]!.value = rows.filter((r) => Object.values(r).some((v) => String(v).trim()));
  }

  // Utilization % used is calculated, never extracted.
  const util = c.utilization?.value as TableRow[] | undefined;
  if (util) {
    for (const r of util) {
      const a = parseNumber(r.hours_authorized);
      const u = parseNumber(r.hours_used);
      if (a && u !== null) r.pct_used = String(Math.round((u / a) * 100));
    }
  }
  calcDerived(template, c);
  return c;
}

/** Recompute derived values that depend on other fields (e.g. 97155:97153 ratio). */
export function calcDerived(t: Template, c: PlanContent) {
  const f = findField(t, "requested_services");
  if (!f) return;
  const h53 = readLink(f, { group: "x", path: "97153:hrs_week", mode: "value" }, c);
  const h55 = readLink(f, { group: "x", path: "97155:hrs_week", mode: "value" }, c);
  if (h53 && h55 !== null && c.mn_ratio_97155 && c.mn_ratio_97155.status !== "complete") {
    c.mn_ratio_97155 = { value: `${Math.round((h55 / h53) * 100)}% (${h55} hrs 97155 : ${h53} hrs 97153 per week)`, status: "calculated", sources: ["requested_services"] };
  }
}
