import { useMemo, useState } from 'react';
import type { ScreenProps } from '../App';
import { money, monthNames } from '../model';
import { Cell, Ledger } from '../reports';
import { lastRosterYear, months, onRoster } from '../engine';
import { cx } from './common';

const LABEL: Record<Cell['status'], string> = {
  paid: 'Paid', 'partly paid': 'Part', unpaid: 'Unpaid', waived: 'Waived', future: 'Future', advance: 'Advance', joining: 'Joining', 'n/a': 'n/a', legacy: 'Recorded',
};

export function Grid({ s, cutoff }: ScreenProps) {
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
  const ledger = useMemo(() => new Ledger(s, cutoff), [s, cutoff]);
  const cols = months(`${year}-01`, `${year}-12`);
  const last = useMemo(() => lastRosterYear(s), [s]);
  // Members with money recorded in the year are always listed, so nothing allocated is hidden.
  const paidInYear = useMemo(() => new Set(s.allocations.filter(a => a.month.startsWith(`${year}-`)).map(a => a.memberId)), [s, year]);
  const listed = (m: (typeof s.members)[number]) => onRoster(s, m, year, last) || paidInYear.has(m.id);
  const members = s.members.filter(m => showAll || listed(m)).sort((a, b) => a.name.localeCompare(b.name));
  const hidden = s.members.length - s.members.filter(listed).length;
  const selected = pick && s.members.find(m => m.id === pick.memberId);
  const cell = selected && ledger.cell(selected, pick!.month);

  return (
    <section>
      <h1>Monthly contribution grid</h1>
      <div className="toolbar">
        <label>Year <select value={year} onChange={e => setYear(Number(e.target.value))}>{years.map(y => <option key={y}>{y}</option>)}</select></label>
        <label className="inline"><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /> Show members not on the {year} register{hidden ? ` (${hidden})` : ''}</label>
      </div>
      <p className="note">{last !== undefined && year <= last ? <>Members as listed in the workbook’s <b>{year}</b> sheet. </> : last !== undefined ? <>Members on the {last} register who are still active. </> : null}Reporting cutoff <b>{cutoff}</b>. A month falls due on day {s.settings.dueDay}; months after <b>{ledger.until}</b> are shown as future and are not overdue. Payments received after the cutoff are not counted.</p>
      <div className="grid-wrap">
        <table className="grid">
          <thead><tr><th className="sticky">Member</th>{cols.map(c => <th key={c}>{monthNames[Number(c.slice(5)) - 1]}</th>)}<th>Year total</th></tr></thead>
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
                      <td key={c} className={cx('gc', x.status.replace(/\W/g, '-'), pick?.memberId === m.id && pick.month === c && 'picked')} onClick={() => setPick({ memberId: m.id, month: c })} title="Click for details">
                        <div className="gc-amt">{amount ? money(amount) : x.due ? '—' : ''}</div>
                        <div className="gc-st">{LABEL[x.status]}{legacy ? '*' : ''}</div>
                      </td>
                    );
                  })}
                  <td className="num">{money(total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="dim small">* includes a workbook allocation without a linked bank receipt. Statuses: Paid · Part (partly paid) · Unpaid · Waived · Future · Advance (paid ahead) · Joining (initial ₹350) · n/a (before start or inactive).</p>
      {selected && cell && (
        <div className="panel">
          <div className="report-head"><h3>{selected.name} — {pick!.month}</h3><button onClick={() => setPick(undefined)}>Close</button></div>
          <p>Status: <b>{cell.status}</b> · Due {money(cell.due)} · Paid {money(cell.paid)}</p>
          {cell.allocations.length ? (
            <table className="compact"><thead><tr><th>Amount</th><th>Type</th><th>Received</th><th>Receipt / source</th><th>Note</th></tr></thead>
              <tbody>{cell.allocations.map(a => { const r = a.receiptId ? ledger.receipts.get(a.receiptId) : undefined; return (
                <tr key={a.id}><td className="num">{money(a.amount)}</td><td>{a.kind}</td><td>{r?.date ?? a.received ?? 'unknown'}</td>
                  <td className="narr">{r ? `${money(r.credit)} — ${r.narration}` : `Workbook ${a.source?.sheet ?? ''} ${a.source?.cells ?? ''} (no bank receipt linked)`}</td><td>{a.note}</td></tr>); })}</tbody></table>
          ) : <p className="dim">No payments allocated to this month{cell.due ? '' : ' and nothing is due'}.</p>}
        </div>
      )}
    </section>
  );
}
