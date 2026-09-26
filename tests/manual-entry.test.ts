// Manual entries: typed in before the bank shows them, reconciled by a later statement import.
import { describe, expect, it } from 'vitest';
import { State, awaitingBank } from '../src/model';
import { addManualReceipt, deleteManualReceipt, paid } from '../src/engine';
import { MANUAL_MISSING } from '../src/importer';
import { undoImport, validate } from '../src/storage';
import { csv, fixture, importCSV, row, rupees, upi } from './helpers';

const member = (s: State, name: string) => s.members.find(m => m.name === name)!;

function cashFromAsha(s: State, date = '2025-06-02', extra: { reference?: string; amount?: number } = {}) {
  return addManualReceipt(s, {
    date, narration: 'Cash deposit by Asha', credit: rupees(extra.amount ?? 200), debit: 0, reference: extra.reference,
    decision: { category: 'Member contribution', memberId: member(s, 'ASHA').id },
  });
}

describe('manual entries', () => {
  it('counts a manual entry straight away and marks it as awaiting the bank', () => {
    const s = fixture();
    const r = cashFromAsha(s);
    expect(r.status).toBe('confirmed');
    expect(awaitingBank(r)).toBe(true);
    expect(paid(s, member(s, 'ASHA').id, '2025-03')).toBe(rupees(200));
    validate(s);
  });

  it('reconciles with the matching statement row: bank narration copied, no second record', () => {
    const s = fixture();
    const r = cashFromAsha(s);
    const allocations = s.allocations.filter(a => a.receiptId === r.id).map(a => [a.month, a.amount]);
    const narration = 'BY CASH DEPOSIT-ASHA K-MUVATTUPUZHA';
    const st = importCSV(s, csv([row('04-06-2025', '04 Jun 2025', '', narration, '', '200.00', '10,200.00')]));
    expect(st.matched).toHaveLength(1);
    expect(st.auto).toHaveLength(0);
    expect(st.review).toHaveLength(0);
    const after = st.state.receipts.find(x => x.id === r.id)!;
    expect(after).toMatchObject({ narration, date: '2025-06-04', balance: rupees(10200), status: 'confirmed', memberId: member(s, 'ASHA').id });
    expect(after.manual).toMatchObject({ narration: 'Cash deposit by Asha', date: '2025-06-02' });
    expect(after.manual?.matched?.batch).toBe(st.batch.id);
    expect(awaitingBank(after)).toBe(false);
    expect(st.state.receipts.filter(x => x.credit === rupees(200) && x.date >= '2025-06-01')).toHaveLength(1);
    expect(st.state.allocations.filter(a => a.receiptId === r.id).map(a => [a.month, a.amount])).toEqual(allocations);
    expect(st.state.allocations.filter(a => a.receiptId === r.id).every(a => a.received === '2025-06-04')).toBe(true);
    validate(st.state);
    // A later import of an overlapping statement sees it as already recorded.
    const again = importCSV(st.state, csv([row('04-06-2025', '04 Jun 2025', '', narration, '', '200.00', '10,200.00')]), 'overlap.csv');
    expect(again.skipped).toHaveLength(1);
    expect(again.matched).toHaveLength(0);
  });

  it('does not match a different amount, direction, or a date outside the window', () => {
    const s = fixture();
    cashFromAsha(s);
    const st = importCSV(s, csv([
      row('04-06-2025', '04 Jun 2025', '', 'BY CASH 250', '', '250.00', '10,250.00'),
      row('05-06-2025', '05 Jun 2025', '', 'TO CASH 200', '200.00', '', '10,050.00'),
      row('20-06-2025', '20 Jun 2025', '', 'BY CASH 200', '', '200.00', '10,250.00'),
    ]));
    expect(st.matched).toHaveLength(0);
    expect(st.state.receipts.filter(awaitingBank)).toHaveLength(1);
  });

  it('requires the reference the treasurer typed, and prefers the member the bank row points to', () => {
    const s = fixture();
    const withRef = cashFromAsha(s, '2025-06-02', { reference: '600000000099' });
    const other = importCSV(s, csv([row('03-06-2025', '03 Jun 2025', '600000000011', upi('600000000011', 'ASHA K', 'asha.k@oksbi'), '', '200.00', '10,200.00')]));
    expect(other.matched).toHaveLength(0);
    const same = importCSV(s, csv([row('03-06-2025', '03 Jun 2025', '600000000099', upi('600000000099', 'ASHA K', 'asha.k@oksbi'), '', '200.00', '10,200.00')]), 'b.csv');
    expect(same.matched.map(x => x.entry.id)).toEqual([withRef.id]);

    const t = fixture();
    const benny = addManualReceipt(t, { date: '2025-06-02', narration: 'Cash for Benny', credit: rupees(200), debit: 0, decision: { category: 'Member contribution', memberId: member(t, 'BENNY').id } });
    const asha = cashFromAsha(t, '2025-06-02');
    const st = importCSV(t, csv([row('03-06-2025', '03 Jun 2025', '600000000012', upi('600000000012', 'ASHA K', 'asha.k@oksbi'), '', '200.00', '10,200.00')]));
    expect(st.matched.map(x => x.entry.id)).toEqual([asha.id]);
    expect(st.state.receipts.find(x => x.id === benny.id)!.manual?.matched).toBeUndefined();
  });

  it('flags a manual entry the statement should have shown but did not', () => {
    const s = fixture();
    const r = cashFromAsha(s, '2025-06-02');
    const st = importCSV(s, csv([
      row('01-06-2025', '01 Jun 2025', '', 'BY CASH 500', '', '500.00', '10,500.00'),
      row('30-06-2025', '30 Jun 2025', '', 'BY CASH 100', '', '100.00', '10,600.00'),
    ]));
    const issue = st.state.issues.find(i => i.kind === MANUAL_MISSING);
    expect(issue).toMatchObject({ receiptId: r.id, resolved: false });
  });

  it('undoing the import puts the manual entry back as awaiting the bank', () => {
    const s = fixture();
    const r = cashFromAsha(s);
    const st = importCSV(s, csv([row('04-06-2025', '04 Jun 2025', '', 'BY CASH DEPOSIT', '', '200.00', '10,200.00')]));
    const back = undoImport(st.state);
    const restored = back.receipts.find(x => x.id === r.id)!;
    expect(restored.narration).toBe('Cash deposit by Asha');
    expect(awaitingBank(restored)).toBe(true);
    expect(back.allocations.some(a => a.receiptId === r.id)).toBe(true);
  });

  it('deletes an unmatched manual entry with its allocations, but not a reconciled one', () => {
    const s = fixture();
    const r = cashFromAsha(s);
    deleteManualReceipt(s, r.id);
    expect(s.receipts.some(x => x.id === r.id)).toBe(false);
    expect(s.allocations.some(a => a.receiptId === r.id)).toBe(false);
    validate(s);

    const t = fixture();
    const m = cashFromAsha(t);
    const st = importCSV(t, csv([row('04-06-2025', '04 Jun 2025', '', 'BY CASH DEPOSIT', '', '200.00', '10,200.00')]));
    expect(() => deleteManualReceipt(st.state, m.id)).toThrow(/already matched/);
  });

  it('records a manual debit with its category', () => {
    const s = fixture();
    const r = addManualReceipt(s, { date: '2025-06-10', narration: 'Hospital bill paid by cheque', credit: 0, debit: rupees(1200), reference: '004512', decision: { category: 'Charity expenditure' } });
    expect(r).toMatchObject({ status: 'confirmed', category: 'Charity expenditure' });
    const st = importCSV(s, csv([row('12-06-2025', '12 Jun 2025', '004512', 'CHQ PAID-004512-CITY HOSPITAL', '1,200.00', '', '8,800.00')]));
    expect(st.matched).toHaveLength(1);
    expect(st.state.receipts.find(x => x.id === r.id)).toMatchObject({ narration: 'CHQ PAID-004512-CITY HOSPITAL', category: 'Charity expenditure', reference: '004512' });
  });
});
