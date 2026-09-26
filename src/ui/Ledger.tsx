import { useMemo, useState } from 'react';
import type { ScreenProps } from '../App';
import { Category, Receipt, awaitingBank, categories, contributionCategories, memberName, money, monthLabel, norm, today } from '../model';
import { MANUAL_BATCH, addManualReceipt, deleteManualReceipt, planAllocation, reopenReceipt } from '../engine';
import { MANUAL_MATCH_DAYS } from '../importer';
import { sortRows } from '../reports';
import { Badge, ErrorLine, MemberSelect, download, useAsync } from './common';
import { toCSV } from '../reports';
import { parseMonths } from './Review';

export function Ledger({ s, go, store }: ScreenProps) {
  const [reopen, setReopen] = useState<string>();
  const [adding, setAdding] = useState(false);
  const { busy, error, run } = useAsync();
  const [f, setF] = useState({ q: '', from: '', to: '', min: '', max: '', member: '', category: '', status: '', batch: '', dir: '' });
  const [limit, setLimit] = useState(200);
  const rows = useMemo(() => {
    const min = f.min ? Math.round(Number(f.min) * 100) : undefined, max = f.max ? Math.round(Number(f.max) * 100) : undefined;
    return sortRows(s.receipts, s).reverse().filter(r => {
      const amt = r.credit || r.debit;
      return (!f.q || norm(r.narration + ' ' + (r.remarks ?? '') + ' ' + (r.label ?? '')).includes(norm(f.q))) &&
        (!f.from || r.date >= f.from) && (!f.to || r.date <= f.to) && (min === undefined || amt >= min) && (max === undefined || amt <= max) &&
        (!f.member || r.memberId === f.member || s.allocations.some(a => a.receiptId === r.id && a.memberId === f.member)) &&
        (!f.category || r.category === f.category) && (!f.status || (f.status === 'manual' ? awaitingBank(r) : r.status === f.status)) && (!f.batch || r.batch === f.batch) &&
        (!f.dir || (f.dir === 'in' ? r.credit > 0 : r.debit > 0));
    });
  }, [s, f]);
  const credit = rows.filter(r => r.status === 'confirmed').reduce((v, r) => v + r.credit, 0);
  const debit = rows.filter(r => r.status === 'confirmed').reduce((v, r) => v + r.debit, 0);
  const pending = s.receipts.filter(awaitingBank).length;
  const exportRows = () => download('sahho-transactions.csv', toCSV({ title: 'Transactions', columns: ['Date', 'Value date', 'Narration', 'Debit', 'Credit', 'Balance', 'Category', 'Member', 'Status', 'Months', 'Reference', 'Source'], rows: rows.map(r => [r.date, r.valueDate, r.narration, (r.debit / 100).toFixed(2), (r.credit / 100).toFixed(2), r.balance === undefined ? '' : (r.balance / 100).toFixed(2), r.category, memberName(s, r.memberId), r.status + (awaitingBank(r) ? ' (manual, awaiting bank)' : r.manual ? ' (manual, matched)' : ''), allocText(s, r), r.reference, `${r.source.file} ${r.source.sheet ?? ''} row ${r.source.row}`]) }), 'text/csv');
  return (
    <section>
      <h1>Transactions</h1>
      <div className="actions">
        <button className={adding ? '' : 'primary'} onClick={() => setAdding(!adding)}>{adding ? 'Close manual entry' : '+ Add manual entry'}</button>
        {pending > 0 && <button className="link" onClick={() => setF({ ...f, status: 'manual' })}>{pending} manual entr{pending === 1 ? 'y' : 'ies'} awaiting the bank statement</button>}
      </div>
      {!reopen && <ErrorLine error={error} />}
      {adding && <ManualForm s={s} store={store} onDone={() => setAdding(false)} />}
      <div className="filters">
        <input placeholder="Search narration" value={f.q} onChange={e => setF({ ...f, q: e.target.value })} />
        <label>From<input type="date" value={f.from} onChange={e => setF({ ...f, from: e.target.value })} /></label>
        <label>To<input type="date" value={f.to} onChange={e => setF({ ...f, to: e.target.value })} /></label>
        <input placeholder="Min ₹" value={f.min} onChange={e => setF({ ...f, min: e.target.value })} className="short" />
        <input placeholder="Max ₹" value={f.max} onChange={e => setF({ ...f, max: e.target.value })} className="short" />
        <select value={f.dir} onChange={e => setF({ ...f, dir: e.target.value })}><option value="">In & out</option><option value="in">Credits</option><option value="out">Debits</option></select>
        <MemberSelect s={s} value={f.member} onChange={v => setF({ ...f, member: v })} placeholder="Any member" />
        <select value={f.category} onChange={e => setF({ ...f, category: e.target.value })}><option value="">Any category</option>{categories.map(c => <option key={c}>{c}</option>)}</select>
        <select value={f.status} onChange={e => setF({ ...f, status: e.target.value })}><option value="">Any match status</option><option value="confirmed">Confirmed</option><option value="review">Needs review</option><option value="duplicate">Duplicate (excluded)</option><option value="manual">Manual, awaiting bank</option></select>
        <select value={f.batch} onChange={e => setF({ ...f, batch: e.target.value })}><option value="">Any import</option><option value={MANUAL_BATCH}>Manual entries (not yet matched)</option>{s.batches.filter(b => !b.undone).map(b => <option key={b.id} value={b.id}>{b.file} ({b.at.slice(0, 10)})</option>)}</select>
        <button onClick={exportRows}>Export CSV</button>
      </div>
      <p className="dim">{rows.length} transactions · confirmed credits {money(credit)} · confirmed debits {money(debit)}</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Narration</th><th>Debit</th><th>Credit</th><th>Balance</th><th>Category</th><th>Member / months</th><th>Status</th></tr></thead>
          <tbody>
            {rows.slice(0, limit).flatMap(r => [
              <tr key={r.id}>
                <td>{r.date}{r.valueDate !== r.date && <div className="dim small">val {r.valueDate}</div>}</td>
                <td className="narr">{r.narration}{r.manual?.matched && r.manual.narration !== r.narration && <div className="dim small">entered as: {r.manual.narration}{r.manual.date !== r.date ? ` (${r.manual.date})` : ''}</div>}{(r.remarks || r.type) && <div className="dim small">{[r.type, r.remarks].filter(Boolean).join(' · ')}</div>}</td>
                <td className="num">{r.debit ? money(r.debit) : ''}</td>
                <td className="num">{r.credit ? money(r.credit) : ''}</td>
                <td className="num dim">{money(r.balance)}</td>
                <td>{r.category}{r.reversalOf && <div className="small">reverses {s.receipts.find(x => x.id === r.reversalOf)?.date}</div>}{s.receipts.some(x => x.reversalOf === r.id) && <div><Badge tone="bad">reversed</Badge></div>}</td>
                <td>{memberName(s, r.memberId)}{r.sender && r.memberId && norm(r.sender) !== memberName(s, r.memberId) && <div className="dim small">paid by {r.sender}</div>}<div className="dim small">{allocText(s, r)}</div></td>
                <td>{r.status === 'confirmed' ? <Badge tone="good">confirmed</Badge> : r.status === 'review' ? <button className="badge warn" onClick={() => go('review')}>review</button> : <Badge tone="muted">duplicate</Badge>}{awaitingBank(r) ? <div><Badge tone="info">manual · awaiting bank</Badge></div> : r.manual && <div><Badge tone="muted">manual · reconciled</Badge></div>}<div className="dim small" title={r.reason}>{r.reason.slice(0, 70)}</div>
                  {r.status === 'confirmed' && <button className="link small" onClick={() => setReopen(reopen === r.id ? undefined : r.id)}>Edit…</button>}
                  {awaitingBank(r) && <button className="link small" disabled={busy} onClick={() => { if (confirm('Delete this manual entry and its month allocations?')) void run(() => store.commit(d => deleteManualReceipt(d, r.id))); }}>Delete</button>}</td>
              </tr>,
              reopen === r.id && <tr key={r.id + '-reopen'}><td colSpan={8}><ReopenPanel r={r} s={s} busy={busy} error={error} onCancel={() => setReopen(undefined)}
                onReopen={() => void run(async () => { await store.commit(d => { reopenReceipt(d, r.id); }); setReopen(undefined); go('review'); })} /></td></tr>,
            ])}
          </tbody>
        </table>
      </div>
      {rows.length > limit && <button className="link" onClick={() => setLimit(limit + 500)}>Show more</button>}
    </section>
  );
}

/** Type in a transaction the bank statement does not show yet; the next import that contains it reconciles it. */
function ManualForm({ s, store, onDone }: { s: ScreenProps['s']; store: ScreenProps['store']; onDone: () => void }) {
  const { busy, error, run } = useAsync();
  const [v, setV] = useState({ date: today(), dir: 'in', amount: '', narration: '', reference: '', months: '' });
  const [category, setCategory] = useState<Category>('Member contribution');
  const [memberId, setMemberId] = useState<string>();
  const paise = Math.round(Number(v.amount.replace(/,/g, '')) * 100);
  const valid = Number.isSafeInteger(paise) && paise > 0;
  const credit = v.dir === 'in';
  const contribution = credit && contributionCategories.includes(category);
  const monthsList = parseMonths(v.months);
  const plan = useMemo(() => {
    if (!contribution || !memberId || !valid) return undefined;
    const draft = { id: 'preview', date: v.date, valueDate: v.date, narration: v.narration, sender: '', credit: paise, debit: 0, reference: '', batch: MANUAL_BATCH, order: 0, source: { file: 'Manual entry', row: 0, raw: {} }, category, status: 'review', reason: '', candidates: [] } as Receipt;
    return planAllocation(s, draft, memberId, { months: monthsList, ignorePeriod: !monthsList, treatAsJoining: category === 'Joining contribution' });
  }, [s, contribution, memberId, valid, paise, v.date, v.narration, category, monthsList?.join()]);
  const save = () => run(async () => {
    if (!valid) throw Error('Enter an amount greater than zero.');
    if (v.months.trim() && !monthsList) throw Error('Months must look like 2026-01..2026-06 or 2026-03, 2026-04.');
    await store.commit(d => { addManualReceipt(d, { date: v.date, narration: v.narration, reference: v.reference, credit: credit ? paise : 0, debit: credit ? 0 : paise, decision: { category, memberId: credit ? memberId : undefined, months: contribution ? monthsList : undefined } }); });
    onDone();
  });
  return (
    <div className="panel">
      <h3>Manual entry</h3>
      <p className="note">Use this for a transaction you need recorded before the bank statement shows it. It counts straight away and is marked <b>awaiting bank</b>. When a later statement import has a row with the same amount and direction dated within {MANUAL_MATCH_DAYS} days (and your reference, if you enter one), the bank’s narration is copied onto this entry and it is reconciled instead of being imported twice.</p>
      <div className="row">
        <label>Date<input type="date" value={v.date} onChange={e => setV({ ...v, date: e.target.value })} /></label>
        <label>Direction<select value={v.dir} onChange={e => { const dir = e.target.value; setV({ ...v, dir }); setCategory(dir === 'in' ? 'Member contribution' : 'Other expense'); }}><option value="in">Credit (money in)</option><option value="out">Debit (money out)</option></select></label>
        <label>Amount ₹<input className="short" inputMode="decimal" value={v.amount} onChange={e => setV({ ...v, amount: e.target.value })} /></label>
        <label>Description<input value={v.narration} placeholder="e.g. Cash deposit by Asha" onChange={e => setV({ ...v, narration: e.target.value })} /></label>
        <label>Bank reference (optional)<input value={v.reference} placeholder="UTR / cheque no." onChange={e => setV({ ...v, reference: e.target.value })} /></label>
      </div>
      <div className="row">
        <label>Category<select value={category} onChange={e => setCategory(e.target.value as Category)}>{categories.filter(c => credit || !contributionCategories.includes(c)).map(c => <option key={c}>{c}</option>)}</select></label>
        {credit && <label>Member<MemberSelect s={s} value={memberId} onChange={setMemberId} /></label>}
        {contribution && <label>Months covered (optional)<input placeholder="e.g. 2026-01..2026-06" value={v.months} onChange={e => setV({ ...v, months: e.target.value })} /></label>}
      </div>
      {contribution && <p className="small">{!memberId || !valid ? <span className="dim">Choose a member and amount to see the proposed months.</span>
        : plan?.problem ? <span className="bad-text">{plan.problem}</span>
        : plan && <>Proposed: {plan.lines.map(l => <Badge key={l.month} tone="info">{monthLabel(l.month)}{l.kind === 'joining' ? ' joining' : ''} {money(l.amount)}</Badge>)}{plan.unapplied > 0 && <Badge tone="muted">unapplied {money(plan.unapplied)}</Badge>}</>}</p>}
      <div className="actions">
        <button className="primary" disabled={busy || !valid || !v.narration.trim() || (contribution && !memberId)} onClick={() => void save()}>Save manual entry</button>
        <button disabled={busy} onClick={onDone}>Cancel</button>
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

function ReopenPanel({ r, s, busy, error, onReopen, onCancel }: { r: Receipt; s: ScreenProps['s']; busy: boolean; error?: string; onReopen: () => void; onCancel: () => void }) {
  const list = s.allocations.filter(a => a.receiptId === r.id).sort((a, b) => a.month.localeCompare(b.month));
  const workbook = list.filter(a => a.source?.sheet);
  const blocked = !!r.reversalOf || s.receipts.some(x => x.reversalOf === r.id);
  return (
    <div className="confirm reopen">
      <b>Edit this transaction</b>
      {blocked ? <p>This transaction is part of a linked reversal, so it can’t be reopened.</p> : <>
        <p>Reopening sends it back to <b>Needs your review</b>, where you choose the category, member and months again. The bank details (date, amount, narration) don’t change.</p>
        {list.length > 0 && <p>Currently: {r.category}{r.memberId ? ` · ${memberName(s, r.memberId)}` : ''} · {list.map(a => `${monthLabel(a.month)}${a.kind === 'joining' ? ' (joining)' : ''} ${money(a.amount)}`).join(', ')}. These month allocations will be removed{workbook.length ? `; the ${workbook.length} that came from the workbook are kept as unlinked workbook records, and you can link them back or remove them from the review card` : ''}.</p>}
      </>}
      <div className="actions">
        {!blocked && <button className="primary" disabled={busy} onClick={onReopen}>Reopen for review</button>}
        <button disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

function allocText(s: ScreenProps['s'], r: Receipt) {
  const list = s.allocations.filter(a => a.receiptId === r.id);
  if (!list.length) return '';
  const ms = list.map(a => a.month).sort();
  const names = [...new Set(list.map(a => a.memberId))];
  return `${ms.length === 1 ? ms[0] : `${ms[0]}…${ms.at(-1)} (${ms.length})`}${names.length > 1 ? ` · ${names.length} members` : ''}${list.some(a => a.kind === 'joining') ? ' · joining' : ''}`;
}
