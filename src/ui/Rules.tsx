import { Fragment, useState } from 'react';
import type { ScreenProps } from '../App';
import { Category, Rule, audit, categories, id, memberName, money, norm } from '../model';
import { testRule, trainRules, validateToken } from '../matching';
import { decide } from '../engine';
import { Badge, ErrorLine, MemberSelect, useAsync } from './common';

export function Rules({ s, store }: ScreenProps) {
  const [q, setQ] = useState('');
  const [show, setShow] = useState<'all' | 'member' | 'category' | 'conflict'>('all');
  const [testing, setTesting] = useState<string>();
  const [draft, setDraft] = useState({ token: 'UPI:', memberId: '', category: '' as Category | '' });
  const { busy, error, run } = useAsync();
  const conflicts = new Set(s.rules.filter(r => r.memberId && s.rules.some(x => x !== r && x.token === r.token && x.memberId && x.memberId !== r.memberId)).map(r => r.id));
  const rules = s.rules.filter(r => (!q || norm(r.token + ' ' + memberName(s, r.memberId) + ' ' + (r.category ?? '')).includes(norm(q))) &&
    (show === 'all' || (show === 'member' ? !!r.memberId : show === 'category' ? !!r.category : conflicts.has(r.id))))
    .sort((a, b) => a.token.localeCompare(b.token));
  const edit = (ruleId: string, patch: Partial<Rule>) => run(() => store.commit(d => {
    const r = d.rules.find(x => x.id === ruleId)!;
    if (patch.token) { const p = validateToken(patch.token); if (p) throw Error(p); patch.token = norm(patch.token); }
    const before = structuredClone(r);
    Object.assign(r, patch);
    audit(d, 'Rule changed', r.token, before, structuredClone(r));
  }));
  return (
    <section>
      <h1>Matching rules</h1>
      <p className="sub">Rules link bank sender details to members (for credits) or to categories (for debits). They are learned from confirmed history. Only an enabled, <b>validated</b> rule that points to a single member records a payment automatically; conflicting rules send payments to review. Changing a rule never rewrites past confirmed records — use “Test” to see proposed changes.</p>
      <div className="toolbar">
        <input placeholder="Search token, member or category" value={q} onChange={e => setQ(e.target.value)} />
        <select value={show} onChange={e => setShow(e.target.value as typeof show)}>
          <option value="all">All rules ({s.rules.length})</option><option value="member">Identity rules</option><option value="category">Category rules</option><option value="conflict">Conflicting senders ({conflicts.size})</option>
        </select>
        <button disabled={busy} onClick={() => void run(() => store.commit(d => { trainRules(d); audit(d, 'Rules relearned', 'Rebuilt candidate rules from confirmed history'); }))}>Relearn from confirmed history</button>
      </div>
      <div className="panel">
        <h3>Add a rule</h3>
        <div className="row">
          <label>Token<input value={draft.token} onChange={e => setDraft({ ...draft, token: e.target.value })} placeholder="UPI:**name@okaxis, SENDER:NAME, TEXT:words" /></label>
          <label>Member (for credits)<MemberSelect s={s} value={draft.memberId} onChange={v => setDraft({ ...draft, memberId: v, category: '' })} /></label>
          <label>or Category (for debits)<select value={draft.category} onChange={e => setDraft({ ...draft, category: e.target.value as Category, memberId: '' })}><option value="">—</option>{categories.map(c => <option key={c}>{c}</option>)}</select></label>
          <button disabled={busy} onClick={() => void run(() => store.commit(d => {
            const p = validateToken(draft.token); if (p) throw Error(p);
            if (!draft.memberId && !draft.category) throw Error('Choose a member or a category.');
            d.rules.push({ id: id(), token: norm(draft.token), memberId: draft.memberId || undefined, category: draft.category || undefined, enabled: true, validated: true, evidence: [], origin: 'manual', note: 'Added manually' });
            audit(d, 'Rule added', norm(draft.token));
          }))}>Add rule</button>
        </div>
      </div>
      <ErrorLine error={error} />
      <div className="table-wrap">
        <table>
          <thead><tr><th>Token</th><th>Target</th><th>Evidence</th><th>State</th><th>Actions</th></tr></thead>
          <tbody>
            {rules.slice(0, 400).map(r => (
              <Fragment key={r.id}>
                <tr>
                  <td className="mono">{r.token}</td>
                  <td>{r.memberId ? <b>{memberName(s, r.memberId)}</b> : r.category}{conflicts.has(r.id) && <div><Badge tone="bad">sender pays for several members</Badge></div>}</td>
                  <td>{r.evidence.length} record(s)<div className="dim small">{r.note}</div></td>
                  <td>{r.enabled ? <Badge tone="good">enabled</Badge> : <Badge tone="muted">disabled</Badge>} {r.validated ? <Badge tone="info">validated</Badge> : <Badge tone="warn">suggest only</Badge>} <Badge tone="muted">{r.origin}</Badge></td>
                  <td className="actions">
                    <button onClick={() => setTesting(testing === r.id ? undefined : r.id)}>Test</button>
                    <button disabled={busy} onClick={() => void edit(r.id, { enabled: !r.enabled })}>{r.enabled ? 'Disable' : 'Enable'}</button>
                    {!r.validated && <button disabled={busy || conflicts.has(r.id)} onClick={() => void edit(r.id, { validated: true })}>Validate</button>}
                    <button disabled={busy} onClick={() => { const t = prompt('Edit token', r.token); if (t) void edit(r.id, { token: t }); }}>Edit</button>
                  </td>
                </tr>
                {testing === r.id && <tr><td colSpan={5}><RuleTest rule={r} s={s} store={store} /></td></tr>}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RuleTest({ rule, s, store }: { rule: Rule; s: ScreenProps['s']; store: ScreenProps['store'] }) {
  const results = testRule(s, rule);
  const { busy, error, run } = useAsync();
  const disagree = results.filter(x => !x.agrees);
  return (
    <div className="rule-test">
      <p>Matches {results.length} past transaction(s): {results.length - disagree.length} agree, <b>{disagree.length}</b> would change.</p>
      {disagree.length > 0 && <p className="note">Proposed changes are not applied automatically. Apply individually after checking each one.</p>}
      <table className="compact"><tbody>
        {disagree.slice(0, 50).map(({ receipt: r, confirmed }) => (
          <tr key={r.id}><td>{r.date}</td><td className="num">{money(r.credit || r.debit)}</td><td className="narr">{r.narration}</td>
            <td>now: {r.memberId ? memberName(s, r.memberId) : r.category} ({r.status}) → <b>{rule.memberId ? memberName(s, rule.memberId) : rule.category}</b></td>
            <td><button disabled={busy} onClick={() => void run(() => store.commit(d => decide(d, r.id, rule.memberId ? { memberId: rule.memberId, category: r.category === 'Joining contribution' ? r.category : 'Member contribution', note: `applied rule ${rule.token}${confirmed ? ' (correction of a confirmed record)' : ''}` } : { category: rule.category!, note: `applied rule ${rule.token}` })))}>Apply</button></td></tr>
        ))}
      </tbody></table>
      <ErrorLine error={error} />
    </div>
  );
}
