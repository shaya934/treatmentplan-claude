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
}

export async function renderDocx(i: ExportInput): Promise<Buffer> {
  const base = i.wordTemplate ?? (await defaultWordTemplate(i.template, i.logo ?? undefined));
  const zip = new PizZip(base);
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true, nullGetter: () => "" });
  let body = planBodyXml(i.template, i.content, i.vars);
  if (i.draft) body = para("DRAFT - not finalized. Requires BCBA review before use.", { bold: true, color: "C00000", center: true }) + body;
  doc.render({
    body,
    company: i.template.branding.companyName,
    footer: i.template.branding.footer,
    client_name: i.vars.full_name ?? "",
    final_date: i.finalDate ?? "",
    provider_name: String(i.content.supervising_bcba?.value ?? ""),
  });
  return doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
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
