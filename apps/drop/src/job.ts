import { pathToFileURL } from "node:url";
import { setAiClient, BedrockAiClient } from "@aba/core/ai/client";
import { setOcr, TextractOcr } from "@aba/core/ocr";
import { draftToPdf, editFormContent, formContentFromDocuments, type FormDraft } from "@aba/core/pipeline/from-documents";
import { audit, cfg } from "./config";
import { store } from "./store";

/**
 * Fill one job's form, or apply a BCBA's edit instruction to it. On AWS this file runs
 * as its own process (forked by the server), so the heavy PDF work never stalls the
 * website; locally, where files are kept in memory, the server calls runJob directly.
 */

/** The answers as stored with the job (graph images base64-encoded). */
interface StoredDraft extends Omit<FormDraft, "figures"> {
  figures: Array<Omit<FormDraft["figures"][number], "png"> & { png: string }>;
}
const toStored = (d: FormDraft): StoredDraft => ({ ...d, figures: d.figures.map((f) => ({ ...f, png: f.png.toString("base64") })) });
const fromStored = (d: StoredDraft): FormDraft => ({ ...d, figures: d.figures.map((f) => ({ ...f, png: Buffer.from(f.png, "base64") })) });

export async function runJob(owner: string, email: string, job: string, mode: "fill" | "edit" = "fill") {
  setAiClient(new BedrockAiClient(cfg.region));
  setOcr(new TextractOcr(cfg.region, cfg.bucket ?? "local"));
  const ctx = { tenantId: "we-achieve", planId: job };
  if (mode === "edit") {
    try {
      const draft = fromStored((await store.getJson<StoredDraft>(owner, job, "draft"))!);
      const { instruction } = (await store.getJson<{ instruction: string }>(owner, job, "edit"))!;
      const { reply, changed } = await editFormContent(ctx, draft, instruction);
      if (changed.length) {
        await store.putOutput(owner, job, await draftToPdf(draft));
        await store.putJson(owner, job, "draft", toStored(draft));
      }
      await store.setStatus(owner, job, { state: "done", updated: changed.length > 0, reply: reply || (changed.length ? `Updated: ${changed.join(", ")}.` : "Nothing was changed.") });
      audit("form_edited", email, { jobId: job, count: changed.length });
    } catch (e) {
      console.error(JSON.stringify({ event: "edit_failed", jobId: job, errorName: (e as Error).name }));
      // The form from before the instruction is still there to download.
      await store.setStatus(owner, job, { state: "done", reply: "Sorry, that change could not be made. The form was not changed; please try again." });
    }
    return;
  }
  try {
    const docs = await store.inputs(owner, job);
    const draft = await formContentFromDocuments(ctx, docs);
    await store.putOutput(owner, job, await draftToPdf(draft));
    await store.putJson(owner, job, "draft", toStored(draft));
    await store.setStatus(owner, job, { state: "done" });
    audit("form_created", email, { jobId: job, count: docs.length });
  } catch (e) {
    console.error(JSON.stringify({ event: "job_failed", jobId: job, errorName: (e as Error).name }));
    await store.setStatus(owner, job, { state: "failed", message: "Something went wrong reading the documents. Please try again." });
    audit("form_failed", email, { jobId: job });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [owner, email, job, mode] = process.argv.slice(2);
  await runJob(owner!, email!, job!, mode === "edit" ? "edit" : "fill");
  process.exit(0);
}
