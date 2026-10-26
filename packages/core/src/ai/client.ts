import { BedrockRuntimeClient, ConverseCommand, type ContentBlock, type SystemContentBlock } from "@aws-sdk/client-bedrock-runtime";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { estimateCost, modelFor, type AiStep, type ModelKey } from "@aba/config/models";
import { env } from "../env";
import { log, SafeError } from "../logger";

/**
 * All AI calls go through this module and only to Amazon Bedrock (Converse API).
 * Structured outputs use forced tool-use with a JSON schema; invalid output is
 * retried once, then surfaced as an error and never silently saved.
 */

export interface AiContext {
  tenantId: string;
  planId?: string | null;
  complexCase?: boolean;
}

export interface UsageRecord {
  tenantId: string;
  planId?: string | null;
  step: AiStep;
  model: string;
  modelKey: ModelKey;
  inputTokens: number;
  outputTokens: number;
  estCost: number;
  latencyMs: number;
}

export interface StructuredRequest<T> {
  step: AiStep;
  ctx: AiContext;
  system: string;
  /** Large, stable context (template etc.) placed before a cache point. */
  cachedContext?: string;
  user: string;
  toolName: string;
  toolDescription: string;
  schema: z.ZodType<T>;
  /** Structured inputs the prompt was built from. Used only by the local mock client. */
  mockInput?: unknown;
  maxTokens?: number;
}

export interface AiClient {
  structured<T>(req: StructuredRequest<T>): Promise<T>;
}

type UsageSink = (u: UsageRecord) => Promise<void> | void;
let usageSink: UsageSink = () => {};
export function setUsageSink(s: UsageSink) {
  usageSink = s;
}

export class AiOutputError extends SafeError {
  constructor(step: string) {
    super(`The AI returned an invalid result for ${step} twice. Nothing was saved. Please try again.`, 502);
  }
}

async function record(ctx: AiContext, step: AiStep, key: ModelKey, id: string, inTok: number, outTok: number, latencyMs: number) {
  const est = estimateCost(key, inTok, outTok);
  log.info({ event: "ai_call", tenantId: ctx.tenantId, planId: ctx.planId ?? undefined, step, model: id, inputTokens: inTok, outputTokens: outTok, latencyMs });
  await usageSink({ tenantId: ctx.tenantId, planId: ctx.planId, step, model: id, modelKey: key, inputTokens: inTok, outputTokens: outTok, estCost: est, latencyMs });
}

export class BedrockAiClient implements AiClient {
  private client: BedrockRuntimeClient;
  constructor(region = env().region) {
    this.client = new BedrockRuntimeClient({ region });
  }

  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    const { key, id } = modelFor(req.step, { complexCase: req.ctx.complexCase });
    const jsonSchema = zodToJsonSchema(req.schema, { target: "jsonSchema7", $refStrategy: "none" }) as Record<string, unknown>;
    delete jsonSchema.$schema;
    const system: SystemContentBlock[] = [{ text: req.system }];
    if (req.cachedContext) system.push({ text: req.cachedContext });
    system.push({ cachePoint: { type: "default" } });

    let lastIssue = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      const user: ContentBlock[] = [{ text: req.user }];
      if (attempt === 2) user.push({ text: `Your previous output did not match the required schema (${lastIssue}). Call ${req.toolName} again with valid input.` });
      const started = Date.now();
      const res = await this.client.send(
        new ConverseCommand({
          modelId: id,
          system,
          messages: [{ role: "user", content: user }],
          inferenceConfig: { maxTokens: req.maxTokens ?? 4096, temperature: 0.2 },
          toolConfig: {
            tools: [{ toolSpec: { name: req.toolName, description: req.toolDescription, inputSchema: { json: jsonSchema as never } } }],
            toolChoice: { tool: { name: req.toolName } },
          },
        }),
      );
      await record(req.ctx, req.step, key, id, res.usage?.inputTokens ?? 0, res.usage?.outputTokens ?? 0, Date.now() - started);
      const block = res.output?.message?.content?.find((b) => b.toolUse);
      const parsed = req.schema.safeParse(block?.toolUse?.input);
      if (parsed.success) return parsed.data;
      lastIssue = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      log.warn({ event: "ai_invalid_output", step: req.step, attempt, planId: req.ctx.planId ?? undefined });
    }
    throw new AiOutputError(req.step);
  }
}

/**
 * Local-mode client: runs deterministic handlers on req.mockInput so the whole
 * pipeline can be exercised with synthetic data and no AWS account. Still
 * validates output against the schema and retries once, exactly like Bedrock.
 */
export type MockHandler = (input: unknown, req: StructuredRequest<unknown>, attempt: number) => unknown;

export class MockAiClient implements AiClient {
  constructor(private handlers: Record<string, MockHandler>) {}

  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    const { key, id } = modelFor(req.step, { complexCase: req.ctx.complexCase });
    const handler = this.handlers[req.toolName];
    if (!handler) throw new Error(`No mock handler for ${req.toolName}`);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const started = Date.now();
      const out = handler(req.mockInput, req as StructuredRequest<unknown>, attempt);
      const approxIn = Math.ceil((req.system.length + (req.cachedContext?.length ?? 0) + req.user.length) / 4);
      const approxOut = Math.ceil(JSON.stringify(out ?? null).length / 4);
      await record(req.ctx, req.step, key, id, approxIn, approxOut, Date.now() - started);
      const parsed = req.schema.safeParse(out);
      if (parsed.success) return parsed.data;
      log.warn({ event: "ai_invalid_output", step: req.step, attempt });
    }
    throw new AiOutputError(req.step);
  }
}

let instance: AiClient | null = null;

export function setAiClient(c: AiClient | null) {
  instance = c;
}

export async function ai(): Promise<AiClient> {
  if (instance) return instance;
  if (env().mode === "aws") instance = new BedrockAiClient();
  else {
    const { mockHandlers } = await import("./mock");
    instance = new MockAiClient(mockHandlers);
  }
  return instance;
}
