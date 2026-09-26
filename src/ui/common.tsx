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

export async function exportXLSX(name: string, tables: Table[]) {
  const XLSX = await import('xlsx');
  const book = XLSX.utils.book_new();
  tables.forEach((t, i) => {
    const sheet = XLSX.utils.aoa_to_sheet([[t.title], ...(t.note ? [[t.note]] : []), [], t.columns, ...t.rows]);
    XLSX.utils.book_append_sheet(book, sheet, (t.title.replace(/[^\w ]/g, '').slice(0, 28) || 'Report') + (tables.length > 1 ? i : ''));
  });
  XLSX.writeFile(book, name);
}

export function ReportTable({ table, limit = 500, compact = false, nowrap = false }: { table: Table; limit?: number; compact?: boolean; nowrap?: boolean }) {
  const [all, setAll] = useState(false);
  const rows = all ? table.rows : table.rows.slice(0, limit);
  return (
    <div className={compact ? 'report compact' : 'report'}>
      <div className="report-head">
        <h3>{table.title}</h3>
        <div className="actions no-print">
          <button onClick={() => download(`${table.title.replace(/\W+/g, '-')}.csv`, toCSV(table), 'text/csv')}>CSV</button>
          <button onClick={() => void exportXLSX(`${table.title.replace(/\W+/g, '-')}.xlsx`, [table])}>Excel</button>
          <button onClick={() => window.print()}>Print</button>
        </div>
      </div>
      {table.note && <p className="note">{table.note}</p>}
      <div className="table-wrap">
        <table className={[compact && 'compact', nowrap && 'nowrap'].filter(Boolean).join(' ') || undefined}>
          <thead><tr>{table.columns.map(c => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={/\(₹\)/.test(table.columns[j]) ? 'num' : undefined}>{v}</td>)}</tr>)}
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
