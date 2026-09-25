// Grid colours shared by the on-screen grid, its legend and the exported image.
import { monthNames } from '../model';
import type { CellStatus } from '../reports';

export const STATUS: Record<CellStatus, { bg: string; fg: string; label: string }> = {
  paid: { bg: '#bfe5cc', fg: '#14532d', label: 'Paid' },
  'partly paid': { bg: '#fde2a6', fg: '#713f12', label: 'Part paid' },
  unpaid: { bg: '#f6b8b2', fg: '#7f1d1d', label: 'Unpaid' },
  advance: { bg: '#c7dbf7', fg: '#1e3a8a', label: 'Paid in advance' },
  joining: { bg: '#dccdf5', fg: '#4c1d95', label: 'Joining ₹350' },
  waived: { bg: '#cfd4dc', fg: '#374151', label: 'Waived' },
  future: { bg: '#f7f8fa', fg: '#667085', label: 'Not due yet' },
  'n/a': { bg: '#e9ebef', fg: '#9ca3af', label: 'Not a member / before start' },
  legacy: { bg: '#eadfc6', fg: '#5b4a1f', label: 'Recorded outside dues' },
};

/** Legend order: the statuses a reader needs first. */
export const LEGEND: CellStatus[] = ['paid', 'partly paid', 'unpaid', 'advance', 'joining', 'waived', 'future', 'n/a', 'legacy'];

export interface ImageRow { name: string; cells: { status: CellStatus; amount: number }[]; due: number }

const rupees = (paise: number) => Math.round(paise / 100).toLocaleString('en-IN');

/**
 * Compact grid picture for sharing on phones: names, 12 coloured month cells with the amount paid,
 * and what is still due for the year. Drawn at 3× so text stays sharp when zoomed.
 */
export function drawGridImage(title: string, subtitle: string, rows: ImageRow[]): HTMLCanvasElement {
  const font = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const pad = 10, nameW = 118, cellW = 30, dueW = 58, rowH = 20, headH = 18;
  const width = pad * 2 + nameW + cellW * 12 + dueW;
  const measure = document.createElement('canvas').getContext('2d')!;
  // Legend wraps into rows that fit the width.
  measure.font = `11px ${font}`;
  const legendRows: { status: CellStatus; x: number }[][] = [[]];
  let lx = pad;
  for (const st of LEGEND) {
    if (!rows.some(r => r.cells.some(c => c.status === st)) && !['paid', 'unpaid'].includes(st)) continue;
    const w = 16 + measure.measureText(STATUS[st].label).width + 12;
    if (lx + w > width - pad) { legendRows.push([]); lx = pad; }
    legendRows.at(-1)!.push({ status: st, x: lx });
    lx += w;
  }
  const top = pad + 20 + 16 + 8;
  const tableH = headH + rows.length * rowH;
  const height = top + tableH + 10 + legendRows.length * 18 + pad;

  const scale = 3;
  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const g = canvas.getContext('2d')!;
  g.scale(scale, scale);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, width, height);
  g.textBaseline = 'middle';

  g.fillStyle = '#1d2433';
  g.font = `bold 15px ${font}`;
  g.fillText(title, pad, pad + 9);
  g.fillStyle = '#667085';
  g.font = `11px ${font}`;
  g.fillText(subtitle, pad, pad + 27);

  const x0 = pad, y0 = top;
  g.font = `bold 10px ${font}`;
  g.fillStyle = '#1d2433';
  g.textAlign = 'left';
  g.fillText('Member', x0 + 4, y0 + headH / 2);
  g.textAlign = 'center';
  monthNames.forEach((m, i) => g.fillText(m, x0 + nameW + i * cellW + cellW / 2, y0 + headH / 2));
  g.fillText('Due', x0 + nameW + 12 * cellW + dueW / 2, y0 + headH / 2);

  rows.forEach((r, ri) => {
    const y = y0 + headH + ri * rowH;
    if (ri % 2) { g.fillStyle = '#f8f9fb'; g.fillRect(x0, y, nameW, rowH); g.fillRect(x0 + nameW + 12 * cellW, y, dueW, rowH); }
    g.fillStyle = '#1d2433';
    g.textAlign = 'left';
    g.font = `600 11px ${font}`;
    let name = r.name;
    while (g.measureText(name).width > nameW - 8 && name.length > 3) name = name.slice(0, -2) + '…';
    g.fillText(name, x0 + 4, y + rowH / 2);
    g.textAlign = 'center';
    r.cells.forEach((c, ci) => {
      const cx = x0 + nameW + ci * cellW;
      g.fillStyle = STATUS[c.status].bg;
      g.fillRect(cx, y, cellW, rowH);
      if (c.amount) {
        g.fillStyle = STATUS[c.status].fg;
        g.font = `600 9.5px ${font}`;
        g.fillText(rupees(c.amount), cx + cellW / 2, y + rowH / 2);
      }
    });
    g.textAlign = 'right';
    g.font = `bold 11px ${font}`;
    g.fillStyle = r.due ? '#b42318' : '#1f7a4d';
    g.fillText(r.due ? `₹${rupees(r.due)}` : '✓', x0 + nameW + 12 * cellW + dueW - 6, y + rowH / 2);
  });

  // Cell borders
  g.strokeStyle = '#ffffff';
  g.lineWidth = 1;
  for (let i = 0; i <= 12; i++) { g.beginPath(); g.moveTo(x0 + nameW + i * cellW, y0 + headH); g.lineTo(x0 + nameW + i * cellW, y0 + tableH); g.stroke(); }
  for (let ri = 0; ri <= rows.length; ri++) { g.beginPath(); g.moveTo(x0 + nameW, y0 + headH + ri * rowH); g.lineTo(x0 + nameW + 12 * cellW, y0 + headH + ri * rowH); g.stroke(); }
  g.strokeStyle = '#d0d5dd';
  g.beginPath(); g.moveTo(x0, y0 + headH); g.lineTo(width - pad, y0 + headH); g.stroke();
  g.beginPath(); g.moveTo(x0, y0 + tableH); g.lineTo(width - pad, y0 + tableH); g.stroke();

  g.textAlign = 'left';
  g.font = `11px ${font}`;
  legendRows.forEach((row, i) => {
    const y = y0 + tableH + 10 + i * 18 + 9;
    for (const { status, x } of row) {
      g.fillStyle = STATUS[status].bg;
      g.fillRect(x, y - 6, 12, 12);
      g.strokeStyle = '#98a2b3';
      g.strokeRect(x + 0.5, y - 5.5, 11, 11);
      g.fillStyle = '#1d2433';
      g.fillText(STATUS[status].label, x + 16, y);
    }
  });
  return canvas;
}

export const toBlob = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(Error('Could not create the image.'))), 'image/png'));
