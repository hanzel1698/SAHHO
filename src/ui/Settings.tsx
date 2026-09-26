import { useState } from 'react';
import type { ScreenProps } from '../App';
import { State, audit, emptyState, money, today } from '../model';
import { backupText, parseBackup, undoImport, undoPreview } from '../storage';
import { demoState } from '../demo';
import { cloud } from '../cloud';
import { Badge, ErrorLine, download, useAsync } from './common';

export function Settings({ s, store }: ScreenProps) {
  const { busy, error, run } = useAsync();
  const [restore, setRestore] = useState<{ file: string; state: State }>();
  const [rate, setRate] = useState({ from: '', amount: '' });
  const undo = undoPreview(s);
  const [auditLimit, setAuditLimit] = useState(50);

  const exportBackup = () => run(async () => {
    download(`sahho-backup-${today()}.json`, backupText(s), 'application/json');
    await store.commit(d => { d.lastBackup = new Date().toISOString(); audit(d, 'Backup exported', `${d.members.length} members, ${d.receipts.length} transactions`); });
  });
  const safetyExport = () => download(`sahho-before-replace-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, backupText(s), 'application/json');
  const replaceAll = (next: State, why: string) => run(async () => {
    if (s.members.length || s.receipts.length) safetyExport();
    const n = structuredClone(next);
    n.revision = s.revision;
    audit(n, 'Records replaced', why);
    await store.replace(n);
  });

  return (
    <section>
      <h1>Backup &amp; settings</h1>
      <div className="panel highlight">
        <h3>Backup</h3>
        <p>Last backup: <b>{s.lastBackup ? new Date(s.lastBackup).toLocaleString() : 'never'}</b>. A backup contains all members, transactions, allocations, rules, review decisions, archived workbook cells and the audit history.</p>
        <div className="actions">
          <button className="primary" disabled={busy} onClick={() => void exportBackup()}>Export full backup</button>
          <label className="file-button">Restore from backup…
            <input type="file" accept=".json" onChange={async e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) await run(async () => setRestore({ file: f.name, state: parseBackup(await f.text()) })); }} />
          </label>
        </div>
        {restore && (
          <div className="confirm">
            <p>Backup <b>{restore.file}</b> is valid: {restore.state.members.length} members, {restore.state.receipts.length} transactions, {restore.state.allocations.length} allocations, {restore.state.rules.length} rules, {restore.state.audit.length} audit entries{restore.state.demo ? ' (demo data)' : ''}.</p>
            <p className="warn-text">Restoring replaces the saved records. Your current records will be downloaded first as a safety copy.</p>
            <button className="primary" disabled={busy} onClick={() => void replaceAll(restore.state, `Restored from ${restore.file}`).then(ok => ok && setRestore(undefined))}>Restore now</button>
            <button onClick={() => setRestore(undefined)}>Cancel</button>
          </div>
        )}
        {cloud
          ? <p className="note">Records are stored in SAHHO’s Supabase database; only signed-in treasurer accounts can read or change them. Changes made on another device are detected, and an older window can never overwrite newer records. Keep exported backups as an offline copy.</p>
          : <p className="note">Records live only in this browser on this device (IndexedDB). They are not synchronised to other devices or people, and clearing browser data deletes them. Use backups to move records or keep them safe. If several tabs are open, a change saved in one tab is detected in the others and older tabs cannot overwrite it.</p>}
      </div>

      <div className="panel">
        <h3>Undo last import</h3>
        {undo ? (
          <>
            <p><b>{undo.batch?.file}</b>: removes {undo.receipts} transactions and {undo.allocations} allocations.</p>
            {undo.laterEdits.length > 0 && <div className="warn-text">Changes made after this import — any that involve its transactions are undone with it:<ul>{undo.laterEdits.slice(0, 10).map(a => <li key={a.id}>{a.at.slice(0, 16).replace('T', ' ')} — {a.action}: {a.detail}</li>)}</ul></div>}
            <button disabled={busy} onClick={() => { if (confirm('Roll back this import?')) void run(() => store.replace(undoImport(s, true))); }}>Undo import</button>
          </>
        ) : <p className="dim">No import available to undo.</p>}
      </div>

      <div className="panel">
        <h3>Contribution policy</h3>
        <p>Joining contribution: <b>{money(s.settings.joiningAmount)}</b>, recorded as one whole payment — never split into months.</p>
        <p>Monthly rates (by effective month — changes never alter earlier months):</p>
        <ul>{[...s.settings.rates].sort((a, b) => a.from.localeCompare(b.from)).map(r => <li key={r.from}>From {r.from}: {money(r.amount)} per month</li>)}</ul>
        <div className="row">
          <label>New rate from<input type="month" value={rate.from} onChange={e => setRate({ ...rate, from: e.target.value })} /></label>
          <label>Amount ₹<input value={rate.amount} onChange={e => setRate({ ...rate, amount: e.target.value })} /></label>
          <button disabled={busy} onClick={() => void run(() => {
            const amount = Math.round(Number(rate.amount) * 100);
            if (!rate.from || !Number.isSafeInteger(amount) || amount <= 0) throw Error('Enter a month and a positive amount.');
            return store.commit(d => { d.settings.rates = [...d.settings.rates.filter(r => r.from !== rate.from), { from: rate.from, amount }]; audit(d, 'Rate changed', `${rate.from}: ${money(amount)}`); });
          })}>Add rate</button>
        </div>
        <p><b>Allocation policy</b> (applies automatically, no per-transaction questions): joining ₹350 for a member’s first payment → months stated clearly in the narration → oldest unpaid months first, completing part-paid months → future months up to
          <input className="short" type="number" min={0} max={120} value={s.settings.advanceMonths} onChange={e => void run(() => store.commit(d => { d.settings.advanceMonths = Math.max(0, Math.min(120, Number(e.target.value) || 0)); audit(d, 'Policy changed', `Advance limit ${d.settings.advanceMonths} months`); }))} /> months ahead → anything left is kept as unapplied credit.</p>
        <p>A month’s contribution falls due on day <input className="short" type="number" min={1} max={28} value={s.settings.dueDay} onChange={e => void run(() => store.commit(d => { d.settings.dueDay = Math.max(1, Math.min(28, Number(e.target.value) || 28)); audit(d, 'Policy changed', `Due day ${d.settings.dueDay}`); }))} /> of that month. Later months are future, not overdue.</p>
        <p>Backup reminder after <input className="short" type="number" min={1} max={365} value={s.settings.backupReminderDays} onChange={e => void run(() => store.commit(d => { d.settings.backupReminderDays = Math.max(1, Number(e.target.value) || 14); }))} /> days.</p>
      </div>

      <div className="panel">
        <h3>Import history &amp; migration reports</h3>
        <table className="compact"><thead><tr><th>When</th><th>File</th><th>Kind</th><th>Period</th><th>New</th><th>Skipped</th><th>Review</th><th>Statement check</th></tr></thead>
          <tbody>{[...s.batches].reverse().map(b => (
            <tr key={b.id + (b.undone ? 'u' : '')}><td>{b.at.slice(0, 16).replace('T', ' ')}</td><td>{b.file}{b.undone && <Badge tone="muted">undone</Badge>}</td><td>{b.kind}</td><td>{b.from} → {b.to}</td><td>{b.imported}</td><td>{b.duplicates}</td><td>{b.review}</td>
              <td>{b.reconciliation.difference === undefined ? '—' : b.reconciliation.difference === 0 ? <Badge tone="good">ok</Badge> : <Badge tone="bad">{money(b.reconciliation.difference)}</Badge>}</td></tr>
          ))}</tbody></table>
        {s.batches.filter(b => b.report).map(b => (
          <details key={b.id}><summary>Migration report — {b.file}</summary>
            <table className="compact"><tbody>{Object.entries(b.report!).map(([k, v]) => <tr key={k}><td>{k}</td><td className="num">{/Paise$/.test(k) ? money(v as number) : typeof v === 'object' ? JSON.stringify(v) : String(v)}</td></tr>)}</tbody></table>
          </details>
        ))}
      </div>

      <div className="panel">
        <h3>Start again</h3>
        <p>Both options download your current records first.</p>
        <div className="actions">
          <button disabled={busy} onClick={() => { if (confirm('Replace all records with an empty register? A backup downloads first.')) void replaceAll(emptyState(), 'Started empty'); }}>Start empty (e.g. before migrating the workbook)</button>
          <button disabled={busy} onClick={() => { if (confirm('Replace all records with fictional demo data? A backup downloads first.')) void replaceAll(demoState(), 'Loaded demo data'); }}>Load fictional demo data</button>
        </div>
      </div>

      <div className="panel">
        <h3>Audit history ({s.audit.length})</h3>
        <table className="compact"><tbody>{[...s.audit].reverse().slice(0, auditLimit).map(a => <tr key={a.id}><td className="nowrap">{a.at.slice(0, 19).replace('T', ' ')}</td><td>{a.action}</td><td>{a.detail}</td></tr>)}</tbody></table>
        {s.audit.length > auditLimit && <button className="link" onClick={() => setAuditLimit(auditLimit + 200)}>Show more</button>}
      </div>
      <ErrorLine error={error} />
    </section>
  );
}
