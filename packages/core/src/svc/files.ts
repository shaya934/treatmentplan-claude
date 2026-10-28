import { randomUUID } from "node:crypto";
import { one } from "../db";
import { enqueue } from "../jobs";
import { SafeError } from "../logger";
import { assertCan } from "../rbac";
import { ALLOWED_MIME, fileKey, MAX_UPLOAD_BYTES, storage } from "../storage";
import { log, tx, type Svc } from "./context";
import { deleteFigures, deleteObjects } from "./figures";
import { assertPlanEditable, getPlanRow, tenantPolicy } from "./plans";

/** Uploads go straight to encrypted S3 via presigned URLs (spec F2). */

/** Which upload box a file came from. previous_plan is copied into the plan; the rest are read for facts and graphs. */
export type FilePurpose = "source" | "previous_plan" | "assessment" | "graphs" | "other";
export const FILE_PURPOSES: FilePurpose[] = ["source", "previous_plan", "assessment", "graphs", "other"];

export async function requestUpload(s: Svc, planId: string, filename: string, mime: string, size: number, purpose: FilePurpose = "source") {
  if (!ALLOWED_MIME[mime]) throw new SafeError("Unsupported file type. Upload PDF, DOCX, PNG/JPG/TIFF, CSV or XLSX.");
  if (purpose === "previous_plan" && !["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"].includes(mime)) {
    throw new SafeError("Upload the previous plan as a Word (.docx) or PDF file.");
  }
  if (size <= 0 || size > MAX_UPLOAD_BYTES) throw new SafeError("Files must be 50 MB or smaller.");
  const safeName = filename.replace(/[\\/\0]/g, "_").slice(0, 200);
  return tx(s, async (t) => {
    assertCan(s.p, "file.upload", await tenantPolicy(t));
    const plan = await assertPlanEditable(t, s, planId);
    const id = randomUUID();
    const key = fileKey(plan.tenant_id, plan.client_id, id, ALLOWED_MIME[mime]!);
    await t.query("INSERT INTO files (id, tenant_id, client_id, plan_id, s3_key, filename, mime, size_bytes, uploaded_by, purpose) VALUES ($1, app_tenant(), $2, $3, $4, $5, $6, $7, $8, $9)", [
      id,
      plan.client_id,
      planId,
      key,
      safeName,
      mime,
      size,
      s.p.userId,
      purpose,
    ]);
    const up = await storage().presignUpload(key, mime, size);
    await log(t, s, "upload", "file", id, { bytes: size });
    return { fileId: id, ...up };
  });
}

/** Called by the browser after the direct upload finishes; queues extraction. */
export async function completeUpload(s: Svc, planId: string, fileId: string) {
  const job = await tx(s, async (t) => {
    await assertPlanEditable(t, s, planId);
    const f = await one<{ id: string; extraction_status: string }>(t, "SELECT id, extraction_status FROM files WHERE id = $1 AND plan_id = $2", [fileId, planId]);
    if (!f) throw new SafeError("File not found", 404);
    await t.query("UPDATE files SET extraction_status = 'uploaded' WHERE id = $1", [fileId]);
    return enqueue(t, "extract", { fileId, planId }, s.p.userId);
  });
  await job.dispatch();
  return { jobId: job.id };
}

export async function downloadUrl(s: Svc, fileId: string) {
  return tx(s, async (t) => {
    const f = await one<{ s3_key: string; filename: string; plan_id: string }>(t, "SELECT s3_key, filename, plan_id FROM files WHERE id = $1", [fileId]);
    if (!f) throw new SafeError("File not found", 404);
    await getPlanRow(t, f.plan_id);
    await log(t, s, "download", "file", fileId);
    return storage().presignDownload(f.s3_key, f.filename);
  });
}

export async function deleteFile(s: Svc, planId: string, fileId: string) {
  const keys = await tx(s, async (t) => {
    await assertPlanEditable(t, s, planId);
    const f = await one<{ s3_key: string }>(t, "SELECT s3_key FROM files WHERE id = $1 AND plan_id = $2", [fileId, planId]);
    if (!f) throw new SafeError("File not found", 404);
    await t.query("UPDATE evidence SET deleted = true WHERE file_id = $1", [fileId]);
    await t.query("UPDATE evidence SET file_id = NULL WHERE file_id = $1", [fileId]);
    const figureKeys = await deleteFigures(t, "file_id", fileId);
    await t.query("DELETE FROM files WHERE id = $1", [fileId]);
    await log(t, s, "delete", "file", fileId);
    return [f.s3_key, ...figureKeys];
  });
  await deleteObjects(keys);
}
