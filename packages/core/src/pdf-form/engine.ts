import { readFile } from "node:fs/promises";
import { join } from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";

/**
 * Fill a company's own (flat) PDF form without changing it: answers are typed
 * into the existing blanks, found by their label text and the cell rectangles
 * drawn on the page (both recorded once in a layout file). Sentences that
 * contain the client's name or an inline blank are retyped in place. A box too
 * small for its answer grows where it is: the page is cut below the box, the
 * box is extended, and the rest of the page moves down (onto a following page
 * when needed). Pages without a long answer stay exactly as they are. Graphs
 * go on added pages before the signature page.
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

/** Resolved when a form is filled (the worker), not at import: bundlers such as Next.js have no import.meta.dirname. */
export const assetsDir = () => process.env.ABA_ASSETS_DIR ?? join(import.meta.dirname ?? process.cwd(), "..", "..", "assets");
const BLACK = rgb(0, 0, 0);
const WHITE = rgb(1, 1, 1);
const YELLOW = rgb(1, 0.95, 0.4);
const MIN_SIZE = 6.8;
/** Boxes shrink their text at most this far before they grow instead. */
const GROW_SIZE = 7.4;
/** The form's content area on every page; below it is the footer. */
const CONTENT_TOP = 774;
const CONTENT_BOTTOM = 69;
/** Half the width of the form's table lines plus a little: cuts sit this far above a border. */
const BORDER = 1.1;
const LINE = 1.4;

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

/** The invisible frame every form page has around its content area. */
const isFrame = (e: { o: "h" | "v"; c: number; a: number; b: number }) =>
  e.b - e.a >= 600 || (e.o === "h" && e.b - e.a > 560 && (Math.abs(e.c - CONTENT_BOTTOM) < 1 || Math.abs(e.c - CONTENT_TOP) < 1));

/** The drawing calls the filler uses, on a form page (recorded) or on an output page (direct). */
type Canvas = Pick<PDFPage, "drawText" | "drawRectangle" | "drawLine">;

/** Lines of an answer that continue below its box, in a strip added under the box's row. */
interface Grow {
  p: number;
  /** Where the page is cut: just above the box's bottom border. */
  cut: number;
  x: number;
  lines: string[];
  size: number;
  lead: number;
  /** Baseline of the first continued line below the top of the strip (keeps the box's line spacing). */
  drop: number;
  gap: { open: boolean };
}

export interface Figure {
  png: Buffer;
  title: string;
  source: string;
  summary: string;
}

export class FormFiller {
  overflow: Overflow[] = [];
  private grows: Grow[] = [];
  private ops: Array<{ p: number; y: number; run: (pg: PDFPage, dy: number) => void }> = [];
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
    const doc = await PDFDocument.load(await readFile(join(assetsDir(), blankPdf)));
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(await readFile(join(assetsDir(), "DejaVuSans.ttf")), { subset: true });
    const bold = await doc.embedFont(await readFile(join(assetsDir(), "DejaVuSans-Bold.ttf")), { subset: true });
    const layout = JSON.parse(await readFile(join(assetsDir(), layoutJson), "utf8")) as Layout;
    return new FormFiller(doc, layout, font, bold);
  }

  /**
   * Drawing on form page p. Nothing touches the page itself until finish(): each call is
   * recorded with its height on the page and replayed where that part of the page ends up,
   * so every answer is written exactly once even when the page is cut and moved.
   */
  page(p: number): Canvas {
    const rec = (y: number, run: (pg: PDFPage, dy: number) => void) => this.ops.push({ p, y, run });
    return {
      drawText: (t, o = {}) => rec(o.y ?? 0, (pg, dy) => pg.drawText(t, { ...o, y: (o.y ?? 0) + dy })),
      drawRectangle: (o = {}) => rec((o.y ?? 0) + (o.height ?? 0) / 2, (pg, dy) => pg.drawRectangle({ ...o, y: (o.y ?? 0) + dy })),
      drawLine: (o) => rec((o.start.y + o.end.y) / 2, (pg, dy) => pg.drawLine({ ...o, start: { ...o.start, y: o.start.y + dy }, end: { ...o.end, y: o.end.y + dy } })),
    };
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

  cellOrNull(p: number, x: number, y: number): LayoutRect | null {
    try {
      return this.cellAt(p, x, y);
    } catch {
      return null;
    }
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
  draw(p: number | Canvas, x: number, y: number, text: string, size: number, b = false, gap: { open: boolean } = { open: false }) {
    const pg = typeof p === "number" ? this.page(p) : p;
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
      if (hl) pg.drawRectangle({ x: cx, y: y - size * 0.25, width: w, height: size * 1.15, color: YELLOW });
      pg.drawText(part, { x: cx, y, size, font: b ? this.bold : this.font, color: BLACK });
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
   * Text in a box from `top` down: shrink a little to fit; if it still doesn't fit, the box
   * grows (see finish). Boxes that aren't a whole cell fall back to the added pages.
   */
  box(p: number, x0: number, top: number, x1: number, bottom: number, text: string, label: string, size = 8.2) {
    if (!text.trim()) return;
    const width = x1 - x0;
    let s = size;
    let lines = this.wrap(text, width, s);
    const fits = (n: number, sz: number) => n * sz * 1.25 <= top - bottom;
    while (!fits(lines.length, s) && s > Math.min(size, GROW_SIZE)) {
      s -= 0.2;
      lines = this.wrap(text, width, s);
    }
    const lead = s * 1.25;
    if (!fits(lines.length, s)) {
      const marker = this.compactGap(text, width, s);
      if (marker) return this.draw(p, x0, top - s, marker, s);
      const cell = this.cellOrNull(p, x0 + 1, bottom + 1);
      if (cell && bottom - cell.y0 <= 4) {
        // Fill the box down to its border, then continue in the strip at the same line spacing.
        const cut = cell.y0 + BORDER;
        const inBox = Math.max(1, Math.floor((top - s - (cut + s * 0.3)) / lead) + 1);
        const gap = { open: false };
        lines.slice(0, inBox).forEach((l, i) => this.draw(p, x0, top - s - i * lead, l, s, false, gap));
        const nextBaseline = top - s - inBox * lead;
        this.grows.push({ p, cut, x: x0, lines: lines.slice(inBox), size: s, lead, drop: Math.max(s * 0.85, cut - nextBaseline), gap });
        return;
      }
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
   * Lay the filled pages out again: each page starts a new page; a page with a grown box is
   * cut into bands (at the box and between sections), the box's extra lines go in a strip
   * under its row, and bands that no longer fit move to a following page. Added pages for
   * answers that still didn't fit and for graphs go before page `insertBefore`; then every
   * "Page X of N" footer is renumbered. `footer` is the company line on the added pages.
   */
  async finish(figures: Figure[], footer: string, insertBefore: number) {
    const W = 612;
    const H = 792;
    const n = this.doc.getPageCount();
    const originals = this.doc.getPages();
    // The form's own "Page X of 13" goes; every page gets the new count at the end.
    const footerItems = this.layout.items.filter((i) => /^Page \d+ of \d+$/.test(i.s.trim()));
    originals.forEach((_, idx) => {
      for (const it of footerItems.filter((i) => i.p === idx + 1)) this.page(idx + 1).drawRectangle({ x: it.x - 2, y: it.y - 3, width: it.w + 8, height: it.size + 5, color: WHITE });
    });

    const out: PDFPage[] = [];
    const addPage = () => {
      const pg = this.doc.addPage([W, H]);
      out.push(pg);
      return pg;
    };

    /** Replay page p's recorded drawing: each call goes where its part of the page was placed. */
    const replay = (p: number, placed: Array<{ top: number; bottom: number; pg: PDFPage; dy: number }>, footers: PDFPage[]) => {
      for (const op of this.ops.filter((o) => o.p === p)) {
        if (op.y < CONTENT_BOTTOM - 3) {
          for (const f of footers) op.run(f, 0);
          continue;
        }
        const at = placed.find((b) => op.y <= b.top && op.y > b.bottom) ?? placed[placed.length - 1]!;
        op.run(at.pg, at.dy);
      }
    };

    // The output page being filled, shared across form pages: once a long answer pushes content
    // down, the following form pages continue right after it instead of leaving half-empty pages.
    let pg: PDFPage | null = null;
    let cursor = 0;
    let openEnd = false; // the previous form page ended inside a box that continues on the next page
    let endLine: [number, number] | null = null; // ...or ended with a table line, spanning these x
    const bottomY = CONTENT_BOTTOM - 3;

    const layOut = async (p: number) => {
      const src = originals[p - 1]!;
      const grows = this.grows.filter((g) => g.p === p);
      if (!grows.length && !pg) {
        // Nothing moved so far: the page stays exactly as it is.
        const whole = addPage();
        whole.drawPage(await this.doc.embedPage(src), { x: 0, y: 0 });
        replay(p, [{ top: H, bottom: -1, pg: whole, dy: 0 }], [whole]);
        return;
      }
      const placed: Array<{ top: number; bottom: number; pg: PDFPage; dy: number }> = [];
      const footers: PDFPage[] = [];
      const footerBand = await this.doc.embedPage(src, { left: 0, bottom: 0, right: W, top: bottomY });
      const cuts = [...new Set(grows.map((g) => g.cut))].sort((a, b) => b - a);
      // Each piece carries the page's whole content (clipped), so the page is cut as few times as possible.
      const breaks = this.sectionBreaks(p);
      const fresh = () => {
        pg = addPage();
        pg.drawPage(footerBand, { x: 0, y: 0 });
        footers.push(pg);
        cursor = CONTENT_TOP;
      };
      let top = H;
      if (!pg) {
        fresh();
        cursor = H; // the first piece keeps the page top (logo, draft note)
      } else {
        // Continue on the current page after a small gap, from where this page's content starts.
        // A box that ran over the form's page break joins up seamlessly; otherwise leave a small gap.
        const first = this.contentBelow(p, CONTENT_TOP, bottomY) ?? bottomY;
        const startLine = this.hLineNear(p, first - 1);
        if (openEnd) top = CONTENT_TOP + 1;
        else if (endLine && startLine && Math.abs(startLine[0] - endLine[0]) < 3 && Math.abs(startLine[1] - endLine[1]) < 3) {
          // A table split by the form's page break: its two halves meet on one line.
          top = first - 1;
          cursor += 1;
        } else {
          top = first + 2;
          cursor -= 10;
        }
      }
      // Place [top, y] of the page at the cursor, splitting between sections where a page fills up.
      const place = async (y: number) => {
        while (top - y > 0.5) {
          const content = this.contentBelow(p, top, y);
          if (content === null) break; // only white space left
          if (cursor === CONTENT_TOP && content < top - 2) top = content + 2; // a new page starts at content, not white space
          let end = y;
          if (cursor - (top - y) < bottomY) {
            const fits = breaks.filter((b) => b < top && b > y && cursor - (top - b) >= bottomY);
            if (fits.length) end = Math.min(...fits);
            else if (cursor < CONTENT_TOP) {
              fresh();
              continue;
            } else end = Math.max(y, top - (cursor - bottomY)); // taller than a page: cut where it must
          }
          const band = await this.doc.embedPage(src, { left: 0, bottom: end, right: W, top });
          pg!.drawPage(band, { x: 0, y: cursor - (top - end) });
          placed.push({ top, bottom: end, pg: pg!, dy: cursor - top });
          cursor -= top - end;
          top = end;
          if (top > y + 0.5 && this.contentBelow(p, top, y) !== null) fresh();
        }
        top = Math.min(top, y);
      };
      // The page's white space at the bottom is left out, so the next page can follow straight on.
      const last = this.contentBottom(p);
      openEnd = last <= CONTENT_BOTTOM + 3;
      endLine = this.hLineNear(p, last + 2);
      for (const y of [...cuts.filter((c) => c > last), last]) {
        await place(y);
        if (cuts.includes(y)) {
          // The strip continuing every grown box of this row, with the row's column lines.
          const row = grows.filter((g) => g.cut === y);
          const cols = this.layout.edges.filter((e) => e.p === p && e.o === "v" && e.b - e.a < 600 && e.a <= y - BORDER - 0.3 && e.b >= y + 0.3).map((e) => e.c);
          const queue = row.map((g) => ({ g, i: 0 }));
          const stripTop = cursor;
          while (queue.some((q) => q.i < q.g.lines.length)) {
            if (cursor - CONTENT_BOTTOM < 14) {
              this.hline(pg!, cols, cursor);
              fresh();
              this.hline(pg!, cols, cursor);
            }
            const start = cursor;
            let used = 0;
            for (const q of queue) {
              const drop = q.i === 0 && start === stripTop ? q.g.drop : q.g.size * 1.05;
              const fit = Math.max(1, Math.floor((start - drop - CONTENT_BOTTOM - 3) / q.g.lead) + 1);
              const take = q.g.lines.slice(q.i, q.i + fit);
              take.forEach((l, k) => this.draw(pg!, q.g.x, start - drop - k * q.g.lead, l, q.g.size, false, q.g.gap));
              q.i += take.length;
              if (take.length) used = Math.max(used, drop + (take.length - 1) * q.g.lead + q.g.size * 0.45);
            }
            for (const c of cols) pg!.drawLine({ start: { x: c, y: start }, end: { x: c, y: start - used }, thickness: LINE, color: BLACK });
            cursor -= used;
          }
        }
      }
      replay(p, placed, footers);
    };

    for (let p = 1; p < insertBefore; p++) await layOut(p);
    pg = null; // graphs and the signature page start on new pages

    // Added pages: answers that still didn't fit, then the graphs.
    let y = 0;
    const added: PDFPage[] = [];
    const newPage = () => {
      pg = addPage();
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
        this.draw(pg!, 28, y, l, size, b, gap);
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
      for (const [i, f] of figures.entries()) {
        const w0 = f.png.readUInt32BE(16);
        const h0 = f.png.readUInt32BE(20);
        const k = Math.min(540 / w0, 330 / h0);
        const [w, h] = [w0 * k, h0 * k];
        if (!pg || y - h < 110) newPage();
        pg!.drawImage(await this.doc.embedPng(f.png), { x: (W - w) / 2, y: y - h, width: w, height: h });
        y -= h + 12;
        para(`Figure ${i + 1}. ${f.title} (source: ${f.source})`, 7.8, true);
        para(f.summary);
      }
    }
    for (const a of added) {
      const fw = this.width(footer, 7);
      a.drawText(footer, { x: W / 2 - fw / 2, y: 42.8, size: 7, font: this.font });
    }

    for (let p = insertBefore; p <= n; p++) await layOut(p);
    for (let i = 0; i < n; i++) this.doc.removePage(0);
    out.forEach((page, idx) => {
      const label = `Page ${idx + 1} of ${out.length}`;
      page.drawText(label, { x: 589 - this.width(label, 9), y: 24, size: 9, font: this.font });
    });
    return out.length - n;
  }

  /**
   * The top of the highest thing drawn on page p between y and top: `top` itself when
   * something crosses it, null when there is only white space.
   */
  private contentBelow(p: number, top: number, y: number): number | null {
    let best: number | null = null;
    for (const [lo, hi] of this.spans(p)) {
      if (hi <= y || lo >= top) continue;
      if (hi >= top) return top;
      best = Math.max(best ?? -Infinity, hi);
    }
    return best;
  }

  /** The x extent of the table line(s) at height y on page p, if any. */
  private hLineNear(p: number, y: number): [number, number] | null {
    const hs = this.layout.edges.filter((e) => e.p === p && e.o === "h" && !isFrame(e) && Math.abs(e.c - y) < 1.6);
    return hs.length ? [Math.min(...hs.map((e) => e.a)), Math.max(...hs.map((e) => e.b))] : null;
  }

  /** The lowest point of anything drawn in page p's content area. */
  private contentBottom(p: number): number {
    return Math.max(CONTENT_BOTTOM - 3, Math.min(...this.spans(p).filter(([, hi]) => hi > CONTENT_BOTTOM - 3).map(([lo]) => lo)) - 1);
  }

  /** Vertical extent of every text item, table line, shaded bar and recorded drawing on page p. */
  private spans(p: number): Array<[number, number]> {
    return [
      ...this.layout.items.filter((i) => i.p === p && i.s.trim()).map((i): [number, number] => [i.y - i.size * 0.35, i.y + i.size * 1.05]),
      ...this.layout.edges.filter((e) => e.p === p && !isFrame(e)).map((e): [number, number] => (e.o === "h" ? [e.c - 1, e.c + 1] : [e.a, e.b])),
      ...this.layout.rects.filter((r) => r.p === p && r.y1 - r.y0 < 600).map((r): [number, number] => [r.y0, r.y1]),
      ...this.ops.filter((o) => o.p === p).map((o): [number, number] => [o.y - 8, o.y + 8]),
    ];
  }

  /** A horizontal line across a strip's columns (where a strip breaks across pages). */
  private hline(pg: PDFPage, cols: number[], y: number) {
    if (cols.length < 2) return;
    pg.drawLine({ start: { x: Math.min(...cols), y }, end: { x: Math.max(...cols), y }, thickness: LINE, color: BLACK });
  }

  /**
   * Where a page can be cut between sections: heights crossed by no table column line,
   * text or shaded bar (the page frame aside). Cuts sit in the middle of each such gap.
   */
  private sectionBreaks(p: number): number[] {
    const v = this.layout.edges.filter((e) => e.p === p && e.o === "v" && e.b - e.a < 600);
    const h = this.layout.edges.filter((e) => e.p === p && e.o === "h" && e.b - e.a < 600);
    const items = this.layout.items.filter((i) => i.p === p);
    const rects = this.layout.rects.filter((r) => r.p === p && r.y1 - r.y0 < 600);
    const free = (y: number) =>
      !v.some((e) => e.a < y && y < e.b) &&
      !h.some((e) => Math.abs(e.c - y) < 1.5) &&
      !items.some((i) => i.y - i.size * 0.35 < y && y < i.y + i.size * 1.05) &&
      !rects.some((r) => r.y0 - 1 < y && y < r.y1 + 1);
    const out: number[] = [];
    let runTop: number | null = null;
    for (let y = CONTENT_TOP - 1; y >= CONTENT_BOTTOM + 1; y--) {
      if (free(y)) runTop ??= y;
      else if (runTop !== null) {
        if (runTop - y >= 3) out.push((runTop + y + 1) / 2);
        runTop = null;
      }
    }
    return out;
  }

  save(): Promise<Uint8Array> {
    return this.doc.save();
  }
}
