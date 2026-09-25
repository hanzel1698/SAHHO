import { useMemo, useState } from 'react';
import type { ScreenProps } from '../App';
import { Member, money, monthLabel, norm } from '../model';
import { createMember, linkLegacy, updateMember } from '../engine';
import { Ledger, memberStatement } from '../reports';
import { Badge, ErrorLine, ReportTable, useAsync } from './common';

type Filter = 'all' | 'active' | 'inactive' | 'owing' | 'nostart' | 'advance';

export function Members({ s, store, cutoff, focus }: ScreenProps) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<string | undefined>(focus);
  const [adding, setAdding] = useState(false);
  const ledger = useMemo(() => new Ledger(s, cutoff), [s, cutoff]);
  const rows = useMemo(() => s.members.map(m => ledger.summary(m)), [s, ledger]);
  const shown = rows.filter(x => {
    const m = x.member;
    if (q && ![m.name, ...m.aliases, m.notes].some(t => norm(t).includes(norm(q)))) return false;
    const inactive = !!m.inactiveFrom && m.inactiveFrom <= cutoff.slice(0, 7);
    if (filter === 'active') return !inactive;
    if (filter === 'inactive') return inactive;
    if (filter === 'owing') return x.outstanding > 0;
    if (filter === 'nostart') return !m.start;
    if (filter === 'advance') return x.advance > 0 || x.unapplied > 0;
    return true;
  }).sort((a, b) => a.member.name.localeCompare(b.member.name));
  const current = selected ? s.members.find(m => m.id === selected) : undefined;

  return (
    <section>
      <h1>Member register</h1>
      <div className="toolbar">
        <input placeholder="Search name, alias or note" value={q} onChange={e => setQ(e.target.value)} />
        <select value={filter} onChange={e => setFilter(e.target.value as Filter)}>
          <option value="all">All members ({rows.length})</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="owing">With outstanding</option>
          <option value="advance">With advance or unapplied credit</option>
          <option value="nostart">Start month not confirmed</option>
        </select>
        <button onClick={() => setAdding(true)}>+ Add member</button>
      </div>
      {adding && <AddMember store={store} onDone={() => setAdding(false)} />}
      <div className="table-wrap">
        <table>
          <thead><tr><th className="sticky">Member</th><th>Joining paid</th><th>Joined (month)</th><th>Regular from</th><th>Status</th><th>Total contributed</th><th>Outstanding</th><th>Advance</th><th>Unapplied</th><th>Last payment</th><th>Unpaid / partly paid months</th></tr></thead>
          <tbody>
            {shown.map(x => {
              const m = x.member;
              const inactive = !!m.inactiveFrom && m.inactiveFrom <= cutoff.slice(0, 7);
              return (
                <tr key={m.id} className="clickable" onClick={() => setSelected(m.id)}>
                  <td className="sticky"><b>{m.name}</b>{m.aliases.length > 0 && <div className="dim small">{m.aliases.join(', ')}</div>}</td>
                  <td>{x.joiningPaid ? <Badge tone="good">₹350 paid {x.joiningDate ?? ''}</Badge> : <Badge tone="muted">not recorded</Badge>}</td>
                  <td>{m.joiningMonth ?? '—'}</td>
                  <td>{m.start ?? <Badge tone="warn">not confirmed{m.suggestedStart ? ` (suggested ${m.suggestedStart})` : ''}</Badge>}</td>
                  <td>{inactive ? <Badge tone="muted">inactive from {m.inactiveFrom}</Badge> : <Badge tone="good">active</Badge>}</td>
                  <td className="num">{money(x.total)}</td>
                  <td className="num">{x.outstanding ? <b>{money(x.outstanding)}</b> : money(0)}</td>
                  <td className="num">{money(x.advance)}</td>
                  <td className="num">{money(x.unapplied)}</td>
                  <td>{x.last ?? '—'}</td>
                  <td className="small">{x.unpaid.length > 0 && <>Unpaid: {compact(x.unpaid)}</>}{x.partial.length > 0 && <div>Partly: {compact(x.partial)}</div>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {current && <MemberDetail key={current.id + s.revision} m={current} s={s} store={store} cutoff={cutoff} onClose={() => setSelected(undefined)} />}
    </section>
  );
}

function compact(list: string[]) {
  if (list.length <= 4) return list.map(monthLabel).join(', ');
  return `${monthLabel(list[0])} … ${monthLabel(list.at(-1)!)} (${list.length})`;
}

function AddMember({ store, onDone }: { store: ScreenProps['store']; onDone: () => void }) {
  const [f, setF] = useState({ name: '', aliases: '', joiningMonth: '', start: '' });
  const { busy, error, run } = useAsync();
  return (
    <div className="panel">
      <h3>New member</h3>
      <div className="row">
        <label>Name<input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></label>
        <label>Aliases / sender names (comma separated)<input value={f.aliases} onChange={e => setF({ ...f, aliases: e.target.value })} /></label>
        <label>Joining month<input type="month" value={f.joiningMonth} onChange={e => setF({ ...f, joiningMonth: e.target.value })} /></label>
        <label>Regular contributions from<input type="month" value={f.start} onChange={e => setF({ ...f, start: e.target.value })} /></label>
      </div>
      <div className="actions">
        <button className="primary" disabled={busy} onClick={() => void run(async () => { await store.commit(d => { createMember(d, { name: f.name, aliases: f.aliases.split(','), joiningMonth: f.joiningMonth || undefined, start: f.start || undefined }); }); onDone(); })}>Create</button>
        <button onClick={onDone}>Cancel</button>
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

function MemberDetail({ m, s, store, cutoff, onClose }: { m: Member; s: ScreenProps['s']; store: ScreenProps['store']; cutoff: string; onClose: () => void }) {
  const [f, setF] = useState({ name: m.name, aliases: m.aliases.join(', '), notes: m.notes, start: m.start ?? '', joiningMonth: m.joiningMonth ?? '', inactiveFrom: m.inactiveFrom ?? '' });
  const [ex, setEx] = useState({ from: '', to: '', amount: '0', reason: '' });
  const [link, setLink] = useState<{ allocation: string; receipt: string }>({ allocation: '', receipt: '' });
  const { busy, error, run } = useAsync();
  const legacy = s.allocations.filter(a => a.memberId === m.id && a.legacy && !a.receiptId);
  const receiptOptions = s.receipts.filter(r => r.credit > 0 && r.status === 'confirmed' && (r.memberId === m.id || !r.memberId));
  return (
    <div className="panel detail">
      <div className="report-head"><h2>{m.name}</h2><button onClick={onClose}>Close</button></div>
      <div className="row">
        <label>Name<input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></label>
        <label>Aliases / sender names<input value={f.aliases} onChange={e => setF({ ...f, aliases: e.target.value })} /></label>
        <label>Joining month<input type="month" value={f.joiningMonth} onChange={e => setF({ ...f, joiningMonth: e.target.value })} /></label>
        <label>Regular ₹ from<input type="month" value={f.start} onChange={e => setF({ ...f, start: e.target.value })} /></label>
        <label>Inactive from<input type="month" value={f.inactiveFrom} onChange={e => setF({ ...f, inactiveFrom: e.target.value })} /></label>
      </div>
      <label>Notes<textarea value={f.notes} onChange={e => setF({ ...f, notes: e.target.value })} rows={2} /></label>
      <p className="dim small">Joining payment date: {m.joined ?? 'not recorded'} (kept separate from the contribution start month).</p>
      <button className="primary" disabled={busy} onClick={() => void run(() => store.commit(d => updateMember(d, m.id, { name: norm(f.name), aliases: f.aliases.split(',').map(norm).filter(Boolean), notes: f.notes, start: f.start || undefined, joiningMonth: f.joiningMonth || undefined, inactiveFrom: f.inactiveFrom || undefined })))}>Save member</button>

      <h3>Approved exceptions, pauses and waivers</h3>
      {m.exceptions.length ? <ul>{m.exceptions.map((e, i) => <li key={i}>{e.from} → {e.to}: {e.amount ? `${money(e.amount)} per month` : 'waived / paused'} — {e.reason} <button className="link" onClick={() => void run(() => store.commit(d => updateMember(d, m.id, { exceptions: m.exceptions.filter((_, j) => j !== i) })))}>remove</button></li>)}</ul> : <p className="dim">None.</p>}
      <div className="row">
        <label>From<input type="month" value={ex.from} onChange={e => setEx({ ...ex, from: e.target.value })} /></label>
        <label>To<input type="month" value={ex.to} onChange={e => setEx({ ...ex, to: e.target.value })} /></label>
        <label>Monthly amount ₹ (0 = waived)<input value={ex.amount} onChange={e => setEx({ ...ex, amount: e.target.value })} /></label>
        <label>Reason<input value={ex.reason} onChange={e => setEx({ ...ex, reason: e.target.value })} /></label>
        <button disabled={busy} onClick={() => void run(() => {
          const amount = Math.round(Number(ex.amount) * 100);
          if (!ex.from || !ex.to || ex.from > ex.to || !Number.isSafeInteger(amount) || amount < 0 || !ex.reason) throw Error('Enter a valid period, amount and reason.');
          return store.commit(d => updateMember(d, m.id, { exceptions: [...m.exceptions, { from: ex.from, to: ex.to, amount, reason: ex.reason }] }));
        })}>Add exception</button>
      </div>

      {legacy.length > 0 && (
        <>
          <h3>Workbook allocations without a bank receipt ({legacy.length})</h3>
          <p className="note">Preserved from the workbook. Linking one to a confirmed receipt uses that receipt’s unallocated amount; it never creates bank income.</p>
          <div className="row">
            <select value={link.allocation} onChange={e => setLink({ ...link, allocation: e.target.value })}><option value="">Allocation…</option>{legacy.map(a => <option key={a.id} value={a.id}>{a.month} {money(a.amount)} paid {a.received ?? '?'} {a.source?.sheet ? `(${a.source.sheet} ${a.source.cells ?? ''})` : ''}</option>)}</select>
            <select value={link.receipt} onChange={e => setLink({ ...link, receipt: e.target.value })}><option value="">Receipt…</option>{receiptOptions.map(r => <option key={r.id} value={r.id}>{r.date} {money(r.credit)} {r.sender || r.narration.slice(0, 30)}</option>)}</select>
            <button disabled={busy || !link.allocation || !link.receipt} onClick={() => void run(() => store.commit(d => linkLegacy(d, link.allocation, link.receipt)))}>Link</button>
          </div>
        </>
      )}
      <ErrorLine error={error} />
      <ReportTable table={memberStatement(s, m.id, cutoff)} />
    </div>
  );
}
