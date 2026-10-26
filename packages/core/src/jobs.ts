import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { one, type Tx } from "./db";
import { env } from "./env";
import { log } from "./logger";

/**
 * Background jobs: extraction, generation and export. A row in `jobs` tracks
 * status; in AWS the job id goes to SQS and the Fargate worker runs it. In
 * local mode the job runs in-process right after the transaction commits.
 * Messages carry only IDs, never PHI.
 */
export type JobType = "extract" | "generate" | "export";

export interface JobMessage {
  jobId: string;
  tenantId: string;
  type: JobType;
}

type Runner = (m: JobMessage) => Promise<void>;
let localRunner: Runner | null = null;
export function setLocalRunner(r: Runner | null) {
  localRunner = r;
}

let sqs: SQSClient | null = null;

export async function enqueue(t: Tx, type: JobType, payload: Record<string, string>, userId: string | null): Promise<{ id: string; dispatch: () => Promise<void> }> {
  const r = await one<{ id: string; tenant_id: string }>(t, "INSERT INTO jobs (tenant_id, type, payload, created_by) VALUES (app_tenant(),$1,$2,$3) RETURNING id, tenant_id", [type, JSON.stringify(payload), userId]);
  const msg: JobMessage = { jobId: r!.id, tenantId: r!.tenant_id, type };
  // Dispatch after commit so the worker can see the row.
  const dispatch = async () => {
    if (env().mode === "aws") {
      sqs ??= new SQSClient({ region: env().region });
      await sqs.send(new SendMessageCommand({ QueueUrl: env().queueUrl, MessageBody: JSON.stringify(msg) }));
    } else if (localRunner) {
      const run = localRunner;
      setImmediate(() => run(msg).catch((e) => log.error({ event: "job_failed", jobId: msg.jobId, jobType: type }, e)));
    }
  };
  return { id: r!.id, dispatch };
}
