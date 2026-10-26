/**
 * Single source of truth for Bedrock model IDs. Change a model here, not in code.
 * Only models on the AWS HIPAA-eligible list may be used. Fable and Mythos models
 * are excluded on Bedrock and must never be added.
 *
 * IDs are Bedrock inference-profile IDs (US cross-region; called from us-east-2). Confirm availability in the
 * Bedrock console (Model access) for the deploying account before first deploy.
 */
export type AiStep =
  | "extraction"
  | "guided_chat"
  | "narrative"
  | "review"
  | "plan_edit"
  | "template_edit"
  | "complex_case";

export const MODEL_IDS = {
  haiku: "us.anthropic.claude-haiku-5-5",
  sonnet: "us.anthropic.claude-sonnet-5-5",
  opus: "us.anthropic.claude-opus-5-5",
} as const;

export type ModelKey = keyof typeof MODEL_IDS;

/** Default model per pipeline step (spec: AI design table). */
export const STEP_MODELS: Record<AiStep, ModelKey> = {
  extraction: "haiku",
  guided_chat: "haiku",
  narrative: "sonnet",
  review: "sonnet",
  plan_edit: "sonnet",
  template_edit: "sonnet",
  complex_case: "opus",
};

/** USD per 1M tokens, used only for the usage dashboard estimate. Update with AWS pricing. */
export const MODEL_PRICING: Record<ModelKey, { input: number; output: number }> = {
  haiku: { input: 1.0, output: 5.0 },
  sonnet: { input: 3.0, output: 15.0 },
  opus: { input: 15.0, output: 75.0 },
};

/** Model IDs IAM is scoped to. Infra reads this list. */
export const APPROVED_MODEL_IDS: string[] = Object.values(MODEL_IDS);

const EXCLUDED = /fable|mythos/i;
for (const id of APPROVED_MODEL_IDS) {
  if (EXCLUDED.test(id)) throw new Error(`Model ${id} is not permitted (not HIPAA-eligible on Bedrock)`);
}

export function modelFor(step: AiStep, opts?: { complexCase?: boolean }): { key: ModelKey; id: string } {
  const key: ModelKey =
    opts?.complexCase && (step === "narrative" || step === "review" || step === "plan_edit")
      ? STEP_MODELS.complex_case
      : STEP_MODELS[step];
  return { key, id: MODEL_IDS[key] };
}

export function estimateCost(key: ModelKey, inputTokens: number, outputTokens: number): number {
  const p = MODEL_PRICING[key];
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}
