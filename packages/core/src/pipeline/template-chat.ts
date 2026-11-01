import mammoth from "mammoth";
import { ai, type AiContext } from "../ai/client";
import { DOCX_TEMPLATE_IMPORT_SYSTEM, TEMPLATE_EDIT_SYSTEM, TEMPLATE_OUTLINE_SYSTEM } from "../ai/prompts";
import { DocxTemplateOutput, TemplateDiffOutput, TemplateOutline, type TemplateOp } from "../ai/schemas";
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

/**
 * Convert a Word template into a structured draft in two passes, so a full plan form
 * never needs one huge model answer (which could be cut off or outlast the request):
 * 1. list the sections with their heading text as written; 2. convert each section's
 * text into fields, a few sections at a time. If the headings can't be found in the
 * text, the whole document is converted in one call as before.
 */
export async function importDocxTemplate(ctx: AiContext, bytes: Buffer, branding: Template["branding"]): Promise<Template> {
  const { value: raw } = await mammoth.extractRawText({ buffer: bytes });
  const text = raw.slice(0, 120_000);
  const client = await ai();
  const convert = (doc: string, maxTokens: number) =>
    client.structured({
      step: "template_edit",
      ctx,
      system: DOCX_TEMPLATE_IMPORT_SYSTEM,
      user: `<document>\n${doc}\n</document>`,
      toolName: "template_from_docx",
      toolDescription: "Return the structured template sections and fields.",
      schema: DocxTemplateOutput,
      mockInput: { text: doc },
      maxTokens,
    });

  const outline = await client.structured({
    step: "template_edit",
    ctx,
    system: TEMPLATE_OUTLINE_SYSTEM,
    user: `<document>\n${text}\n</document>`,
    toolName: "template_outline",
    toolDescription: "List the template's sections in order, with each heading exactly as written.",
    schema: TemplateOutline,
    mockInput: { text },
    maxTokens: 4000,
  });
  const chunks = splitAtHeadings(text, outline.sections);
  const sections: Array<{ id: string; title: string; fields: Array<Record<string, unknown>> }> = [];
  if (!chunks) {
    sections.push(...(await convert(text, 32_000)).sections);
  } else {
    const results = await mapLimit(chunks, 4, async (c) => ({ title: c.title, out: await convert(c.text, 12_000) }));
    for (const r of results) {
      const fields = r.out.sections.flatMap((s) => s.fields);
      if (fields.length) sections.push({ id: r.out.sections[0]?.id ?? r.title, title: r.title, fields });
    }
  }
  return parseTemplate({ name: "Imported template (draft)", sections: uniqueIds(sections), rules: [{ id: "required", kind: "required_fields" }, { id: "no_placeholders", kind: "no_placeholders" }], branding });
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Cut the document text at each listed heading, in order. Null if any heading can't be found. */
export function splitAtHeadings(text: string, sections: Array<{ title: string; heading: string }>): Array<{ title: string; text: string }> | null {
  if (!sections.length) return null;
  const lines = text.split("\n");
  const starts: number[] = [];
  let from = 0;
  for (const s of sections) {
    const h = norm(s.heading);
    const i = lines.findIndex((l, k) => k >= from && h.length > 0 && norm(l).startsWith(h));
    if (i < 0) return null;
    starts.push(i);
    from = i + 1;
  }
  return sections.map((s, n) => ({ title: s.title, text: lines.slice(n === 0 ? 0 : starts[n]!, starts[n + 1] ?? lines.length).join("\n") }));
}

/** Section and field ids must be unique across the whole template. */
function uniqueIds(sections: Array<{ id: string; title: string; fields: Array<Record<string, unknown>> }>) {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "x";
  const used = new Set<string>();
  const uid = (base: string) => {
    let id = slug(base);
    for (let n = 2; used.has(id); n++) id = `${slug(base)}_${n}`;
    used.add(id);
    return id;
  };
  return sections.map((s) => ({ ...s, id: uid(s.id || s.title), fields: s.fields.map((f) => ({ ...f, id: uid(String(f.id ?? f.label ?? "field")) })) }));
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}
