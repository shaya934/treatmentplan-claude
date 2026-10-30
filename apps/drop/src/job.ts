import { pathToFileURL } from "node:url";
import { setAiClient, BedrockAiClient } from "@aba/core/ai/client";
import { setOcr, TextractOcr } from "@aba/core/ocr";
import { documentsToForm } from "@aba/core/pipeline/from-documents";
import { audit, cfg } from "./config";
import { store } from "./store";

/**
 * Fill one job's form. On AWS this file runs as its own process (forked by the
 * server), so the heavy PDF work never stalls the website; locally, where files
 * are kept in memory, the server calls runJob directly.
 */
export async function runJob(owner: string, email: string, job: string) {
  setAiClient(new BedrockAiClient(cfg.region));
  setOcr(new TextractOcr(cfg.region, cfg.bucket ?? "local"));
  try {
    const docs = await store.inputs(owner, job);
    const pdf = await documentsToForm({ tenantId: "we-achieve", planId: job }, docs);
    await store.putOutput(owner, job, pdf);
    await store.setStatus(owner, job, { state: "done" });
    audit("form_created", email, { jobId: job, count: docs.length });
  } catch (e) {
    console.error(JSON.stringify({ event: "job_failed", jobId: job, errorName: (e as Error).name }));
    await store.setStatus(owner, job, { state: "failed", message: "Something went wrong reading the documents. Please try again." });
    audit("form_failed", email, { jobId: job });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [owner, email, job] = process.argv.slice(2);
  await runJob(owner!, email!, job!);
  process.exit(0);
}
