import { useMemo, useState } from 'react';
import type { ScreenProps } from '../App';
import { Category, Issue, Receipt, State, categories, contributionCategories, memberName, money, monthLabel } from '../model';
import { createMember, decide, linkReversal, markDuplicate, months as monthRange, notDuplicate, planAllocation, referencedOriginals, resolveIssue, reversalCandidates, updateMember } from '../engine';
import { signals } from '../matching';
import { Badge, ErrorLine, MemberSelect, useAsync } from './common';

type Filter = 'all' | 'contributions' | 'duplicates' | 'expenses' | 'records';

export function Review({ s, store }: ScreenProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const receipts = s.receipts.filter(r => r.status === 'review').sort((a, b) => a.date.localeCompare(b.date));
  const issues = s.issues.filter(i => !i.resolved);
  const groups = {
    contributions: receipts.filter(r => r.credit > 0 && !r.duplicateOf && r.category !== 'Refund / reversal'),
    duplicates: receipts.filter(r => r.duplicateOf),
    expenses: receipts.filter(r => (r.debit > 0 || r.category === 'Refund / reversal') && !r.duplicateOf),
  };
  const shownReceipts = filter === 'all' ? receipts : filter === 'records' ? [] : groups[filter];
  const shownIssues = filter === 'all' || filter === 'records' ? issues : [];
  const visible = shownReceipts.filter(r => !skipped.has(r.id));
  return (
    <section>
      <h1>Needs your review</h1>
      <p className="sub">Only entries the app could not resolve reliably. Everything else was recorded automatically. “Leave unresolved” keeps an item here without blocking anything else.</p>
      <div className="tabs">
        {([['all', `All (${receipts.length + issues.length})`], ['contributions', `Contributions (${groups.contributions.length})`], ['duplicates', `Possible duplicates (${groups.duplicates.length})`], ['expenses', `Expenses & reversals (${groups.expenses.length})`], ['records', `Records & migration (${issues.length})`]] as [Filter, string][]).map(([k, label]) => (
          <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{label}</button>
        ))}
      </div>
      {!visible.length && !shownIssues.length && <div className="empty">Nothing to review here. 🎉</div>}
      {visible.slice(0, 60).map(r => <ReceiptCard key={r.id + s.revision} r={r} s={s} store={store} onSkip={() => setSkipped(new Set([...skipped, r.id]))} />)}
      {visible.length > 60 && <p className="note">Showing the first 60 of {visible.length}. Resolve these to see more.</p>}
      {skipped.size > 0 && <p className="note">{skipped.size} item(s) left unresolved for now. <button className="link" onClick={() => setSkipped(new Set())}>Show them again</button></p>}
      {shownIssues.length > 0 && <h2>Records, migration and reconciliation</h2>}
      <IssueList issues={shownIssues} s={s} store={store} />
    </section>
  );
}

function ReceiptCard({ r, s, store, onSkip }: { r: Receipt; s: State; store: ScreenProps['store']; onSkip: () => void }) {
  const { busy, error, run } = useAsync();
  const original = r.duplicateOf ? s.receipts.find(x => x.id === r.duplicateOf) : undefined;
  const reversal = r.category === 'Refund / reversal' && !r.duplicateOf;
  const [memberId, setMemberId] = useState(r.memberId ?? r.candidates.find(c => s.members.some(m => m.id === c)));
  const [category, setCategory] = useState<Category>(r.credit ? (r.category === 'Unclassified' || r.category === 'Refund / reversal' ? 'Member contribution' : r.category) : (r.category === 'Unclassified' ? 'Other expense' : r.category));
  const [monthsText, setMonthsText] = useState('');
  const token = signals(r.narration)[0] ?? '';
  const [saveRule, setSaveRule] = useState(false);
  const [ruleToken, setRuleToken] = useState(token);
  const [newMember, setNewMember] = useState<{ name: string; start: string; joiningMonth: string }>();
  // Preselect an original only when the bank reference ties it to this reversal; otherwise the treasurer chooses.
  const [originalId, setOriginalId] = useState(() => { const strong = r.category === 'Refund / reversal' ? referencedOriginals(s, r) : []; return strong.length === 1 ? strong[0].id : undefined; });

  const parsedMonths = useMemo(() => parseMonths(monthsText), [monthsText]);
  const plan = useMemo(() => {
    if (!r.credit || !memberId || !contributionCategories.includes(category)) return undefined;
    try { return planAllocation(s, r, memberId, { months: parsedMonths, ignorePeriod: !parsedMonths, treatAsJoining: category === 'Joining contribution' }); } catch { return undefined; }
  }, [s, r, memberId, category, parsedMonths]);

  const approve = () => run(() => store.commit(d => {
    let mid = memberId;
    if (newMember) {
      const m = createMember(d, { name: newMember.name, start: newMember.start || undefined, joiningMonth: newMember.joiningMonth || undefined, aliases: r.sender ? [r.sender] : [] });
      mid = m.id;
    }
    decide(d, r.id, { memberId: mid, category, months: parsedMonths, ruleToken: saveRule ? ruleToken : undefined });
  }));

  return (
    <div className="review-card">
      <div className="rc-head">
        <span className="date">{r.date}{r.valueDate !== r.date && <span className="dim"> (value {r.valueDate})</span>}</span>
        <span className={r.credit ? 'amt in' : 'amt out'}>{r.credit ? '+' : '−'}{money(r.credit || r.debit)}</span>
        <Badge tone="warn">{r.reason}</Badge>
      </div>
      <div className="narration">{r.narration}</div>
      <div className="dim small">{r.source.file}{r.source.sheet ? ` · ${r.source.sheet}` : ''} · row {r.source.row}{r.sender && <> · sender shown by bank: <b>{r.sender}</b></>}{r.label && <> · workbook label: <b>{r.label}</b></>}</div>

      {original ? (
        <div className="rc-body">
          <p>Looks like the earlier record: <b>{original.date}</b> {money(original.credit || original.debit)} — <span className="narr">{original.narration}</span> ({original.category}{original.memberId ? `, ${memberName(s, original.memberId)}` : ''}, balance {money(original.balance)} vs this row {money(r.balance)})</p>
          <div className="actions">
            <button className="primary" disabled={busy} onClick={() => void run(() => store.commit(d => markDuplicate(d, r.id)))}>Same transaction — exclude</button>
            <button disabled={busy} onClick={() => void run(() => store.commit(d => notDuplicate(d, r.id)))}>Separate payment — keep it</button>
            <button className="link" onClick={onSkip}>Leave unresolved</button>
          </div>
        </div>
      ) : reversal ? (
        <div className="rc-body">
          <label>Original transaction being reversed
            <select value={originalId ?? ''} onChange={e => setOriginalId(e.target.value)}>
              <option value="">Choose…</option>
              {[...new Set([...reversalCandidates(s, r).map(x => x.id), ...r.candidates])].filter(id => s.receipts.some(x => x.id === id)).map(id => { const o = s.receipts.find(x => x.id === id)!; return <option key={id} value={id}>{o.date} {money(o.credit || o.debit)} {o.memberId ? memberName(s, o.memberId) : o.category} — {o.narration.slice(0, 50)}</option>; })}
            </select>
          </label>
          <p className="note">Linking reverses the original’s month allocations (the months become unpaid again). Both records are kept.</p>
          <div className="actions">
            <button className="primary" disabled={busy || !originalId} onClick={() => void run(() => store.commit(d => linkReversal(d, r.id, originalId!)))}>Link reversal</button>
            <select value={category} onChange={e => setCategory(e.target.value as Category)}>{categories.filter(c => !contributionCategories.includes(c)).map(c => <option key={c}>{c}</option>)}</select>
            <button disabled={busy} onClick={() => void run(() => store.commit(d => decide(d, r.id, { category })))}>Record as category instead</button>
            <button className="link" onClick={onSkip}>Leave unresolved</button>
          </div>
        </div>
      ) : (
        <div className="rc-body">
          <div className="row">
            <label>Category
              <select value={category} onChange={e => setCategory(e.target.value as Category)}>
                {categories.filter(c => r.credit ? true : !contributionCategories.includes(c)).map(c => <option key={c}>{c}</option>)}
              </select>
            </label>
            {r.credit > 0 && !newMember && (
              <label>Paid for member
                <MemberSelect s={s} value={memberId} onChange={setMemberId} include={r.candidates} />
              </label>
            )}
            {r.credit > 0 && contributionCategories.includes(category) && (
              newMember ? (
                <div className="new-member">
                  <label>New member name<input value={newMember.name} onChange={e => setNewMember({ ...newMember, name: e.target.value })} /></label>
                  <label>Joining month<input type="month" value={newMember.joiningMonth} onChange={e => setNewMember({ ...newMember, joiningMonth: e.target.value })} /></label>
                  <label>Regular ₹200 from<input type="month" value={newMember.start} onChange={e => setNewMember({ ...newMember, start: e.target.value })} /></label>
                  <button className="link" onClick={() => setNewMember(undefined)}>Use existing member</button>
                </div>
              ) : <button className="link" onClick={() => setNewMember({ name: r.sender, joiningMonth: r.date.slice(0, 7), start: nextMonth(r.date.slice(0, 7)) })}>+ New member</button>
            )}
          </div>
          {r.credit > 0 && contributionCategories.includes(category) && (
            <div className="row">
              <label>Months covered (optional)
                <input placeholder="e.g. 2026-01..2026-06 or 2026-03, 2026-04" value={monthsText} onChange={e => setMonthsText(e.target.value)} />
              </label>
              <div className="proposal">
                {newMember ? <span className="dim">New member: {money(r.credit)} {r.credit === s.settings.joiningAmount ? `→ joining contribution for ${newMember.joiningMonth}` : '→ review months after creating'}</span>
                  : plan ? (plan.problem ? <span className="bad-text">{plan.problem}</span> : <>Proposed: {plan.lines.map(l => <Badge key={l.month} tone="info">{monthLabel(l.month)}{l.kind === 'joining' ? ' joining' : ''} {money(l.amount)}</Badge>)}{plan.unapplied > 0 && <Badge tone="muted">unapplied {money(plan.unapplied)}</Badge>}<div className="dim small">{plan.method}</div></>)
                    : <span className="dim">Choose a member to see the proposed months.</span>}
              </div>
            </div>
          )}
          {r.debit > 0 && r.candidates.length === 0 && s.members.some(m => r.narration.toUpperCase().includes(m.name)) && <p className="note">A member’s name appears in this debit. It may be a reimbursement or charity paid through them — not a contribution.</p>}
          <div className="actions">
            <button className="primary" disabled={busy || (contributionCategories.includes(category) && !memberId && !newMember?.name)} onClick={() => void approve()}>Approve</button>
            {token && <label className="inline"><input type="checkbox" checked={saveRule} onChange={e => setSaveRule(e.target.checked)} /> Remember for next time:
              <input className="token" value={ruleToken} onChange={e => setRuleToken(e.target.value)} disabled={!saveRule} /></label>}
            <button className="link" onClick={onSkip}>Leave unresolved</button>
          </div>
        </div>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

function IssueList({ issues, s, store }: { issues: Issue[]; s: State; store: ScreenProps['store'] }) {
  const byKind = new Map<string, Issue[]>();
  for (const i of issues) byKind.set(i.kind, [...(byKind.get(i.kind) ?? []), i]);
  return <>{[...byKind].map(([kind, list]) => <IssueGroup key={kind} kind={kind} list={list} s={s} store={store} />)}</>;
}

function IssueGroup({ kind, list, s, store }: { kind: string; list: Issue[]; s: State; store: ScreenProps['store'] }) {
  const [open, setOpen] = useState(list.length <= 8);
  const { busy, error, run } = useAsync();
  return (
    <div className="panel">
      <h3 onClick={() => setOpen(!open)} className="clickable">{open ? '▾' : '▸'} {kind} <Badge tone="warn">{list.length}</Badge></h3>
      {kind === 'Unmatched historical allocation' && <p className="note">These workbook allocations are preserved as legacy records. They count toward the member’s months but are never added to bank income. Mark them reviewed once you are satisfied, or link them to a receipt from the member page.</p>}
      {open && list.slice(0, 200).map(i => <IssueRow key={i.id} i={i} s={s} busy={busy} run={run} store={store} />)}
      {open && list.length > 1 && !kind.startsWith('Contribution start') && (
        <button disabled={busy} onClick={() => void run(() => store.commit(d => { for (const x of list) resolveIssue(d, x.id, 'Reviewed; kept as recorded'); }))}>Mark all {list.length} as reviewed (keep as recorded)</button>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

function IssueRow({ i, s, busy, run, store }: { i: Issue; s: State; busy: boolean; run: ReturnType<typeof useAsync>['run']; store: ScreenProps['store'] }) {
  const [month, setMonth] = useState(i.suggestion ?? '');
  const m = i.memberId ? s.members.find(x => x.id === i.memberId) : undefined;
  return (
    <div className="issue">
      <div>{i.reason}{i.source && <span className="dim small"> — {i.source.sheet ?? i.source.file} row {i.source.row}{i.source.cells ? ` (${i.source.cells})` : ''}</span>}</div>
      <div className="actions">
        {i.kind === 'Contribution start month' && m ? (
          <>
            <input type="month" value={month} onChange={e => setMonth(e.target.value)} />
            <button className="primary" disabled={busy || !month} onClick={() => void run(() => store.commit(d => updateMember(d, m.id, { start: month })))}>Confirm start month</button>
            <button disabled={busy} onClick={() => void run(() => store.commit(d => { updateMember(d, m.id, { inactiveFrom: '2000-01' }); resolveIssue(d, i.id, 'Marked as not a contributing member'); }))}>Not a contributing member</button>
          </>
        ) : (
          <button disabled={busy} onClick={() => void run(() => store.commit(d => resolveIssue(d, i.id, 'Reviewed; kept as recorded')))}>Mark reviewed</button>
        )}
      </div>
    </div>
  );
}

function nextMonth(m: string) { const [y, mm] = m.split('-').map(Number); return mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`; }

/** "2026-01..2026-06" or "2026-01, 2026-03" → months; undefined when empty or unreadable. */
export function parseMonths(text: string): string[] | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const out: string[] = [];
  for (const part of t.split(/[,;\s]+/).filter(Boolean)) {
    const range = part.match(/^(\d{4}-\d{2})\.\.(\d{4}-\d{2})$/);
    if (range) out.push(...monthRange(range[1], range[2]));
    else if (/^\d{4}-(0[1-9]|1[0-2])$/.test(part)) out.push(part);
    else return undefined;
  }
  return out.length ? [...new Set(out)].sort() : undefined;
}
