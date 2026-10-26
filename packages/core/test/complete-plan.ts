import type { FieldValue, PlanContent, TableRow } from "../src/plan/content";
import { isEmptyValue } from "../src/plan/content";
import { allFields, type Template } from "../src/template/schema";

/** Fills every required field of a plan with SYNTHETIC, rule-compliant values (for finalize tests). */
export function completeContent(t: Template, c: PlanContent): Record<string, FieldValue> {
  const edits: Record<string, FieldValue> = {};
  for (const f of allFields(t)) {
    if (f.type === "static" || !f.required) continue;
    if (!isEmptyValue(f, c[f.id]?.value)) continue;
    if (f.type === "table") {
      const cols = f.columns!;
      const base = ((c[f.id]?.value as TableRow[]) ?? []).length ? (c[f.id]!.value as TableRow[]) : [{ [cols[0]!.id]: "Item" }];
      edits[f.id] = base.map((r) => Object.fromEntries(cols.map((col, i) => [col.id, r[col.id] || (i === 0 ? "Item" : col.type === "number" ? "1" : col.type === "date" ? "6/1/2027" : col.options?.[0] ?? "Synthetic value")])));
    } else if (f.type === "boolean") edits[f.id] = true;
    else if (f.type === "number") edits[f.id] = "6";
    else if (f.type === "date") edits[f.id] = "11/1/2026";
    else if (f.type === "select") edits[f.id] = f.options![0]!;
    else edits[f.id] = `Synthetic text for ${f.label}.`;
  }
  // Rule-specific data.
  edits.behavior_benchmarks = [{ target_behavior: "Aggression", baseline_rate: "2.4 per hour (9/30/2026)", sto1: "50% reduction for 4 weeks", sto2: "75% reduction for 4 weeks", ltg: "0.3 per hour for 8 weeks" }];
  edits.caregiver_goals = [
    { goal: "Implement first-then", baseline: "20%", behavior: "Uses first-then board", mastery: "80% across 3 sessions", timeline: "6/1/2027", priority: "home" },
    { goal: "Support session attendance", baseline: "70%", behavior: "Has client ready at start time", mastery: "90% for 4 weeks", timeline: "6/1/2027", priority: "home" },
  ];
  edits.caregiver_sessions_scheduled = "6";
  edits.goal_data_summary = [{ goal: "Mand for items", baseline: "5/hr (3/2026)", current_level: "18/hr (9/2026)", status: "Progressing", reason: "", target_date: "6/1/2027" }];
  edits.utilization = [
    { code: "97153", hours_authorized: "520", hours_used: "450", pct_used: "87", reason_under_80: "" },
    { code: "97155", hours_authorized: "78", hours_used: "70", pct_used: "90", reason_under_80: "" },
  ];
  edits.fba_behaviors = [{ behavior: "Aggression", status: "Addressed in BIP" }];
  edits.requested_services = [
    { code: "97153", total_hours: "180", total_units: "720", hrs_week: "14", units_week: "56", location: "Home" },
    { code: "97155", total_hours: "26", total_units: "104", hrs_week: "2", units_week: "8", location: "Home" },
    { code: "97156", total_hours: "13", total_units: "52", hrs_week: "1", units_week: "4", location: "Home" },
  ];
  edits.mn_requested = "97153: 14 hrs/week; 97155: 2 hrs/week; 97156: 1 hrs/week";
  edits.projected_schedule = [
    { service: "Direct - Individual", monday: "3.5", tuesday: "3.5", wednesday: "3.5", thursday: "3.5" },
    { service: "Direct/Protocol Modification", monday: "1", wednesday: "1" },
    { service: "Parent Training", thursday: "1" },
  ];
  edits.daily_schedule = ["Monday", "Tuesday", "Wednesday", "Thursday"].map((d) => ({ day: d, school: "8:00-3:00", aba: "97153 3:30-7:00 home", other_therapies: "", non_billable: "3:00-3:30 snack" }));
  edits.transition_plan = [{ phase: "Current", gate: "N/A", h97153: "14", h97155: "2", h97156: "1", timeframe: "Now" }];
  edits.telehealth = [{ code: "97155", pct: "0", justification: "" }];
  edits.hours_confirmation = true;
  return edits;
}
