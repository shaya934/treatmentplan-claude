import { many, one, type Tx } from "../db";
import { SafeError } from "../logger";
import { assertCan } from "../rbac";
import { storage } from "../storage";
import { log, tx, type Svc } from "./context";
import { assertPlanEditable, getPlanRow } from "./plans";

/** Graphs found in uploaded files (pipeline/graphs.ts); the BCBA picks which go into the exported plan. */

export interface FigureRow {
  id: string;
  file_id: string | null;
  filename: string | null;
  page: number;
  title: string;
  summary: string;
  include_in_report: boolean;
  s3_key: string;
}

export async function listFigures(s: Svc, planId: string) {
  return tx(s, async (t) => {
    assertCan(s.p, "plan.view");
    await getPlanRow(t, planId);
    if (s.p.role === "read_only") return []; // like source files, graph images are not shown to read-only users
    const rows = await planFigures(t, planId);
    return Promise.all(rows.map(async ({ s3_key, ...r }) => ({ ...r, url: await storage().presignDownload(s3_key, `graph-p${r.page}.png`) })));
  });
}

export async function planFigures(t: Tx, planId: string, onlyIncluded = false): Promise<FigureRow[]> {
  return many<FigureRow>(
    t,
    `SELECT g.id, g.file_id, f.filename, g.page, g.title, g.summary, g.include_in_report, g.s3_key
       FROM figures g LEFT JOIN files f ON f.id = g.file_id
      WHERE g.plan_id = $1 ${onlyIncluded ? "AND g.include_in_report" : ""}
      ORDER BY f.uploaded_at NULLS LAST, g.page, g.created_at`,
    [planId],
  );
}

export async function setFigureIncluded(s: Svc, planId: string, figureId: string, include: boolean) {
  return tx(s, async (t) => {
    await assertPlanEditable(t, s, planId);
    const r = await one(t, "UPDATE figures SET include_in_report = $3 WHERE id = $1 AND plan_id = $2 RETURNING id", [figureId, planId, include]);
    if (!r) throw new SafeError("Graph not found", 404);
    await log(t, s, "update", "figure", figureId, { include });
    return { ok: true };
  });
}

/**
 * Delete figure rows matching a condition and return their S3 keys. Callers delete the
 * objects after the transaction commits (the same order as source files).
 */
export async function deleteFigures(t: Tx, where: "file_id" | "plan_id" | "client", id: string): Promise<string[]> {
  const cond = where === "client" ? "file_id IN (SELECT id FROM files WHERE client_id = $1) OR plan_id IN (SELECT id FROM plans WHERE client_id = $1)" : `${where} = $1`;
  const rows = await many<{ s3_key: string }>(t, `DELETE FROM figures WHERE ${cond} RETURNING s3_key`, [id]);
  return rows.map((r) => r.s3_key);
}

export async function deleteObjects(keys: string[]) {
  for (const k of keys) await storage().delete(k);
}
