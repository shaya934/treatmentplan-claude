import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { closePool, withCtx } from "@aba/core/db";
import { env } from "@aba/core/env";
import type { JobMessage } from "@aba/core/jobs";
import { log } from "@aba/core/logger";
import { runRetention } from "@aba/core/svc/admin";
import { installUsageSink } from "@aba/core/svc/context";
import { runJob } from "@aba/core/svc/work";

/**
 * Fargate worker: long-polls SQS for extraction, generation and export jobs.
 * Messages carry IDs only. Temp files are wiped after every job. Failed jobs
 * are left for SQS redrive to the dead-letter queue after maxReceiveCount.
 * With --retention it runs the per-tenant retention purge once and exits
 * (scheduled daily by EventBridge in infra).
 */
installUsageSink();
const sqs = new SQSClient({ region: env().region });
let stopping = false;
process.on("SIGTERM", () => (stopping = true));

async function wipeTemp() {
  // docxToPdf already removes its own dir; this catches anything left by a crash.
  const dir = tmpdir();
  const { readdir } = await import("node:fs/promises");
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    if (f.startsWith("aba-")) await rm(`${dir}/${f}`, { recursive: true, force: true }).catch(() => {});
  }
}

async function retention() {
  const tenants = await withCtx({ tenantId: null, userId: null, role: "super_admin" }, (t) => t.query("SELECT id FROM tenants WHERE status = 'active'"));
  for (const r of tenants.rows) {
    const res = await runRetention(r.id as string);
    log.info({ event: "retention", tenantId: r.id as string, count: res.files + res.plans });
  }
}

async function loop() {
  log.info({ event: "worker_started" });
  while (!stopping) {
    const res = await sqs.send(new ReceiveMessageCommand({ QueueUrl: env().queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 20, VisibilityTimeout: 900 }));
    for (const m of res.Messages ?? []) {
      let msg: JobMessage;
      try {
        msg = JSON.parse(m.Body ?? "{}");
      } catch {
        await sqs.send(new DeleteMessageCommand({ QueueUrl: env().queueUrl, ReceiptHandle: m.ReceiptHandle! }));
        continue;
      }
      try {
        await runJob(msg);
        await sqs.send(new DeleteMessageCommand({ QueueUrl: env().queueUrl, ReceiptHandle: m.ReceiptHandle! }));
      } catch {
        // left on the queue -> retried, then dead-lettered
      } finally {
        await wipeTemp();
      }
    }
  }
  await closePool();
}

if (process.argv.includes("--retention")) {
  await retention();
  await closePool();
} else {
  await loop();
}
