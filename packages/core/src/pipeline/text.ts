import ExcelJS from "exceljs";
import mammoth from "mammoth";
import Papa from "papaparse";
import { extractText, getDocumentProxy } from "unpdf";
import { ocr } from "../ocr";

/** Text of one page of an uploaded file. needsOcr = scanned page that OCR could not read. */
export interface PageText {
  page: number;
  text: string;
  ocr: boolean;
  needsOcr: boolean;
}

const SCANNED_THRESHOLD = 25;

export async function fileToPages(bytes: Buffer, mime: string, s3Key: string): Promise<PageText[]> {
  if (mime === "application/pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: false });
    const pages: PageText[] = (text as string[]).map((t, i) => ({ page: i + 1, text: t.trim(), ocr: false, needsOcr: false }));
    const scanned = pages.filter((p) => p.text.replace(/\s/g, "").length < SCANNED_THRESHOLD);
    if (scanned.length) {
      const ocrPages = await ocr().pdf(s3Key);
      for (const p of scanned) {
        const t = ocrPages?.[p.page - 1];
        if (t && t.trim()) Object.assign(p, { text: t.trim(), ocr: true });
        else p.needsOcr = true;
      }
    }
    return pages;
  }
  if (mime.startsWith("image/")) {
    const t = await ocr().image(bytes);
    return [{ page: 1, text: t ?? "", ocr: !!t, needsOcr: !t }];
  }
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const { value } = await mammoth.extractRawText({ buffer: bytes });
    return chunkPages(value);
  }
  if (mime === "text/csv") {
    const parsed = Papa.parse<Record<string, string>>(bytes.toString("utf8"), { header: true, skipEmptyLines: true });
    return chunkPages(parsed.data.map((r) => Object.entries(r).map(([k, v]) => `${k}: ${v}`).join("; ")).join("\n"));
  }
  if (mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
    const pages: PageText[] = [];
    wb.eachSheet((ws) => {
      const header: string[] = [];
      const lines: string[] = [];
      ws.eachRow((row, i) => {
        const vals = (row.values as unknown[]).slice(1).map((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "")));
        if (i === 1) header.push(...vals);
        else lines.push(vals.map((v, j) => `${header[j] ?? `col${j + 1}`}: ${v}`).join("; "));
      });
      pages.push({ page: pages.length + 1, text: `Sheet ${ws.name}\n${lines.join("\n")}`, ocr: false, needsOcr: false });
    });
    return pages;
  }
  throw new Error("Unsupported file type");
}

/** Split long text into pseudo-pages of ~3000 chars on line boundaries. */
function chunkPages(text: string): PageText[] {
  const lines = text.split(/\n/);
  const pages: PageText[] = [];
  let buf = "";
  for (const l of lines) {
    if (buf.length + l.length > 3000 && buf) {
      pages.push({ page: pages.length + 1, text: buf.trim(), ocr: false, needsOcr: false });
      buf = "";
    }
    buf += l + "\n";
  }
  if (buf.trim() || !pages.length) pages.push({ page: pages.length + 1, text: buf.trim(), ocr: false, needsOcr: false });
  return pages;
}
