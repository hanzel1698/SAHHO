import { useMemo, useState } from 'react';
import type { ScreenProps } from '../App';
import { Member, money, monthLabel, monthNames } from '../model';
import { Ledger } from '../reports';
import { editWorkbookAmount, lastRosterYear, months, onRoster } from '../engine';
import { ErrorLine, cx, useAsync } from './common';
import { LEGEND, STATUS, drawGridImage, toBlob } from './gridImage';

export function Grid({ s, cutoff, store }: ScreenProps) {
  const years = useMemo(() => {
    const ys = new Set<number>();
    for (const a of s.allocations) ys.add(Number(a.month.slice(0, 4)));
    for (const m of s.members) {
      if (m.start) ys.add(Number(m.start.slice(0, 4)));
      for (const y of m.rosterYears ?? []) ys.add(y);
    }
    ys.add(Number(cutoff.slice(0, 4)));
    return [...ys].sort();
  }, [s, cutoff]);
  const [year, setYear] = useState(Number(cutoff.slice(0, 4)));
  const [pick, setPick] = useState<{ memberId: string; month: string }>();
  const [showAll, setShowAll] = useState(false);
  const [onlyDue, setOnlyDue] = useState(false);
  const { busy, error, run } = useAsync();
  const [edit, setEdit] = useState<{ id: string; amount: string; reason: string }>();
  const saving = useAsync();
  const ledger = useMemo(() => new Ledger(s, cutoff), [s, cutoff]);
  const cols = months(`${year}-01`, `${year}-12`);
  const last = useMemo(() => lastRosterYear(s), [s]);
  // Members with money recorded in the year are always listed, so nothing allocated is hidden.
  const paidInYear = useMemo(() => new Set(s.allocations.filter(a => a.month.startsWith(`${year}-`)).map(a => a.memberId)), [s, year]);
  const listed = (m: (typeof s.members)[number]) => onRoster(s, m, year, last) || paidInYear.has(m.id);
  // Still owed for this year's months that have fallen due (by the reporting cutoff).
  const dueInYear = (m: Member) => cols.filter(c => c <= ledger.until).reduce((v, c) => {
    const x = ledger.cell(m, c);
    return v + (x.status === 'unpaid' || x.status === 'partly paid' ? Math.max(0, x.due - x.paid) : 0);
  }, 0);
  const members = s.members.filter(m => (showAll || listed(m)) && (!onlyDue || dueInYear(m) > 0)).sort((a, b) => a.name.localeCompare(b.name));
  const hidden = s.members.length - s.members.filter(listed).length;
  const dues = new Map(members.map(m => [m.id, dueInYear(m)]));
  const canShare = typeof navigator !== 'undefined' && !!navigator.canShare?.({ files: [new File([''], 'x.png', { type: 'image/png' })] });
  const image = () => drawGridImage(`SAHHO contributions ${year}`, `As of ${cutoff} · ${members.length} members${onlyDue ? ' with dues' : ''} · Due = unpaid up to ${monthLabel(ledger.until)}`,
    members.map(m => ({
      name: m.name,
      cells: cols.map(c => { const x = ledger.cell(m, c); return { status: x.status, amount: x.allocations.reduce((v, a) => v + a.amount, 0) }; }),
      due: dues.get(m.id) ?? 0,
    })));
  const selected = pick && s.members.find(m => m.id === pick.memberId);
  const cell = selected && ledger.cell(selected, pick!.month);

  return (
    <section>
      <h1>Monthly contribution grid</h1>
      <div className="toolbar">
        <label>Year <select value={year} onChange={e => setYear(Number(e.target.value))}>{years.map(y => <option key={y}>{y}</option>)}</select></label>
        <label className="inline"><input type="checkbox" checked={onlyDue} onChange={e => setOnlyDue(e.target.checked)} /> Only members with dues</label>
        <label className="inline"><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /> Show members not on the {year} register{hidden ? ` (${hidden})` : ''}</label>
        <span className="toolbar-end">
          <button disabled={busy || !members.length} onClick={() => void run(async () => {
            const blob = await toBlob(image());
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `SAHHO-grid-${year}-as-of-${cutoff}.png`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 10000);
          })}>Download image</button>
          {canShare && <button disabled={busy || !members.length} onClick={() => void run(async () => {
            const file = new File([await toBlob(image())], `SAHHO-grid-${year}.png`, { type: 'image/png' });
            try { await navigator.share({ files: [file], title: `SAHHO contributions ${year}` }); } catch (e) { if ((e as Error).name !== 'AbortError') throw e; }
          })}>Share image</button>}
        </span>
      </div>
      <ErrorLine error={error} />
      <div className="legend">{LEGEND.map(st => <span key={st}><i style={{ background: STATUS[st].bg }} />{STATUS[st].label}</span>)}</div>
      <p className="note">{last !== undefined && year <= last ? <>Members as listed in the workbook’s <b>{year}</b> sheet. </> : last !== undefined ? <>Members on the {last} register who are still active. </> : null}Reporting cutoff <b>{cutoff}</b>. A month falls due on day {s.settings.dueDay}; months after <b>{ledger.until}</b> are shown as future and are not overdue. Payments received after the cutoff are not counted.</p>
      <div className="grid-wrap">
        <table className="grid">
          <thead><tr><th className="sticky">Member</th>{cols.map(c => <th key={c}>{monthNames[Number(c.slice(5)) - 1]}</th>)}<th>Paid {year}</th><th>Due {year}</th></tr></thead>
          <tbody>
            {members.map(m => {
              let total = 0;
              return (
                <tr key={m.id}>
                  <th className="sticky">{m.name}{!m.start && <span className="dim small"> (start?)</span>}{showAll && !listed(m) && <span className="dim small"> (not on {year} register)</span>}</th>
                  {cols.map(c => {
                    const x = ledger.cell(m, c);
                    const amount = x.allocations.reduce((v, a) => v + a.amount, 0);
                    total += amount;
                    const legacy = x.allocations.some(a => !a.receiptId);
                    return (
                      <td key={c} className={cx('gc', pick?.memberId === m.id && pick.month === c && 'picked')} style={{ background: STATUS[x.status].bg, color: STATUS[x.status].fg }}
                        onClick={() => setPick({ memberId: m.id, month: c })} title={`${STATUS[x.status].label}${amount ? ` · ${money(amount)}` : ''} — click for details`}>
                        {amount ? (amount / 100).toLocaleString('en-IN') : ''}{legacy ? '*' : ''}
                      </td>
                    );
                  })}
                  <td className="num">{money(total)}</td>
                  <td className={cx('num', dues.get(m.id) ? 'bad-text' : 'dim')}>{dues.get(m.id) ? money(dues.get(m.id)) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="dim small">Cells show the amount paid for that month in ₹. * includes a workbook allocation without a linked bank receipt. “Due” is what is still owed for {year}’s months up to {ledger.until}.</p>
      {selected && cell && (
        <div className="panel">
          <div className="report-head"><h3>{selected.name} — {pick!.month}</h3><button onClick={() => setPick(undefined)}>Close</button></div>
          <p>Status: <b>{STATUS[cell.status].label}</b> · Due {money(cell.due)} · Paid {money(cell.paid)}</p>
          {cell.allocations.length ? (
            <table className="compact"><thead><tr><th>Amount</th><th>Type</th><th>Received</th><th>Receipt / source</th><th>Note</th><th></th></tr></thead>
              <tbody>{cell.allocations.map(a => { const r = a.receiptId ? ledger.receipts.get(a.receiptId) : undefined; return (
                <tr key={a.id}><td className="num">{money(a.amount)}</td><td>{a.kind}</td><td>{r?.date ?? a.received ?? 'unknown'}</td>
                  <td className="narr">{r ? `${money(r.credit)} — ${r.narration}` : `Workbook ${a.source?.sheet ?? ''} ${a.source?.cells ?? ''} (no bank receipt linked)`}</td><td>{a.note}</td>
                  <td>{a.source?.sheet && !a.reversedBy && <button className="link" onClick={() => setEdit({ id: a.id, amount: String(a.amount / 100), reason: '' })}>Edit amount</button>}</td></tr>); })}</tbody></table>
          ) : <p className="dim">No payments allocated to this month{cell.due ? '' : ' and nothing is due'}.</p>}
          {edit && cell.allocations.some(a => a.id === edit.id) && (
            <div className="confirm">
              <b>Correct the amount recorded in the workbook</b>
              <p className="small">Use this for entry errors in the Excel file. The original cell stays in the archived workbook, and the change is recorded in the audit log.</p>
              <div className="row">
                <label>Amount (₹)<input className="short" inputMode="decimal" value={edit.amount} onChange={e => setEdit({ ...edit, amount: e.target.value })} /></label>
                <label>Reason<input value={edit.reason} placeholder="e.g. typing error in workbook" onChange={e => setEdit({ ...edit, reason: e.target.value })} /></label>
              </div>
              <div className="actions">
                <button className="primary" disabled={saving.busy} onClick={() => void saving.run(async () => {
                  const paise = Math.round(Number(edit.amount) * 100);
                  if (!edit.amount.trim() || !Number.isFinite(paise)) throw Error('Enter the amount in rupees.');
                  await store.commit(d => editWorkbookAmount(d, edit.id, paise, edit.reason.trim()));
                  setEdit(undefined);
                })}>Save amount</button>
                <button disabled={saving.busy} onClick={() => setEdit(undefined)}>Cancel</button>
              </div>
              <ErrorLine error={saving.error} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
