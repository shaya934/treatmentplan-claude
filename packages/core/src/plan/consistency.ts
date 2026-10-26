import type { Field, FieldLink, Template } from "../template/schema";
import { allFields } from "../template/schema";
import { cloneContent, findRow, parseNumber, type PlanContent, type TableRow } from "./content";

/**
 * Consistency engine (spec F7). Linked fields are declared in the template
 * (field.links[].group). Changing one value either updates the others after the
 * BCBA confirms (returned as proposed changes) or flags them as mismatched.
 */

export interface LinkReading {
  fieldId: string;
  fieldLabel: string;
  link: FieldLink;
  value: number | null;
}

export interface ProposedChange {
  fieldId: string;
  before: unknown;
  after: unknown;
  reason: string;
}

export interface ConsistencyResult {
  group: string;
  readings: LinkReading[];
  consistent: boolean;
  /** Fields whose value cannot be rewritten automatically and need BCBA attention. */
  flagged: Array<{ fieldId: string; reason: string }>;
  changes: ProposedChange[];
}

const DAY_COLS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function linkGroups(t: Template): Map<string, Array<{ field: Field; link: FieldLink }>> {
  const groups = new Map<string, Array<{ field: Field; link: FieldLink }>>();
  for (const f of allFields(t)) {
    for (const l of f.links) {
      if (!groups.has(l.group)) groups.set(l.group, []);
      groups.get(l.group)!.push({ field: f, link: l });
    }
  }
  return groups;
}

/** "3:00-6:00", "4:15 - 7:15pm", "9am-12pm" -> hours. */
export function parseTimeRanges(text: string): number {
  const re = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*[-–to]+\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/gi;
  let total = 0;
  for (const m of text.matchAll(re)) {
    let s = Number(m[1]) + Number(m[2] ?? 0) / 60;
    let e = Number(m[4]) + Number(m[5] ?? 0) / 60;
    const sp = m[3]?.toLowerCase();
    const ep = m[6]?.toLowerCase();
    if (sp === "pm" && s < 12) s += 12;
    if (ep === "pm" && e < 12) e += 12;
    if (!sp && ep === "pm" && s + 12 < e) s += 12;
    if (e <= s) e += 12;
    total += e - s;
  }
  return Math.round(total * 100) / 100;
}

/** Sum hours of a code across the ABA column of the daily schedule. */
export function scheduleHours(rows: TableRow[], column: string, code: string): number | null {
  let total = 0;
  let found = false;
  for (const r of rows) {
    const cell = r[column] ?? "";
    for (const seg of cell.split(/[;\n]|,(?![^()]*\))/)) {
      if (!seg.includes(code)) continue;
      const h = parseTimeRanges(seg);
      if (h > 0) {
        total += h;
        found = true;
      }
    }
  }
  return found ? Math.round(total * 100) / 100 : null;
}

/** Find hours/week for a code mentioned in free text, e.g. "97153: 15 hrs/week" or "15 hours of 97153". */
export function mentionedHours(text: string, code: string): { value: number; index: number; length: number } | null {
  const esc = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const after = new RegExp(`${esc}[^\\d\\n.;]{0,40}?(\\d+(?:\\.\\d+)?)\\s*(?:hrs?|hours)`, "i");
  const before = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:hrs?|hours)(?:\\s*(?:/|per)\\s*(?:wk|week))?\\s*(?:of\\s+)?${esc}`, "i");
  let m = after.exec(text);
  if (m) {
    const numIdx = m.index + m[0].indexOf(m[1]!, code.length);
    return { value: Number(m[1]), index: numIdx, length: m[1]!.length };
  }
  m = before.exec(text);
  if (m) return { value: Number(m[1]), index: m.index, length: m[1]!.length };
  return null;
}

export function readLink(field: Field, link: FieldLink, content: PlanContent): number | null {
  const v = content[field.id]?.value;
  if (v === null || v === undefined) return null;
  if (link.mode === "mention") return mentionedHours(String(v), link.path ?? "")?.value ?? null;
  if (field.type !== "table") return parseNumber(v);
  const rows = v as TableRow[];
  const path = link.path ?? "";
  if (link.mode === "sum" && path.startsWith("schedule:")) {
    const [, col, code] = path.split(":");
    return scheduleHours(rows, col!, code!);
  }
  const [rowKey, col] = path.split(":");
  const row = findRow(field, rows, rowKey!);
  if (!row) return null;
  if (col === "*") {
    let total = 0;
    let any = false;
    for (const d of DAY_COLS) {
      const n = parseNumber(row[d]);
      if (n !== null) {
        total += n;
        any = true;
      }
    }
    return any ? Math.round(total * 100) / 100 : null;
  }
  return parseNumber(row[col!]);
}

export function checkGroup(t: Template, content: PlanContent, group: string): ConsistencyResult {
  const links = linkGroups(t).get(group) ?? [];
  const readings = links.map(({ field, link }) => ({ fieldId: field.id, fieldLabel: field.label, link, value: readLink(field, link, content) }));
  const present = readings.filter((r) => r.value !== null).map((r) => r.value);
  const consistent = present.every((v) => Math.abs((v as number) - (present[0] as number)) < 0.01);
  const flagged = consistent
    ? []
    : readings.map((r) => ({ fieldId: r.fieldId, reason: `${group.replace("hours_", "")} hours = ${r.value ?? "missing"}` }));
  return { group, readings, consistent, flagged, changes: [] };
}

function round(n: number, step = 0.25) {
  return Math.round(n / step) * step;
}

/**
 * Propose updates so every linked field in the group equals newValue.
 * Narrative mentions are rewritten in place; schedule text cannot be rewritten
 * safely, so it is flagged for the BCBA instead.
 */
export function propagate(t: Template, content: PlanContent, group: string, newValue: number, exceptFieldId?: string): ConsistencyResult {
  const links = linkGroups(t).get(group) ?? [];
  const next = cloneContent(content);
  const changes: ProposedChange[] = [];
  const flagged: Array<{ fieldId: string; reason: string }> = [];
  const code = group.replace("hours_", "");

  for (const { field, link } of links) {
    if (field.id === exceptFieldId) continue;
    const current = readLink(field, link, next);
    if (current !== null && Math.abs(current - newValue) < 0.01) continue;
    const entry = next[field.id] ?? { value: null, status: "needs_bcba" as const, sources: [] };
    const before = JSON.parse(JSON.stringify(entry.value));

    if (link.mode === "mention") {
      const text = String(entry.value ?? "");
      const hit = mentionedHours(text, link.path ?? code);
      if (!hit) {
        flagged.push({ fieldId: field.id, reason: `No ${code} hours found in text; add "${code}: ${newValue} hrs/week"` });
        continue;
      }
      entry.value = text.slice(0, hit.index) + String(newValue) + text.slice(hit.index + hit.length);
    } else if (link.mode === "sum" && (link.path ?? "").startsWith("schedule:")) {
      flagged.push({ fieldId: field.id, reason: `Daily schedule shows ${current ?? 0} hrs of ${code}; adjust the ABA times to total ${newValue} hrs/week` });
      continue;
    } else if (field.type === "table") {
      const rows = (entry.value as TableRow[]) ?? [];
      const [rowKey, col] = (link.path ?? "").split(":");
      let row = findRow(field, rows, rowKey!);
      if (!row) {
        row = { [field.columns![0]!.id]: rowKey! };
        rows.push(row);
      }
      if (col === "*") {
        const used = DAY_COLS.filter((d) => (parseNumber(row![d]) ?? 0) > 0);
        const days = used.length ? used : ["monday", "tuesday", "wednesday", "thursday", "friday"];
        const per = round(newValue / days.length);
        for (const d of DAY_COLS) row[d] = "";
        days.forEach((d, i) => {
          const isLast = i === days.length - 1;
          row![d] = String(isLast ? round(newValue - per * (days.length - 1), 0.01) : per);
        });
      } else {
        row[col!] = String(newValue);
      }
      entry.value = rows;
    } else {
      entry.value = String(newValue);
    }
    next[field.id] = entry;
    changes.push({ fieldId: field.id, before, after: entry.value, reason: `Keep ${code} weekly hours at ${newValue} across linked fields` });
  }
  return { group, readings: links.map(({ field, link }) => ({ fieldId: field.id, fieldLabel: field.label, link, value: readLink(field, link, next) })), consistent: flagged.length === 0, flagged, changes };
}

/** After any edit to a linked field, find groups that changed and propose the propagation. */
export function onFieldChanged(t: Template, before: PlanContent, after: PlanContent, fieldId: string): ConsistencyResult[] {
  const results: ConsistencyResult[] = [];
  for (const [group, links] of linkGroups(t)) {
    for (const { field, link } of links) {
      if (field.id !== fieldId) continue;
      const oldV = readLink(field, link, before);
      const newV = readLink(field, link, after);
      if (newV !== null && oldV !== newV) results.push(propagate(t, after, group, newV, fieldId));
    }
  }
  return results;
}
