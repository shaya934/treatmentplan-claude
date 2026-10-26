import { ai, type AiContext } from "../ai/client";
import { GUIDED_CHAT_SYSTEM } from "../ai/prompts";
import { AnswerAssessment } from "../ai/schemas";
import { valueToText, isEmptyValue, type PlanContent } from "../plan/content";
import type { GuidedQuestion, Template } from "../template/schema";
import { findField, guidedQuestions } from "../template/schema";
import type { BcbaAnswer, Evidence } from "../types";

/** Guided question chat (spec F4). */

export const MAX_FOLLOW_UPS = 2;

export type QuestionStatus = "answered_by_files" | "partial" | "open" | "answered" | "skipped";

export interface QuestionView extends GuidedQuestion {
  status: QuestionStatus;
  /** What is already known from files, shown before the question. */
  known: string | null;
  prompt: string;
  answers: BcbaAnswer[];
}

function isoToUs(d: string | null) {
  const m = d?.match(/^(\d{4})-(\d{2})/);
  return m ? `${Number(m[2])}/${m[1]}` : "";
}

/** Short summary of evidence relevant to a question, e.g. "The Vineland-3 from 3/2026 shows Communication SS 68." */
function knownFromEvidence(fields: ReturnType<typeof findField>[], evidence: Evidence[]): string[] {
  const hints = new Set(fields.flatMap((f) => f?.sourceHints ?? []));
  const out: string[] = [];
  for (const e of evidence) {
    if (e.deleted || !hints.has(e.category) || !e.value) continue;
    if (!["score", "rate", "medication", "service", "iep"].includes(e.category)) continue;
    const when = isoToUs(e.source_date);
    if (e.category === "score") {
      const tool = e.fact_text.match(/^(\S+)/)?.[1] ?? "assessment";
      out.push(`The ${tool}${when ? ` from ${when}` : ""} shows ${e.fact_text.replace(/^\S+\s*/, "").replace(/standard score/i, "SS")} ${e.value}${e.unit && e.unit !== "SS" ? " " + e.unit : ""}.`.replace(/\s+/g, " "));
    } else {
      out.push(`${e.fact_text}: ${e.value}${e.unit ? " " + e.unit : ""}${when ? ` (${when})` : ""}.`);
    }
    if (out.length >= 4) break;
  }
  return out;
}

export function questionViews(t: Template, content: PlanContent, evidence: Evidence[], answers: BcbaAnswer[], skipped: string[] = []): QuestionView[] {
  return guidedQuestions(t).map((q) => {
    const fields = q.fieldIds.map((id) => findField(t, id));
    const filled = fields.filter((f) => f && !isEmptyValue(f, content[f.id]?.value) && content[f.id]?.status !== "needs_bcba");
    const fromFiles = filled.filter((f) => ["prefilled", "calculated", "carried_forward"].includes(content[f!.id]!.status));
    const qa = answers.filter((a) => a.question_id === q.id);
    const knownParts = [
      ...fromFiles.slice(0, 3).map((f) => `${f!.label}: ${valueToText(content[f!.id]!.value).slice(0, 160)}${content[f!.id]!.status === "carried_forward" ? " (carried forward from the last plan)" : ""}.`),
      ...knownFromEvidence(fields, evidence),
    ];
    const known = knownParts.length ? knownParts.join(" ") : null;
    let status: QuestionStatus = "open";
    if (qa.length) status = "answered";
    else if (skipped.includes(q.id)) status = "skipped";
    else if (fromFiles.length === fields.length && fields.every((f) => content[f!.id]?.status !== "carried_forward")) status = "answered_by_files";
    else if (known) status = "partial";
    const prompt = status === "partial" && known ? `${known} Anything to add or correct? ${q.text}` : q.text;
    return { ...q, status, known, prompt, answers: qa };
  });
}

export async function assessAnswer(ctx: AiContext, q: GuidedQuestion, known: string | null, answer: string, followUpsSoFar: number): Promise<AnswerAssessment> {
  if (followUpsSoFar >= MAX_FOLLOW_UPS) return { complete: true, follow_up: null };
  const client = await ai();
  const res = await client.structured({
    step: "guided_chat",
    ctx,
    system: GUIDED_CHAT_SYSTEM,
    user: `Question: ${q.text}\nAlready known from files: ${known ?? "nothing"}\n<answer>\n${answer}\n</answer>\nFollow-ups already asked: ${followUpsSoFar} (max ${MAX_FOLLOW_UPS}).`,
    toolName: "assess_answer",
    toolDescription: "Report whether the answer is complete, or give one short follow-up question.",
    schema: AnswerAssessment,
    mockInput: { question: q, answer, followUpsSoFar },
    maxTokens: 400,
  });
  if (!res.complete && !res.follow_up) return { complete: true, follow_up: null };
  return res;
}
