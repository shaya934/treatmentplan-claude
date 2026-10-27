import { z } from "zod";
import { NextResponse } from "next/server";
import { SafeError } from "@aba/core/logger";
import * as plans from "@aba/core/svc/plans";
import * as files from "@aba/core/svc/files";
import * as work from "@aba/core/svc/work";
import { EvidenceCategory } from "@aba/core/template/schema";
import { one } from "@aba/core/db";
import { tx } from "@aba/core/svc/context";
import { api, body } from "@/lib/api";

/**
 * Plan sub-resources. One dispatcher keeps the many small endpoints together:
 *   GET  versions | versions/:n | questions | chat | validate | jobs | stream
 *   POST fields | restore | files | files/:id/complete | files/:id/delete | evidence | evidence/:id | evidence/confirm-all
 *        prefill | answer | question | generate | chat | chat/decide | review/:id | finalize | reopen
 *        update-template | export | complex-case
 */
type P = { id: string; action: string[] };

const EvidencePatch = z.object({
  fact_text: z.string().min(1).max(500).optional(),
  value: z.string().max(200).nullable().optional(),
  unit: z.string().max(60).nullable().optional(),
  source_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().or(z.literal("")),
  category: EvidenceCategory.optional(),
  deleted: z.boolean().optional(),
  confirmed: z.boolean().optional(),
});

export const GET = api<P>(async ({ svc, params, req }) => {
  const [a, b] = params.action;
  switch (a) {
    case "versions":
      return b ? plans.getVersion(svc, params.id, Number(b)) : plans.listVersions(svc, params.id);
    case "questions": {
      const q = await plans.getQuestions(svc, params.id);
      const messages = await plans.getGuidedMessages(svc, params.id);
      return { ...q, messages };
    }
    case "chat":
      return plans.getEditMessages(svc, params.id);
    case "validate":
      return plans.validate(svc, params.id);
    case "jobs":
      return work.planJobs(svc, params.id);
    case "stream":
      return stream(svc, params.id, req.signal);
  }
  throw new SafeError("Not found", 404);
});

/** Server-sent events while generation runs: each finished section is pushed as soon as it is saved. */
function stream(svc: Parameters<typeof plans.getPlanBundle>[0], planId: string, signal: AbortSignal) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(ctrl) {
      let last = "";
      for (let i = 0; i < 600 && !signal.aborted; i++) {
        const row = await tx(svc, (t) => one<{ generation_status: string; progress: { generated?: Record<string, boolean> }; draft_content: unknown }>(t, "SELECT generation_status, progress, draft_content FROM plans WHERE id = $1", [planId]));
        if (!row) break;
        const key = JSON.stringify(row.progress.generated ?? {}) + row.generation_status;
        if (key !== last) {
          last = key;
          ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ status: row.generation_status, generated: Object.keys(row.progress.generated ?? {}), content: row.draft_content })}\n\n`));
        }
        if (row.generation_status !== "running") break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      ctrl.close();
    },
  });
  return new NextResponse(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" } });
}

export const POST = api<P>(
  async ({ svc, params, req }) => {
  const [a, b, c] = params.action;
  const id = params.id;
  const j = (await body<Record<string, unknown>>(req).catch(() => ({}))) as Record<string, unknown>;
  switch (a) {
    case "fields":
      return plans.saveFieldEdits(svc, id, z.record(z.string(), z.unknown()).parse(j.edits) as never, typeof j.summary === "string" ? j.summary : undefined);
    case "restore":
      return { version: await plans.restoreVersion(svc, id, Number(j.version)) };
    case "files":
      if (!b) return files.requestUpload(svc, id, String(j.filename), String(j.mime), Number(j.size), j.purpose === "previous_plan" ? "previous_plan" : "source");
      if (c === "complete") return files.completeUpload(svc, id, b);
      if (c === "delete") return files.deleteFile(svc, id, b);
      break;
    case "evidence":
      if (!b) return plans.addEvidence(svc, id, z.object({ fact_text: z.string().min(1), category: EvidenceCategory, value: z.string().nullable(), unit: z.string().nullable(), source_date: z.string().nullable() }).parse(j));
      if (b === "confirm-all") return plans.confirmAllEvidence(svc, id);
      return plans.updateEvidence(svc, id, b, EvidencePatch.parse(j) as never);
    case "prefill":
      return { version: await plans.prefillPlan(svc, id) };
    case "answer":
      return plans.answerQuestion(svc, id, String(j.questionId), z.string().min(1).max(20000).parse(j.text), j.mode === "voice" ? "voice" : "typed");
    case "question":
      return { current: await plans.setCurrentQuestion(svc, id, String(j.questionId), !!j.skip) };
    case "generate":
      return work.startGeneration(svc, id);
    case "chat":
      if (b === "decide") return plans.decideChanges(svc, id, String(j.messageId), (j.accept as string[]) ?? [], (j.reject as string[]) ?? []);
      return plans.chatEdit(svc, id, z.string().min(1).max(4000).parse(j.request), j.mode === "voice" ? "voice" : "typed");
    case "review":
      return plans.resolveReviewItem(svc, id, b!, j.resolved !== false);
    case "finalize":
      return plans.finalize(svc, id);
    case "reopen":
      return plans.reopen(svc, id);
    case "update-template":
      return plans.updateToLatestTemplate(svc, id);
    case "export":
      return work.startExport(svc, id, j.format === "pdf" ? "pdf" : "docx");
    case "complex-case":
      return plans.setComplexCase(svc, id, !!j.on);
  }
  throw new SafeError("Not found", 404);
},
  { limit: { key: "plan-write", max: 300, windowSec: 60 } },
);
