import { afterAll, beforeAll, describe, expect, it } from "vitest";
import PizZip from "pizzip";
import { MockAiClient, setAiClient } from "../src/ai/client";
import { mockHandlers } from "../src/ai/mock";
import { renderDocx } from "../src/export";
import { makeLearningTreePdf } from "../src/fixtures";
import { candidateGraphPages, cropPng, graphPageImages, readGraphs } from "../src/pipeline/graphs";
import { emptyContent } from "../src/plan/content";
import { WE_ACHIEVE_TEMPLATE as T } from "../src/template/we-achieve-template";

/** Graph reading from uploaded files and graphs in the exported plan. SYNTHETIC data only. */

beforeAll(() => setAiClient(new MockAiClient(mockHandlers)));
afterAll(() => setAiClient(null));

const pngSize = (b: Buffer) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) });

describe("graph reading", () => {
  it("sends only pages that draw graphs, not text-only pages", async () => {
    const { getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(await makeLearningTreePdf()));
    expect(await candidateGraphPages(pdf)).toEqual([2]);
  });

  it("renders the graph page, reads it, and crops each graph out of the page", async () => {
    const images = await graphPageImages(await makeLearningTreePdf(), "application/pdf");
    expect(images.map((i) => i.page)).toEqual([2]);
    const page = pngSize(images[0]!.png);
    expect(Math.max(page.w, page.h)).toBeLessThanOrEqual(1600);

    const graphs = await readGraphs({ tenantId: "t" }, "ava_learning_tree_graphs.pdf", images);
    expect(graphs).toHaveLength(1);
    expect(graphs[0]!.facts.every((f) => f.fact_text.startsWith("Graph:") && f.page === 2)).toBe(true);
    const crop = pngSize(graphs[0]!.png);
    expect(crop.w).toBeLessThan(page.w);
    expect(crop.h).toBeLessThan(page.h);
  });

  it("ignores page numbers the model made up and implausible crop boxes", async () => {
    const images = await graphPageImages(await makeLearningTreePdf(), "application/pdf");
    const lying = new MockAiClient({ record_graphs: () => ({ graphs: [{ page: 9, title: "x", summary: "y", facts: [] }] }) });
    setAiClient(lying);
    expect(await readGraphs({ tenantId: "t" }, "f.pdf", images)).toHaveLength(0);
    setAiClient(new MockAiClient(mockHandlers));
    const png = images[0]!.png;
    expect(await cropPng(png, { x: 0, y: 0, w: 0.01, h: 0.01 })).toBe(png);
    expect(await cropPng(png, null)).toBe(png);
  });

  it("other file types have no graph pages", async () => {
    expect(await graphPageImages(Buffer.from("a,b\n1,2"), "text/csv")).toEqual([]);
  });
});

describe("graphs in the exported plan", () => {
  it("embeds each included graph with a caption, relationship and png content type", async () => {
    const images = await graphPageImages(await makeLearningTreePdf(), "application/pdf");
    const docx = await renderDocx({
      template: T,
      content: emptyContent(T),
      vars: {},
      draft: true,
      figures: [{ png: images[0]!.png, title: "Mands for preferred items", source: "ava_learning_tree_graphs.pdf, page 2", summary: "Rising from about 20% to 86%." }],
    });
    const zip = new PizZip(docx);
    expect(zip.file("word/media/aba_graph1.png")).toBeTruthy();
    expect(zip.file("word/_rels/document.xml.rels")!.asText()).toContain('Id="rIdAbaFig1"');
    expect(zip.file("[Content_Types].xml")!.asText()).toMatch(/Extension="png"/i);
    const body = zip.file("word/document.xml")!.asText();
    expect(body).toContain('r:embed="rIdAbaFig1"');
    expect(body).toContain("Figure 1. Mands for preferred items (source: ava_learning_tree_graphs.pdf, page 2)");
  });

  it("exports unchanged when no graph is included", async () => {
    const zip = new PizZip(await renderDocx({ template: T, content: emptyContent(T), vars: {}, draft: false }));
    expect(Object.keys(zip.files).some((n) => n.includes("aba_graph"))).toBe(false);
  });
});
