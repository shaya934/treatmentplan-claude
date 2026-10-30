import type { Field, Template } from "../template/schema";
import { allFields } from "../template/schema";

/** Field status shown in the editor (spec F3). */
export type FieldStatus = "prefilled" | "needs_bcba" | "calculated" | "complete" | "carried_forward";

export type TableRow = Record<string, string>;
export type FieldValue = string | number | boolean | string[] | TableRow[] | null;

export interface FieldEntry {
  value: FieldValue;
  status: FieldStatus;
  /** Evidence row IDs (or "client_record", "bcba_answer:<qid>", "previous_plan") backing the value. */
  sources: string[];
  /** Per-sentence evidence links for narrative fields (feeds the Source Key; never shown inline). */
  sentenceSources?: Array<{ sentence: string; sources: string[] }>;
}

export type PlanContent = Record<string, FieldEntry>;

export const PLACEHOLDER_RE = /\[BCBA to confirm:[^\]]*\]/g;
/** Non-global twin for .test() (a /g regex keeps state between calls). */
export const HAS_PLACEHOLDER = /\[BCBA to confirm:[^\]]*\]/;

export function placeholder(what: string): string {
  return `[BCBA to confirm: ${what}]`;
}

/** Dates are shown as M/D/YYYY everywhere; ISO dates ("2026-09-24", also inside ranges) are converted. */
export function usDates(s: string): string {
  return s.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_, y: string, m: string, d: string) => `${Number(m)}/${Number(d)}/${y}`);
}

export function valueToText(v: FieldValue): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) {
    if (v.length && typeof v[0] === "object") return (v as TableRow[]).map((r) => Object.values(r).join(" | ")).join("\n");
    return (v as string[]).join(", ");
  }
  return String(v);
}

export function isEmptyValue(field: Field, v: FieldValue | undefined): boolean {
  if (v === null || v === undefined) return true;
  if (field.type === "boolean") return typeof v !== "boolean";
  if (field.type === "table") {
    const rows = (v as TableRow[]) ?? [];
    const dataCols = (field.columns ?? []).slice(field.fixedRows ? 1 : 0).map((c) => c.id);
    return !rows.some((r) => dataCols.some((c) => (r[c] ?? "").toString().trim() !== ""));
  }
  if (Array.isArray(v)) return v.length === 0;
  return String(v).trim() === "";
}

export function findPlaceholders(content: PlanContent): Array<{ fieldId: string; text: string }> {
  const out: Array<{ fieldId: string; text: string }> = [];
  for (const [fieldId, entry] of Object.entries(content)) {
    const text = valueToText(entry?.value ?? null);
    for (const m of text.match(PLACEHOLDER_RE) ?? []) out.push({ fieldId, text: m });
  }
  return out;
}

/** Fresh content: fixed-row tables are pre-seeded with their row labels. */
export function emptyContent(t: Template): PlanContent {
  const c: PlanContent = {};
  for (const f of allFields(t)) {
    if (f.type === "static") continue;
    let value: FieldValue = null;
    if (f.type === "table") {
      const first = f.columns![0]!.id;
      value = (f.fixedRows ?? []).map((label) => ({ [first]: label }));
    }
    c[f.id] = { value, status: "needs_bcba", sources: [] };
  }
  return c;
}

export function parseNumber(s: unknown): number | null {
  if (typeof s === "number") return Number.isFinite(s) ? s : null;
  if (typeof s !== "string") return null;
  const m = s.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** Find a table row by its label in column 0 (case-insensitive prefix match) or numeric index. */
export function findRow(field: Field, rows: TableRow[], key: string): TableRow | undefined {
  const first = field.columns![0]!.id;
  if (/^\d+$/.test(key) && !field.fixedRows?.length && Number(key) < rows.length && !rows.some((r) => r[first] === key)) {
    return rows[Number(key)];
  }
  const k = key.toLowerCase();
  return rows.find((r) => (r[first] ?? "").toLowerCase() === k) ?? rows.find((r) => (r[first] ?? "").toLowerCase().startsWith(k));
}

export function cloneContent(c: PlanContent): PlanContent {
  return JSON.parse(JSON.stringify(c));
}

/** Resolve {{tokens}} in static template text. */
export function renderStatic(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? placeholder(k.replace(/_/g, " ")));
}
