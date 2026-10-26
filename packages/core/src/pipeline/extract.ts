import { ai, type AiContext } from "../ai/client";
import { EXTRACTION_SYSTEM } from "../ai/prompts";
import { ExtractionOutput, type ExtractedFact } from "../ai/schemas";
import type { PageText } from "./text";

/** Build the evidence table from page text (spec F2). Batches pages to keep prompts small. */
export async function extractFacts(ctx: AiContext, filename: string, pages: PageText[]): Promise<ExtractedFact[]> {
  const readable = pages.filter((p) => p.text.trim());
  const batches: PageText[][] = [];
  let cur: PageText[] = [];
  let size = 0;
  for (const p of readable) {
    if (size + p.text.length > 12_000 && cur.length) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(p);
    size += p.text.length;
  }
  if (cur.length) batches.push(cur);

  const client = await ai();
  const facts: ExtractedFact[] = [];
  for (const batch of batches) {
    const doc = batch.map((p) => `<page number="${p.page}">\n${p.text}\n</page>`).join("\n");
    const out = await client.structured({
      step: "extraction",
      ctx,
      system: EXTRACTION_SYSTEM,
      user: `<document name="${filename.replace(/"/g, "")}">\n${doc}\n</document>\nExtract every clinically relevant fact, one per row, with its page number.`,
      toolName: "record_facts",
      toolDescription: "Record the facts extracted from the document.",
      schema: ExtractionOutput,
      mockInput: { pages: batch },
      maxTokens: 8000,
    });
    const allowed = new Set(batch.map((p) => p.page));
    // Never trust a page number the model made up.
    facts.push(...out.facts.map((f) => ({ ...f, page: allowed.has(f.page) ? f.page : batch[0]!.page })));
  }
  return facts;
}
