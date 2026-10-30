import { ai, type AiContext } from "../ai/client";
import { FORM_FROM_DOCUMENTS_SYSTEM } from "../ai/prompts";
import { ImportOutput } from "../ai/schemas";
import { isEmptyValue, type PlanContent } from "../plan/content";
import type { Figure } from "../pdf-form/engine";
import { fillWeAchieveForm } from "../pdf-form/we-achieve";
import { WE_ACHIEVE_FORM_TEMPLATE } from "../template/we-achieve-form";
import type { Field, Section } from "../template/schema";
import { lengthGuide, normalizeValue } from "./generate";
import { graphPageImages, readGraphs } from "./graphs";
import { ageOn } from "./prefill";
import { fileToPages } from "./text";

/**
 * Documents in, filled We Achieve PDF form out. No database: every document is
 * read (text, OCR, graphs), then the form is filled section by section with all
 * documents in the cached context, then typed into the company's own PDF.
 * Anything the documents don't cover stays a yellow [BCBA to confirm: ...] gap.
 */

export interface InputDocument {
  name: string;
  mime: string;
  bytes: Buffer;
  /** Where the file sits in S3, for Textract on scanned PDFs. */
  s3Key: string;
}

/** Longest combined document text sent; ~100k tokens. */
const MAX_CHARS = 400_000;
const PARALLEL = 2;

export async function documentsToForm(ctx: AiContext, docs: InputDocument[], today = new Date()): Promise<Buffer> {
  const t = WE_ACHIEVE_FORM_TEMPLATE;
  const parts: string[] = [];
  const figures: Figure[] = [];
  for (const d of docs) {
    const name = d.name.replace(/["<>]/g, "");
    const pages = await fileToPages(d.bytes, d.mime, d.s3Key);
    const graphs = await readGraphs(ctx, name, await graphPageImages(d.bytes, d.mime));
    const text = pages.map((p) => `<page number="${p.page}">\n${p.needsOcr ? "[unreadable scanned page]" : p.text}\n</page>`);
    const graphText = graphs.map((g) => `<graph page="${g.page}" title="${g.title.replace(/"/g, "")}">\n${g.summary}\n${g.facts.map((f) => f.fact_text).join("\n")}\n</graph>`);
    parts.push(`<document name="${name}">\n${[...text, ...graphText].join("\n")}\n</document>`);
    figures.push(...graphs.map((g) => ({ png: g.png, title: g.title, source: `${d.name}, page ${g.page}`, summary: g.summary })));
  }
  const context = parts.join("\n").slice(0, MAX_CHARS);

  const content: PlanContent = {};
  for (const f of t.sections.flatMap((s) => s.fields)) {
    if (f.fixedRows) content[f.id] = { value: f.fixedRows.map((r) => ({ [f.columns![0]!.id]: r })), status: "prefilled", sources: [] };
  }
  const fillable = (f: Field) => f.type !== "static" && !f.calc;
  const sections = t.sections.filter((s) => s.fields.some(fillable));
  const fill = async (s: Section) => {
    const fields = s.fields.filter(fillable);
    const out = await (await ai()).structured({
      step: "narrative",
      ctx,
      system: FORM_FROM_DOCUMENTS_SYSTEM,
      // The documents are the stable part across sections, so they sit before the cache point.
      cachedContext: context,
      user: `Form section: ${s.title}\n${lengthGuide(fields)}\nFill these fields from the documents.`,
      toolName: "fill_section",
      toolDescription: "Return each field's content for the treatment plan form.",
      schema: ImportOutput,
      maxTokens: 8000,
    });
    const allowed = new Map(fields.map((f) => [f.id, f]));
    for (const o of out.fields) {
      const f = allowed.get(o.field_id);
      if (!f) continue; // never write outside the requested fields
      const value = normalizeValue(f, o.value, content[f.id]?.value ?? null);
      if (!isEmptyValue(f, value)) content[f.id] = { value, status: "prefilled", sources: [] };
    }
  };
  // The first call writes the document cache; the rest read it.
  await fill(sections[0]!);
  const queue = sections.slice(1);
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    for (let s = queue.shift(); s; s = queue.shift()) await fill(s);
  }));

  const us = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
  content.report_started = { value: us(today), status: "calculated", sources: [] };
  const dob = new Date(String(content.dob?.value ?? ""));
  const age = isNaN(+dob) ? null : ageOn(dob.toISOString().slice(0, 10), today);
  if (age !== null) content.age = { value: String(age), status: "calculated", sources: [] };

  return fillWeAchieveForm({ content, firstName: firstName(String(content.client_name?.value ?? "")), draft: true, figures, footer: "We Achieve ABA" });
}

/** "Testcase, Ava" or "Ava Testcase" -> "Ava". */
export function firstName(name: string): string {
  const n = name.replace(/\[[^\]]*\]/g, "").trim();
  if (!n) return "";
  return (n.includes(",") ? n.split(",")[1]! : n).trim().split(/\s+/)[0] ?? "";
}
