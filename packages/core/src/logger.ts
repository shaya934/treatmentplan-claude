/**
 * PHI-safe structured logger. Only allow-listed metadata keys are emitted to
 * stdout (CloudWatch). Anything else is dropped, and string values are scrubbed
 * of patterns that look like PHI. Never pass prompt or document text here.
 */

const ALLOWED_KEYS = new Set([
  "event",
  "requestId",
  "tenantId",
  "userId",
  "planId",
  "clientId",
  "fileId",
  "templateId",
  "jobId",
  "jobType",
  "step",
  "model",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "latencyMs",
  "status",
  "statusCode",
  "method",
  "route",
  "attempt",
  "errorCode",
  "errorName",
  "count",
  "durationMs",
  "pages",
  "bytes",
  "mime",
]);

const SCRUBBERS: Array<[RegExp, string]> = [
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn]"],
  [/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, "[date]"],
  [/\b\d{4}-\d{2}-\d{2}\b/g, "[date]"],
  [/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]"],
  [/\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, "[phone]"],
  [/\b\d{6,}\b/g, "[id]"],
];

export function scrub(s: string): string {
  let out = s;
  for (const [re, rep] of SCRUBBERS) out = out.replace(re, rep);
  return out;
}

export type LogFields = Record<string, unknown>;

export function sanitize(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!ALLOWED_KEYS.has(k)) continue;
    if (typeof v === "string") out[k] = k.endsWith("Id") || k === "event" || k === "route" ? v : scrub(v).slice(0, 200);
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

type Sink = (line: string) => void;
let sink: Sink = (line) => process.stdout.write(line + "\n");

export function setLogSink(s: Sink) {
  sink = s;
}

function emit(level: string, fields: LogFields) {
  sink(JSON.stringify({ level, ts: new Date().toISOString(), ...sanitize(fields) }));
}

export const log = {
  info: (fields: LogFields) => emit("info", fields),
  warn: (fields: LogFields) => emit("warn", fields),
  /** Errors are logged by name/code only; messages may contain PHI. */
  error: (fields: LogFields, err?: unknown) => {
    const e = err as { name?: string; code?: string } | undefined;
    emit("error", { ...fields, errorName: e?.name, errorCode: e?.code });
  },
};

/** Generic user-facing error: never echoes input or internal messages (no PHI in error messages). */
export class SafeError extends Error {
  constructor(
    public publicMessage: string,
    public status = 400,
  ) {
    super(publicMessage);
    this.name = "SafeError";
  }
}
