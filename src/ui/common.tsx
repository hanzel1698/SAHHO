import { ReactNode, useState } from 'react';
import { State, money } from '../model';
import { Table, toCSV } from '../reports';

export const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(' ');

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className={cx('stat', tone)}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function Money({ p, dim }: { p?: number; dim?: boolean }) {
  return <span className={cx('num', dim && 'dim')}>{money(p)}</span>;
}

export function Badge({ children, tone }: { children: ReactNode; tone?: 'good' | 'warn' | 'bad' | 'info' | 'muted' }) {
  return <span className={cx('badge', tone)}>{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function download(name: string, content: BlobPart, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const XL_LINE = { style: 'thin' as const, color: { rgb: 'A9B1BD' } };
const XL_BOX = { top: XL_LINE, bottom: XL_LINE, left: XL_LINE, right: XL_LINE };
const XL_TONE = { bad: ['B42318', 'FDECEA'], warn: ['9A5B00', 'FFF4DD'], good: ['1F7A4D', 'E6F4EC'] } as const;
const XL_GROUP = ['E8F0FB', 'FFF4DD'];

/** Styled workbook: key figures highlighted at the top, then a fully bordered table (header shaded, amounts as numbers). */
export async function exportXLSX(name: string, tables: Table[]) {
  const mod = await import('xlsx-js-style');
  const XLSX = mod.default ?? mod;
  const book = XLSX.utils.book_new();
  const font = (extra: object = {}) => ({ name: 'Arial', sz: 10, ...extra });
  tables.forEach((t, i) => {
    const last = Math.max(t.columns.length - 1, 1);
    const isNum = (j: number) => /\(₹\)/.test(t.columns[j]);
    const aoa: (string | number)[][] = [[t.title]];
    const merges: { s: { r: number; c: number }; e: { r: number; c: number } }[] = [];
    const styles = new Map<string, object>([['0,0', { font: font({ bold: true, sz: 14 }) }]]);
    for (const x of t.summary ?? []) {
      const r = aoa.length, [ink, bg] = x.tone ? XL_TONE[x.tone] : ['1D2433', 'EEF0F3'];
      aoa.push([x.label, x.value]);
      merges.push({ s: { r, c: 1 }, e: { r, c: last } });
      const fill = { fgColor: { rgb: bg } };
      styles.set(`${r},0`, { font: font({ bold: true, color: { rgb: ink } }), fill, border: XL_BOX, alignment: { vertical: 'center' } });
      for (let c = 1; c <= last; c++) styles.set(`${r},${c}`, { font: font({ bold: true, sz: 13, color: { rgb: ink } }), fill, border: XL_BOX, alignment: { vertical: 'center', wrapText: true } });
      if (x.detail) {
        aoa.push(['', x.detail]);
        merges.push({ s: { r: r + 1, c: 1 }, e: { r: r + 1, c: last } });
        for (let c = 0; c <= last; c++) styles.set(`${r + 1},${c}`, { font: font({ italic: true, color: { rgb: ink } }), fill, border: XL_BOX, alignment: { wrapText: true } });
      }
    }
    if (t.note) { styles.set(`${aoa.length},0`, { font: font({ italic: true, color: { rgb: '667085' } }) }); aoa.push([t.note]); }
    aoa.push([]);
    const head = aoa.length;
    aoa.push(t.columns);
    // Amount columns go in as numbers so they align and can be summed.
    for (const row of t.rows) aoa.push(row.map((v, j) => isNum(j) && typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v));
    t.columns.forEach((c, j) => styles.set(`${head},${j}`, {
      font: font({ bold: true }), fill: { fgColor: { rgb: 'E4E8EE' } },
      border: { ...XL_BOX, bottom: { style: 'medium', color: { rgb: '98A2B3' } } },
      alignment: { horizontal: isNum(j) ? 'right' : t.center?.includes(c) ? 'center' : 'left', vertical: 'center', wrapText: true },
    }));
    t.rows.forEach((_, k) => {
      const g = t.groups?.[k], bad = t.tones?.[k] === 'bad';
      t.columns.forEach((c, j) => styles.set(`${head + 1 + k},${j}`, {
        font: font(bad ? { bold: true, color: { rgb: XL_TONE.bad[0] } } : {}), border: XL_BOX, ...(g ? { fill: { fgColor: { rgb: XL_GROUP[(g + 1) % 2] } } } : {}),
        alignment: { horizontal: isNum(j) ? 'right' : t.center?.includes(c) ? 'center' : 'left', vertical: 'top' },
        ...(isNum(j) ? { numFmt: '#,##0.00' } : {}),
      }));
    });
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    for (const [key, s] of styles) {
      const [r, c] = key.split(',').map(Number), ref = XLSX.utils.encode_cell({ r, c });
      (sheet[ref] ??= { t: 's', v: '' }).s = s;
    }
    sheet['!merges'] = merges;
    // Widths follow the table's own content; the label column also fits the summary labels.
    const width = (v: unknown) => String(v ?? '').length;
    sheet['!cols'] = t.columns.map((c, j) => ({
      wch: Math.min(48, Math.max(8, width(c) + 2, ...t.rows.map(r => width(r[j]) + 1), ...(j === 0 ? (t.summary ?? []).map(x => width(x.label) + 2) : []))),
    }));
    const span = sheet['!cols'].slice(1).reduce((v, c) => v + (c.wch ?? 0), 0) || 40;
    // Summary rows grow to fit wrapped text (Excel does not auto-fit merged cells).
    sheet['!rows'] = aoa.map((r, k) => k === head ? { hpt: 20 } : k > 0 && k < head && typeof r[1] === 'string' && r[1] ? { hpt: Math.ceil(r[1].length / span) * (r[0] ? 18 : 14) + 4 } : {});
    XLSX.utils.book_append_sheet(book, sheet, (t.title.replace(/[^\w ]/g, '').slice(0, 28) || 'Report') + (tables.length > 1 ? i : ''));
  });
  XLSX.writeFile(book, name);
}

/** Shading for grouped rows: alternating tints per group, with a bracket on the first and last row of each group. */
function splitClass(groups: Table['groups'], i: number) {
  const g = groups?.[i];
  if (!g) return undefined;
  return ['split', `split-${g % 2 ? 'a' : 'b'}`, groups![i - 1] !== g ? 'split-first' : '', groups![i + 1] !== g ? 'split-last' : ''].filter(Boolean).join(' ');
}

export function ReportTable({ table, limit = 500, compact = false, nowrap = false, bordered = false }: { table: Table; limit?: number; compact?: boolean; nowrap?: boolean; bordered?: boolean }) {
  const [all, setAll] = useState(false);
  const rows = all ? table.rows : table.rows.slice(0, limit);
  return (
    <div className={compact ? 'report compact' : 'report'}>
      <div className="report-head">
        <h3>{table.title}</h3>
        <div className="actions no-print">
          <button onClick={() => download(`${table.title.replace(/\W+/g, '-')}.csv`, '\uFEFF' + toCSV(table), 'text/csv')}>CSV</button>
          <button onClick={() => void exportXLSX(`${table.title.replace(/\W+/g, '-')}.xlsx`, [table])}>Excel</button>
          <button onClick={() => window.print()}>Print</button>
        </div>
      </div>
      {table.summary && (
        <div className="report-summary">
          {table.summary.map(x => (
            <div key={x.label} className={cx('summary-item', x.tone)}>
              <div className="summary-label">{x.label}</div>
              <div className="summary-value">{x.value}</div>
              {x.detail && <div className="summary-detail">{x.detail}</div>}
            </div>
          ))}
        </div>
      )}
      {table.note && <p className="note">{table.note}</p>}
      <div className={cx('table-wrap', bordered && 'bordered')}>
        <table className={cx(compact && 'compact', nowrap && 'nowrap', bordered && 'bordered') || undefined}>
          <thead><tr>{table.columns.map(c => <th key={c} className={table.center?.includes(c) ? 'center' : undefined}>{c}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => <tr key={i} className={cx(splitClass(table.groups, i), table.tones?.[i] === 'bad' && 'due') || undefined}>{r.map((v, j) => <td key={j} className={cx(/\(₹\)/.test(table.columns[j]) ? 'num' : table.center?.includes(table.columns[j]) && 'center', /\S{16,}/.test(String(v)) ? 'break' : String(v).length <= 15 && 'short') || undefined}>{v}</td>)}</tr>)}
            {!rows.length && <tr><td colSpan={table.columns.length} className="dim">No rows.</td></tr>}
          </tbody>
        </table>
      </div>
      {table.rows.length > rows.length && <button className="link" onClick={() => setAll(true)}>Show all {table.rows.length} rows</button>}
    </div>
  );
}

export function MemberSelect({ s, value, onChange, include, placeholder = 'Choose member…' }: { s: State; value?: string; onChange: (id: string) => void; include?: string[]; placeholder?: string }) {
  const first = include?.filter(id => s.members.some(m => m.id === id)) ?? [];
  const rest = [...s.members].filter(m => !first.includes(m.id)).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <select value={value ?? ''} onChange={e => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {first.length > 0 && <optgroup label="Suggested">{first.map(id => <option key={id} value={id}>{s.members.find(m => m.id === id)!.name}</option>)}</optgroup>}
      <optgroup label="All members">{rest.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</optgroup>
    </select>
  );
}

export function useAsync() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = async (f: () => Promise<unknown> | unknown) => {
    setBusy(true); setError(undefined);
    try { await f(); return true; } catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); }
  };
  return { busy, error, setError, run };
}

export function ErrorLine({ error }: { error?: string }) {
  return error ? <div className="error" role="alert">{error}</div> : null;
}
