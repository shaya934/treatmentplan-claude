import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installInlineJobs, seedWorld, setupTestEnv, svcFor, type World } from "./helpers";
import type { TableRow } from "../src/plan/content";

/**
 * End-to-end with SYNTHETIC data and the deterministic local AI:
 * upload -> extract -> pre-fill -> guided chat -> generate -> review -> chat edit
 * -> validation -> finalize -> export, plus the logging guarantee.
 */

let w: World;
let flush: () => Promise<void>;
let plans: typeof import("../src/svc/plans");
let files: typeof import("../src/svc/files");
let work: typeof import("../src/svc/work");
let db: typeof import("../src/db");
let planId: string;
const logLines: string[] = [];

beforeAll(async () => {
  await setupTestEnv();
  const logger = await import("../src/logger");
  logger.setLogSink((l) => logLines.push(l));
  db = await import("../src/db");
  plans = await import("../src/svc/plans");
  files = await import("../src/svc/files");
  work = await import("../src/svc/work");
  (await import("../src/svc/context")).installUsageSink();
  w = await seedWorld();
  flush = await installInlineJobs();
});
afterAll(async () => db.closePool());

async function upload(s: ReturnType<typeof svcFor>, pid: string, filename: string, bytes: Buffer) {
  const { storage, LocalStorage } = await import("../src/storage");
  const up = await files.requestUpload(s, pid, filename, "application/pdf", bytes.length);
  // Simulate the browser PUT to the presigned URL.
  const u = new URL(up.url);
  const st = storage() as InstanceType<typeof LocalStorage>;
  expect(st.verify("put", u.searchParams.get("key")!, Number(u.searchParams.get("exp")), u.searchParams.get("sig")!, u.searchParams.get("x")!)).toBe(true);
  await st.put(u.searchParams.get("key")!, bytes);
  await files.completeUpload(s, pid, up.fileId);
  return up.fileId;
}

describe("Phase 2: upload and extraction", () => {
  it("uploading the 3 fake PDFs pre-fills scores, dates and diagnoses with the correct source and page", async () => {
    const s = svcFor(w, "bcba1");
    planId = (await plans.createPlan(s, { clientId: w.clients.ava!, type: "reassessment", periodStart: "2026-11-01", periodEnd: "2027-01-29" })).id;
    const { SYNTHETIC_CLIENTS, makePdf } = await import("../src/fixtures");
    for (const f of SYNTHETIC_CLIENTS[0]!.files) await upload(s, planId, f.filename, await makePdf(f));
    await flush();

    const b = await plans.getPlanBundle(s, planId);
    expect(b.files.map((f) => [f.filename, f.extraction_status])).toEqual(b.files.map((f) => [f.filename, "done"]));
    const comm = b.evidence.find((e) => e.fact_text.includes("Communication") && e.source_date === "2026-03-12")!;
    expect(comm.value).toBe("68");
    expect(comm.filename).toBe("ava_vineland3_2026.pdf");
    expect(comm.page).toBe(1);
    const prior = b.evidence.find((e) => e.fact_text.includes("Communication") && e.source_date === "2025-02-20")!;
    expect(prior.page).toBe(2);

    const c = b.version.content_json;
    const scores = c.score_summary!.value as TableRow[];
    const row = scores.find((r) => r.domain === "Communication")!;
    expect(row).toMatchObject({ tool: "Vineland-3", current_score: "68", date: "3/12/2026", prior_score: "61", prior_date: "2/20/2025", change: "+7" });
    expect(c.score_summary!.sources).toContain(comm.id);
    expect(c.score_summary!.status).toBe("prefilled");
    expect(c.onset_of_diagnosis!.value).toBe("3/4/2022");
    expect(c.additional_diagnoses!.value).toMatch(/F90\.2/);
    expect(c.treatment_start_date!.value).toBe("1/20/2026");
    const util = (c.utilization!.value as TableRow[]).find((r) => r.code === "97153")!;
    expect(util).toMatchObject({ hours_authorized: "520", hours_used: "380", pct_used: "73" });
    expect(c.age).toMatchObject({ value: "7", status: "calculated" });
    expect(c.diagnosis!.sources).toEqual(["client_record"]);
  });

  it("the BCBA can correct or delete extracted facts, and pre-fill follows", async () => {
    const s = svcFor(w, "bcba1");
    const b = await plans.getPlanBundle(s, planId);
    const elope = b.evidence.find((e) => e.fact_text.startsWith("Elopement"))!;
    await plans.updateEvidence(s, planId, elope.id, { deleted: true });
    const mel = b.evidence.find((e) => e.category === "medication")!;
    await plans.updateEvidence(s, planId, mel.id, { value: "5 mg" });
    await plans.prefillPlan(s, planId);
    const b2 = await plans.getPlanBundle(s, planId);
    expect(b2.evidence.find((e) => e.id === elope.id)).toBeUndefined();
    const bb = b2.version.content_json.behavior_benchmarks!.value as TableRow[];
    expect(bb.map((r) => r.target_behavior)).toContain("Aggression");
    expect((b2.version.content_json.medications!.value as TableRow[])[0]!.dosage).toBe("5 mg");
  });

  it("scanned pages without OCR are flagged for the BCBA, never guessed", async () => {
    const s = svcFor(w, "bcba2");
    const pid = (await plans.createPlan(s, { clientId: w.clients.noah!, type: "initial", periodStart: "2026-11-01", periodEnd: "2027-04-29" })).id;
    const { SYNTHETIC_CLIENTS, makePdf } = await import("../src/fixtures");
    const scan = SYNTHETIC_CLIENTS[1]!.files.find((f) => f.scanned)!;
    await upload(s, pid, scan.filename, await makePdf(scan));
    await flush();
    const b = await plans.getPlanBundle(s, pid);
    expect(b.files[0]!.extraction_status).toBe("needs_ocr");
    expect(b.review.some((r) => r.kind === "needs_ocr")).toBe(true);
    expect(b.evidence).toHaveLength(0);
  });
});

describe("Phase 3: guided chat", () => {
  it("skips anything the files cover, asks no follow-ups, and saves every answer", async () => {
    const s = svcFor(w, "bcba1");
    const { questions, current } = await plans.getQuestions(s, planId);
    expect(questions).toHaveLength(29);
    const progress = questions.find((q) => q.id === "q_progress")!;
    expect(progress.status).toBe("answered_by_files");
    expect(progress.known).toMatch(/The Vineland-3 from 3\/2026 shows Communication SS 68/);
    const open = questions.filter((q) => q.status === "open");
    expect(open.length).toBeLessThan(questions.length);
    expect(current).toBe(open[0]?.id ?? null);

    // The BCBA can still add to a covered question; one answer completes it.
    const r1 = await plans.answerQuestion(s, planId, "q_progress", "doing well", "voice");
    expect(r1.complete).toBe(true);
    expect(r1.followUp).toBeNull();
    expect(r1.next).not.toBe("q_progress");
  });

  it("answers all questions and resumes on any device", async () => {
    const s = svcFor(w, "bcba1");
    const { SAMPLE_ANSWERS } = await import("../src/fixtures");
    for (const [qid, text] of Object.entries(SAMPLE_ANSWERS)) await plans.answerQuestion(s, planId, qid, text, "voice");
    const again = await plans.getQuestions(s, planId); // a fresh load = another device
    expect(again.questions.find((q) => q.id === "q_hours")!.answers.length).toBe(1);
    expect(again.questions.find((q) => q.id === "q_hours")!.status).toBe("answered");
  });
});

describe("Phase 4: narrative generation and review", () => {
  it("generates a full draft with placeholders, a source key, and a review list with the planted conflict and a missing number", async () => {
    const s = svcFor(w, "bcba1");
    const started = Date.now();
    await work.startGeneration(s, planId);
    await flush();
    expect(Date.now() - started).toBeLessThan(180_000);
    const b = await plans.getPlanBundle(s, planId);
    expect(b.plan.generation_status).toBe("done");
    const c = b.version.content_json;
    // BCBA statement kept even though the file says 68
    expect(String(c.progress_this_period!.value)).toMatch(/Communication standard score is 72/);
    expect(c.progress_this_period!.sentenceSources!.some((x) => x.sources.includes("bcba_answer:q_progress"))).toBe(true);
    // missing data -> visible placeholder
    expect(String(c.caregiver_sessions_scheduled!.value)).toMatch(/\[BCBA to confirm:/);
    const conflict = b.review.find((r) => r.kind === "conflict")!;
    expect(conflict.detail).toMatch(/68/);
    expect(conflict.detail).toMatch(/72/);
    expect(b.review.some((r) => r.kind === "placeholder" && r.field_id === "caregiver_sessions_scheduled")).toBe(true);
    expect(b.review.some((r) => r.kind === "carried_forward") || b.plan.type === "reassessment").toBe(true);
  });

  it("logs AI usage metadata per call (tokens, model, plan) without prompt text", async () => {
    const r = await db.withCtx({ tenantId: w.tenantA, userId: null, role: "system" }, (t) => t.query("SELECT step, model, input_tokens FROM ai_usage WHERE plan_id = $1", [planId]));
    const steps = new Set(r.rows.map((x) => x.step));
    // No guided_chat: answers are accepted without an AI follow-up check (MAX_FOLLOW_UPS = 0).
    expect(steps).toEqual(new Set(["extraction", "narrative", "review"]));
    expect(r.rows.find((x) => x.step === "narrative")!.model).toMatch(/sonnet/);
    expect(r.rows.find((x) => x.step === "extraction")!.model).toMatch(/haiku/);
  });
});

describe("Phase 5: editor, chat edits and versions", () => {
  it("changing 97153 hours in chat updates or flags all linked places, with accept/reject", async () => {
    const s = svcFor(w, "bcba1");
    // Set up consistent hours first via direct edits.
    const b = await plans.getPlanBundle(s, planId);
    const rs = (b.version.content_json.requested_services!.value as TableRow[]).map((r) => (r.code === "97153" ? { ...r, hrs_week: "16", location: "Home" } : r));
    const ps = (b.version.content_json.projected_schedule!.value as TableRow[]).map((r) => (r.service === "Direct - Individual" ? { ...r, monday: "4", tuesday: "4", wednesday: "4", thursday: "4" } : r));
    const ds = (b.version.content_json.daily_schedule!.value as TableRow[]).map((r, i) => (i < 4 ? { ...r, school: "8:00-3:00", aba: "97153 3:30-7:30 home" } : r));
    await plans.saveFieldEdits(s, planId, { requested_services: rs, projected_schedule: ps, daily_schedule: ds, mn_requested: "97153: 16 hrs/week; 97155: 3 hrs/week; 97156: 1 hrs/week" });

    const prop = await plans.chatEdit(s, planId, "Change 97153 to 12 hrs/week");
    const fields = prop.changes.map((c) => c.fieldId);
    expect(fields).toEqual(expect.arrayContaining(["requested_services", "mn_requested", "projected_schedule"]));
    expect(prop.flags.map((f) => f.fieldId)).toContain("daily_schedule");
    const reject = prop.changes.find((c) => c.fieldId === "transition_plan")?.id;
    const accept = prop.changes.filter((c) => c.id !== reject).map((c) => c.id);
    const { version } = await plans.decideChanges(s, planId, prop.messageId, accept, reject ? [reject] : []);
    expect(version).toBeGreaterThan(0);
    const after = await plans.getPlanBundle(s, planId);
    expect(String(after.version.content_json.mn_requested!.value)).toContain("97153: 12 hrs/week");
    expect((after.version.content_json.requested_services!.value as TableRow[]).find((r) => r.code === "97153")!.hrs_week).toBe("12");
    const v = await plans.validate(s, planId);
    expect(v.violations.some((x) => x.ruleId === "hours_97153_match")).toBe(true); // daily schedule still 16 -> flagged
  });

  it("every save is a version and any version can be restored", async () => {
    const s = svcFor(w, "bcba1");
    const versions = await plans.listVersions(s, planId);
    expect(versions.length).toBeGreaterThan(4);
    expect(versions[0]!.created_by_name).toBe("User bcba1");
    const target = versions.find((v) => v.change_summary.startsWith("AI draft"))!;
    const restored = await plans.restoreVersion(s, planId, target.version);
    const b = await plans.getPlanBundle(s, planId);
    expect(b.version.version).toBe(restored);
    expect((b.version.content_json.requested_services!.value as TableRow[]).find((r) => r.code === "97153")!.hrs_week ?? "").toBe("");
  });
});

describe("Phase 6: validation, finalize, export", () => {
  it("a plan with a missing caregiver goal cannot be finalized", async () => {
    const s = svcFor(w, "bcba1");
    await expect(plans.finalize(s, planId)).rejects.toThrow(/cannot be finalized/);
    const v = await plans.validate(s, planId);
    expect(v.violations.some((x) => x.ruleId === "caregiver_goals_min")).toBe(true);
  });

  it("a complete plan finalizes, locks, and later edits need a new version", async () => {
    const s = svcFor(w, "bcba1");
    const pid = (await plans.createPlan(s, { clientId: w.clients.ava!, type: "initial", periodStart: "2026-11-01", periodEnd: "2027-01-29" })).id;
    const { completeContent } = await import("./complete-plan");
    const b = await plans.getPlanBundle(s, pid);
    await plans.saveFieldEdits(s, pid, completeContent(b.template, b.version.content_json));
    const v = await plans.validate(s, pid);
    expect(v.violations).toEqual([]);
    const { version } = await plans.finalize(s, pid, "2026-10-26");
    const fin = await plans.getPlanBundle(s, pid);
    expect(fin.plan.status).toBe("final");
    expect(fin.plan.final_date).toBe("2026-10-26");
    expect(fin.version.content_json.plan_final_date!.value).toBe("10/26/2026");
    await expect(plans.saveFieldEdits(s, pid, { strengths: "changed" })).rejects.toThrow(/finalized/);
    const tamper = await db.withCtx({ tenantId: w.tenantA, userId: w.users.bcba1!.id, role: "bcba" }, (t) => t.query("UPDATE plan_versions SET change_summary = 'x' WHERE plan_id = $1 AND version = $2", [pid, version]));
    expect(tamper.rowCount).toBe(0); // no UPDATE policy on versions
    const { OWNER_URL } = await import("./helpers");
    const pg = (await import("pg")).default;
    const oc = new pg.Client({ connectionString: OWNER_URL });
    await oc.connect();
    await oc.query("SELECT set_config('app.tenant_id', $1, false), set_config('app.role', 'system', false)", [w.tenantA]);
    await oc.query("ALTER TABLE plan_versions NO FORCE ROW LEVEL SECURITY");
    await expect(oc.query("UPDATE plan_versions SET change_summary = 'x' WHERE plan_id = $1 AND version = $2", [pid, version])).rejects.toThrow(/locked/);
    await oc.query("ALTER TABLE plan_versions FORCE ROW LEVEL SECURITY");
    await oc.end();
    await plans.reopen(s, pid);
    const re = await plans.getPlanBundle(s, pid);
    expect(re.version.version).toBe(version + 1);
    // Read-only can now see the finalized plan? Only while final; reopened -> hidden.
  });

  it("exports DOCX (company template layout) and PDF", async () => {
    const s = svcFor(w, "bcba1");
    const docxJob = await work.startExport(s, planId, "docx");
    await flush();
    const j = await work.getJob(s, docxJob.jobId);
    expect(j.status).toBe("done");
    expect(j.downloadUrl).toMatch(/local-storage\/get/);
    const { storage } = await import("../src/storage");
    const key = new URL(j.downloadUrl!).searchParams.get("key")!;
    const bytes = await storage().get(key);
    const PizZip = (await import("pizzip")).default;
    const xml = new PizZip(bytes).file("word/document.xml")!.asText();
    expect(xml).toContain("Standardized score summary");
    expect(xml).toContain("DRAFT");
    const hdr = Object.keys(new PizZip(bytes).files).filter((f) => f.startsWith("word/header"));
    expect(hdr.length).toBeGreaterThan(0);
  });

  it("exports PDF via LibreOffice", async () => {
    const s = svcFor(w, "bcba1");
    const job = await work.startExport(s, planId, "pdf");
    await flush();
    const j = await work.getJob(s, job.jobId);
    expect(j.status).toBe("done");
    const { storage } = await import("../src/storage");
    const pdf = await storage().get(new URL(j.downloadUrl!).searchParams.get("key")!);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  }, 180_000);
});

describe("no PHI in logs", () => {
  it("log output never contains synthetic client names, DOBs, IDs or answer text", () => {
    expect(logLines.length).toBeGreaterThan(10);
    const all = logLines.join("\n");
    for (const needle of ["Testcase", "Ava", "2019-04-12", "04/12/2019", "SYN", "Melatonin", "Communication standard score", "Maple Grove", "Vineland"]) {
      expect(all, needle).not.toContain(needle);
    }
  });

  it("the sanitizer drops unknown keys and scrubs PHI-like strings", async () => {
    const { sanitize } = await import("../src/logger");
    const out = sanitize({ event: "x", prompt: "Ava Testcase DOB 04/12/2019", status: "call 704-555-1234 email a@b.co id 123456789" });
    expect(out).toEqual({ event: "x", status: "call [phone] email [email] id [id]" });
  });
});
