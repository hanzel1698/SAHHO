import { useMemo, useState } from 'react';
import type { ScreenProps } from '../App';
import { Receipt, categories, memberName, money, norm } from '../model';
import { sortRows } from '../reports';
import { Badge, MemberSelect, download } from './common';
import { toCSV } from '../reports';

export function Ledger({ s, go }: ScreenProps) {
  const [f, setF] = useState({ q: '', from: '', to: '', min: '', max: '', member: '', category: '', status: '', batch: '', dir: '' });
  const [limit, setLimit] = useState(200);
  const rows = useMemo(() => {
    const min = f.min ? Math.round(Number(f.min) * 100) : undefined, max = f.max ? Math.round(Number(f.max) * 100) : undefined;
    return sortRows(s.receipts, s).reverse().filter(r => {
      const amt = r.credit || r.debit;
      return (!f.q || norm(r.narration + ' ' + (r.remarks ?? '') + ' ' + (r.label ?? '')).includes(norm(f.q))) &&
        (!f.from || r.date >= f.from) && (!f.to || r.date <= f.to) && (min === undefined || amt >= min) && (max === undefined || amt <= max) &&
        (!f.member || r.memberId === f.member || s.allocations.some(a => a.receiptId === r.id && a.memberId === f.member)) &&
        (!f.category || r.category === f.category) && (!f.status || r.status === f.status) && (!f.batch || r.batch === f.batch) &&
        (!f.dir || (f.dir === 'in' ? r.credit > 0 : r.debit > 0));
    });
  }, [s, f]);
  const credit = rows.filter(r => r.status === 'confirmed').reduce((v, r) => v + r.credit, 0);
  const debit = rows.filter(r => r.status === 'confirmed').reduce((v, r) => v + r.debit, 0);
  const exportRows = () => download('sahho-transactions.csv', toCSV({ title: 'Transactions', columns: ['Date', 'Value date', 'Narration', 'Debit', 'Credit', 'Balance', 'Category', 'Member', 'Status', 'Months', 'Reference', 'Source'], rows: rows.map(r => [r.date, r.valueDate, r.narration, (r.debit / 100).toFixed(2), (r.credit / 100).toFixed(2), r.balance === undefined ? '' : (r.balance / 100).toFixed(2), r.category, memberName(s, r.memberId), r.status, allocText(s, r), r.reference, `${r.source.file} ${r.source.sheet ?? ''} row ${r.source.row}`]) }), 'text/csv');
  return (
    <section>
      <h1>Transactions</h1>
      <div className="filters">
        <input placeholder="Search narration" value={f.q} onChange={e => setF({ ...f, q: e.target.value })} />
        <label>From<input type="date" value={f.from} onChange={e => setF({ ...f, from: e.target.value })} /></label>
        <label>To<input type="date" value={f.to} onChange={e => setF({ ...f, to: e.target.value })} /></label>
        <input placeholder="Min ₹" value={f.min} onChange={e => setF({ ...f, min: e.target.value })} className="short" />
        <input placeholder="Max ₹" value={f.max} onChange={e => setF({ ...f, max: e.target.value })} className="short" />
        <select value={f.dir} onChange={e => setF({ ...f, dir: e.target.value })}><option value="">In & out</option><option value="in">Credits</option><option value="out">Debits</option></select>
        <MemberSelect s={s} value={f.member} onChange={v => setF({ ...f, member: v })} placeholder="Any member" />
        <select value={f.category} onChange={e => setF({ ...f, category: e.target.value })}><option value="">Any category</option>{categories.map(c => <option key={c}>{c}</option>)}</select>
        <select value={f.status} onChange={e => setF({ ...f, status: e.target.value })}><option value="">Any match status</option><option value="confirmed">Confirmed</option><option value="review">Needs review</option><option value="duplicate">Duplicate (excluded)</option></select>
        <select value={f.batch} onChange={e => setF({ ...f, batch: e.target.value })}><option value="">Any import</option>{s.batches.filter(b => !b.undone).map(b => <option key={b.id} value={b.id}>{b.file} ({b.at.slice(0, 10)})</option>)}</select>
        <button onClick={exportRows}>Export CSV</button>
      </div>
      <p className="dim">{rows.length} transactions · confirmed credits {money(credit)} · confirmed debits {money(debit)}</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Narration</th><th>Debit</th><th>Credit</th><th>Balance</th><th>Category</th><th>Member / months</th><th>Status</th></tr></thead>
          <tbody>
            {rows.slice(0, limit).map(r => (
              <tr key={r.id}>
                <td>{r.date}{r.valueDate !== r.date && <div className="dim small">val {r.valueDate}</div>}</td>
                <td className="narr">{r.narration}{(r.remarks || r.type) && <div className="dim small">{[r.type, r.remarks].filter(Boolean).join(' · ')}</div>}</td>
                <td className="num">{r.debit ? money(r.debit) : ''}</td>
                <td className="num">{r.credit ? money(r.credit) : ''}</td>
                <td className="num dim">{money(r.balance)}</td>
                <td>{r.category}{r.reversalOf && <div className="small">reverses {s.receipts.find(x => x.id === r.reversalOf)?.date}</div>}{s.receipts.some(x => x.reversalOf === r.id) && <div><Badge tone="bad">reversed</Badge></div>}</td>
                <td>{memberName(s, r.memberId)}{r.sender && r.memberId && norm(r.sender) !== memberName(s, r.memberId) && <div className="dim small">paid by {r.sender}</div>}<div className="dim small">{allocText(s, r)}</div></td>
                <td>{r.status === 'confirmed' ? <Badge tone="good">confirmed</Badge> : r.status === 'review' ? <button className="badge warn" onClick={() => go('review')}>review</button> : <Badge tone="muted">duplicate</Badge>}<div className="dim small" title={r.reason}>{r.reason.slice(0, 70)}</div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > limit && <button className="link" onClick={() => setLimit(limit + 500)}>Show more</button>}
    </section>
  );
}

function allocText(s: ScreenProps['s'], r: Receipt) {
  const list = s.allocations.filter(a => a.receiptId === r.id);
  if (!list.length) return '';
  const ms = list.map(a => a.month).sort();
  const names = [...new Set(list.map(a => a.memberId))];
  return `${ms.length === 1 ? ms[0] : `${ms[0]}…${ms.at(-1)} (${ms.length})`}${names.length > 1 ? ` · ${names.length} members` : ''}${list.some(a => a.kind === 'joining') ? ' · joining' : ''}`;
}
