import type { Rule, Template } from "../template/schema";
import { allFields, findField } from "../template/schema";
import { checkGroup } from "./consistency";
import { findPlaceholders, isEmptyValue, parseNumber, type PlanContent, type TableRow } from "./content";

/**
 * CCP 8F rule checks (spec F8). Every rule is data in the template, so admins
 * can change thresholds without code changes. A plan can be finalized only
 * when this returns zero errors.
 */

export interface PlanMeta {
  periodStart?: string | null; // ISO date
  periodEnd?: string | null;
  planDate?: string | null;
}

export interface Violation {
  ruleId: string;
  fieldId?: string;
  message: string;
  severity: "error" | "warning";
}

function rows(content: PlanContent, id: string): TableRow[] {
  const v = content[id]?.value;
  return Array.isArray(v) && (v.length === 0 || typeof v[0] === "object") ? (v as TableRow[]) : [];
}

function str(content: PlanContent, id: string): string {
  const v = content[id]?.value;
  return v === null || v === undefined ? "" : String(v);
}

function rowHasData(r: TableRow, skipFirst: boolean, firstCol: string): boolean {
  return Object.entries(r).some(([k, v]) => !(skipFirst && k === firstCol) && String(v ?? "").trim() !== "");
}

function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const iso = /^\d{4}-\d{2}-\d{2}/.test(s) ? new Date(s.slice(0, 10) + "T00:00:00Z") : null;
  if (iso && !isNaN(+iso)) return iso;
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return new Date(Date.UTC(y, Number(m[1]) - 1, Number(m[2])));
  }
  return null;
}

function addMonths(d: Date, months: number): Date {
  const r = new Date(d);
  r.setUTCMonth(r.getUTCMonth() + months);
  return r;
}

function daysBetween(a: Date, b: Date) {
  return Math.round((+b - +a) / 86_400_000);
}

export function runRule(rule: Rule, t: Template, c: PlanContent, meta: PlanMeta): Violation[] {
  const out: Violation[] = [];
  const v = (message: string, fieldId?: string, severity: "error" | "warning" = "error") =>
    out.push({ ruleId: rule.id, fieldId, message, severity });

  switch (rule.kind) {
    case "required_fields": {
      for (const f of allFields(t)) {
        if (f.type === "static" || !f.required) continue;
        if (rule.tag && !f.tags.includes(rule.tag)) continue;
        if (isEmptyValue(f, c[f.id]?.value)) v(`${rule.message ?? "Required field is empty"}: ${f.label}`, f.id);
      }
      break;
    }
    case "linked_equal": {
      const res = checkGroup(t, c, rule.group);
      if (!res.consistent) {
        const detail = res.readings.map((r) => `${r.fieldLabel.split("(")[0]!.trim()}: ${r.value ?? "missing"}`).join("; ");
        v(`${rule.message ?? "Linked values differ"} (${detail})`, res.readings[0]?.fieldId);
      }
      break;
    }
    case "behavior_benchmarks": {
      const f = findField(t, rule.field);
      const first = f?.columns?.[0]?.id ?? "target_behavior";
      const rs = rows(c, rule.field).filter((r) => rowHasData(r, false, first));
      if (rs.length === 0) {
        v(`${f?.label ?? rule.field}: write N/A in the first row if there are no behavior reduction goals`, rule.field);
        break;
      }
      if (/^n\/?a\b/i.test((rs[0]![first] ?? "").trim())) break;
      for (const r of rs) {
        const missing = rule.columns.filter((col) => !(r[col] ?? "").trim());
        if (missing.length) v(`${rule.message ?? "Missing benchmarks"}: "${r[first] || "(unnamed)"}" is missing ${missing.join(", ").toUpperCase()}`, rule.field);
      }
      break;
    }
    case "min_rows": {
      const f = findField(t, rule.field);
      const first = f?.columns?.[0]?.id ?? "";
      const n = rows(c, rule.field).filter((r) => rowHasData(r, !!f?.fixedRows, first)).length;
      if (n < rule.min) v(`${rule.message ?? "Too few rows"} (found ${n})`, rule.field);
      break;
    }
    case "min_value_or_justification": {
      const n = parseNumber(str(c, rule.field));
      let min = rule.min;
      const s = parseDate(meta.periodStart);
      const e = parseDate(meta.periodEnd);
      if (rule.perDays && s && e) min = Math.ceil((rule.min * Math.max(daysBetween(s, e), 1)) / rule.perDays);
      if ((n === null || n < min) && !str(c, rule.justificationField).trim()) {
        v(`${rule.message ?? "Below minimum"} (scheduled ${n ?? "none"}, minimum ${min} for this period)`, rule.field);
      }
      break;
    }
    case "max_date_offset": {
      const base = parseDate(meta.planDate) ?? parseDate(meta.periodStart);
      if (!base) break;
      const limit = addMonths(base, rule.months);
      for (const spec of rule.fields) {
        const [fid, col] = spec.split(":");
        const targets = col ? rows(c, fid!).map((r) => r[col] ?? "") : [str(c, fid!)];
        for (const d of targets) {
          const dt = parseDate(d);
          if (dt && dt > limit) v(`${rule.message ?? "Date too far out"}: ${d}`, fid);
        }
      }
      break;
    }
    case "threshold_requires_explanation": {
      for (const r of rows(c, rule.field)) {
        const pct = parseNumber(r[rule.valueColumn]);
        if (pct !== null && pct < rule.below && !(r[rule.explanationColumn] ?? "").trim()) {
          const label = Object.values(r)[0];
          v(`${rule.message ?? "Below threshold"}: ${label} at ${pct}%`, rule.field);
        }
      }
      break;
    }
    case "forbidden_combination": {
      const cond = c[rule.whenField]?.value;
      if (cond === rule.whenValue || String(cond) === String(rule.whenValue)) {
        for (const r of rows(c, rule.tableField)) {
          if ((r[rule.column] ?? "").trim().toLowerCase() === rule.forbiddenValue.toLowerCase()) {
            v(`${rule.message ?? "Forbidden combination"}: ${Object.values(r)[0]}`, rule.tableField);
          }
        }
      }
      break;
    }
    case "telehealth": {
      for (const r of rows(c, rule.field)) {
        const code = (Object.values(r)[0] ?? "").trim();
        const pct = parseNumber(r[rule.percentColumn]);
        if (pct === null || pct <= 0) continue;
        if (rule.disallowed.includes(code)) v(`${code} cannot be delivered by telehealth`, rule.field);
        const cap = rule.caps[code];
        if (cap !== undefined && pct > cap && !(r[rule.justificationColumn] ?? "").trim()) {
          v(`${code} telehealth is ${pct}% (cap ${cap}%) with no clinical justification`, rule.field);
        }
      }
      if (rule.locationField && rule.locationColumn) {
        for (const r of rows(c, rule.locationField)) {
          const code = (Object.values(r)[0] ?? "").trim();
          if (rule.disallowed.some((d) => code.startsWith(d)) && /tele/i.test(r[rule.locationColumn] ?? "")) {
            v(`${code} cannot be delivered by telehealth (location says telehealth)`, rule.locationField);
          }
        }
      }
      break;
    }
    case "auth_period_limit": {
      const total = rows(c, rule.field).reduce((sum, r) => sum + (parseNumber(r[rule.column]) ?? 0), 0);
      const s = parseDate(meta.periodStart);
      const e = parseDate(meta.periodEnd);
      if (total > rule.thresholdHours && s && e) {
        const days = daysBetween(s, e) + 1;
        if (days > rule.maxDays) v(`${rule.message ?? "Authorization period too long"} (requesting ${total} hrs/week over ${days} days)`, rule.field);
      }
      break;
    }
    case "no_placeholders": {
      for (const p of findPlaceholders(c)) v(`${rule.message ?? "Unresolved placeholder"}: ${p.text}`, p.fieldId);
      break;
    }
  }
  return out;
}

export function validatePlan(t: Template, c: PlanContent, meta: PlanMeta): Violation[] {
  return t.rules.flatMap((r) => runRule(r, t, c, meta));
}
