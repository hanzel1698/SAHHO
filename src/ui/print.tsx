// Printed and PDF layout for report tables: fills one A4 portrait page whenever the rows allow.
import { Ref, RefObject, useLayoutEffect, useState } from 'react';
import type { Table } from '../reports';

// A4 portrait (210 × 297mm) with 7mm margins leaves 196 × 283mm, about 740 × 1069 CSS px.
const MARGIN_MM = 7;
const SHEET_MM = { width: 196, height: 283 };
const SHEET_PX = { width: 740, height: 1060 }; // height kept a little short of the page as a safety margin
const GAP_PX = 8;
/** Table type sizes to try, largest first: the largest that fits one page wins. 10px (7.5pt) is the smallest
 *  that stays comfortable to read on paper; anything longer runs onto a second page instead of shrinking. */
const FONT_STEPS = [14, 13.5, 13, 12.5, 12, 11.5, 11, 10.5, 10];
const FALLBACK_FONT = 11;

export type PrintFit = { count: number; font: number; widths: number[] };
export type PrintCells = {
  headClass: (j: number) => string | undefined;
  cellClass: (v: string | number, j: number) => string | undefined;
  rowClass: (i: number) => string | undefined;
};

const PRINT_COLUMNS_KEY = 'sahho-print-hidden-columns';

/** Columns left out of printouts and PDFs, remembered in this browser per table layout (its column list). */
export function usePrintHidden(columns: string[], defaults: string[] = []) {
  const layout = columns.join('|');
  const [saved, setSaved] = useState<Record<string, string[]>>(() => {
    try { return JSON.parse(localStorage.getItem(PRINT_COLUMNS_KEY) ?? '{}') ?? {}; } catch { return {}; }
  });
  const hidden = (saved[layout] ?? defaults).filter(c => columns.includes(c));
  const setHidden = (list: string[]) => {
    const next = { ...saved, [layout]: list };
    setSaved(next);
    try { localStorage.setItem(PRINT_COLUMNS_KEY, JSON.stringify(next)); } catch { /* not remembered; still applies for now */ }
  };
  return [hidden, setHidden] as const;
}

/** "SAHHO · Contributions-ANARGH_V" for a member statement, otherwise the report title. */
export function printName(table: Table) {
  return `SAHHO · Contributions-${(table.subject ?? table.title).trim().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_|_$/g, '')}`;
}

/**
 * Picks the printed layout from a hidden, full-length copy of the sheet: the largest type, then the fewest
 * side-by-side tables, that fit the title block and every row on one page without squeezing a table below
 * its content width. Also returns that table's column widths (%) so the side-by-side tables line up.
 */
export function usePrintFit(probe: RefObject<HTMLDivElement | null>, deps: unknown[]) {
  const [fit, setFit] = useState<PrintFit>({ count: 1, font: FALLBACK_FONT, widths: [] });
  useLayoutEffect(() => {
    const sheet = probe.current, t = sheet?.querySelector('table'), head = sheet?.querySelector<HTMLElement>('.ps-head');
    if (!t || !head) return;
    const room = SHEET_PX.height - head.offsetHeight;
    const slot = (n: number) => (SHEET_PX.width - GAP_PX * (n - 1)) / n;
    const apply = (n: number, font: number) => { t.style.width = `${slot(n)}px`; t.style.fontSize = `${font}px`; };
    const fits = (n: number) => {
      const headRow = t.tHead?.offsetHeight ?? 0;
      // Rows are shared out evenly, so allow a little for the tallest table holding the taller rows.
      return (t.offsetHeight - headRow) / n * 1.04 + headRow <= room;
    };
    let choice: { count: number; font: number } | undefined;
    search: for (const font of FONT_STEPS) {
      for (let n = 1; n <= 3; n++) {
        apply(n, font);
        if (t.offsetWidth > slot(n) + 1) break; // too wide at this size: more tables only get narrower
        if (fits(n)) { choice = { count: n, font }; break search; }
      }
    }
    if (!choice) {
      // Longer than one page even at 10px: comfortable type, and as many tables across as fit.
      let n = 1;
      while (n < 3) { apply(n + 1, FALLBACK_FONT); if (t.offsetWidth > slot(n + 1) + 1) break; n++; }
      choice = { count: n, font: FALLBACK_FONT };
    }
    apply(choice.count, choice.font);
    const cells = [...t.querySelectorAll('thead th')].map(th => (th as HTMLElement).offsetWidth);
    const total = cells.reduce((v, w) => v + w, 0) || 1;
    const next = { ...choice, widths: cells.map(w => w / total * 100) };
    setFit(f => f.count === next.count && f.font === next.font && f.widths.join() === next.widths.join() ? f : next);
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return fit;
}

/** The printed page: compact title block, then the rows split across `fit.count` side-by-side tables. */
export function PrintSheet({ table, cols, cells, fit, probe, className, ref }: {
  table: Table; cols: number[]; cells: PrintCells; fit: PrintFit; probe?: boolean; className: string; ref?: Ref<HTMLDivElement>;
}) {
  const count = probe ? 1 : fit.count;
  const per = Math.ceil(table.rows.length / count) || 1;
  const chunks = Array.from({ length: count }, (_, i) => [i * per, Math.min(table.rows.length, (i + 1) * per)] as const).filter(([a, b]) => b > a);
  const sized = !probe && fit.widths.length === cols.length;
  return (
    <div ref={ref} className={`print-sheet ${className}`} aria-hidden={probe || undefined}>
      <div className="ps-head">
        <div className="ps-title">{table.title}</div>
        {table.summary && (
          <div className="ps-summary">
            {table.summary.map(x => (
              <div key={x.label} className={`summary-item ${x.tone ?? ''}`}>
                <div className="summary-label">{x.label}</div>
                <div className="summary-value">{x.value}</div>
                {x.detail && <div className="summary-detail">{x.detail}</div>}
              </div>
            ))}
          </div>
        )}
        {(table.printNote ?? table.note) && <div className="ps-note">{table.printNote ?? table.note}</div>}
      </div>
      <div className="ps-cols">
        {(chunks.length ? chunks : [[0, 0] as const]).map(([from, to]) => (
          <table key={from} className="bordered print-table" style={probe ? undefined : { fontSize: `${fit.font}px`, tableLayout: sized ? 'fixed' : undefined }}>
            {sized && <colgroup>{fit.widths.map((w, x) => <col key={x} style={{ width: `${w}%` }} />)}</colgroup>}
            <thead><tr>{cols.map(j => <th key={j} className={cells.headClass(j)}>{table.columns[j]}</th>)}</tr></thead>
            <tbody>
              {table.rows.slice(from, to).map((r, i) => <tr key={i} className={cells.rowClass(from + i)}>{cols.map(j => <td key={j} className={cells.cellClass(r[j], j)}>{r[j]}</td>)}</tr>)}
            </tbody>
          </table>
        ))}
      </div>
    </div>
  );
}

/** Prints with the PDF name as the page title, which browsers offer as the "Save as PDF" file name. */
export function printAs(name: string) {
  const title = document.title;
  document.title = name;
  try { window.print(); } finally { document.title = title; }
}

/** Saves the printed sheet straight to an A4 PDF (a crisp image of the same layout, one page per 283mm). */
export async function savePDF(sheet: HTMLElement, name: string) {
  const [{ toCanvas }, { jsPDF }] = await Promise.all([import('html-to-image'), import('jspdf')]);
  sheet.classList.add('capturing');
  let canvas: HTMLCanvasElement;
  try {
    canvas = await toCanvas(sheet, { pixelRatio: 3, backgroundColor: '#ffffff', skipFonts: true, style: { position: 'static', left: '0', top: '0' } });
  } finally {
    sheet.classList.remove('capturing');
  }
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
  const pxPerMm = canvas.width / SHEET_MM.width, pageH = Math.floor(SHEET_MM.height * pxPerMm);
  for (let y = 0; y < canvas.height; y += pageH) {
    const h = Math.min(pageH, canvas.height - y), page = document.createElement('canvas');
    page.width = canvas.width; page.height = h;
    page.getContext('2d')!.drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h);
    if (y) pdf.addPage();
    pdf.addImage(page.toDataURL('image/png'), 'PNG', MARGIN_MM, MARGIN_MM, SHEET_MM.width, h / pxPerMm, undefined, 'FAST');
  }
  pdf.setProperties({ title: name });
  const url = URL.createObjectURL(pdf.output('blob'));
  const a = document.createElement('a');
  a.href = url; a.download = `${name}.pdf`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
