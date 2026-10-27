import { getDocumentProxy, getResolvedPDFJS, renderPageAsImage } from "unpdf";
import { ai, type AiContext } from "../ai/client";
import { GRAPH_SYSTEM } from "../ai/prompts";
import { GraphReading, type ExtractedFact } from "../ai/schemas";

type PDFDocumentProxy = Awaited<ReturnType<typeof getDocumentProxy>>;

/**
 * Graph reading (CentralReach learning trees, program graphs, screenshots).
 * Pages that draw many vector paths or embed images are rendered to PNG and
 * shown to the model, which reports each graph's trend as evidence facts and
 * where it sits on the page so it can be cropped for the exported report.
 */

/** Pages drawing at least this many paths are graph candidates (plain text pages draw almost none). */
const PATH_THRESHOLD = 15;
/** Upper bound on pages sent per file, to keep cost and latency predictable. */
const MAX_PAGES = 20;
const BATCH = 4;
/** Longest side of an image sent to the model; Bedrock accepts up to 8000 px, detail beyond this adds cost, not accuracy. */
const MAX_SIDE = 1600;

export interface FoundGraph {
  page: number;
  title: string;
  summary: string;
  facts: ExtractedFact[];
  /** The graph cropped from its page (the whole page if no usable position was returned). */
  png: Buffer;
}

const canvasImport = () => import("@napi-rs/canvas");

export async function candidateGraphPages(pdf: PDFDocumentProxy): Promise<number[]> {
  const { OPS } = await getResolvedPDFJS();
  const pages: number[] = [];
  for (let n = 1; n <= pdf.numPages && pages.length < MAX_PAGES; n++) {
    const ops = await (await pdf.getPage(n)).getOperatorList();
    let paths = 0;
    let images = 0;
    for (const fn of ops.fnArray) {
      if (fn === OPS.constructPath) paths++;
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) images++;
    }
    if (paths >= PATH_THRESHOLD || images > 0) pages.push(n);
  }
  return pages;
}

/** Re-encode as PNG no larger than MAX_SIDE (also strips any image metadata). */
async function normalize(img: Buffer | ArrayBuffer): Promise<Buffer> {
  const { createCanvas, loadImage } = await canvasImport();
  const src = await loadImage(Buffer.from(img as ArrayBuffer));
  const k = Math.min(1, MAX_SIDE / Math.max(src.width, src.height));
  const c = createCanvas(Math.round(src.width * k), Math.round(src.height * k));
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  return c.toBuffer("image/png");
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));

/** Crop the graph out of its page with a small margin. Implausible boxes fall back to the whole page. */
export async function cropPng(png: Buffer, bbox?: { x: number; y: number; w: number; h: number } | null): Promise<Buffer> {
  if (!bbox || !(bbox.w >= 0.1 && bbox.h >= 0.05 && bbox.w <= 1.05 && bbox.h <= 1.05)) return png;
  const { createCanvas, loadImage } = await canvasImport();
  const img = await loadImage(png);
  const pad = 0.02;
  const x0 = clamp(bbox.x - pad) * img.width;
  const y0 = clamp(bbox.y - pad) * img.height;
  const w = clamp(bbox.x + bbox.w + pad) * img.width - x0;
  const h = clamp(bbox.y + bbox.h + pad) * img.height - y0;
  if (w < 50 || h < 50) return png;
  const c = createCanvas(Math.round(w), Math.round(h));
  c.getContext("2d").drawImage(img, x0, y0, w, h, 0, 0, Math.round(w), Math.round(h));
  return c.toBuffer("image/png");
}

/** Page images of an uploaded file that may contain graphs. Other file types have none to read. */
export async function graphPageImages(bytes: Buffer, mime: string): Promise<Array<{ page: number; png: Buffer }>> {
  if (mime === "image/png" || mime === "image/jpeg") return [{ page: 1, png: await normalize(bytes) }];
  if (mime !== "application/pdf") return [];
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const out: Array<{ page: number; png: Buffer }> = [];
  for (const page of await candidateGraphPages(pdf)) {
    out.push({ page, png: await normalize(await renderPageAsImage(pdf, page, { canvasImport, scale: 2 })) });
  }
  return out;
}

export async function readGraphs(ctx: AiContext, filename: string, images: Array<{ page: number; png: Buffer }>): Promise<FoundGraph[]> {
  const client = await ai();
  const found: FoundGraph[] = [];
  for (let i = 0; i < images.length; i += BATCH) {
    const batch = images.slice(i, i + BATCH);
    const out = await client.structured({
      step: "graph_reading",
      ctx,
      system: GRAPH_SYSTEM,
      images: batch.map((b) => ({ label: `Page ${b.page}:`, png: b.png })),
      user: `<document name="${filename.replace(/"/g, "")}">Pages ${batch.map((b) => b.page).join(", ")} of this file are shown above.</document>\nRecord every graph on these pages.`,
      toolName: "record_graphs",
      toolDescription: "Record the graphs found on the page images.",
      schema: GraphReading,
      mockInput: { pages: batch.map((b) => b.page), filename },
      maxTokens: 6000,
    });
    const byPage = new Map(batch.map((b) => [b.page, b.png]));
    for (const g of out.graphs) {
      const png = byPage.get(g.page);
      if (!png) continue; // never trust a page number the model made up
      found.push({
        page: g.page,
        title: g.title,
        summary: g.summary,
        facts: g.facts.map((f) => ({ ...f, fact_text: f.fact_text.startsWith("Graph:") ? f.fact_text : `Graph: ${f.fact_text}`, page: g.page })),
        png: await cropPng(png, g.bbox),
      });
    }
  }
  return found;
}
