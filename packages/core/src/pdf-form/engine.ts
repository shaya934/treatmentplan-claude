import { readFile } from "node:fs/promises";
import { join } from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";

/**
 * Fill a company's own (flat) PDF form without changing it: answers are typed
 * into the existing blanks, found by their label text and the cell rectangles
 * drawn on the page (both recorded once in a layout file). Sentences that
 * contain the client's name or an inline blank are retyped in place. Answers
 * that don't fit continue on added pages, which also hold the graphs.
 */

export interface LayoutItem {
  p: number;
  x: number;
  y: number;
  w: number;
  size: number;
  s: string;
}
export interface LayoutRect {
  p: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export interface Layout {
  pageCount: number;
  items: LayoutItem[];
  rects: LayoutRect[];
  nameSlots: Array<{ p: number; x: number; y: number; w: number; size: number }>;
  /** Table borders: h = horizontal line at y=c from x=a to b; v = vertical line at x=c from y=a to b. */
  edges: Array<{ p: number; o: "h" | "v"; c: number; a: number; b: number }>;
}

export const ASSETS = join(import.meta.dirname, "..", "..", "assets");
const BLACK = rgb(0, 0, 0);
const WHITE = rgb(1, 1, 1);
const YELLOW = rgb(1, 0.95, 0.4);
const MIN_SIZE = 6.8;

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export interface Line {
  p: number;
  y: number;
  items: LayoutItem[];
  text: string;
}

export interface Overflow {
  label: string;
  text: string;
  fromPage: number;
}

export interface Figure {
  png: Buffer;
  title: string;
  source: string;
  summary: string;
}

export class FormFiller {
  overflow: Overflow[] = [];
  private lines: Line[];
  private constructor(
    readonly doc: PDFDocument,
    readonly layout: Layout,
    readonly font: PDFFont,
    readonly bold: PDFFont,
  ) {
    // Group text items into lines (same page, baselines within 2pt).
    const sorted = [...layout.items].sort((a, b) => a.p - b.p || b.y - a.y || a.x - b.x);
    this.lines = [];
    for (const it of sorted) {
      const last = this.lines[this.lines.length - 1];
      if (last && last.p === it.p && Math.abs(last.y - it.y) <= 2) last.items.push(it);
      else this.lines.push({ p: it.p, y: it.y, items: [it], text: "" });
    }
    for (const l of this.lines) {
      l.items.sort((a, b) => a.x - b.x);
      l.text = l.items.map((i) => i.s).join(" ");
    }
  }

  static async open(blankPdf: string, layoutJson: string): Promise<FormFiller> {
    const doc = await PDFDocument.load(await readFile(join(ASSETS, blankPdf)));
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(await readFile(join(ASSETS, "DejaVuSans.ttf")), { subset: true });
    const bold = await doc.embedFont(await readFile(join(ASSETS, "DejaVuSans-Bold.ttf")), { subset: true });
    const layout = JSON.parse(await readFile(join(ASSETS, layoutJson), "utf8")) as Layout;
    return new FormFiller(doc, layout, font, bold);
  }

  page(p: number): PDFPage {
    return this.doc.getPage(p - 1);
  }

  /** The n-th line (1-based) on page p whose text contains `text`. */
  line(p: number, text: string, n = 1): Line {
    const hits = this.lines.filter((l) => l.p === p && norm(l.text).includes(norm(text)));
    const l = hits[n - 1];
    if (!l) throw new Error(`Form layout: no line "${text}" (#${n}) on page ${p}`);
    return l;
  }

  /** The line on page p whose baseline is at y (the blank form is fixed, so positions are stable). */
  lineAt(p: number, y: number): Line {
    const near = this.lines.filter((m) => m.p === p && Math.abs(m.y - y) <= 2.5).sort((a, b) => Math.abs(a.y - y) - Math.abs(b.y - y));
    if (!near[0]) throw new Error(`Form layout: no line at ${p}:${y}`);
    return near[0];
  }

  /** Blank out a cell's inside (its border stays). */
  clearCell(c: LayoutRect) {
    this.whiteout(c.p, c.x0 + 1, c.y0 + 1, c.x1 - 1, c.y1 - 1);
  }

  /** Type a value right after a label on a line, within the label's cell. */
  after(p: number, y: number, labelText: string, value: string) {
    if (!value) return;
    const l = this.lineAt(p, y);
    const lab = this.label(l, labelText);
    const cell = this.cellAt(p, lab.x0 + 1, l.y + 2);
    this.fitLine(p, lab.x1 + 3, l.y, cell.x1 - 3 - (lab.x1 + 3), value, lab.size, labelText.replace(/:$/, ""));
  }

  /** Where a label sits on its line: its start x and the x where it ends. */
  label(l: Line, text: string): { x0: number; x1: number; size: number } {
    const want = norm(text);
    for (let i = 0; i < l.items.length; i++) {
      let joined = "";
      for (let j = i; j < l.items.length; j++) {
        joined = norm(`${joined} ${l.items[j]!.s}`);
        if (joined.includes(want)) return { x0: l.items[i]!.x, x1: l.items[j]!.x + l.items[j]!.w, size: l.items[i]!.size };
        if (!want.startsWith(joined.slice(0, Math.min(joined.length, want.length)))) break;
      }
    }
    throw new Error(`Form layout: label "${text}" not found on line "${l.text}"`);
  }

  /** The table cell around a point: the nearest border edges on each side (the form draws borders as lines or boxes). */
  cellAt(p: number, x: number, y: number): LayoutRect {
    const es = this.layout.edges.filter((e) => e.p === p);
    const v = es.filter((e) => e.o === "v" && e.a - 1 <= y && y <= e.b + 1);
    const h = es.filter((e) => e.o === "h" && e.a - 1 <= x && x <= e.b + 1);
    const x0 = Math.max(...v.filter((e) => e.c <= x).map((e) => e.c));
    const x1 = Math.min(...v.filter((e) => e.c >= x).map((e) => e.c));
    const y0 = Math.max(...h.filter((e) => e.c <= y).map((e) => e.c));
    const y1 = Math.min(...h.filter((e) => e.c >= y).map((e) => e.c));
    if (![x0, x1, y0, y1].every(Number.isFinite)) throw new Error(`Form layout: no cell at ${p}:${x},${y}`);
    return { p, x0, y0, x1, y1 };
  }

  /** The cell to the right of the cell holding a point. */
  cellRightOf(p: number, x: number, y: number): LayoutRect {
    return this.cellRight(this.cellAt(p, x, y));
  }

  /** The cell to the right of `c` (same row). */
  cellRight(c: LayoutRect): LayoutRect {
    return this.cellAt(c.p, c.x1 + 3, (c.y0 + c.y1) / 2);
  }

  /** Empty table rows from `first` downwards (stops at text, a tall box, or the page bottom). */
  rowsBelow(first: LayoutRect, max = 12): LayoutRect[] {
    const out: LayoutRect[] = [];
    let c: LayoutRect | null = first;
    while (c && out.length < max) {
      out.push(c);
      let next: LayoutRect;
      try {
        next = this.cellBelow(c);
      } catch {
        break;
      }
      const hasText = this.layout.items.some((i) => i.p === c!.p && i.s.trim() !== "-" && i.x >= next.x0 && i.x < next.x1 && i.y > next.y0 && i.y < next.y1);
      if (next.y1 - next.y0 > 40 || next.y0 < 55 || hasText || next.y1 >= c.y1) break;
      c = next;
    }
    return out;
  }

  /** The cell directly below `c` (e.g. the answer box under a gray label bar). */
  cellBelow(c: LayoutRect): LayoutRect {
    return this.cellAt(c.p, (c.x0 + c.x1) / 2, c.y0 - 3);
  }

  whiteout(p: number, x0: number, y0: number, x1: number, y1: number) {
    this.page(p).drawRectangle({ x: x0, y: y0, width: x1 - x0, height: y1 - y0, color: WHITE });
  }

  width(text: string, size: number, b = false) {
    return (b ? this.bold : this.font).widthOfTextAtSize(text, size);
  }

  /**
   * Draw one line; "[BCBA to confirm: ...]" gaps get a yellow highlight. Pass the same `gap`
   * state for every line of one answer so a gap that wraps onto the next line stays highlighted.
   */
  draw(p: number, x: number, y: number, text: string, size: number, b = false, gap: { open: boolean } = { open: false }) {
    const segs: Array<[string, boolean]> = [];
    let rest = text;
    if (gap.open) {
      const k = rest.indexOf("]");
      segs.push([k < 0 ? rest : rest.slice(0, k + 1), true]);
      rest = k < 0 ? "" : rest.slice(k + 1);
      gap.open = k < 0;
    }
    while (rest) {
      const i = rest.indexOf("[BCBA to confirm");
      if (i < 0) {
        segs.push([rest, false]);
        break;
      }
      if (i > 0) segs.push([rest.slice(0, i), false]);
      const k = rest.indexOf("]", i);
      if (k < 0) {
        segs.push([rest.slice(i), true]);
        gap.open = true;
        break;
      }
      segs.push([rest.slice(i, k + 1), true]);
      rest = rest.slice(k + 1);
    }
    let cx = x;
    for (const [part, hl] of segs) {
      if (!part) continue;
      const w = this.width(part, size, b);
      if (hl) this.page(p).drawRectangle({ x: cx, y: y - size * 0.25, width: w, height: size * 1.15, color: YELLOW });
      this.page(p).drawText(part, { x: cx, y, size, font: b ? this.bold : this.font, color: BLACK });
      cx += w;
    }
  }

  /** A gap that doesn't fit its spot shrinks to a short highlighted marker instead of moving to the added pages. */
  private compactGap(text: string, maxW: number, size: number): string | null {
    if (!/^\[BCBA to confirm:[^\]]*\]$/.test(text.trim())) return null;
    for (const t of [text.trim(), "[BCBA to confirm]", "[confirm]"]) if (this.width(t, size) <= maxW) return t;
    return "[?]";
  }

  wrap(text: string, width: number, size: number): string[] {
    const out: string[] = [];
    for (const para of text.replace(/\r/g, "").split("\n")) {
      let cur = "";
      for (const word of para.split(/ +/)) {
        const next = cur ? `${cur} ${word}` : word;
        if (this.width(next, size) <= width || !cur) cur = next;
        else {
          out.push(cur);
          cur = word;
        }
      }
      out.push(cur);
    }
    return out;
  }

  /** One line of text that must fit a width: shrink down to MIN_SIZE, else continue on the added pages. */
  fitLine(p: number, x: number, y: number, maxW: number, text: string, size: number, label: string) {
    if (!text) return;
    let s = size;
    while (s > MIN_SIZE && this.width(text, s) > maxW) s -= 0.2;
    if (this.width(text, s) <= maxW) return this.draw(p, x, y, text, s);
    const marker = this.compactGap(text, maxW, s);
    if (marker) return this.draw(p, x, y, marker, s);
    // Too long even small: keep what fits, send the rest to the addendum.
    const words = text.split(" ");
    let head = "";
    while (words.length && this.width(`${head} ${words[0]} …`, s) <= maxW) head = `${head} ${words.shift()}`.trim();
    this.draw(p, x, y, `${head} …`, s);
    this.overflow.push({ label, text, fromPage: p });
  }

  /**
   * Text in a box from `top` down: shrink to fit; if it still doesn't fit, fill the box,
   * end with "(continued on added pages)" and put the full answer in the addendum.
   */
  box(p: number, x0: number, top: number, x1: number, bottom: number, text: string, label: string, size = 8.2) {
    if (!text.trim()) return;
    const width = x1 - x0;
    let s = size;
    let lines = this.wrap(text, width, s);
    const fits = (n: number, sz: number) => n * sz * 1.25 <= top - bottom;
    while (!fits(lines.length, s) && s > MIN_SIZE) {
      s -= 0.2;
      lines = this.wrap(text, width, s);
    }
    const lead = s * 1.25;
    if (!fits(lines.length, s)) {
      const marker = this.compactGap(text, width, s);
      if (marker) return this.draw(p, x0, top - s, marker, s);
      const room = Math.max(1, Math.floor((top - bottom) / lead));
      lines = [...lines.slice(0, room - 1), "(continued on the added pages)"];
      this.overflow.push({ label, text, fromPage: p });
    }
    const gap = { open: false };
    lines.forEach((l, i) => this.draw(p, x0, top - s - i * lead, l, s, false, gap));
  }

  /** Tick a ☐ glyph on a line: draws an X over it. */
  tick(p: number, glyph: LayoutItem) {
    const s = glyph.size * 0.62;
    const x = glyph.x + 0.6;
    const y = glyph.y - 0.2;
    const pg = this.page(p);
    pg.drawLine({ start: { x, y }, end: { x: x + s, y: y + s }, thickness: 0.9, color: BLACK });
    pg.drawLine({ start: { x, y: y + s }, end: { x: x + s, y }, thickness: 0.9, color: BLACK });
  }

  /** The ☐ glyphs on a line, left to right. */
  boxes(l: Line): LayoutItem[] {
    return l.items.filter((i) => i.s.trim() === "☐");
  }

  /**
   * Retype `count` consecutive lines of one paragraph (starting at line `l`) with `text`,
   * starting at x0, within the cell; used for sentences holding the name or an inline blank.
   */
  retype(l: Line, count: number, text: string, opts: { x0?: number; xRest?: number; label?: string } = {}) {
    const first = l.items[0]!;
    const x0 = opts.x0 ?? first.x;
    const cell = this.cellAt(l.p, first.x + 1, l.y + 2);
    const xRest = opts.xRest ?? Math.min(x0, cell.x0 + 2.5);
    const right = cell.x1 - 3;
    const own = this.lines.filter((m) => m.p === l.p && m.y <= l.y && m.y > cell.y0 && m.items[0]!.x >= cell.x0 - 1 && m.items[0]!.x < right);
    const para = own.slice(0, count);
    const nextLine = own[count];
    const lead = para.length > 1 ? para[0]!.y - para[1]!.y : first.size * 1.6;
    for (const m of para) this.whiteout(l.p, Math.min(x0, m.items[0]!.x) - 0.5, m.y - first.size * 0.35, right, m.y + first.size * 1.05);
    // Room down to the next line of the form (or the cell bottom); shrink to fit, else continue on the added pages.
    const limitY = nextLine ? nextLine.y + nextLine.items[0]!.size * 1.05 : cell.y0 + 2;
    const width = right - Math.max(x0, xRest);
    let s = first.size;
    let lines = this.wrap(text, width, s);
    const room = () => Math.max(1, Math.floor((l.y - s * 0.35 - limitY) / lead) + 1);
    while (lines.length > room() && s > MIN_SIZE) {
      s -= 0.2;
      lines = this.wrap(text, width, s);
    }
    if (lines.length > room()) {
      lines = [...lines.slice(0, room() - 1), "(continued on the added pages)"];
      this.overflow.push({ label: opts.label ?? "Text", text, fromPage: l.p });
    }
    const lastY = l.y - (lines.length - 1) * lead;
    if (lines.length > para.length) this.whiteout(l.p, xRest - 0.5, lastY - s * 0.35, right, para[para.length - 1]!.y - first.size * 0.35);
    const gap = { open: false };
    lines.forEach((t, i) => this.draw(l.p, i === 0 ? x0 : xRest, l.y - i * lead, t, s, false, gap));
  }

  /**
   * Added pages (before the last page) for long answers and graphs, then renumber every
   * "Page X of N" footer. `footer` is the company line repeated on added pages.
   */
  async finish(figures: Figure[], footer: string, insertBefore: number) {
    const W = 612;
    const H = 792;
    const added: PDFPage[] = [];
    const figs: Array<{ page: PDFPage; x: number; y: number; w: number; h: number; png: Buffer }> = [];
    let pg: PDFPage | null = null;
    let y = 0;
    const newPage = () => {
      pg = this.doc.insertPage(insertBefore - 1 + added.length, [W, H]);
      added.push(pg);
      y = H - 50;
    };
    const bar = (title: string) => {
      if (!pg || y < 120) newPage();
      pg!.drawRectangle({ x: 22, y: y - 20, width: 562, height: 22, color: rgb(0.83, 0.83, 0.83), borderColor: BLACK, borderWidth: 0.75 });
      const tw = this.width(title, 8.5, true);
      pg!.drawText(title, { x: W / 2 - tw / 2, y: y - 13, size: 8.5, font: this.bold });
      y -= 32;
    };
    const para = (text: string, size = 8.2, b = false) => {
      const gap = { open: false };
      for (const l of this.wrap(text, 552, size)) {
        if (!pg || y < 70) newPage();
        this.draw(this.doc.getPages().indexOf(pg!) + 1, 28, y, l, size, b, gap);
        y -= size * 1.3;
      }
      y -= 6;
    };
    if (this.overflow.length) {
      bar("Continued Answers");
      for (const o of this.overflow) {
        para(`${o.label} (continued from page ${o.fromPage})`, 8.2, true);
        para(o.text);
      }
    }
    if (figures.length) {
      bar("Graphs");
      figures.forEach((f, i) => {
        const img = f.png;
        const w0 = img.readUInt32BE(16);
        const h0 = img.readUInt32BE(20);
        const k = Math.min(540 / w0, 330 / h0);
        const [w, h] = [w0 * k, h0 * k];
        if (!pg || y - h < 110) newPage();
        figs.push({ page: pg!, x: (W - w) / 2, y: y - h, w, h, png: img });
        y -= h + 12;
        para(`Figure ${i + 1}. ${f.title} (source: ${f.source})`, 7.8, true);
        para(f.summary);
      });
    }
    for (const f of figs) {
      const emb = await this.doc.embedPng(f.png);
      f.page.drawImage(emb, { x: f.x, y: f.y, width: f.w, height: f.h });
    }
    // Footers: the form's own "Page X of 13" is replaced on every page with the new count.
    const total = this.doc.getPageCount();
    const footerItems = this.layout.items.filter((i) => /^Page \d+ of \d+$/.test(i.s.trim()));
    let orig = 0;
    this.doc.getPages().forEach((page, idx) => {
      if (!added.includes(page)) {
        orig++;
        for (const it of footerItems.filter((i) => i.p === orig)) page.drawRectangle({ x: it.x - 2, y: it.y - 3, width: it.w + 8, height: it.size + 5, color: WHITE });
      } else {
        const fw = this.width(footer, 7);
        page.drawText(footer, { x: W / 2 - fw / 2, y: 42.8, size: 7, font: this.font });
      }
      const label = `Page ${idx + 1} of ${total}`;
      page.drawText(label, { x: 589 - this.width(label, 9), y: 24, size: 9, font: this.font });
    });
    return added.length;
  }

  save(): Promise<Uint8Array> {
    return this.doc.save();
  }
}
