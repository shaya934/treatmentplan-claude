import mammoth from "mammoth";
import { ai, type AiContext } from "../ai/client";
import { DOCX_TEMPLATE_IMPORT_SYSTEM, TEMPLATE_EDIT_SYSTEM } from "../ai/prompts";
import { DocxTemplateOutput, TemplateDiffOutput, type TemplateOp } from "../ai/schemas";
import { applyTemplateOps, type DiffResult } from "../template/diff";
import { parseTemplate, type Template } from "../template/schema";

/** Admin template chatbot (spec F10). */

export interface TemplateProposal extends DiffResult {
  ops: TemplateOp[];
  summary: string;
}

function outline(t: Template): string {
  return t.sections
    .map((s) => `## ${s.id}: ${s.title}\n` + s.fields.map((f) => `- ${f.id} [${f.type}${f.required ? ", required" : ""}${f.tags.length ? ", " + f.tags.join(",") : ""}]: ${f.label}`).join("\n"))
    .join("\n") + `\n## rules\n` + t.rules.map((r) => `- ${r.id}: ${JSON.stringify(r)}`).join("\n");
}

export async function proposeTemplateDiff(ctx: AiContext, t: Template, request: string): Promise<TemplateProposal> {
  const client = await ai();
  const out = await client.structured({
    step: "template_edit",
    ctx,
    system: TEMPLATE_EDIT_SYSTEM,
    cachedContext: `Current template outline:\n${outline(t)}`,
    user: `<request>\n${request}\n</request>`,
    toolName: "template_diff",
    toolDescription: "Return the list of template operations and a one-line summary.",
    schema: TemplateDiffOutput,
    mockInput: { request, template: t },
    maxTokens: 4000,
  });
  const res = applyTemplateOps(t, out.ops);
  return { ...res, ops: out.ops, summary: out.summary };
}

export async function importDocxTemplate(ctx: AiContext, bytes: Buffer, branding: Template["branding"]): Promise<Template> {
  const { value: text } = await mammoth.extractRawText({ buffer: bytes });
  const client = await ai();
  const out = await client.structured({
    step: "template_edit",
    ctx,
    system: DOCX_TEMPLATE_IMPORT_SYSTEM,
    user: `<document>\n${text.slice(0, 120_000)}\n</document>`,
    toolName: "template_from_docx",
    toolDescription: "Return the structured template sections and fields.",
    schema: DocxTemplateOutput,
    mockInput: { text },
    maxTokens: 16000,
  });
  return parseTemplate({ name: "Imported template (draft)", sections: out.sections, rules: [{ id: "required", kind: "required_fields" }, { id: "no_placeholders", kind: "no_placeholders" }], branding });
}
