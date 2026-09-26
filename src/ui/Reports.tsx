import { useMemo, useState } from 'react';
import type { ScreenProps } from '../App';
import { allocatedByObligationMonth, annualReport, charityReport, memberStatement, outstandingReport, receivedByReceiptMonth, reconciliationReport } from '../reports';
import { MemberSelect, ReportTable, exportXLSX } from './common';

const REPORTS = [
  ['member', 'Individual member statement'],
  ['outstanding', 'Outstanding as of date'],
  ['receipt', 'By bank receipt month'],
  ['obligation', 'By contribution month'],
  ['annual', 'Annual receipts & expenditure'],
  ['charity', 'Charity spending'],
  ['recon', 'Bank reconciliation'],
] as const;

export function Reports({ s, cutoff }: ScreenProps) {
  const [kind, setKind] = useState<typeof REPORTS[number][0]>('outstanding');
  const [memberId, setMemberId] = useState(s.members[0]?.id);
  const table = useMemo(() => {
    switch (kind) {
      case 'member': return memberId ? memberStatement(s, memberId, cutoff) : undefined;
      case 'outstanding': return outstandingReport(s, cutoff);
      case 'receipt': return receivedByReceiptMonth(s, cutoff);
      case 'obligation': return allocatedByObligationMonth(s, cutoff);
      case 'annual': return annualReport(s, cutoff);
      case 'charity': return charityReport(s, cutoff);
      case 'recon': return reconciliationReport(s);
    }
  }, [kind, s, cutoff, memberId]);
  return (
    <section>
      <h1>Reports</h1>
      <p className="sub no-print">All reports use the reporting date <b>{cutoff}</b> (change it at the top). Historical reports exclude payments received after that date and reversals are applied from their own date.</p>
      <div className="tabs no-print">
        {REPORTS.map(([k, label]) => <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{label}</button>)}
        <button onClick={() => void exportXLSX(`sahho-reports-${cutoff}.xlsx`, [outstandingReport(s, cutoff), receivedByReceiptMonth(s, cutoff), allocatedByObligationMonth(s, cutoff), annualReport(s, cutoff), charityReport(s, cutoff), reconciliationReport(s)])}>Export all to Excel</button>
      </div>
      {kind === 'member' && <div className="toolbar no-print"><MemberSelect s={s} value={memberId} onChange={setMemberId} /></div>}
      {table && <ReportTable table={table} compact nowrap={kind === 'outstanding'} />}
    </section>
  );
}
