import type { ScreenProps } from '../App';
import { money } from '../model';
import { Badge, Stat } from './common';

export function Dashboard({ s, dash, cutoff, go }: ScreenProps) {
  const d = dash;
  const b = d.latestBatch;
  const recon = d.reconciliation;
  const noStart = s.members.filter(m => !m.start && !m.inactiveFrom).length;
  return (
    <section>
      <h1>Dashboard</h1>
      <p className="sub">Figures as of <b>{cutoff}</b>. Bank data available through <b>{d.dataThrough ?? '—'}</b>. Contribution months are due on day {s.settings.dueDay}; dues are counted through <b>{d.until}</b>.</p>
      <div className="stats">
        <Stat label="Recorded bank balance" value={money(d.bankBalance)} sub={<>as per bank on {d.balanceDate ?? '—'} · {recon.ok ? <Badge tone="good">Reconciled</Badge> : <Badge tone="bad">{recon.rowIssues.length + recon.batchDifferences.length} difference(s)</Badge>}</>} />
        <Stat label="Needs your review" value={d.review} tone={d.review ? 'warn' : 'good'} sub={<button className="link" onClick={() => go('review')}>Open review queue →</button>} />
        <Stat label="Joining contributions" value={money(d.joining)} sub="Initial ₹350 payments received" />
        <Stat label="Regular contributions" value={money(d.regular)} sub={d.reversalDebits ? `net of ${money(d.reversalDebits)} reversed` : "Confirmed bank receipts"} />
        <Stat label="Charity expenditure" value={money(d.charity)} />
        <Stat label="Other receipts / expenses" value={<>{money(d.otherReceipts + d.interest)} / {money(d.otherExpenses)}</>} sub={`incl. bank interest ${money(d.interest)}`} />
        <Stat label="Outstanding contributions" value={money(d.outstanding)} tone={d.outstanding ? 'warn' : undefined} sub={noStart ? `${noStart} member(s) without a confirmed start month are excluded` : 'Overdue months only; future months excluded'} />
        <Stat label="Advances / unapplied credit" value={<>{money(d.advance)} / {money(d.unapplied)}</>} sub="Paid ahead · received but not yet allocated" />
      </div>
      {(d.pendingCredits > 0 || d.pendingDebits > 0) && (
        <p className="note">Awaiting review (not in the confirmed figures above): credits {money(d.pendingCredits)}, debits {money(d.pendingDebits)}. Possible duplicates are excluded from all totals.</p>
      )}
      <div className="grid2">
        <div className="panel">
          <h3>Latest import</h3>
          {b ? (
            <>
              <p><b>{b.file}</b> <span className="dim">({new Date(b.at).toLocaleString()})</span></p>
              <p>{b.from} → {b.to}</p>
              <p>{b.imported} new · {b.auto ?? 0} recorded automatically · {b.duplicates} already recorded (skipped) · {b.review} for review</p>
              <p>Statement check: {b.reconciliation.difference === undefined ? <Badge tone="muted">no opening/closing given</Badge> : b.reconciliation.difference === 0 ? <Badge tone="good">opening + credits − debits = closing</Badge> : <Badge tone="bad">differs by {money(b.reconciliation.difference)}</Badge>}</p>
            </>
          ) : <p className="dim">No imports yet.</p>}
          <button className="primary" onClick={() => go('import')}>Import a bank statement</button>
        </div>
        <div className="panel">
          <h3>Members with most outstanding</h3>
          <table className="compact">
            <tbody>
              {[...d.members].filter(x => x.outstanding).sort((a, b) => b.outstanding - a.outstanding).slice(0, 8).map(x => (
                <tr key={x.member.id}><td>{x.member.name}</td><td className="num">{money(x.outstanding)}</td><td className="dim">{x.unpaid.length + x.partial.length} month(s)</td></tr>
              ))}
            </tbody>
          </table>
          <button className="link" onClick={() => go('members')}>Member register →</button>
        </div>
      </div>
    </section>
  );
}
