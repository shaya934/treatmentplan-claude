import { describe, expect, it } from "vitest";
import { getDocumentProxy, extractText } from "unpdf";
import { fillWeAchieveForm } from "../src/pdf-form/we-achieve";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Filling the company's own PDF form (assets/we-achieve-form-blank.pdf). SYNTHETIC data only. */

const e = (value: unknown) => ({ value, status: "prefilled" as const, sources: [] as string[] });

async function pages(pdf: Buffer) {
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  return { count: doc.numPages, text: ((await extractText(doc, { mergePages: false })).text as string[]).map((t) => t.replace(/\s+/g, " ")) };
}

describe("We Achieve PDF form", () => {
  it("the blank template holds no client data from the sample it was made from", async () => {
    const { text } = await pages(await readFile(join(import.meta.dirname, "..", "assets", "we-achieve-form-blank.pdf")));
    const all = text.join(" ");
    for (const pii of ["Anabelle", "Lawrence", "Tara", "robinwong", "Calloway", "954984548Q", "02/26/2014", "585-4546"]) expect(all).not.toContain(pii);
    expect(text).toHaveLength(13);
  });

  it("types answers into the form, retypes sentences with the name, and keeps the 13 pages", async () => {
    const content = {
      client_name: e("Testcase, Ava"),
      dob: e("4/12/2019"),
      age: e("7"),
      diagnosis: e("Autism Spectrum Disorder (F84.0)"),
      member_id: e("SYN123456"),
      has_allergies: e(true),
      communication_abilities: e(["Use simple mands"]),
      past_aba: e([{ provider: "Example ABA", dates: "2023 - 2025", discharge_reason: "Moved" }]),
      requested_services: e([{ code: "97153: Adaptive", hrs_week: "15", total_hours: "[BCBA to confirm: total hours]" }]),
      supervising_bcba: e("Jordan Example, BCBA"),
    };
    const pdf = await fillWeAchieveForm({ content: content as never, firstName: "Ava", draft: true, figures: [], footer: "We Achieve ABA" });
    const { count, text } = await pages(pdf);
    expect(count).toBe(13); // nothing overflowed, no graphs: no added pages
    expect(text[0]).toContain("Testcase, Ava");
    expect(text[0]).toContain("SYN123456");
    expect(text[0]).toContain("Ava is a 7-year-old individual who has a diagnosis of Autism Spectrum Disorder (F84.0).");
    expect(text[2]).toContain("Example ABA");
    expect(text[11]).toContain("15");
    expect(text[11]).not.toContain("total hours"); // a gap too long for its cell shrinks to a marker in place
    expect(text[12]).toContain("Page 13 of 13");
    expect(text.join(" ")).not.toContain("Anabelle");
  });

  it("puts long answers and graphs on added pages before the signature page and renumbers", async () => {
    const png = await readFile(join(import.meta.dirname, "..", "assets", "we-achieve-logo.png"));
    const long = "Long developmental history sentence for testing. ".repeat(80);
    const pdf = await fillWeAchieveForm({
      content: { developmental_history: e(long) } as never,
      firstName: "Ava",
      draft: false,
      figures: [{ png, title: "Mands", source: "graphs.pdf, page 2", summary: "Rising trend." }],
      footer: "We Achieve ABA",
    });
    const { count, text } = await pages(pdf);
    expect(count).toBeGreaterThan(13);
    const added = text.slice(13 - 1, count - 1).join(" ");
    expect(added).toContain("Continued Answers");
    expect(added).toContain("Developmental History (continued from page 1)");
    expect(added).toContain("Figure 1. Mands");
    expect(text[count - 1]).toContain("Provider Signature"); // signature page stays last
    expect(text[count - 1]).toContain(`Page ${count} of ${count}`);
  });
});
