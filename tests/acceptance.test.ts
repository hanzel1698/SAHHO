// Acceptance scenarios from the specification, on fictional data.
import { describe, expect, it } from 'vitest';
import { State } from '../src/model';
import { decide, due, linkReversal, paid, planAllocation } from '../src/engine';
import { Ledger, countedRows, dashboard, memberStatement, receivedByReceiptMonth } from '../src/reports';
import { backupText, parseBackup, validate } from '../src/storage';
import { demoState, demoStatementCSV } from '../src/demo';
import { csv, fixture, importCSV, row, rupees, upi } from './helpers';

const member = (s: State, name: string) => s.members.find(m => m.name === name)!;
const allocs = (s: State, receiptId: string) => s.allocations.filter(a => a.receiptId === receiptId).map(a => [a.month, a.amount, a.kind]);

describe('contribution rules', () => {
  it('2. keeps the initial ₹350 as one joining contribution (never 200 + 150 or 1.75 months)', () => {
    const s = fixture();
    const asha = member(s, 'ASHA');
    const joining = s.allocations.filter(a => a.memberId === asha.id && a.kind === 'joining');
    expect(joining).toHaveLength(1);
    expect(joining[0]).toMatchObject({ amount: 35000, month: '2025-01' });
    expect(asha.joined).toBe('2025-01-05');
    expect(asha.start).toBe('2025-02');
    expect(paid(s, asha.id, '2025-01')).toBe(0); // no regular credit carried from the ₹350
  });

  it('2b. a later ₹350 is not another joining payment', () => {
    const s = fixture();
    const st = importCSV(s, csv([row('05-06-2025', '05 Jun 2025', '600000000001', upi('600000000001', 'ASHA K', 'asha.k@oksbi'), '', '350.00', '10,350.00')]));
    const r = st.auto[0];
    expect(r.category).toBe('Member contribution');
    expect(allocs(st.state, r.id)).toEqual([['2025-03', 20000, 'regular'], ['2025-04', 15000, 'regular']]);
  });

  it('3/9. applies ₹200s to oldest unpaid months, completes partial months, then advances', () => {
    const s = fixture();
    const text = csv([
      row('01-06-2025', '01 Jun 2025', '600000000002', upi('600000000002', 'ASHA K', 'asha.k@oksbi'), '', '200.00', '10,200.00'),
      row('02-06-2025', '02 Jun 2025', '600000000003', upi('600000000003', 'ASHA K', 'asha.k@oksbi'), '', '100.00', '10,300.00'),
      row('03-06-2025', '03 Jun 2025', '600000000004', upi('600000000004', 'ASHA K', 'asha.k@oksbi'), '', '100.00', '10,400.00'),
      row('04-06-2025', '04 Jun 2025', '600000000005', upi('600000000005', 'ASHA K', 'asha.k@oksbi'), '', '1,000.00', '11,400.00'),
    ]);
    const st = importCSV(s, text);
    expect(st.auto).toHaveLength(4);
    const [a, b, c, d] = st.auto;
    expect(allocs(st.state, a.id)).toEqual([['2025-03', 20000, 'regular']]);
    expect(allocs(st.state, b.id)).toEqual([['2025-04', 10000, 'regular']]);
    expect(allocs(st.state, c.id)).toEqual([['2025-04', 10000, 'regular']]); // two ₹100 settle one month
    expect(allocs(st.state, d.id).map(x => x[0])).toEqual(['2025-05', '2025-06', '2025-07', '2025-08', '2025-09']);
    const ledger = new Ledger(st.state, '2025-06-30');
    const sum = ledger.summary(member(st.state, 'ASHA'));
    expect(sum.outstanding).toBe(0);
    expect(sum.advance).toBe(rupees(600)); // Jul–Sep paid ahead (June due on the 28th, so it is not advance)
    expect(ledger.cell(member(st.state, 'ASHA'), '2025-08').status).toBe('advance');
  });

  it('4. never creates dues before the confirmed start month, or when no start month is confirmed', () => {
    const s = fixture();
    const asha = member(s, 'ASHA');
    expect(due(s, asha, '2025-01')).toBe(0);
    expect(due(s, asha, '2024-12')).toBe(0);
    expect(due(s, asha, '2025-02')).toBe(20000);
    asha.start = undefined;
    expect(new Ledger(s, '2026-01-31').summary(asha).outstanding).toBe(0);
  });

  it('8. allocates ₹1,200 across six eligible months', () => {
    const s = fixture();
    const st = importCSV(s, csv([row('10-09-2025', '10 Sep 2025', '600000000006', upi('600000000006', 'ASHA K', 'asha.k@oksbi'), '', '1,200.00', '11,200.00')]));
    expect(allocs(st.state, st.auto[0].id)).toEqual(['2025-03', '2025-04', '2025-05', '2025-06', '2025-07', '2025-08'].map(m => [m, 20000, 'regular']));
  });

  it('marks the parts of one split receipt as a group in the member statement', () => {
    const s = fixture();
    const st = importCSV(s, csv([row('10-09-2025', '10 Sep 2025', '600000000009', upi('600000000009', 'ASHA K', 'asha.k@oksbi'), '', '1,200.00', '11,200.00')]));
    const asha = st.state.members.find(m => m.name === 'ASHA')!;
    const t = memberStatement(st.state, asha.id, '2026-01-31');
    const col = t.columns.indexOf('Split payment');
    const parts = t.rows.filter(r => r[3] === '2025-09-10');
    expect(parts).toHaveLength(6);
    const n = t.groups![t.rows.indexOf(parts[0])]!;
    expect(parts.map(r => t.groups![t.rows.indexOf(r)])).toEqual(Array(6).fill(n));
    expect(parts[0][col]).toBe(`#${n} · part 1 of 6 · 1200.00 total`);
    expect(parts[5][col]).toBe(`#${n} · part 6 of 6 · 1200.00 total`);
    expect(new Set(t.groups!.filter(Boolean)).size).toBe(Math.max(...t.groups!.map(g => g ?? 0)));
  });

  it('respects rate changes by effective month and never over-allocates a receipt', () => {
    const s = fixture();
    s.settings.rates.push({ from: '2025-05', amount: 25000 });
    const st = importCSV(s, csv([row('10-09-2025', '10 Sep 2025', '600000000007', upi('600000000007', 'ASHA K', 'asha.k@oksbi'), '', '1,000.00', '11,000.00')]));
    expect(allocs(st.state, st.auto[0].id)).toEqual([['2025-03', 20000, 'regular'], ['2025-04', 20000, 'regular'], ['2025-05', 25000, 'regular'], ['2025-06', 25000, 'regular'], ['2025-07', 10000, 'regular']]);
    expect(() => planAllocation(st.state, st.auto[0], member(s, 'ASHA').id, { amount: 1 })).not.toThrow();
    expect(planAllocation(st.state, st.auto[0], member(s, 'ASHA').id, { amount: 1 }).problem).toMatch(/exceeds/);
  });
});

describe('statement import', () => {
  const statement = () => csv([
    row('01-07-2025', '01 Jul 2025', '600000000010', upi('600000000010', 'ASHA K', 'asha.k@oksbi'), '', '200.00', '10,200.00'),
    row('02-07-2025', '02 Jul 2025', '', 'NEFT Cr-SBIN600000000011-SBIN0001-FATHER OF BENNY--/ATTN/', '', '400.00', '10,600.00'),
    row('03-07-2025', '03 Jul 2025', '600000000012', upi('600000000012', 'UNCLE SAM', 'uncle.sam@okaxis'), '', '200.00', '10,800.00'),
    row('28-07-2025', '27 Jul 2025', ' ', 'SBINT FOR THE PERIOD FROM28-APR-25 TO 27-JUL-25', '', '85.00', '10,885.00'),
    row('29-07-2025', '29 Jul 2025', ' ', 'SMS charge Short collection APR-JUL2025', '17.70', '', '10,867.30'),
    row('30-07-2025', '30 Jul 2025', '600000000013', upi('600000000013', 'CITY PHARMA', 'citypharma@okhdfc', 'Medicines', 'DR'), '1,200.00', '', '9,667.30'),
  ], 'Rs.10,000.00', 'Rs.9,667.30');

  it('5/10/13. processes familiar transactions automatically, including a confirmed third-party payer and categories', () => {
    const st = importCSV(fixture(), statement());
    expect(st.batch.reconciliation.difference).toBe(0);
    const by = (text: string) => [...st.auto, ...st.review].find(r => r.narration.includes(text))!;
    expect(by('ASHA K').status).toBe('confirmed');
    expect(by('FATHER OF BENNY')).toMatchObject({ status: 'confirmed', memberId: member(st.state, 'BENNY').id }); // third party
    expect(by('FATHER OF BENNY').sender).toBe('FATHER OF BENNY'); // sender kept separate from member
    expect(by('SBINT')).toMatchObject({ category: 'Bank interest', status: 'confirmed' });
    expect(by('SMS charge')).toMatchObject({ category: 'Bank charges', status: 'confirmed' });
    expect(by('CITY PHARMA')).toMatchObject({ category: 'Charity expenditure', status: 'confirmed' });
  });

  it('11/12. sends an ambiguous third-party payment to review, and a correction updates reports', () => {
    const st = importCSV(fixture(), statement());
    const amb = st.review.find(r => r.narration.includes('UNCLE SAM'))!;
    expect(amb.reason).toMatch(/Ambiguous third-party/);
    expect(amb.candidates.sort()).toEqual([member(st.state, 'CHARU').id, member(st.state, 'DILEEP').id].sort());
    const s = st.state;
    const before = dashboard(s, '2025-12-31');
    const charu = member(s, 'CHARU');
    decide(s, amb.id, { memberId: charu.id, category: 'Member contribution' });
    const after = dashboard(s, '2025-12-31');
    expect(after.regular - before.regular).toBe(20000);
    expect(new Ledger(s, '2025-12-31').cell(charu, '2025-02').status).toBe('paid');
    // Correct it again to DILEEP: CHARU's month is released, DILEEP's is paid.
    const dileep = member(s, 'DILEEP');
    decide(s, amb.id, { memberId: dileep.id, category: 'Member contribution' });
    const l = new Ledger(s, '2025-12-31');
    expect(l.cell(charu, '2025-02').status).toBe('unpaid');
    expect(l.cell(dileep, '2025-02').status).toBe('paid');
    expect(s.audit.some(a => a.action === 'Transaction corrected')).toBe(true);
    validate(s);
  });

  it('6. importing the same statement again changes nothing', () => {
    const st = importCSV(fixture(), statement());
    expect(() => importCSV(st.state, statement())).toThrow(/already been imported/);
    // Same rows saved as a different file (different hash): every row is recognised and skipped.
    const again = importCSV(st.state, statement() + '\r\n', 'renamed.csv');
    expect(again.batch.imported).toBe(0);
    expect(again.skipped).toHaveLength(6);
    expect(dashboard(again.state, '2025-12-31').credits).toBe(dashboard(st.state, '2025-12-31').credits);
  });

  it('7. keeps genuine same-day, same-amount payments in an overlapping statement', () => {
    const first = importCSV(fixture(), csv([row('01-07-2025', '01 Jul 2025', '600000000020', upi('600000000020', 'ASHA K', 'asha.k@oksbi'), '', '200.00', '10,200.00')]));
    const overlapping = csv([
      row('01-07-2025', '01 Jul 2025', '600000000020', upi('600000000020', 'ASHA K', 'asha.k@oksbi'), '', '200.00', '10,200.00'),
      row('01-07-2025', '01 Jul 2025', '600000000021', upi('600000000021', 'ASHA K', 'asha.k@oksbi'), '', '200.00', '10,400.00'),
      row('02-07-2025', '02 Jul 2025', '', 'BY CASH DEPOSIT', '', '500.00', '10,900.00'),
      row('02-07-2025', '02 Jul 2025', '', 'BY CASH DEPOSIT', '', '500.00', '11,400.00'),
    ], 'Rs.10,000.00', 'Rs.11,400.00');
    const st = importCSV(first.state, overlapping, 'overlap.csv');
    expect(st.skipped).toHaveLength(1);
    expect(st.batch.imported).toBe(3);
    expect(st.batch.reconciliation.difference).toBe(0);
    // Importing the overlap again (renamed): the two identical cash rows each match their own record.
    const third = importCSV(st.state, overlapping + '\r\n', 'overlap-again.csv');
    expect(third.skipped).toHaveLength(4);
    expect(third.batch.imported).toBe(0);
  });

  it('uncertain duplicate candidates do not inflate totals', () => {
    const first = importCSV(fixture(), csv([row('02-07-2025', '02 Jul 2025', '', 'BY CASH DEPOSIT', '', '500.00', '')]));
    const st = importCSV(first.state, csv([row('02-07-2025', '02 Jul 2025', '', 'BY CASH DEPOSIT', '', '500.00', '')]), 'second.csv');
    expect(st.review[0].duplicateOf).toBeTruthy();
    expect(countedRows(st.state).filter(r => r.narration === 'BY CASH DEPOSIT')).toHaveLength(1);
  });

  it('14. a confirmed reversal removes the contribution credit but keeps both records', () => {
    const st = importCSV(fixture(), csv([
      row('01-07-2025', '01 Jul 2025', '600000000030', upi('600000000030', 'ASHA K', 'asha.k@oksbi'), '', '200.00', '10,200.00'),
      row('03-07-2025', '03 Jul 2025', '', 'UPI/REV/600000000030/REVERSAL', '200.00', '', '10,000.00'),
    ]));
    const s = st.state;
    const original = st.auto[0], rev = st.review[0];
    expect(rev.category).toBe('Refund / reversal');
    expect(rev.candidates).toContain(original.id);
    const asha = member(s, 'ASHA');
    expect(new Ledger(s, '2025-07-02').cell(asha, '2025-03').status).toBe('paid');
    linkReversal(s, rev.id, original.id);
    expect(new Ledger(s, '2025-07-02').cell(asha, '2025-03').status).toBe('paid'); // history before the reversal date
    expect(new Ledger(s, '2025-07-31').cell(asha, '2025-03').status).toBe('unpaid');
    expect(s.receipts.filter(r => r.id === original.id || r.id === rev.id)).toHaveLength(2);
    const byMonth = receivedByReceiptMonth(s, '2025-12-31').rows.find(r => r[0] === '2025-07')!;
    expect(byMonth[4]).toBe('0.00');
  });

  it('historical as-of reports exclude payments received after the cutoff', () => {
    const st = importCSV(fixture(), csv([row('10-09-2025', '10 Sep 2025', '600000000040', upi('600000000040', 'ASHA K', 'asha.k@oksbi'), '', '1,200.00', '11,200.00')]));
    const asha = member(st.state, 'ASHA');
    expect(new Ledger(st.state, '2025-08-31').summary(asha).outstanding).toBe(rupees(1200)); // Mar–Aug unpaid as of Aug 31
    expect(new Ledger(st.state, '2025-09-30').summary(asha).outstanding).toBe(rupees(200)); // Sep due on 28th
  });
});

describe('demo data and backups', () => {
  it('demo statement imports cleanly and reconciles', () => {
    const st = importCSV(demoState(), demoStatementCSV(), 'demo.csv');
    expect(st.batch.reconciliation.difference).toBe(0);
    expect(st.batch.reconciliation.rowIssues).toEqual([]);
    expect(st.skipped.length).toBeGreaterThan(0);
    expect(st.auto.length).toBeGreaterThan(5);
    expect(st.review.length).toBeGreaterThan(2);
    validate(st.state);
  });

  it('15. export and restore keeps records, rules, allocations and audit history', () => {
    const st = importCSV(demoState(), demoStatementCSV(), 'demo.csv');
    const restored = parseBackup(backupText(st.state));
    for (const k of ['members', 'receipts', 'allocations', 'rules', 'issues', 'audit', 'charity'] as const) expect(restored[k]).toEqual(st.state[k]);
    expect(restored.settings).toEqual(st.state.settings);
  });

  it('refuses a tampered backup that over-allocates a receipt', () => {
    const s = demoState();
    const envelope = JSON.parse(backupText(s));
    const a = envelope.data.allocations.find((x: { receiptId?: string }) => x.receiptId);
    a.amount += 100;
    expect(() => parseBackup(JSON.stringify(envelope))).toThrow(/exceed/);
    expect(() => parseBackup('{"application":"OTHER"}')).toThrow(/not a supported/);
  });
});

describe('reversal matching', () => {
  it('prefers the original whose bank reference appears in the reversal over an earlier same-amount credit', async () => {
    const { referencedOriginals, reversalCandidates } = await import('../src/engine');
    const st = importCSV(fixture(), csv([
      row('01-06-2025', '01 Jun 2025', '600000000050', upi('600000000050', 'ASHA K', 'asha.k@oksbi'), '', '200.00', '10,200.00'),
      row('01-07-2025', '01 Jul 2025', '', 'NEFT Cr-SBIN600000000051-SBIN0001-FATHER OF BENNY--/ATTN/', '', '200.00', '10,400.00'),
      row('03-07-2025', '03 Jul 2025', '', 'UPI/REV/SBIN600000000051/RETURNED', '200.00', '', '10,200.00'),
    ]));
    const rev = st.review.find(r => r.category === 'Refund / reversal')!;
    const benny = st.auto.find(r => r.narration.includes('BENNY'))!;
    expect(reversalCandidates(st.state, rev)[0].id).toBe(benny.id);
    expect(referencedOriginals(st.state, rev).map(r => r.id)).toEqual([benny.id]);
    expect(rev.reason).toMatch(/same bank reference/);
  });
});
