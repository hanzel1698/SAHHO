import { Receipt, State, emptyState, id } from '../src/model';
import { commitPlan, createMember, planAllocation } from '../src/engine';
import { senderOf, trainRules } from '../src/matching';
import { bankRef, readStatement, stageStatement } from '../src/importer';

export const rupees = (n: number) => Math.round(n * 100);

let seq = 0;
export function receipt(s: State, date: string, narration: string, credit: number, debit = 0, extra: Partial<Receipt> = {}): Receipt {
  const r: Receipt = {
    id: id(), date, valueDate: date, narration, sender: senderOf(narration), credit, debit, reference: bankRef(narration),
    batch: 'history', order: seq++, source: { file: 'fixture', row: seq, raw: {} }, category: 'Unclassified', status: 'confirmed', reason: '', candidates: [], ...extra,
  };
  s.receipts.push(r);
  return r;
}

export function pay(s: State, memberName: string, r: Receipt) {
  const m = s.members.find(x => x.name === memberName)!;
  const plan = planAllocation(s, r, m.id, { ignorePeriod: true });
  if (plan.problem) throw Error(plan.problem);
  commitPlan(s, r, plan);
}

export const upi = (ref: string, sender: string, vpa: string, note = 'Paid via', dir = 'CR') => `UPI/${dir}/${ref}/${sender}/SBIN/**${vpa}/${note}//X${ref}/01/01/2026 10:00:00`;

/** A small fictional register: two members with history, a parent paying for a child, a shared payer. */
export function fixture() {
  const s = emptyState();
  if (!s.batches.length) s.batches.push({ id: 'history', file: 'fixture', hash: 'h', at: '2026-01-01T00:00:00Z', kind: 'demo', imported: 0, duplicates: 0, review: 0, reconciliation: { credits: 0, debits: 0, rowIssues: [] } });
  createMember(s, { name: 'ASHA', joiningMonth: '2025-01', start: '2025-02' });
  createMember(s, { name: 'BENNY', joiningMonth: '2025-01', start: '2025-02' });
  createMember(s, { name: 'CHARU', joiningMonth: '2025-01', start: '2025-02' });
  createMember(s, { name: 'DILEEP', joiningMonth: '2025-01', start: '2025-02' });
  pay(s, 'ASHA', receipt(s, '2025-01-05', upi('500000000001', 'ASHA K', 'asha.k@oksbi'), rupees(350)));
  pay(s, 'ASHA', receipt(s, '2025-02-05', upi('500000000002', 'ASHA K', 'asha.k@oksbi'), rupees(200)));
  pay(s, 'BENNY', receipt(s, '2025-01-06', 'NEFT Cr-SBIN500000000003-SBIN0001-FATHER OF BENNY--/ATTN/', rupees(350)));
  pay(s, 'BENNY', receipt(s, '2025-03-06', 'NEFT Cr-SBIN500000000004-SBIN0001-FATHER OF BENNY--/ATTN/', rupees(400)));
  pay(s, 'CHARU', receipt(s, '2025-01-07', upi('500000000005', 'UNCLE SAM', 'uncle.sam@okaxis', 'charu'), rupees(350)));
  pay(s, 'DILEEP', receipt(s, '2025-01-07', upi('500000000006', 'UNCLE SAM', 'uncle.sam@okaxis', 'dileep'), rupees(350)));
  receipt(s, '2025-03-10', upi('500000000007', 'CITY PHARMA', 'citypharma@okhdfc', 'Medicines', 'DR'), 0, rupees(1500), { category: 'Charity expenditure' });
  receipt(s, '2025-04-10', upi('500000000008', 'CITY PHARMA', 'citypharma@okhdfc', 'Medicines', 'DR'), 0, rupees(900), { category: 'Charity expenditure' });
  trainRules(s);
  return s;
}

export const header = 'Txn Date,Value Date,Cheque No.,Description,Branch Code,Debit,Credit,Balance,';
export function csv(rows: string[], opening = 'Rs.10,000.00', closing?: string) {
  return [',,Current & Saving Account Statement', '', 'Account Holders Name,FICTIONAL', `Opening Balance,"${opening}"`, ...(closing ? [`Closing Balance,"${closing}"`] : []), '', header, ...rows, ''].join('\r\n');
}
export const row = (date: string, valueDate: string, ref: string, narration: string, debit: string, credit: string, balance: string) =>
  `="${date} 10:00:00",="${valueDate}",="${ref}","${narration}","1144",${debit ? `="${debit}"` : ''},${credit ? `="${credit}"` : ''},"${balance}",`;

export function importCSV(s: State, text: string, name = 'statement.csv') {
  const data = new TextEncoder().encode(text).buffer as ArrayBuffer;
  const table = readStatement(data, name, s);
  return stageStatement(s, table, name, `hash-${name}-${text.length}-${text.slice(-60)}`);
}
