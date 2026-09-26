import { useState } from 'react';
import type { ScreenProps } from '../App';
import { Mapping, State, memberName, money } from '../model';
import { StagedImport, Table, hash, mappingFields, parseRows, readStatement, stageStatement } from '../importer';
import { demoStatementCSV } from '../demo';
import { Badge, ErrorLine, download, useAsync } from './common';

export function ImportScreen(props: ScreenProps) {
  const [mode, setMode] = useState<'statement' | 'workbook'>(props.focus === 'workbook' ? 'workbook' : 'statement');
  return (
    <section>
      <h1>Import</h1>
      <div className="tabs">
        <button className={mode === 'statement' ? 'on' : ''} onClick={() => setMode('statement')}>Bank statement (CSV / XLSX)</button>
        <button className={mode === 'workbook' ? 'on' : ''} onClick={() => setMode('workbook')}>Migrate SAHHO workbook</button>
      </div>
      {mode === 'statement' ? <StatementImport {...props} /> : <WorkbookImport {...props} />}
    </section>
  );
}

function StatementImport({ store, s, go }: ScreenProps) {
  const [file, setFile] = useState<{ name: string; data: ArrayBuffer; digest: string }>();
  const [table, setTable] = useState<Table>();
  const [mapping, setMapping] = useState<Mapping>();
  const [staged, setStaged] = useState<StagedImport>();
  const { busy, error, run, setError } = useAsync();

  const reset = () => { setFile(undefined); setTable(undefined); setStaged(undefined); setMapping(undefined); setError(undefined); };
  const open = (name: string, data: ArrayBuffer) => run(async () => {
    reset();
    const digest = await hash(data);
    const t = readStatement(data, name, s);
    setFile({ name, data, digest }); setTable(t); setMapping(t.mapping);
    if (t.known) setStaged(stageStatement(s, t, name, digest));
  });
  const stage = () => run(() => { if (table && file && mapping) setStaged(stageStatement(s, { ...table, mapping }, file.name, file.digest)); });
  const commit = () => run(async () => {
    if (!staged) return;
    await store.replace({ ...staged.state, revision: s.revision });
    reset();
    go(staged.review.length || staged.invalid.length ? 'review' : 'dashboard');
  });

  let sample: ReturnType<typeof parseRows> | undefined;
  let sampleError: string | undefined;
  if (table && mapping && !table.known && !staged) {
    try { sample = parseRows({ ...table, mapping }, 'preview', 'preview'); } catch (e) { sampleError = (e as Error).message; }
  }

  return (
    <div>
      <div className="panel">
        <p>Download your statement from net banking as CSV or Excel and choose it below. It is read inside this browser; nothing is uploaded anywhere.</p>
        <input type="file" accept=".csv,.xlsx,.xls,.txt" onChange={async e => { const f = e.target.files?.[0]; if (f) await open(f.name, await f.arrayBuffer()); e.target.value = ''; }} />
        {s.demo && (
          <div className="demo-actions">
            <button onClick={() => { const csv = demoStatementCSV(); void open('demo-statement-jun-sep-2026.csv', new TextEncoder().encode(csv).buffer as ArrayBuffer); }}>Use the fictional demo statement</button>
            <button className="link" onClick={() => download('demo-statement-jun-sep-2026.csv', demoStatementCSV(), 'text/csv')}>Download it</button>
          </div>
        )}
        {busy && <p className="dim">Reading…</p>}
        <ErrorLine error={error} />
      </div>

      {table && mapping && !table.known && !staged && (
        <div className="panel">
          <h3>New statement format — confirm the columns</h3>
          <p className="note">This layout has not been seen before. Match each field to a column. The mapping is remembered after you commit the import.</p>
          <div className="mapping">
            {mappingFields.map(f => (
              <label key={f.key}>{f.label}{f.required && ' *'}
                <select value={mapping[f.key]} onChange={e => setMapping({ ...mapping, [f.key]: Number(e.target.value) })}>
                  <option value={-1}>— not in this file —</option>
                  {table.headers.map((h, i) => h && <option key={i} value={i}>{h}</option>)}
                </select>
              </label>
            ))}
          </div>
          {sampleError ? <ErrorLine error={sampleError} /> : sample && (
            <>
              <p>{sample.receipts.length} rows read, {sample.invalid.length} invalid. First rows:</p>
              <table className="compact"><thead><tr><th>Date</th><th>Narration</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead>
                <tbody>{sample.receipts.slice(0, 5).map(r => <tr key={r.id}><td>{r.date}</td><td className="narr">{r.narration}</td><td className="num">{r.debit ? money(r.debit) : ''}</td><td className="num">{r.credit ? money(r.credit) : ''}</td><td className="num">{money(r.balance)}</td></tr>)}</tbody></table>
            </>
          )}
          <button className="primary" disabled={!!sampleError} onClick={() => void stage()}>Use this mapping and preview</button>
        </div>
      )}

      {staged && <StagedPreview staged={staged} s={staged.state} onCommit={() => void commit()} onCancel={reset} busy={busy} />}
    </div>
  );
}

function StagedPreview({ staged, s, onCommit, onCancel, busy }: { staged: StagedImport; s: State; onCommit: () => void; onCancel: () => void; busy: boolean }) {
  const b = staged.batch, r = b.reconciliation;
  const monthsFor = (id: string) => s.allocations.filter(a => a.receiptId === id).map(a => `${a.month}${a.kind === 'joining' ? ' (joining)' : ''}: ${money(a.amount)}`).join(', ');
  return (
    <div className="panel">
      <h3>Preview — nothing has been saved yet</h3>
      <div className="stats small">
        <div className="stat"><div className="stat-label">Period</div><div className="stat-value">{b.from} → {b.to}</div></div>
        <div className="stat good"><div className="stat-label">Recorded automatically</div><div className="stat-value">{staged.auto.length}</div></div>
        <div className={staged.review.length ? 'stat warn' : 'stat'}><div className="stat-label">For your review</div><div className="stat-value">{staged.review.length}</div></div>
        {staged.matched.length > 0 && <div className="stat good"><div className="stat-label">Matched to manual entries</div><div className="stat-value">{staged.matched.length}</div></div>}
        <div className="stat"><div className="stat-label">Already recorded (skipped)</div><div className="stat-value">{staged.skipped.length}</div></div>
        <div className={staged.invalid.length ? 'stat bad' : 'stat'}><div className="stat-label">Invalid rows</div><div className="stat-value">{staged.invalid.length}</div></div>
      </div>
      <p>Statement check: opening {money(r.opening)} + credits {money(r.credits)} − debits {money(r.debits)} = {money(r.opening !== undefined ? r.opening + r.credits - r.debits : undefined)}; closing {money(r.closing)} → {r.difference === undefined ? <Badge tone="muted">cannot check</Badge> : r.difference === 0 ? <Badge tone="good">matches</Badge> : <Badge tone="bad">differs by {money(r.difference)}</Badge>}
        {r.rowIssues.length > 0 && <> · <Badge tone="bad">{r.rowIssues.length} running-balance break(s)</Badge></>}</p>
      <div className="actions">
        <button className="primary" disabled={busy} onClick={onCommit}>Commit import</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
      {staged.matched.length > 0 && <>
        <h4>Manual entries found in this statement — reconciled</h4>
        <p className="note">These were typed in earlier. The bank narration below replaces the description you entered; the category, member and months stay as you recorded them.</p>
        <table className="compact">
          <thead><tr><th>Bank date</th><th>Amount</th><th>Bank narration</th><th>Entered as</th><th>Recorded as</th></tr></thead>
          <tbody>{staged.matched.map(x => <tr key={x.entry.id}><td>{x.row.date}</td><td className="num">{money(x.row.credit || -x.row.debit)}</td><td className="narr">{x.row.narration}</td><td className="dim">{x.before.date} · {x.before.narration}</td><td>{x.entry.category}{x.entry.memberId && <> — <b>{memberName(s, x.entry.memberId)}</b><div className="dim">{monthsFor(x.entry.id)}</div></>}</td></tr>)}</tbody>
        </table>
      </>}
      <h4>Recorded automatically</h4>
      <table className="compact">
        <thead><tr><th>Date</th><th>Amount</th><th>Narration</th><th>Recorded as</th><th>Why</th></tr></thead>
        <tbody>{staged.auto.map(x => <tr key={x.id}><td>{x.date}</td><td className="num">{money(x.credit || -x.debit)}</td><td className="narr">{x.narration}</td><td>{x.category}{x.memberId && <> — <b>{memberName(s, x.memberId)}</b><div className="dim">{monthsFor(x.id)}</div></>}</td><td className="dim">{x.reason}</td></tr>)}</tbody>
      </table>
      <h4>Needs review after import</h4>
      <table className="compact">
        <thead><tr><th>Date</th><th>Amount</th><th>Narration</th><th>Reason</th></tr></thead>
        <tbody>{staged.review.map(x => <tr key={x.id}><td>{x.date}</td><td className="num">{money(x.credit || -x.debit)}</td><td className="narr">{x.narration}</td><td>{x.reason}</td></tr>)}
          {staged.invalid.map(i => <tr key={i.row}><td colSpan={3}>Row {i.row}</td><td className="bad-text">{i.reason}</td></tr>)}</tbody>
      </table>
      {staged.skipped.length > 0 && <>
        <h4>Already recorded — skipped</h4>
        <table className="compact"><tbody>{staged.skipped.map(x => <tr key={x.row.id}><td>{x.row.date}</td><td className="num">{money(x.row.credit || -x.row.debit)}</td><td className="narr">{x.row.narration}</td><td className="dim">matches record from {x.original.date}{x.original.reference && x.original.reference === x.row.reference ? ' (same bank reference)' : ' (same narration and balance)'}</td></tr>)}</tbody></table>
      </>}
    </div>
  );
}

function WorkbookImport({ store, s, go }: ScreenProps) {
  const [staged, setStaged] = useState<State>();
  const { busy, error, run } = useAsync();
  const report = staged?.batches.at(-1)?.report as Record<string, number> | undefined;
  return (
    <div className="panel">
      <p>Choose <b>Sahho Detailed Account</b> (.xlsx). The workbook is read in this browser. Monthly allocations are preserved as recorded, linked to bank receipts where the evidence is unique, and anything uncertain is listed for your decision. Summary and formula copies are archived, never imported as payments.</p>
      {(s.members.length > 0 || s.receipts.length > 0) && <p className="warn-text">Migration needs an empty register. Export a backup, then choose “Start empty” in Backup &amp; settings.</p>}
      <input type="file" accept=".xlsx,.xlsm" onChange={async e => {
        const f = e.target.files?.[0]; e.target.value = '';
        if (!f) return;
        await run(async () => {
          const data = await f.arrayBuffer();
          const { migrateWorkbook } = await import('../migration');
          setStaged(migrateWorkbook(s, data, f.name, await hash(data)));
        });
      }} />
      {busy && <p className="dim">Reading the workbook… this can take a few seconds.</p>}
      <ErrorLine error={error} />
      {staged && report && (
        <>
          <h3>Migration preview — nothing saved yet</h3>
          <table className="compact"><tbody>{Object.entries(report).map(([k, v]) => <tr key={k}><td>{k}</td><td className="num">{/Paise$/.test(k) ? money(v) : String(v)}</td></tr>)}</tbody></table>
          <div className="actions">
            <button className="primary" disabled={busy} onClick={() => void run(async () => { await store.replace({ ...staged, revision: s.revision }); setStaged(undefined); go('review'); })}>Commit migration</button>
            <button onClick={() => setStaged(undefined)}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}
