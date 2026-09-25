// Fictional demo data. No real member, statement or workbook data is included in this repository.
import { Batch, Receipt, State, audit, emptyState, id } from './model';
import { commitPlan, createMember, planAllocation } from './engine';
import { trainRules, senderOf } from './matching';
import { bankRef, reconcile } from './importer';

interface Txn { date: string; narration: string; credit: number; debit: number; member?: string; category?: Receipt['category']; history: boolean; statement: boolean }

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
let refSeed = 0;
const ref = () => String(610000000000 + (refSeed += 7919));
const ddmmyyyy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const upiCr = (d: string, sender: string, bank: string, vpa: string, note = 'Paid via') => `UPI/CR/${ref()}/${sender}/${bank}/**${vpa}/${note}//DEMO${pad(refSeed % 997, 3)}/${ddmmyyyy(d)} 10:15:00`;
const upiDr = (d: string, payee: string, bank: string, vpa: string, note = 'UPI') => `UPI/DR/${ref()}/${payee}/${bank}/**${vpa}/${note}//DEMO${pad(refSeed % 991, 3)}/${ddmmyyyy(d)} 18:40:00`;
const neft = (sender: string) => `NEFT Cr-SBIN${ref()}-SBIN0001234-${sender}--/ATTN/`;

const HISTORY_END = '2026-06-20';
const STATEMENT_FROM = '2026-06-15';

function monthsBetween(from: string, to: string) {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) { out.push(`${y}-${pad(m)}`); m++; if (m > 12) { m = 1; y++; } }
  return out;
}

function schedule(): Txn[] {
  refSeed = 0;
  const t: Txn[] = [];
  const add = (date: string, narration: string, credit: number, debit: number, extra: Partial<Txn> = {}) => {
    const statement = date >= STATEMENT_FROM;
    const history = date <= HISTORY_END && extra.history !== false;
    t.push({ date, narration, credit, debit, history, statement, ...extra });
  };
  // Joining contributions
  add('2024-01-04', upiCr('2024-01-04', 'ANITA MENON', 'FDRL', 'anita.m@okaxis'), 35000, 0, { member: 'ANITA MENON' });
  add('2024-01-05', neft('BIJU THOMAS'), 35000, 0, { member: 'BIJU THOMAS' });
  add('2024-01-08', neft('K PILLAI'), 35000, 0, { member: 'DEVAN PILLAI' });
  add('2024-01-10', upiCr('2024-01-10', 'GEETHA RAO', 'SBIN', 'geetha.rao@oksbi'), 35000, 0, { member: 'GEETHA RAO' });
  add('2024-03-02', upiCr('2024-03-02', 'CHITRA NAIR', 'SBIN', 'chitra.n@oksbi'), 35000, 0, { member: 'CHITRA NAIR' });
  add('2024-03-06', upiCr('2024-03-06', 'SUNIL VARGHESE', 'ICIC', 'sunil.v@okicici', 'Iqbal'), 35000, 0, { member: 'IQBAL SAIT' });
  add('2024-03-07', upiCr('2024-03-07', 'SUNIL VARGHESE', 'ICIC', 'sunil.v@okicici', 'Jose'), 35000, 0, { member: 'JOSE PAUL' });
  add('2024-06-03', upiCr('2024-06-03', 'FARHAN ALI', 'UTIB', 'farhan.ali@ybl'), 35000, 0, { member: 'FARHAN ALI' });
  add('2025-03-05', upiCr('2025-03-05', 'HARI K', 'HDFC', 'hari.k@okhdfc'), 35000, 0, { member: 'HARI KRISHNAN' });

  for (const m of monthsBetween('2024-02', '2026-06')) {
    const d = (day: number) => `${m}-${pad(day)}`;
    add(d(5), upiCr(d(5), 'ANITA MENON', 'FDRL', 'anita.m@okaxis'), 20000, 0, { member: 'ANITA MENON' });
    if (m >= '2024-04' && m <= '2025-12') add(d(7), upiCr(d(7), 'CHITRA NAIR', 'SBIN', 'chitra.n@oksbi'), 20000, 0, { member: 'CHITRA NAIR' });
    if (m >= '2024-07' && m !== '2026-06') add(d(9), upiCr(d(9), 'FARHAN ALI', 'UTIB', 'farhan.ali@ybl'), 20000, 0, { member: 'FARHAN ALI' });
    if (m <= '2025-06') add(d(11), upiCr(d(11), 'GEETHA RAO', 'SBIN', 'geetha.rao@oksbi'), 20000, 0, { member: 'GEETHA RAO' });
    if (['2024-02', '2024-08', '2025-02', '2025-08', '2026-02'].includes(m)) add(d(3), neft('BIJU THOMAS'), 120000, 0, { member: 'BIJU THOMAS' });
    if (['2024-04', '2024-07', '2024-10', '2025-01', '2025-04', '2025-07', '2025-10', '2026-01', '2026-04'].includes(m)) add(d(2), neft('K PILLAI'), 60000, 0, { member: 'DEVAN PILLAI' });
    if (['2024-06', '2024-12', '2025-06', '2025-12'].includes(m)) {
      add(d(12), upiCr(d(12), 'SUNIL VARGHESE', 'ICIC', 'sunil.v@okicici', 'Iqbal'), 120000, 0, { member: 'IQBAL SAIT' });
      add(d(12), upiCr(d(12), 'SUNIL VARGHESE', 'ICIC', 'sunil.v@okicici', 'Jose'), 120000, 0, { member: 'JOSE PAUL' });
    }
    if (m >= '2025-04' && m <= '2026-03') add(d(15), upiCr(d(15), 'HARI K', 'HDFC', 'hari.k@okhdfc'), 20000, 0, { member: 'HARI KRISHNAN' });
    if (['2024-02', '2024-05', '2024-09', '2025-01', '2025-05', '2025-09', '2026-01', '2026-05'].includes(m)) {
      add(d(20), upiDr(d(20), 'MEDPLUS PHARMACY', 'HDFC', 'medplus.clt@okaxis', 'Medicines'), 0, 350000 + (Number(m.slice(5)) * 1700), { category: 'Charity expenditure' });
    }
    if (['2024-03', '2024-11', '2025-07', '2026-03'].includes(m)) add(d(22), `NEFT Dr-CITY HOSPITAL CALICUT-TREATMENT SUPPORT-${ref()}`, 0, 1000000, { category: 'Charity expenditure' });
    if (['2024-03', '2024-06', '2024-09', '2024-12', '2025-03', '2025-06', '2025-09', '2025-12', '2026-03'].includes(m)) {
      add(d(27), `SBINT FOR THE PERIOD ENDING ${d(27)}`, 18500 + Number(m.slice(5)) * 100, 0, { category: 'Bank interest' });
      add(d(28), `SMS charge Short collection Due Dt:${d(28)}`, 0, 1770, { category: 'Bank charges' });
    }
    if (['2024-01', '2024-07', '2025-01', '2025-07', '2026-01'].includes(m)) add(d(1), upiDr(d(1), 'Vi', 'YESB', 'vi.recharge@ptybl', 'Recharge'), 0, 29900, { category: 'Phone recharge' });
  }
  // KAVYA: recorded in the old workbook with ₹200 months but no joining payment (migration exception in demo).
  // ---- New statement period (after history) ----
  add('2026-06-20', upiCr('2026-06-20', 'FARHAN ALI', 'UTIB', 'farhan.ali@ybl'), 20000, 0, { member: 'FARHAN ALI', history: true });
  add('2026-06-20', upiCr('2026-06-20', 'FARHAN ALI', 'UTIB', 'farhan.ali@ybl', 'July'), 20000, 0, { history: false });
  add('2026-07-05', upiCr('2026-07-05', 'ANITA MENON', 'FDRL', 'anita.m@okaxis'), 20000, 0);
  add('2026-07-06', upiCr('2026-07-06', 'CHITRA NAIR', 'SBIN', 'chitra.n@oksbi'), 120000, 0);
  add('2026-07-02', neft('K PILLAI'), 60000, 0);
  add('2026-07-10', upiCr('2026-07-10', 'SUNIL VARGHESE', 'ICIC', 'sunil.v@okicici', 'Paid via'), 20000, 0);
  add('2026-07-14', upiCr('2026-07-14', 'NEETHU S', 'KKBK', 'neethu.s@okkotak', 'sahho joining'), 35000, 0);
  add('2026-07-15', upiCr('2026-07-15', 'HARI K', 'HDFC', 'hari.k@okhdfc'), 10000, 0);
  add('2026-07-20', upiDr('2026-07-20', 'MEDPLUS PHARMACY', 'HDFC', 'medplus.clt@okaxis', 'Medicines'), 0, 412000);
  add('2026-07-25', upiCr('2026-07-25', 'HARI K', 'HDFC', 'hari.k@okhdfc'), 10000, 0);
  add('2026-08-01', upiDr('2026-08-01', 'Vi', 'YESB', 'vi.recharge@ptybl', 'Recharge'), 0, 29900);
  add('2026-08-05', upiCr('2026-08-05', 'ANITA MENON', 'FDRL', 'anita.m@okaxis'), 20000, 0);
  const reversed = t.at(-1)!.narration;
  add('2026-08-06', `UPI/REV/${bankRef(reversed)}/REVERSAL OF ANITA MENON CREDIT`, 0, 20000);
  add('2026-08-12', upiDr('2026-08-12', 'ANITA MENON', 'FDRL', 'anita.m@okaxis', 'Reimburse charity'), 0, 150000);
  add('2026-09-02', neft('BIJU THOMAS'), 240000, 0);
  add('2026-09-18', 'SBINT FOR THE PERIOD FROM28-JUN-26 TO 17-SEP-26', 21400, 0);
  add('2026-09-19', 'SMS charge Short collection JUN-SEP2026 Due Dt:19-SEP-26', 0, 1770);
  return t.sort((a, b) => a.date.localeCompare(b.date));
}

const OPENING = 8000000;

/** Fictional SAHHO records: members, 2.5 years of history, rules learned from that history. */
export function demoState(): State {
  const s = emptyState();
  s.demo = true;
  const start: Record<string, [string, string]> = {
    'ANITA MENON': ['2024-01', '2024-02'], 'BIJU THOMAS': ['2024-01', '2024-02'], 'DEVAN PILLAI': ['2024-01', '2024-02'],
    'GEETHA RAO': ['2024-01', '2024-02'], 'CHITRA NAIR': ['2024-03', '2024-04'], 'IQBAL SAIT': ['2024-03', '2024-04'],
    'JOSE PAUL': ['2024-03', '2024-04'], 'FARHAN ALI': ['2024-06', '2024-07'], 'HARI KRISHNAN': ['2025-03', '2025-04'],
  };
  for (const [name, [joiningMonth, first]] of Object.entries(start)) createMember(s, { name, joiningMonth, start: first });
  s.members.find(m => m.name === 'GEETHA RAO')!.inactiveFrom = '2025-07';
  s.members.find(m => m.name === 'DEVAN PILLAI')!.notes = 'Contributions are usually paid by his father (K PILLAI).';
  const kavya = createMember(s, { name: 'KAVYA R', notes: 'Old workbook shows ₹200 months from 2025-02 without a joining entry.' });
  kavya.suggestedStart = '2025-02';
  const batch: Batch = { id: id(), file: 'demo-history (fictional)', hash: 'demo', at: new Date().toISOString(), kind: 'demo', imported: 0, duplicates: 0, review: 0, reconciliation: { credits: 0, debits: 0, rowIssues: [] } };
  s.batches.push(batch);
  let balance = OPENING, order = 0;
  for (const tx of schedule().filter(x => x.history)) {
    balance += tx.credit - tx.debit;
    const r: Receipt = {
      id: id(), date: tx.date, valueDate: tx.date, narration: tx.narration, sender: senderOf(tx.narration), credit: tx.credit, debit: tx.debit,
      balance, reference: bankRef(tx.narration), batch: batch.id, order: order++, source: { file: batch.file, row: order + 1, raw: {} },
      category: tx.category ?? 'Unclassified', status: 'confirmed', reason: 'Demo history', candidates: [], historical: true,
    };
    s.receipts.push(r);
    if (tx.member) {
      const m = s.members.find(x => x.name === tx.member)!;
      const plan = planAllocation(s, r, m.id, { ignorePeriod: true });
      if (plan.problem) throw Error(`Demo data error: ${plan.problem}`);
      commitPlan(s, r, plan);
    }
  }
  // Workbook-only (legacy) allocations for KAVYA, and one cash payment with no bank receipt.
  for (const month of ['2025-02', '2025-03', '2025-04']) {
    s.allocations.push({ id: id(), memberId: kavya.id, month, amount: 20000, kind: 'regular', received: `${month}-10`, legacy: true, note: 'Paid in cash at meeting (demo)', source: { file: 'demo workbook', sheet: '2025', row: 12, cells: 'B12', raw: {} } });
  }
  s.issues.push({ id: id(), kind: 'Contribution start month', memberId: kavya.id, suggestion: '2025-02', resolved: false, reason: 'KAVYA R: the workbook has ₹200 allocations from 2025-02 but no joining contribution. Confirm the regular start month; no dues are generated until then.' });
  s.issues.push({ id: id(), kind: 'Unmatched historical allocation', memberId: kavya.id, resolved: false, reason: 'KAVYA R 2025-02 to 2025-04 (₹600): no matching bank receipt. Preserved as a legacy workbook record; no bank income added.' });
  const rows = s.receipts.filter(r => r.batch === batch.id);
  batch.imported = rows.length;
  batch.from = rows[0].date; batch.to = rows.at(-1)!.date;
  batch.reconciliation = reconcile(rows, OPENING);
  // Supplementary charity details (linked by exact date + amount)
  const charityRows = rows.filter(r => r.category === 'Charity expenditure');
  const beneficiaries = ['Medicines for a dialysis patient', 'Cancer care medicines', 'Diabetes medicines for an elderly person', 'Post-surgery support'];
  charityRows.forEach((r, i) => s.charity.push({ id: id(), date: r.date, amount: r.debit, description: beneficiaries[i % beneficiaries.length], beneficiary: `Beneficiary ${String.fromCharCode(65 + (i % 26))}`, referral: ['ANITA MENON', 'BIJU THOMAS', 'CHITRA NAIR'][i % 3], source: { file: 'demo charity sheet', sheet: 'Charity', row: i + 2, raw: {} }, receiptId: r.id }));
  s.charity.push({ id: id(), date: '2025-11-02', amount: 250000, description: 'School kits (recorded in charity sheet; paid in cash by a member)', beneficiary: 'Government LP School', referral: 'HARI KRISHNAN', source: { file: 'demo charity sheet', sheet: 'Charity', row: 40, raw: {} } });
  trainRules(s);
  audit(s, 'Demo data loaded', 'Fictional members and 2.5 years of fictional bank history.');
  return s;
}

/** A fictional Canara-style statement overlapping the demo history (for trying the import). */
export function demoStatementCSV() {
  const all = schedule();
  let balance = OPENING;
  const lines: string[] = [];
  let opening = 0, first = true;
  for (const tx of all) {
    if (tx.statement && first) { opening = balance; first = false; }
    balance += tx.credit - tx.debit;
    if (!tx.statement) continue;
    const [y, m, d] = tx.date.split('-');
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1];
    const chq = tx.narration.match(/UPI\/(?:CR|DR)\/(\d+)/)?.[1] ?? '';
    const amt = (p: number) => (p ? `="${(p / 100).toFixed(2)}"` : '');
    lines.push(`="${d}-${m}-${y} 10:15:00",="${d} ${mon} ${y}",="${chq}","${tx.narration}","1144",${amt(tx.debit)},${amt(tx.credit)},"${(balance / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}",`);
  }
  const fmt = (p: number) => `Rs.${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
  return [
    ',,Current & Saving Account Statement', '', 'SAHHO DEMO ACCOUNT (FICTIONAL)', '',
    'Account Holders Name,SAHHO DEMO', `Searched By,From ${STATEMENT_FROM} To 2026-09-20`, 'Account Currency,INR',
    `Opening Balance,"${fmt(opening)}"`, `Closing Balance,"${fmt(balance)}"`, '', '',
    'Txn Date,Value Date,Cheque No.,Description,Branch Code,Debit,Credit,Balance,',
    ...lines, '',
  ].join('\r\n');
}
