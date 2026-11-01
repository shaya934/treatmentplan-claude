import { randomUUID } from "node:crypto";
import { many, one, type Tx } from "../db";
import { exportKey, figureKey, storage } from "../storage";
import { docxToPdf, renderDocx } from "../export";
import { enqueue, type JobMessage } from "../jobs";
import { log as plog, SafeError } from "../logger";
import { assertCan } from "../rbac";
import { extractFacts } from "../pipeline/extract";
import { generatePlan } from "../pipeline/generate";
import { graphPageImages, readGraphs, type FoundGraph } from "../pipeline/graphs";
import { fillWeAchieveForm } from "../pdf-form/we-achieve";
import { applyImport, importPreviousPlan, toIsoDate } from "../pipeline/import-plan";
import { deleteFigures, deleteObjects, planFigures } from "./figures";
import { fileToPages } from "../pipeline/text";
import { displayName, firstName } from "../types";
import { log, sysTx, tx, type Svc } from "./context";
import { assertPlanEditable, getAnswers, getClientRow, getEvidence, getPlanRow, latestVersion, loadTemplateVersion, runPrefill, saveVersion } from "./plans";

/**
 * Background work run by the worker (AWS: SQS + Fargate; local: in-process):
 * extraction into the evidence table, section-by-section generation, export.
 */

async function jobRow(t: Tx, id: string) {
  const j = await one<{ id: string; type: string; payload: Record<string, string>; created_by: string | null; status: string }>(t, "SELECT * FROM jobs WHERE id = $1", [id]);
  if (!j) throw new Error("job not found");
  return j;
}

async function setJob(tenantId: string, id: string, status: string, error?: string) {
  await sysTx(tenantId, null, (t) => t.query("UPDATE jobs SET status = $2, error = $3, finished_at = CASE WHEN $2 IN ('done','failed') THEN now() END WHERE id = $1", [id, status, error ?? null]));
}

export async function runJob(m: JobMessage): Promise<void> {
  const job = await sysTx(m.tenantId, null, (t) => jobRow(t, m.jobId));
  if (job.status === "done") return; // SQS may deliver twice
  await setJob(m.tenantId, m.jobId, "running");
  const started = Date.now();
  try {
    if (m.type === "extract") await runExtract(m.tenantId, job.payload.planId!, job.payload.fileId!, job.created_by);
    else if (m.type === "generate") await runGenerate(m.tenantId, job.payload.planId!, job.created_by);
    else if (m.type === "export") await runExport(m.tenantId, job.payload.planId!, job.payload.format as "docx" | "pdf", m.jobId, job.created_by);
    await setJob(m.tenantId, m.jobId, "done");
    plog.info({ event: "job_done", jobId: m.jobId, jobType: m.type, durationMs: Date.now() - started });
  } catch (e) {
    const msg = e instanceof SafeError ? e.publicMessage : "Processing failed. Please try again.";
    if (process.env.ABA_DEBUG_JOBS) console.error(e);
    await setJob(m.tenantId, m.jobId, "failed", msg);
    if (m.type === "extract") await sysTx(m.tenantId, null, (t) => t.query("UPDATE files SET extraction_status = 'failed', extraction_error = $2 WHERE id = $1", [job.payload.fileId, msg]));
    if (m.type === "generate") await sysTx(m.tenantId, null, (t) => t.query("UPDATE plans SET generation_status = 'failed' WHERE id = $1", [job.payload.planId]));
    plog.error({ event: "job_failed", jobId: m.jobId, jobType: m.type }, e);
    throw e;
  }
}

// ----------------------------- extraction ----------------------------------

async function runExtract(tenantId: string, planId: string, fileId: string, userId: string | null) {
  const file = await sysTx(tenantId, userId, async (t) => {
    const f = await one<{ s3_key: string; mime: string; filename: string; plan_id: string; purpose: string }>(t, "SELECT s3_key, mime, filename, plan_id, purpose FROM files WHERE id = $1", [fileId]);
    if (!f) throw new Error("file missing");
    await t.query("UPDATE files SET extraction_status = 'processing' WHERE id = $1", [fileId]);
    return f;
  });
  const plan = await sysTx(tenantId, userId, (t) => getPlanRow(t, planId));
  const bytes = await storage().get(file.s3_key);
  const pages = await fileToPages(bytes, file.mime, file.s3_key);
  if (file.purpose === "previous_plan") return runImport(tenantId, planId, fileId, file.filename, pages, plan.complex_case, userId);
  const ctx = { tenantId, planId, complexCase: plan.complex_case };
  const facts = await extractFacts(ctx, file.filename, pages);
  const needsOcr = pages.filter((p) => p.needsOcr).map((p) => p.page);

  // Graphs: a failure here must not lose the text facts, so it only adds a review item.
  let graphs: FoundGraph[] = [];
  let graphsFailed = false;
  try {
    graphs = await readGraphs(ctx, file.filename, await graphPageImages(bytes, file.mime));
  } catch (e) {
    graphsFailed = true;
    plog.warn({ event: "graph_reading_failed", fileId, error: e instanceof Error ? e.name : "unknown" });
  }
  const figures = graphs.map((g) => ({ ...g, id: randomUUID() }));
  for (const g of figures) await storage().put(figureKey(tenantId, plan.client_id, g.id), g.png, "image/png");

  const oldFigureKeys = await sysTx(tenantId, userId, async (t) => {
    // Lock the plan before any write that takes a FK key-share lock on it, so concurrent jobs serialize cleanly.
    await t.query("SELECT 1 FROM plans WHERE id = $1 FOR UPDATE", [planId]);
    await t.query("DELETE FROM evidence WHERE file_id = $1 AND NOT edited_by_bcba", [fileId]);
    const oldKeys = await deleteFigures(t, "file_id", fileId);
    for (const g of figures) {
      await t.query("INSERT INTO figures (id, tenant_id, plan_id, file_id, page, s3_key, title, summary, include_in_report) VALUES ($1, app_tenant(), $2, $3, $4, $5, $6, $7, $8)", [
        g.id,
        planId,
        fileId,
        g.page,
        figureKey(tenantId, plan.client_id, g.id),
        g.title.slice(0, 300),
        g.summary.slice(0, 2000),
        file.purpose === "graphs", // graphs from the Graphs box go into the report unless the BCBA unticks them
      ]);
    }
    if (graphsFailed) {
      await t.query("INSERT INTO review_items (tenant_id, plan_id, field_id, kind, detail) VALUES (app_tenant(),$1,NULL,'needs_ocr',$2)", [
        planId,
        `${file.filename}: graphs could not be read automatically. Review them and add any trends by hand.`,
      ]);
    }
    for (const f of [...facts, ...graphs.flatMap((g) => g.facts)]) {
      await t.query("INSERT INTO evidence (tenant_id, plan_id, file_id, page, fact_text, category, value, unit, source_date) VALUES (app_tenant(),$1,$2,$3,$4,$5,$6,$7,$8)", [
        planId,
        fileId,
        f.page,
        f.fact_text,
        f.category,
        f.value ?? null,
        f.unit ?? null,
        f.source_date ?? null,
      ]);
    }
    await t.query("UPDATE files SET extraction_status = $2, pages = $3 WHERE id = $1", [fileId, needsOcr.length ? "needs_ocr" : "done", pages.length]);
    if (needsOcr.length) {
      await t.query("INSERT INTO review_items (tenant_id, plan_id, field_id, kind, detail) VALUES (app_tenant(),$1,NULL,'needs_ocr',$2)", [
        planId,
        `${file.filename}: page(s) ${needsOcr.join(", ")} look scanned and could not be read. Review them and add any facts by hand.`,
      ]);
    }
    await runPrefill(null, planId, t, userId);
    return oldKeys;
  });
  await deleteObjects(oldFigureKeys);
}

/** Copy last period's plan (uploaded as Word/PDF) into this plan as carried-forward content. */
async function runImport(tenantId: string, planId: string, fileId: string, filename: string, pages: Awaited<ReturnType<typeof fileToPages>>, complexCase: boolean, userId: string | null) {
  const input = await sysTx(tenantId, userId, async (t) => {
    const plan = await getPlanRow(t, planId);
    const { template } = await loadTemplateVersion(t, plan.template_version_id);
    return { template, current: (await latestVersion(t, planId)).content_json };
  });
  const updates = await importPreviousPlan({ tenantId, planId, complexCase }, input.template, filename, pages, input.current);
  await sysTx(tenantId, userId, async (t) => {
    // Re-read inside the lock and apply only the imported fields, so edits made meanwhile are kept.
    await t.query("SELECT 1 FROM plans WHERE id = $1 FOR UPDATE", [planId]);
    const latest = (await latestVersion(t, planId)).content_json;
    const { content, filled } = applyImport(input.template, latest, updates);
    const s: Svc = { p: { userId: userId ?? "", tenantId, role: "bcba" }, meta: {} };
    if (filled.length) await saveVersion(t, s, planId, content, `Copied ${filled.length} fields from the previous plan (${filename})`);
    for (const fid of filled) {
      await t.query("INSERT INTO review_items (tenant_id, plan_id, field_id, kind, detail) VALUES (app_tenant(),$1,$2,'carried_forward',$3)", [planId, fid, "Carried forward from the previous plan - confirm"]);
    }
    // Fill blanks in the client record (never overwrite), then re-run pre-fill so age etc. follow.
    const val = (id: string) => (filled.includes(id) && typeof content[id]?.value === "string" ? String(content[id]!.value).trim() || null : null);
    const dob = val("dob") ? toIsoDate(val("dob")!) : null;
    const plan = await getPlanRow(t, planId);
    const r = await t.query(
      `UPDATE clients SET dob = coalesce(dob, $2::date), medicaid_id = coalesce(nullif(medicaid_id, ''), $3), payer = coalesce(nullif(payer, ''), $4), gender = coalesce(nullif(gender, ''), $5)
        WHERE id = $1 AND ((dob IS NULL AND $2::date IS NOT NULL) OR (nullif(medicaid_id, '') IS NULL AND $3::text IS NOT NULL)
          OR (nullif(payer, '') IS NULL AND $4::text IS NOT NULL) OR (nullif(gender, '') IS NULL AND $5::text IS NOT NULL))`,
      [plan.client_id, dob, val("member_id"), val("insurance"), val("gender")],
    );
    if (r.rowCount) {
      await log(t, s, "update", "client", plan.client_id, { from: "previous_plan" });
      await runPrefill(null, planId, t, userId);
    }
    const pageCount = pages.length;
    await t.query("UPDATE files SET extraction_status = 'done', pages = $2 WHERE id = $1", [fileId, pageCount]);
    if (!filled.length) {
      await t.query("INSERT INTO review_items (tenant_id, plan_id, field_id, kind, detail) VALUES (app_tenant(),$1,NULL,'needs_ocr',$2)", [
        planId,
        `${filename}: no plan content could be matched to this template. Check it is last period's plan, or copy content in by hand.`,
      ]);
    }
  });
}

// ----------------------------- generation ----------------------------------

export async function startGeneration(s: Svc, planId: string) {
  const job = await tx(s, async (t) => {
    const plan = await assertPlanEditable(t, s, planId);
    if (plan.generation_status === "running") throw new SafeError("Generation is already running.", 409);
    await t.query("UPDATE plans SET generation_status = 'running', progress = progress || '{\"generated\":{}}'::jsonb WHERE id = $1", [planId]);
    await log(t, s, "generate", "plan", planId);
    return enqueue(t, "generate", { planId }, s.p.userId);
  });
  await job.dispatch();
  return { jobId: job.id };
}

async function runGenerate(tenantId: string, planId: string, userId: string | null) {
  const input = await sysTx(tenantId, userId, async (t) => {
    const plan = await getPlanRow(t, planId);
    const { template } = await loadTemplateVersion(t, plan.template_version_id);
    const client = await getClientRow(t, plan.client_id);
    const v = await latestVersion(t, planId);
    return { plan, template, client, content: v.content_json, evidence: await getEvidence(t, planId), answers: await getAnswers(t, planId) };
  });
  const generated: Record<string, boolean> = {};
  const partial = JSON.parse(JSON.stringify(input.content));
  const { content, review } = await generatePlan(
    { tenantId, planId, complexCase: input.plan.complex_case },
    input.template,
    input.content,
    input.evidence,
    input.answers,
    input.client,
    async (sectionId, updates) => {
      // Stream: persist each finished section so the editor can show it immediately.
      generated[sectionId] = true;
      Object.assign(partial, updates);
      await sysTx(tenantId, userId, (t) =>
        t.query("UPDATE plans SET progress = jsonb_set(progress, '{generated}', $2::jsonb), draft_content = $3 WHERE id = $1", [planId, JSON.stringify(generated), JSON.stringify(partial)]),
      );
    },
  );
  await sysTx(tenantId, userId, async (t) => {
    const s: Svc = { p: { userId: userId ?? "", tenantId, role: "bcba" }, meta: {} };
    await saveVersion(t, s, planId, content, "AI draft generated from files and BCBA answers");
    // Replace open machine-generated review items; keep resolved history.
    await t.query("DELETE FROM review_items WHERE plan_id = $1 AND resolved_at IS NULL AND kind <> 'needs_ocr'", [planId]);
    for (const r of review) {
      await t.query("INSERT INTO review_items (tenant_id, plan_id, field_id, kind, detail) VALUES (app_tenant(),$1,$2,$3,$4)", [planId, r.field_id, r.kind, r.detail.slice(0, 2000)]);
    }
    await t.query("UPDATE plans SET generation_status = 'done', draft_content = NULL, progress = jsonb_set(progress, '{generatedAt}', to_jsonb(now()::text)) WHERE id = $1", [planId]);
  });
}

// ------------------------------- export ------------------------------------

export async function startExport(s: Svc, planId: string, format: "docx" | "pdf") {
  const job = await tx(s, async (t) => {
    assertCan(s.p, "plan.export");
    await getPlanRow(t, planId);
    return enqueue(t, "export", { planId, format }, s.p.userId);
  });
  await job.dispatch();
  return { jobId: job.id };
}

async function runExport(tenantId: string, planId: string, format: "docx" | "pdf", jobId: string, userId: string | null) {
  const data = await sysTx(tenantId, userId, async (t) => {
    const plan = await getPlanRow(t, planId);
    const tv = await loadTemplateVersion(t, plan.template_version_id);
    const client = await getClientRow(t, plan.client_id);
    const v = await latestVersion(t, planId);
    const tmpl = await one<{ docx_s3_key: string | null }>(t, "SELECT docx_s3_key FROM templates WHERE id = $1", [tv.template_id]);
    return { plan, template: tv.template, client, version: v, wordKey: tmpl?.docx_s3_key ?? null, figures: await planFigures(t, planId, true) };
  });
  const figures = await Promise.all(
    data.figures.map(async (f) => ({ png: await storage().get(f.s3_key), title: f.title, source: `${f.filename ?? "uploaded file"}, page ${f.page}`, summary: f.summary })),
  );
  const wordTemplate = data.wordKey ? await storage().get(data.wordKey) : null;
  const logo = data.template.branding.logoS3Key ? await storage().get(data.template.branding.logoS3Key).catch(() => null) : null;
  const content = data.version.content_json;
  const vars = {
    first_name: firstName(data.client.name),
    full_name: displayName(data.client.name),
    age: String(content.age?.value ?? ""),
    gender: String(content.gender?.value ?? "").toLowerCase(),
    diagnosis: String(content.diagnosis?.value ?? ""),
    company: data.template.branding.companyName,
  };
  const draft = data.plan.status !== "final";
  // The company's own PDF form is filled directly (templates applied before pdfForm existed are recognized by name).
  const pdfForm = data.template.branding.pdfForm ?? (data.template.name === "We Achieve ABA - Treatment Plan" ? "we-achieve" : undefined);
  let bytes: Buffer;
  if (format === "pdf" && pdfForm === "we-achieve") {
    bytes = await fillWeAchieveForm({ content, firstName: vars.first_name, draft, figures, footer: data.template.branding.footer });
  } else {
    const docx = await renderDocx({ template: data.template, content, vars, wordTemplate, logo, finalDate: data.plan.final_date, draft, planType: data.plan.type, figures });
    bytes = format === "pdf" ? await docxToPdf(docx) : docx;
  }
  const key = exportKey(tenantId, planId, data.version.version, format);
  await storage().put(key, bytes, format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  await sysTx(tenantId, userId, (t) => t.query("UPDATE jobs SET payload = payload || $2::jsonb WHERE id = $1", [jobId, JSON.stringify({ s3Key: key, version: String(data.version.version) })]));
}

export async function getJob(s: Svc, jobId: string) {
  return tx(s, async (t) => {
    const j = await one<{ id: string; type: string; status: string; error: string | null; payload: Record<string, string>; created_by: string | null }>(t, "SELECT id, type, status, error, payload, created_by FROM jobs WHERE id = $1", [jobId]);
    if (!j) throw new SafeError("Job not found", 404);
    if (j.payload.planId) await getPlanRow(t, j.payload.planId); // visibility check via RLS
    let downloadUrl: string | null = null;
    if (j.type === "export" && j.status === "done" && j.payload.s3Key) {
      const plan = await getPlanRow(t, j.payload.planId!);
      const client = await getClientRow(t, plan.client_id);
      const ext = j.payload.format ?? "docx";
      const name = `Treatment Plan - ${displayName(client.name).replace(/[^\w ]/g, "")} - v${j.payload.version}.${ext}`;
      downloadUrl = await storage().presignDownload(j.payload.s3Key, name);
      await log(t, s, "export", "plan", j.payload.planId, { format: ext });
    }
    return { id: j.id, type: j.type, status: j.status, error: j.error, downloadUrl };
  });
}

export async function planJobs(s: Svc, planId: string) {
  return tx(s, (t) => many(t, "SELECT id, type, status, error, created_at FROM jobs WHERE payload->>'planId' = $1 ORDER BY created_at DESC LIMIT 20", [planId]));
}
