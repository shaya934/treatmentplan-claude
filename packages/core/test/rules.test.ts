import { describe, expect, it } from "vitest";
import { WE_ACHIEVE_TEMPLATE as T } from "../src/template/we-achieve-template";
import { allFields, CCP8F_TAG, findField, guidedQuestions } from "../src/template/schema";
import { emptyContent, placeholder, type PlanContent, type TableRow } from "../src/plan/content";
import { validatePlan, runRule } from "../src/plan/validation";
import { checkGroup, mentionedHours, onFieldChanged, parseTimeRanges, propagate, scheduleHours } from "../src/plan/consistency";
import { can } from "../src/rbac";

const meta = { periodStart: "2026-11-01", periodEnd: "2027-01-29", planDate: "2026-11-01" };

function rule(id: string) {
  const r = T.rules.find((x) => x.id === id);
  if (!r) throw new Error(id);
  return r;
}

function setRows(c: PlanContent, id: string, rows: TableRow[]) {
  c[id] = { value: rows, status: "complete", sources: [] };
}

function withHours(h53: number, opts: { mention?: string; schedule?: boolean } = {}): PlanContent {
  const c = emptyContent(T);
  const rs = (c.requested_services!.value as TableRow[]).map((r) => (r.code === "97153" ? { ...r, hrs_week: String(h53), location: "Home" } : r));
  setRows(c, "requested_services", rs);
  c.mn_requested = { value: opts.mention ?? `97153: ${h53} hrs/week; 97155: 3 hrs/week; 97156: 1 hrs/week`, status: "complete", sources: [] };
  const ps = (c.projected_schedule!.value as TableRow[]).map((r) => (r.service === "Direct - Individual" ? { ...r, monday: String(h53 / 4), tuesday: String(h53 / 4), wednesday: String(h53 / 4), thursday: String(h53 / 4) } : r));
  setRows(c, "projected_schedule", ps);
  if (opts.schedule !== false) {
    const per = h53 / 4;
    const ds = (c.daily_schedule!.value as TableRow[]).map((r, i) => (i < 4 ? { ...r, school: "8:00-3:00", aba: `97153 3:30-${3.5 + per === Math.floor(3.5 + per) ? 3.5 + per : `${Math.floor(3.5 + per)}:30`} home` } : r));
    setRows(c, "daily_schedule", ds);
  }
  return c;
}

describe("template (Phase 1)", () => {
  it("imports the We Achieve ABA template with ~150 fields and 29 guided questions", () => {
    const fields = allFields(T);
    expect(fields.length).toBeGreaterThanOrEqual(140);
    expect(guidedQuestions(T)).toHaveLength(29);
    expect(fields.filter((f) => f.tags.includes(CCP8F_TAG)).every((f) => f.required)).toBe(true);
    for (const f of fields) {
      expect(["short", "medium", "narrative"]).toContain(f.lengthType);
      if (f.type === "table") expect(f.columns!.length).toBeGreaterThan(0);
    }
  });

  it("keeps page order: Patient Information first, Signatures last; duplicated blocks merged", () => {
    expect(T.sections[0]!.id).toBe("patient_info");
    expect(T.sections.at(-1)!.id).toBe("signatures");
    expect(T.sections.filter((s) => s.title === "Patient Information")).toHaveLength(1);
  });
});

describe("consistency engine (Phase 5)", () => {
  it("parses schedule time ranges", () => {
    expect(parseTimeRanges("3:30-6:30")).toBe(3);
    expect(parseTimeRanges("9am-12pm")).toBe(3);
    expect(parseTimeRanges("4:15 - 7:15")).toBe(3);
    expect(scheduleHours([{ aba: "97153 3:00-6:00 home; 97155 6:00-6:30" }, { aba: "97153 4:00-6:00" }], "aba", "97153")).toBe(5);
  });

  it("finds hours mentioned in narrative text", () => {
    expect(mentionedHours("Requesting 97153: 15 hrs/week due to school", "97153")?.value).toBe(15);
    expect(mentionedHours("We request 12 hours per week of 97153.", "97153")?.value).toBe(12);
  });

  it("changing 97153 hours updates or flags all 4 linked places", () => {
    const before = withHours(16);
    expect(checkGroup(T, before, "hours_97153").consistent).toBe(true);
    const after = JSON.parse(JSON.stringify(before)) as PlanContent;
    (after.requested_services!.value as TableRow[]).find((r) => r.code === "97153")!.hrs_week = "12";
    const [res] = onFieldChanged(T, before, after, "requested_services");
    expect(res).toBeDefined();
    const touched = new Set([...res!.changes.map((c) => c.fieldId), ...res!.flagged.map((f) => f.fieldId)]);
    expect(touched).toEqual(new Set(["mn_requested", "projected_schedule", "daily_schedule", "transition_plan"]));
    const mn = res!.changes.find((c) => c.fieldId === "mn_requested")!;
    expect(mn.after).toContain("97153: 12 hrs/week");
    expect(res!.flagged.find((f) => f.fieldId === "daily_schedule")!.reason).toMatch(/12 hrs/);
  });

  it("propagate distributes projected schedule across the days in use", () => {
    const c = withHours(16);
    const r = propagate(T, c, "hours_97153", 20, "requested_services");
    const ps = r.changes.find((x) => x.fieldId === "projected_schedule")!.after as TableRow[];
    const row = ps.find((x) => x.service === "Direct - Individual")!;
    expect(["monday", "tuesday", "wednesday", "thursday"].reduce((n, d) => n + Number(row[d]), 0)).toBe(20);
  });
});

describe("CCP 8F validation rules (Phase 6)", () => {
  it("flags missing required ccp8f fields", () => {
    const v = validatePlan(T, emptyContent(T), meta);
    expect(v.some((x) => x.fieldId === "progress_this_period")).toBe(true);
  });

  it("hours must match across linked fields", () => {
    const c = withHours(16);
    expect(runRule(rule("hours_97153_match"), T, c, meta)).toHaveLength(0);
    c.mn_requested!.value = "97153: 20 hrs/week";
    expect(runRule(rule("hours_97153_match"), T, c, meta)).toHaveLength(1);
  });

  it("behavior reduction goals need STO1/STO2/LTG (N/A allowed)", () => {
    const c = emptyContent(T);
    setRows(c, "behavior_benchmarks", [{ target_behavior: "Aggression", baseline_rate: "2.4/hr", sto1: "50% reduction 4 wks", sto2: "", ltg: "" }]);
    expect(runRule(rule("behavior_sto_ltg"), T, c, meta)[0]!.message).toMatch(/STO2, LTG/);
    setRows(c, "behavior_benchmarks", [{ target_behavior: "N/A", baseline_rate: "", sto1: "", sto2: "", ltg: "" }]);
    expect(runRule(rule("behavior_sto_ltg"), T, c, meta)).toHaveLength(0);
  });

  it("requires at least 2 caregiver goals", () => {
    const c = emptyContent(T);
    setRows(c, "caregiver_goals", [{ goal: "Use first-then", baseline: "20%", behavior: "x", mastery: "80% 3 sessions", timeline: "5/1/2027", priority: "home" }]);
    expect(runRule(rule("caregiver_goals_min"), T, c, meta)).toHaveLength(1);
    setRows(c, "caregiver_goals", [
      { goal: "a", baseline: "", behavior: "", mastery: "", timeline: "", priority: "" },
      { goal: "b", baseline: "", behavior: "", mastery: "", timeline: "", priority: "" },
    ]);
    expect(runRule(rule("caregiver_goals_min"), T, c, meta)).toHaveLength(0);
  });

  it("requires 6 caregiver sessions per 180 days (pro-rated) or a justification", () => {
    const c = emptyContent(T);
    c.caregiver_sessions_scheduled = { value: "2", status: "complete", sources: [] };
    expect(runRule(rule("caregiver_sessions_min"), T, c, meta)).toHaveLength(1); // 89-day period needs 3
    c.caregiver_sessions_scheduled.value = "3";
    expect(runRule(rule("caregiver_sessions_min"), T, c, meta)).toHaveLength(0);
    c.caregiver_sessions_scheduled.value = "1";
    c.caregiver_sessions_justification = { value: "Caregiver works nights; sessions offered weekly by telehealth.", status: "complete", sources: [] };
    expect(runRule(rule("caregiver_sessions_min"), T, c, meta)).toHaveLength(0);
  });

  it("target dates no more than 12 months out", () => {
    const c = emptyContent(T);
    setRows(c, "goal_data_summary", [{ goal: "Mand", baseline: "", current_level: "", status: "New", reason: "", target_date: "12/01/2027" }]);
    expect(runRule(rule("target_dates_12mo"), T, c, meta)).toHaveLength(1);
    setRows(c, "goal_data_summary", [{ goal: "Mand", baseline: "", current_level: "", status: "New", reason: "", target_date: "10/01/2027" }]);
    expect(runRule(rule("target_dates_12mo"), T, c, meta)).toHaveLength(0);
  });

  it("utilization under 80% needs an explanation", () => {
    const c = emptyContent(T);
    setRows(c, "utilization", [{ code: "97153", hours_authorized: "520", hours_used: "380", pct_used: "73", reason_under_80: "" }]);
    expect(runRule(rule("utilization_80"), T, c, meta)).toHaveLength(1);
    (c.utilization!.value as TableRow[])[0]!.reason_under_80 = "Staffing gap 3/1-4/15/2026";
    expect(runRule(rule("utilization_80"), T, c, meta)).toHaveLength(0);
  });

  it("no BIP attached while a behavior is still 'FBA will be conducted'", () => {
    const c = emptyContent(T);
    c.bip_attached = { value: true, status: "complete", sources: [] };
    setRows(c, "fba_behaviors", [{ behavior: "Aggression", status: "FBA will be conducted" }]);
    expect(runRule(rule("bip_vs_fba"), T, c, meta)).toHaveLength(1);
    c.bip_attached.value = false;
    expect(runRule(rule("bip_vs_fba"), T, c, meta)).toHaveLength(0);
  });

  it("telehealth: 97153 never; 97155 <= 50% unless justified", () => {
    const c = emptyContent(T);
    setRows(c, "telehealth", [{ code: "97155", pct: "60", justification: "" }]);
    expect(runRule(rule("telehealth_rules"), T, c, meta)).toHaveLength(1);
    setRows(c, "telehealth", [{ code: "97155", pct: "60", justification: "No in-person bilingual BCBA in county" }]);
    expect(runRule(rule("telehealth_rules"), T, c, meta)).toHaveLength(0);
    setRows(c, "requested_services", [{ code: "97153", hrs_week: "10", location: "Telehealth" }]);
    expect(runRule(rule("telehealth_rules"), T, c, meta)[0]!.message).toMatch(/97153 cannot/);
  });

  it("over 16 hrs/week limits the authorization to 90 days", () => {
    const c = emptyContent(T);
    setRows(c, "requested_services", [{ code: "97153", hrs_week: "15" }, { code: "97155", hrs_week: "3" }]);
    expect(runRule(rule("auth_16h_90d"), T, c, { periodStart: "2026-11-01", periodEnd: "2027-04-30" })).toHaveLength(1);
    expect(runRule(rule("auth_16h_90d"), T, c, { periodStart: "2026-11-01", periodEnd: "2027-01-29" })).toHaveLength(0);
  });

  it("no unresolved placeholders", () => {
    const c = emptyContent(T);
    c.strengths = { value: `Ava enjoys puzzles. ${placeholder("preferred reinforcers")}`, status: "needs_bcba", sources: [] };
    expect(runRule(rule("no_placeholders"), T, c, meta)).toHaveLength(1);
  });

  it("rules are data: changing the template threshold changes the check", () => {
    const c = emptyContent(T);
    setRows(c, "caregiver_goals", [{ goal: "a" }, { goal: "b" }]);
    const strict = { ...rule("caregiver_goals_min"), min: 3 } as never;
    expect(runRule(strict, T, c, meta)).toHaveLength(1);
  });
});

describe("role permissions", () => {
  const p = (role: string, credential: string | null = null) => ({ userId: "u", tenantId: "t", role: role as never, credential });
  it("matches the spec role table", () => {
    expect(can(p("company_admin"), "template.edit")).toBe(true);
    expect(can(p("company_admin"), "plan.finalize")).toBe(false);
    expect(can(p("company_admin", "BCBA"), "plan.finalize")).toBe(true);
    expect(can(p("clinical_director"), "plan.edit")).toBe(true);
    expect(can(p("clinical_director"), "template.edit")).toBe(false);
    expect(can(p("clinical_director"), "plan.finalize")).toBe(false);
    expect(can(p("clinical_director"), "plan.finalize", { clinicalDirectorCanFinalize: true })).toBe(true);
    expect(can(p("bcba"), "plan.finalize")).toBe(true);
    expect(can(p("bcba"), "template.edit")).toBe(false);
    expect(can(p("read_only"), "plan.edit")).toBe(false);
    expect(can(p("read_only"), "plan.export")).toBe(true);
    expect(can(p("super_admin"), "plan.view")).toBe(false);
    expect(can(p("super_admin"), "tenant.manage")).toBe(true);
  });
  it("findField works for every rule reference", () => {
    for (const r of T.rules) if ("field" in r) expect(findField(T, r.field), r.id).toBeDefined();
  });
});
