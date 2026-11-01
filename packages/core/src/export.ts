import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import Docxtemplater from "docxtemplater";
import { AlignmentType, Document, Footer, Header, ImageRun, Packer, PageNumber, Paragraph, TextRun } from "docx";
import PizZip from "pizzip";
import { renderStatic, usDates, valueToText, type PlanContent, type TableRow } from "./plan/content";
import type { Field, Template } from "./template/schema";

const run = promisify(execFile);

/**
 * Export (spec F9). The company's Word template supplies the header, footer,
 * logo and page setup; it contains a {@body} paragraph where the plan body is
 * injected as raw WordprocessingML, plus optional {company}, {client_name},
 * {final_date} tags. PDF is produced from the DOCX by LibreOffice in the worker.
 */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface RunOpts {
  bold?: boolean;
  size?: number;
  color?: string;
  italic?: boolean;
  font?: string;
}

/** Text runs; "[BCBA to confirm: ...]" gaps are highlighted so a reviewer can't miss them. */
function runs(text: string, opts: RunOpts = {}): string {
  const rpr = (hl: boolean) =>
    `<w:rPr>${opts.font ? `<w:rFonts w:ascii="${opts.font}" w:hAnsi="${opts.font}" w:cs="${opts.font}"/>` : ""}${opts.bold ? "<w:b/>" : ""}${opts.italic ? "<w:i/>" : ""}${opts.color ? `<w:color w:val="${opts.color}"/>` : ""}${opts.size ? `<w:sz w:val="${opts.size}"/><w:szCs w:val="${opts.size}"/>` : ""}${hl ? '<w:highlight w:val="yellow"/>' : ""}</w:rPr>`;
  return text
    .split("\n")
    .map((line, i) => {
      const parts = line.split(/(\[BCBA to confirm:[^\]]*\])/);
      return `${i ? "<w:r><w:br/></w:r>" : ""}${parts.map((p) => (p ? `<w:r>${rpr(p.startsWith("[BCBA to confirm:"))}<w:t xml:space="preserve">${esc(p)}</w:t></w:r>` : "")).join("") || `<w:r>${rpr(false)}<w:t xml:space="preserve"></w:t></w:r>`}`;
    })
    .join("");
}

interface ParaOpts extends RunOpts {
  center?: boolean;
  spaceAfter?: number;
  spaceBefore?: number;
  shade?: string;
  keepNext?: boolean;
  pageBreakBefore?: boolean;
  /** Line spacing in 240ths of a line (276 = 1.15). */
  line?: number;
  indent?: number;
}

function para(text: string, opts: ParaOpts = {}): string {
  const ppr =
    `<w:pPr>${opts.keepNext ? "<w:keepNext/>" : ""}${opts.pageBreakBefore ? "<w:pageBreakBefore/>" : ""}` +
    `${opts.shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${opts.shade}"/>` : ""}` +
    `<w:spacing w:before="${opts.spaceBefore ?? 0}" w:after="${opts.spaceAfter ?? 120}"${opts.line ? ` w:line="${opts.line}" w:lineRule="auto"` : ""}/>` +
    `${opts.indent ? `<w:ind w:left="${opts.indent}"/>` : ""}${opts.center ? '<w:jc w:val="center"/>' : ""}</w:pPr>`;
  return `<w:p>${ppr}${runs(text, opts)}</w:p>`;
}

const BORDER = "C5CFDB";
const ZEBRA = "F3F6FA";
const LABEL_FILL = "EAF0F7";

function tableXml(widths: number[], rows: string[]): string {
  const b = (s: string) => `<w:${s} w:val="single" w:sz="4" w:color="${BORDER}"/>`;
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, x) => a + x, 0)}" w:type="dxa"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(b).join("")}</w:tblBorders>` +
    `<w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="50" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="50" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
    `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>${rows.join("")}</w:tbl>${para("", { spaceAfter: 80 })}`
  );
}

function cell(text: string, width: number, opts: RunOpts & { fill?: string } = {}): string {
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${opts.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${opts.fill}"/>` : ""}</w:tcPr>${para(text || " ", { ...opts, size: opts.size ?? 19, spaceAfter: 0 })}</w:tc>`;
}

/** Data table with a branded header row (repeats across pages) and zebra rows. */
function table(headers: string[], rows: string[][], color: string): string {
  const w = Math.floor(9360 / headers.length);
  const widths = headers.map(() => w);
  return tableXml(widths, [
    `<w:tr><w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>${headers.map((h) => cell(h, w, { bold: true, color: "FFFFFF", fill: color, size: 18 })).join("")}</w:tr>`,
    ...rows.map((r, i) => `<w:tr><w:trPr><w:cantSplit/></w:trPr>${r.map((c) => cell(c, w, { fill: i % 2 ? ZEBRA : undefined })).join("")}</w:tr>`),
  ]);
}

/** Label/value pairs as a two-column table with a shaded label column. */
function keyValueTable(pairs: Array<[string, string]>): string {
  const widths = [3400, 5960];
  return tableXml(
    widths,
    pairs.map(([k, v]) => `<w:tr><w:trPr><w:cantSplit/></w:trPr>${cell(k, widths[0]!, { bold: true, fill: LABEL_FILL })}${cell(v, widths[1]!)}</w:tr>`),
  );
}

const isShort = (f: Field) => f.lengthType === "short" && ["text", "date", "number", "select"].includes(f.type);
const display = (f: Field, v: PlanContent[string]["value"] | null) => (f.type === "date" ? usDates(valueToText(v)) : valueToText(v));

function fieldXml(f: Field, content: PlanContent, vars: Record<string, string>, color: string): string {
  if (f.type === "static") return para(renderStatic(f.text ?? "", vars), { size: 20, line: 276 });
  const v = content[f.id]?.value ?? null;
  const label = (text: string) => para(text, { bold: true, size: 20, color, spaceBefore: 120, spaceAfter: 60, keepNext: true });
  if (f.type === "table") {
    const cols = f.columns!;
    const rows = ((v as TableRow[]) ?? []).map((r) => cols.map((c) => r[c.id] ?? ""));
    return label(f.label) + table(cols.map((c) => c.label), rows.length ? rows : [cols.map(() => "")], color);
  }
  if (f.type === "boolean") return para(`${v === true ? "☒" : "☐"}  ${f.label}`, { size: 20, spaceAfter: 60 });
  if (f.type === "multiselect") {
    const sel = new Set((v as string[]) ?? []);
    return label(f.label) + para((f.options ?? []).map((o) => `${sel.has(o) ? "☒" : "☐"} ${o}`).join("     "), { size: 20, line: 300 });
  }
  return label(f.label) + para(display(f, v) || " ", { size: 20, line: 276, spaceAfter: 160 });
}

function sectionBar(title: string, color: string): string {
  return para(title, { bold: true, size: 24, color: "FFFFFF", shade: color, spaceBefore: 280, spaceAfter: 120, keepNext: true, indent: 0 });
}

export function planBodyXml(t: Template, content: PlanContent, vars: Record<string, string>): string {
  const color = t.branding.primaryColor.replace("#", "").toUpperCase();
  let xml = "";
  for (const s of t.sections) {
    xml += sectionBar(s.title, color);
    if (s.intro) xml += para(s.intro, { italic: true, size: 18, color: "555555" });
    // Runs of short fields (name, dates, IDs...) read better as one label/value table.
    let pairs: Array<[string, string]> = [];
    const flush = () => {
      if (pairs.length) xml += keyValueTable(pairs);
      pairs = [];
    };
    for (const f of s.fields) {
      if (isShort(f)) {
        pairs.push([f.label, display(f, content[f.id]?.value ?? null)]);
        continue;
      }
      flush();
      xml += fieldXml(f, content, vars, color);
    }
    flush();
  }
  return xml;
}

/** Cover page: title, plan type, the key client facts in a shaded box, the list of sections. */
export function coverXml(t: Template, content: PlanContent, opts: { planType?: string; draft: boolean; finalDate?: string | null }): string {
  const color = t.branding.primaryColor.replace("#", "").toUpperCase();
  const val = (id: string) => usDates(valueToText(content[id]?.value ?? null)).trim();
  const facts: Array<[string, string]> = (
    [
      ["Client", val("client_name")],
      ["Date of birth", val("dob")],
      ["Medicaid / member ID", val("member_id")],
      ["Insurance", val("insurance")],
      ["Diagnosis", val("diagnosis")],
      ["Authorization period", val("auth_period_requested")],
      ["Supervising BCBA", val("supervising_bcba")],
      ["Report date", val("report_date")],
      ["Finalized", opts.finalDate ? usDates(opts.finalDate) : ""],
    ] as Array<[string, string]>
  ).filter(([, v]) => v);
  const type = opts.planType === "reassessment" ? "Reassessment" : opts.planType === "initial" ? "Initial Assessment" : "";
  return (
    para("", { spaceAfter: 1400 }) +
    para(t.branding.companyName, { bold: true, size: 28, color, center: true, spaceAfter: 120 }) +
    para(t.branding.headerText ?? "Treatment Plan", { bold: true, size: 52, center: true, spaceAfter: 80 }) +
    (type ? para(type, { size: 28, color: "555555", center: true, spaceAfter: 480 }) : para("", { spaceAfter: 400 })) +
    (facts.length ? keyValueTable(facts) : "") +
    (opts.draft ? para("DRAFT – not finalized. Requires BCBA review before use.", { bold: true, color: "C00000", center: true, spaceBefore: 240 }) : "") +
    para("Contents", { bold: true, size: 22, color, spaceBefore: 480, spaceAfter: 80 }) +
    t.sections.map((s, i) => para(`${i + 1}.  ${s.title}`, { size: 19, spaceAfter: 20, indent: 240 })).join("")
  );
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
function pictureXml(i: number, png: Buffer, maxW = MAX_W): string {
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  const k = Math.min(maxW / (w * EMU_PER_PX), MAX_H / (h * EMU_PER_PX), maxW === MAX_W ? 1 : Infinity);
  const cx = Math.round(w * EMU_PER_PX * k);
  const cy = Math.round(h * EMU_PER_PX * k);
  const id = 9000 + i;
  return (
    `<w:p><w:pPr><w:keepNext/><w:spacing w:before="120" w:after="60"/><w:jc w:val="center"/></w:pPr><w:r><w:drawing>` +
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
  let xml = para("Graphs", { bold: true, size: 24, color: "FFFFFF", shade: color, spaceAfter: 120, keepNext: true, pageBreakBefore: true });
  figures.forEach((f, n) => {
    const i = n + 1;
    xml += pictureXml(i, f.png);
    xml += para(`Figure ${i}. ${f.title} (source: ${f.source})`, { italic: true, size: 18, color: "555555", center: true, spaceAfter: 60, keepNext: true });
    xml += para(f.summary, { size: 20, line: 276, spaceAfter: 360 });
  });
  return xml;
}

/** Add images (graphs, then the form logo) to the package: media files, relationships and the png content type. */
function addFigureParts(zip: PizZip, figures: Array<{ png: Buffer }>) {
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

/** Page setup for the form style: narrow margins, no header (the logo is on page 1), company footer + page numbers. */
async function formWordTemplate(): Promise<Buffer> {
  const doc = new Document({
    styles: { default: { document: { run: { font: FORM_FONT, size: 16 } } } },
    sections: [
      {
        properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 620, bottom: 620, left: 620, right: 620, footer: 300 } } },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "{footer}", size: 14, font: FORM_FONT })] }),
              new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ children: ["Page ", PageNumber.CURRENT, " of ", PageNumber.TOTAL_PAGES], size: 16, font: FORM_FONT })] }),
            ],
          }),
        },
        children: [new Paragraph({ children: [new TextRun("{@body}")] })],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

/** Default company Word template, used until the company uploads its own. */
export async function defaultWordTemplate(t: Template, logo?: Buffer): Promise<Buffer> {
  if (t.branding.style === "form") return formWordTemplate();
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

// ------------------------------ form style ---------------------------------
// Reproduces a company's paper form: each section is one bordered box with a gray
// title bar; answers sit in cells that grow to fit. Grid: [row label | rest] or two halves.

const FORM_FONT = "Verdana";
const FORM_GRAY = "D4D4D4";
const FORM_GRID = [2500, 3000, 5500]; // twips; total = content width with 0.43in margins
const FORM_W = FORM_GRID.reduce((a, x) => a + x, 0);
const LOGO_W = 1_463_040; // 1.6 in

const fr = (text: string, o: RunOpts = {}) => runs(text, { size: 16, font: FORM_FONT, ...o });
const fp = (text: string, o: ParaOpts = {}) => para(text, { size: 16, font: FORM_FONT, spaceAfter: 60, line: 264, ...o });
const fpRuns = (inner: string, o: { center?: boolean; keepNext?: boolean } = {}) =>
  `<w:p><w:pPr>${o.keepNext ? "<w:keepNext/>" : ""}<w:spacing w:after="60" w:line="264" w:lineRule="auto"/>${o.center ? '<w:jc w:val="center"/>' : ""}</w:pPr>${inner}</w:p>`;
const labelValue = (label: string, value: string, boldLabel = true) => fpRuns(`${fr(`${label}: `, { bold: boldLabel })}${fr(value)}`);
const blank = (lines = 1) => Array.from({ length: lines }, () => fp("")).join("");

function fcell(content: string, width: number, o: { span?: number; fill?: string; vCenter?: boolean } = {}): string {
  return (
    `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${o.span && o.span > 1 ? `<w:gridSpan w:val="${o.span}"/>` : ""}` +
    `${o.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${o.fill}"/>` : ""}${o.vCenter ? '<w:vAlign w:val="center"/>' : ""}</w:tcPr>${content || "<w:p/>"}</w:tc>`
  );
}
const row = (cells: string, header = false) => `<w:tr><w:trPr><w:cantSplit/>${header ? "<w:tblHeader/>" : ""}</w:trPr>${cells}</w:tr>`;
const titleRow = (text: string, bold = true) => row(fcell(fp(text, { bold, center: true, keepNext: true, spaceAfter: 0 }), FORM_W, { span: 3, fill: FORM_GRAY, vCenter: true }));
const fullRow = (content: string) => row(fcell(content, FORM_W, { span: 3 }));
const halfRow = (a: string, b: string) => row(fcell(a, FORM_GRID[0]! + FORM_GRID[1]!, { span: 2 }) + fcell(b, FORM_GRID[2]!));
const labelRow = (label: string, content: string) => row(fcell(fp(label, { bold: true, center: true, spaceAfter: 0 }), FORM_GRID[0]!, { vCenter: true }) + fcell(content, FORM_W - FORM_GRID[0]!, { span: 2 }));

function box(rows: string[]): string {
  const b = (s: string) => `<w:${s} w:val="single" w:sz="8" w:color="000000"/>`;
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="${FORM_W}" w:type="dxa"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(b).join("")}</w:tblBorders>` +
    `<w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
    `<w:tblGrid>${FORM_GRID.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>${rows.join("")}</w:tbl>${fp("", { spaceAfter: 120 })}`
  );
}

/** A data table nested in a full-width cell; empty tables keep two blank rows like the paper form. */
function nestedTable(f: Field, v: TableRow[] | null): string {
  const cols = f.columns!;
  let rows = (v ?? []).map((r) => cols.map((c) => r[c.id] ?? ""));
  if (!rows.length && f.fixedRows?.length) rows = f.fixedRows.map((label) => [label, ...cols.slice(1).map(() => "")]);
  while (rows.length < 2) rows.push(cols.map(() => ""));
  const inner = FORM_W - 160;
  const first = f.fixedRows?.length ? Math.round(inner * 0.24) : Math.floor(inner / cols.length);
  const widths = cols.map((_, i) => (f.fixedRows?.length ? (i === 0 ? first : Math.floor((inner - first) / (cols.length - 1))) : first));
  const b = (s: string) => `<w:${s} w:val="single" w:sz="6" w:color="000000"/>`;
  const head = row(cols.map((c, i) => fcell(fp(c.label, { bold: !!f.fixedRows?.length, center: true, spaceAfter: 0 }), widths[i]!, { fill: f.fixedRows?.length ? FORM_GRAY : undefined, vCenter: true })).join(""), true);
  const body = rows.map((r) => row(r.map((c, i) => fcell(fp(c, { spaceAfter: 0 }), widths[i]!)).join("")));
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="${inner}" w:type="dxa"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(b).join("")}</w:tblBorders>` +
    `<w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="60" w:type="dxa"/><w:right w:w="60" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
    `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>${head}${body.join("")}</w:tbl>${fp("", { spaceAfter: 0 })}`
  );
}

const yesNo = (v: unknown) => (v === true ? "☒ Yes  ☐ No" : v === false ? "☐ Yes  ☒ No" : "☐ Yes  ☐ No");
const paras = (text: string, lines = 2) => (text.trim() ? text.split(/\n{2,}/).map((p) => fp(p)).join("") : blank(lines));

/** One field inside a row-label cell (several fields can share the cell). */
function inRowXml(f: Field, content: PlanContent, vars: Record<string, string>): string {
  const v = content[f.id]?.value ?? null;
  const label = renderStatic(f.label, vars);
  if (f.type === "boolean") return labelValue(label, yesNo(v), false);
  if (f.type === "table") {
    const rows = ((v as TableRow[]) ?? []).map((r) => f.columns!.map((c) => r[c.id]).filter(Boolean).join(" – ")).filter(Boolean);
    return labelValue(label, rows.length ? "" : "", false) + rows.map((r) => fp(`• ${r}`)).join("");
  }
  const text = display(f, v);
  if (f.label === f.rowLabel) return paras(text);
  return f.type === "narrative" ? fp(`${label}:`) + paras(text, 1) : labelValue(label, text, false);
}

/** A records table: one box per row (e.g. one per FBA); "box" columns follow as their own boxes. */
function recordsXml(f: Field, sectionTitle: string, v: TableRow[] | null): string {
  const cols = f.columns!;
  const recs = (v ?? []).length ? (v as TableRow[]) : [Object.fromEntries(cols.map((c) => [c.id, ""]))];
  return recs
    .map((r) => {
      const main = [titleRow(sectionTitle || f.label), ...(f.help ? [fullRow(fp(f.help))] : []), ...cols.filter((c) => !c.box).map((c) => labelRow(c.label, paras(r[c.id] ?? "", c.type === "narrative" ? 2 : 1)))];
      const extra = cols.filter((c) => c.box).map((c) => box([titleRow(c.label), fullRow(paras(r[c.id] ?? ""))]));
      return box(main) + extra.join("");
    })
    .join("");
}

function formSectionXml(s: Template["sections"][number], content: PlanContent, vars: Record<string, string>): string {
  const rows: string[] = [];
  const out: string[] = [];
  if (s.title) rows.push(titleRow(s.title));
  const fields = s.fields;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    const v = content[f.id]?.value ?? null;
    if (f.display === "none") continue;
    if (f.display === "records") {
      // Records stand alone: close the current box first.
      if (rows.length > (s.title ? 1 : 0)) out.push(box(rows.splice(0)));
      else rows.length = 0;
      out.push(recordsXml(f, s.title, v as TableRow[] | null));
      continue;
    }
    if (f.display === "half") {
      const cellXml = (x: Field) => labelValue(x.label, x.type === "static" ? renderStatic(x.text ?? "", vars) : display(x, content[x.id]?.value ?? null));
      const next = fields[i + 1];
      if (next && next.display === "half") {
        rows.push(halfRow(cellXml(f), cellXml(next)));
        i++;
      } else rows.push(halfRow(cellXml(f), ""));
      continue;
    }
    if (f.display === "row") {
      const label = f.rowLabel ?? f.label;
      let inner = "";
      while (i < fields.length && fields[i]!.display === "row" && (fields[i]!.rowLabel ?? fields[i]!.label) === label) inner += inRowXml(fields[i++]!, content, vars);
      i--;
      rows.push(labelRow(label, inner));
      continue;
    }
    if (f.display === "block") {
      rows.push(titleRow(renderStatic(f.label, vars), false));
      rows.push(fullRow(paras(display(f, v))));
      continue;
    }
    if (f.type === "static") {
      rows.push(f.style === "subheader" ? titleRow(f.text ?? f.label) : fullRow(paras(renderStatic(f.text ?? "", vars), 2)));
      continue;
    }
    if (f.type === "table") {
      rows.push(fullRow(nestedTable(f, v as TableRow[] | null)));
      continue;
    }
    if (f.type === "boolean") {
      rows.push(fullRow(fp(`${v === true ? "☒" : "☐"} ${renderStatic(f.label, vars)}`)));
      continue;
    }
    if (f.type === "multiselect") {
      const sel = new Set((v as string[]) ?? []);
      const head = f.label.trim().endsWith(":") ? fp(renderStatic(f.label, vars)) : "";
      rows.push(fullRow(head + (f.options ?? []).map((o) => fp(`${sel.has(o) ? "☒" : "☐"} ${o}`, { indent: 120 })).join("")));
      continue;
    }
    if (f.type === "narrative") {
      rows.push(fullRow(paras(display(f, v))));
      continue;
    }
    rows.push(fullRow(labelValue(renderStatic(f.label, vars), display(f, v))));
  }
  if (rows.length > (s.title ? 1 : 0) || (s.title && !out.length)) out.unshift(box(rows));
  return out.join("");
}

/** The whole plan in form style. Graphs (media 1..n) go after the goals section; the logo is media n+1. */
export function formBodyXml(t: Template, content: PlanContent, vars: Record<string, string>, figures: ExportFigure[], logo: Buffer | null): string {
  const allVars: Record<string, string> = { ...vars };
  for (const s of t.sections) for (const f of s.fields) if (f.type !== "static" && f.type !== "table") allVars[f.id] ??= display(f, content[f.id]?.value ?? null) || "";
  let xml = logo ? pictureXml(figures.length + 1, logo, LOGO_W) : "";
  const graphs = figures.length
    ? box([
        titleRow("Graphs"),
        ...figures.map((f, n) => fullRow(pictureXml(n + 1, f.png, FORM_W * 635 - 200_000) + fp(`Figure ${n + 1}. ${f.title} (source: ${f.source})`, { italic: true, center: true }) + paras(f.summary))),
      ])
    : "";
  let placed = false;
  for (const s of t.sections) {
    xml += formSectionXml(s, content, allVars);
    if (s.id === "goals" && graphs) {
      xml += graphs;
      placed = true;
    }
  }
  return placed || !graphs ? xml : xml + graphs;
}

export interface ExportInput {
  template: Template;
  content: PlanContent;
  vars: Record<string, string>;
  wordTemplate?: Buffer | null;
  logo?: Buffer | null;
  finalDate?: string | null;
  draft: boolean;
  /** "initial" | "reassessment", shown on the cover page. */
  planType?: string;
  /** Graphs the BCBA chose to include, in report order. */
  figures?: ExportFigure[];
}

export async function renderDocx(i: ExportInput): Promise<Buffer> {
  const base = i.wordTemplate ?? (await defaultWordTemplate(i.template, i.logo ?? undefined));
  const zip = new PizZip(base);
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true, nullGetter: () => "" });
  const figures = i.figures ?? [];
  const color = i.template.branding.primaryColor.replace("#", "").toUpperCase();
  const draftLine = i.draft ? para("DRAFT – not finalized. Requires BCBA review before use.", { bold: true, color: "C00000", center: true, spaceAfter: 60 }) : "";
  let body: string;
  let media: Array<{ png: Buffer }> = figures;
  if (i.template.branding.style === "form") {
    const logo = i.logo ?? (i.template.branding.builtinLogo ? await readFile(join(import.meta.dirname, "..", "assets", i.template.branding.builtinLogo)).catch(() => null) : null);
    body = draftLine + formBodyXml(i.template, i.content, i.vars, figures, logo);
    if (logo) media = [...figures, { png: logo }];
  } else {
    body = draftLine + planBodyXml(i.template, i.content, i.vars) + figuresXml(figures, color);
    body = coverXml(i.template, i.content, { planType: i.planType, draft: i.draft, finalDate: i.finalDate }) + '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' + body;
  }
  doc.render({
    body,
    company: i.template.branding.companyName,
    footer: i.template.branding.footer,
    client_name: i.vars.full_name ?? "",
    final_date: i.finalDate ?? "",
    provider_name: String(i.content.supervising_bcba?.value ?? ""),
  });
  const out = doc.getZip();
  addFigureParts(out, media);
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
