import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import Docxtemplater from "docxtemplater";
import { AlignmentType, Document, Footer, Header, ImageRun, Packer, PageNumber, Paragraph, TextRun } from "docx";
import PizZip from "pizzip";
import { renderStatic, valueToText, type PlanContent, type TableRow } from "./plan/content";
import type { Field, Template } from "./template/schema";

const run = promisify(execFile);

/**
 * Export (spec F9). The company's Word template supplies the header, footer,
 * logo and page setup; it contains a {@body} paragraph where the plan body is
 * injected as raw WordprocessingML, plus optional {company}, {client_name},
 * {final_date} tags. PDF is produced from the DOCX by LibreOffice in the worker.
 */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function runs(text: string, opts: { bold?: boolean; size?: number; color?: string; italic?: boolean } = {}): string {
  const rpr = `<w:rPr>${opts.bold ? "<w:b/>" : ""}${opts.italic ? "<w:i/>" : ""}${opts.color ? `<w:color w:val="${opts.color}"/>` : ""}${opts.size ? `<w:sz w:val="${opts.size}"/><w:szCs w:val="${opts.size}"/>` : ""}</w:rPr>`;
  return text
    .split("\n")
    .map((line, i) => `${i ? "<w:r><w:br/></w:r>" : ""}<w:r>${rpr}<w:t xml:space="preserve">${esc(line)}</w:t></w:r>`)
    .join("");
}

function para(text: string, opts: { bold?: boolean; size?: number; color?: string; italic?: boolean; center?: boolean; spaceAfter?: number; shade?: string } = {}): string {
  const ppr = `<w:pPr>${opts.center ? '<w:jc w:val="center"/>' : ""}<w:spacing w:after="${opts.spaceAfter ?? 120}"/>${opts.shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${opts.shade}"/>` : ""}</w:pPr>`;
  return `<w:p>${ppr}${runs(text, opts)}</w:p>`;
}

function table(headers: string[], rows: string[][], color: string): string {
  const n = headers.length;
  const w = Math.floor(9360 / n);
  const cell = (t: string, head: boolean) =>
    `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${head ? `<w:shd w:val="clear" w:color="auto" w:fill="${color}"/>` : ""}</w:tcPr>${para(t || " ", { bold: head, size: 18, color: head ? "FFFFFF" : undefined, spaceAfter: 0 })}</w:tc>`;
  const border = '<w:top w:val="single" w:sz="4" w:color="999999"/><w:left w:val="single" w:sz="4" w:color="999999"/><w:bottom w:val="single" w:sz="4" w:color="999999"/><w:right w:val="single" w:sz="4" w:color="999999"/><w:insideH w:val="single" w:sz="4" w:color="999999"/><w:insideV w:val="single" w:sz="4" w:color="999999"/>';
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblBorders>${border}</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${headers.map(() => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>` +
    `<w:tr><w:trPr><w:tblHeader/></w:trPr>${headers.map((h) => cell(h, true)).join("")}</w:tr>` +
    rows.map((r) => `<w:tr>${r.map((c) => cell(c, false)).join("")}</w:tr>`).join("") +
    `</w:tbl>${para("", { spaceAfter: 60 })}`
  );
}

function fieldXml(f: Field, content: PlanContent, vars: Record<string, string>, color: string): string {
  if (f.type === "static") return para(renderStatic(f.text ?? "", vars), { size: 20 });
  const v = content[f.id]?.value ?? null;
  if (f.type === "table") {
    const cols = f.columns!;
    const rows = ((v as TableRow[]) ?? []).map((r) => cols.map((c) => r[c.id] ?? ""));
    return para(f.label, { bold: true, size: 20 }) + table(cols.map((c) => c.label), rows.length ? rows : [cols.map(() => "")], color);
  }
  if (f.type === "boolean") return para(`${v === true ? "☒" : "☐"} ${f.label}`, { size: 20 });
  if (f.type === "multiselect") {
    const sel = new Set((v as string[]) ?? []);
    return para(f.label, { bold: true, size: 20 }) + (f.options ?? []).map((o) => para(`${sel.has(o) ? "☒" : "☐"} ${o}`, { size: 20, spaceAfter: 40 })).join("");
  }
  const text = valueToText(v);
  if (f.lengthType === "short" && f.type !== "narrative") return `<w:p><w:pPr><w:spacing w:after="80"/></w:pPr>${runs(`${f.label}: `, { bold: true, size: 20 })}${runs(text, { size: 20 })}</w:p>`;
  return para(f.label, { bold: true, size: 20, spaceAfter: 40 }) + para(text || " ", { size: 20 });
}

export function planBodyXml(t: Template, content: PlanContent, vars: Record<string, string>): string {
  const color = t.branding.primaryColor.replace("#", "").toUpperCase();
  let xml = para(t.branding.headerText ?? "Treatment Plan", { bold: true, size: 32, center: true, color, spaceAfter: 240 });
  for (const s of t.sections) {
    xml += para(s.title, { bold: true, size: 26, color: "FFFFFF", shade: color, spaceAfter: 120 });
    if (s.intro) xml += para(s.intro, { italic: true, size: 18 });
    for (const f of s.fields) xml += fieldXml(f, content, vars, color);
  }
  return xml;
}

export interface ExportFigure {
  png: Buffer;
  title: string;
  /** e.g. "ava_learning_tree.pdf, page 3" */
  source: string;
  summary: string;
}

const EMU_PER_PX = 9525; // at 96 dpi
const MAX_W = 5_486_400; // 6.0 in
const MAX_H = 6_858_000; // 7.5 in

/** Inline picture; namespaces are declared inline so it works in any company Word template. */
function pictureXml(i: number, png: Buffer): string {
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  const k = Math.min(1, MAX_W / (w * EMU_PER_PX), MAX_H / (h * EMU_PER_PX));
  const cx = Math.round(w * EMU_PER_PX * k);
  const cy = Math.round(h * EMU_PER_PX * k);
  const id = 9000 + i;
  return (
    `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="60"/></w:pPr><w:r><w:drawing>` +
    `<wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Graph ${i}"/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="graph${i}.png"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="rIdAbaFig${i}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
    `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
  );
}

export function figuresXml(figures: ExportFigure[], color: string): string {
  if (!figures.length) return "";
  let xml = para("Graphs", { bold: true, size: 26, color: "FFFFFF", shade: color, spaceAfter: 120 });
  figures.forEach((f, n) => {
    const i = n + 1;
    xml += pictureXml(i, f.png);
    xml += para(`Figure ${i}. ${f.title} (source: ${f.source})`, { italic: true, size: 18, center: true, spaceAfter: 60 });
    xml += para(f.summary, { size: 20, spaceAfter: 200 });
  });
  return xml;
}

/** Add the figure images to the package: media files, relationships and the png content type. */
function addFigureParts(zip: PizZip, figures: ExportFigure[]) {
  if (!figures.length) return;
  figures.forEach((f, n) => zip.file(`word/media/aba_graph${n + 1}.png`, f.png));
  const relsPath = "word/_rels/document.xml.rels";
  const rels = zip.file(relsPath)!.asText();
  const added = figures.map((_, n) => `<Relationship Id="rIdAbaFig${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/aba_graph${n + 1}.png"/>`).join("");
  zip.file(relsPath, rels.replace("</Relationships>", `${added}</Relationships>`));
  const ctPath = "[Content_Types].xml";
  const ct = zip.file(ctPath)!.asText();
  if (!/Extension="png"/i.test(ct)) zip.file(ctPath, ct.replace(/(<Types[^>]*>)/, '$1<Default Extension="png" ContentType="image/png"/>'));
}

/** Default company Word template, used until the company uploads its own. */
export async function defaultWordTemplate(t: Template, logo?: Buffer): Promise<Buffer> {
  const headerChildren: Paragraph[] = [];
  if (logo) headerChildren.push(new Paragraph({ children: [new ImageRun({ data: logo, transformation: { width: 120, height: 40 }, type: "png" })] }));
  headerChildren.push(new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: "{company}", bold: true, color: t.branding.primaryColor.replace("#", "") })] }));
  const doc = new Document({
    styles: { default: { document: { run: { font: "Calibri", size: 20 } } } },
    sections: [
      {
        headers: { default: new Header({ children: headerChildren }) },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "{footer}", size: 16, color: "666666" })] }),
              new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ children: ["Page ", PageNumber.CURRENT, " of ", PageNumber.TOTAL_PAGES], size: 16 })] }),
            ],
          }),
        },
        children: [
          new Paragraph({ children: [new TextRun("{@body}")] }),
          new Paragraph({ children: [new TextRun("")] }),
          new Paragraph({ children: [new TextRun({ text: "Provider Signature: ______________________________   Date: ____________", size: 20 })] }),
          new Paragraph({ children: [new TextRun({ text: "{provider_name}", size: 20 })] }),
          new Paragraph({ children: [new TextRun("")] }),
          new Paragraph({ children: [new TextRun({ text: "Parent/Caregiver Signature: ______________________________   Date: ____________", size: 20 })] }),
          new Paragraph({ children: [new TextRun({ text: "I have reviewed the treatment plan and clarified any questions I may have, and I agree to the treatment plan above.", size: 18, italics: true })] }),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

export interface ExportInput {
  template: Template;
  content: PlanContent;
  vars: Record<string, string>;
  wordTemplate?: Buffer | null;
  logo?: Buffer | null;
  finalDate?: string | null;
  draft: boolean;
  /** Graphs the BCBA chose to include, in report order. */
  figures?: ExportFigure[];
}

export async function renderDocx(i: ExportInput): Promise<Buffer> {
  const base = i.wordTemplate ?? (await defaultWordTemplate(i.template, i.logo ?? undefined));
  const zip = new PizZip(base);
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true, nullGetter: () => "" });
  const figures = i.figures ?? [];
  let body = planBodyXml(i.template, i.content, i.vars) + figuresXml(figures, i.template.branding.primaryColor.replace("#", "").toUpperCase());
  if (i.draft) body = para("DRAFT - not finalized. Requires BCBA review before use.", { bold: true, color: "C00000", center: true }) + body;
  doc.render({
    body,
    company: i.template.branding.companyName,
    footer: i.template.branding.footer,
    client_name: i.vars.full_name ?? "",
    final_date: i.finalDate ?? "",
    provider_name: String(i.content.supervising_bcba?.value ?? ""),
  });
  const out = doc.getZip();
  addFigureParts(out, figures);
  return out.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
}

/** DOCX -> PDF via LibreOffice. Temp files are wiped immediately after. */
export async function docxToPdf(docx: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "aba-export-"));
  try {
    const src = join(dir, "plan.docx");
    await writeFile(src, docx);
    await run(process.env.SOFFICE_BIN ?? "soffice", ["--headless", "--norestore", `-env:UserInstallation=file://${dir}/profile`, "--convert-to", "pdf", "--outdir", dir, src], { timeout: 120_000 });
    return await readFile(join(dir, "plan.pdf"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
