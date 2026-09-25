import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import 'fake-indexeddb/auto';
import { emptyState } from '../src/model';
import { amount, date, emptyMapping, parseCSV, parseRows, readStatement, stageStatement, tableFromRows } from '../src/importer';
import { explicitMonths, onRoster } from '../src/engine';
import { signals } from '../src/matching';
import { migrateWorkbook } from '../src/migration';
import { ConflictError, load, save, undoImport, undoPreview, upgrade, validate } from '../src/storage';
import { dashboard } from '../src/reports';
import { demoState, demoStatementCSV } from '../src/demo';

describe('parsing', () => {
  it('reads amounts as integer paise', () => {
    expect(amount('Rs.54,105.31')).toBe(5410531);
    expect(amount('="200.00"')).toBe(20000);
    expect(amount('1,00,000')).toBe(10000000);
    expect(amount('250.5 Dr')).toBe(-25050);
    expect(amount('(12.00)')).toBe(-1200);
    expect(amount('')).toBe(0);
    expect(amount('abc')).toBeUndefined();
    expect(amount(0.1 + 0.2)).toBe(30);
  });

  it('reads Indian and ISO date formats and rejects impossible dates', () => {
    expect(date('11-01-2026 06:00:10')).toBe('2026-01-11');
    expect(date('="11 Jan 2026"')).toBe('2026-01-11');
    expect(date('05/06/26')).toBe('2026-06-05');
    expect(date('2024-02-29')).toBe('2024-02-29');
    expect(date('31-02-2025')).toBeUndefined();
    expect(date(45658)).toBe('2025-01-01');
    expect(date('skip')).toBeUndefined();
  });

  it('parses the Canara layout: metadata above the header and ="..." wrappers', () => {
    const text = [',,Current & Saving Account Statement', '', 'Customer Id ,="124"', 'Opening Balance,"Rs.1,000.00"', 'Closing Balance,"Rs.1,150.00"', '',
      'Txn Date,Value Date,Cheque No.,Description,Branch Code,Debit,Credit,Balance,',
      '="28-03-2026 03:43:02",="27 Mar 2026",=" ","SBINT FOR THE PERIOD","1144",,="150.00","1,150.00",', ''].join('\r\n');
    const rows = parseCSV(text);
    expect(rows[2][1]).toBe('124');
    const t = tableFromRows(rows, emptyState());
    expect(t.known).toBe(true);
    expect(t.opening).toBe(100000);
    expect(t.closing).toBe(115000);
    const { receipts, invalid } = parseRows(t, 'x.csv', 'b');
    expect(invalid).toEqual([]);
    expect(receipts[0]).toMatchObject({ date: '2026-03-28', valueDate: '2026-03-27', credit: 15000, debit: 0, balance: 115000 });
  });

  it('handles an amount + Dr/Cr format, newest-first order, repeated headers, blank and invalid rows', () => {
    const rows = [
      ['Date', 'Narration', 'Amount', 'Dr/Cr', 'Balance'],
      ['03/01/2026', 'UPI/CR/1/A/B/**a@b/x', '100.00', 'CR', '300.00'],
      ['', '', '', '', ''],
      ['Date', 'Narration', 'Amount', 'Dr/Cr', 'Balance'],
      ['02/01/2026', 'ATM', '50.00', 'DR', '200.00'],
      ['99/99/2026', 'BAD', '1', 'CR', '1'],
      ['01/01/2026', 'OPENING', '250.00', 'CR', '250.00'],
    ];
    const t = tableFromRows(rows, emptyState());
    expect(t.known).toBe(false);
    const { receipts, invalid } = parseRows(t, 'x.xlsx', 'b');
    expect(receipts.map(r => [r.date, r.credit, r.debit])).toEqual([['2026-01-03', 10000, 0], ['2026-01-02', 0, 5000], ['2026-01-01', 25000, 0]]);
    expect(invalid).toHaveLength(1);
    const st = stageStatement(emptyState(), t, 'x.xlsx', 'h');
    expect(st.batch.reconciliation.rowIssues).toEqual([]);
    expect(st.state.mappings[t.signature]).toBeTruthy(); // mapping remembered for next time
  });

  it('requires a usable mapping for unfamiliar layouts', () => {
    const t = tableFromRows([['When', 'What', 'How much', 'x'], ['1/1/2026', 'a', '1', 'y']], emptyState());
    t.mapping = emptyMapping();
    expect(() => parseRows(t, 'x', 'b')).toThrow(/Map the date/);
  });

  it('extracts identity signals but ignores generic words', () => {
    expect(signals('UPI/CR/700000000001/RAVI K/HSBC/**12345@okaxis/Paid via//SMY/01/02/2026')).toEqual(['UPI:**12345@OKAXIS', 'SENDER:RAVI K']);
    expect(signals('NEFT Cr-SBIN700000000002-SBIN0001234-Mr  MANU  VARMA--/ATTN/')).toEqual(['SENDER:MANU VARMA']);
    expect(signals('UPI/CR/1/UPI/X/NA/Payment//')).toEqual([]);
  });

  it('reads explicit periods only when unambiguous', () => {
    expect(explicitMonths('UPI/CR/1/X/SBIN/**x@oksbi/sahho 2026//SBI/08/05/2026 12:00:00').months).toHaveLength(12);
    expect(explicitMonths('contribution March 2025').months).toEqual(['2025-03']);
    expect(explicitMonths('Jan to Mar 2025').months).toEqual(['2025-01', '2025-02', '2025-03']);
    expect(explicitMonths('UPI/CR/700000000003/MANU V/FDRL/**x@oksbi/Jan Feb //SBI').ambiguous).toBe(true);
    expect(explicitMonths('UPI/CR/1/A/B/**a@b/Paid via//X/02/01/2026 10:57:45')).toEqual({ ambiguous: false });
  });
});

/** Build a small fictional workbook shaped like the SAHHO workbook. */
function fictionalWorkbook() {
  const wb = XLSX.utils.book_new();
  const trx = XLSX.utils.aoa_to_sheet([
    ['Description', 'PAID BY/PAID FOR', 'Debit', 'Credit', 'Value Date', 'Balance', 'Type', 'Remarks'],
    ['UPI/CR/100000000001/ASHA K/SBIN/**asha@oksbi/x//', 'ASHA', '', 350, new Date(Date.UTC(2024, 0, 5)), 350, 'share', ''],
    ['UPI/CR/100000000002/RAVI/SBIN/**ravi@oksbi/x//', 'BENNY', '', 350, new Date(Date.UTC(2024, 0, 6)), 700, 'share', ''],
    ['UPI/CR/100000000003/ASHA K/SBIN/**asha@oksbi/x//', 'ASHA', '', 600, new Date(Date.UTC(2024, 1, 5)), 1300, 'share', ''],
    ['UPI/CR/100000000004/RAVI/SBIN/**ravi@oksbi/x//', 'BENNY', '', 200, new Date(Date.UTC(2024, 1, 6)), 1500, 'share', ''],
    ['UPI/DR/100000000005/PHARMA/SBIN/**ph@okaxis/x//', 'CHARITY', 1000, '', new Date(Date.UTC(2024, 1, 20)), 500, 'charity', 'Medicine for X'],
    ['SBINT FOR THE PERIOD', 'INTEREST', '', 12.5, new Date(Date.UTC(2024, 2, 28)), 512.5, 'interest credit', ''],
  ], { cellDates: true });
  XLSX.utils.book_append_sheet(wb, trx, '2024_Trxns');
  const month = XLSX.utils.aoa_to_sheet([
    ['NAME', 2024],
    ['', 'January', '', '', 'February', '', '', 'March', '', '', 'April', '', '', '', 'NAME', 'JAN'],
    ['', 'Share', 'Paid on', 'Note', 'Share', 'Paid on', 'Note'],
    ['ASHA', 350, new Date(Date.UTC(2024, 0, 5)), '', 200, new Date(Date.UTC(2024, 1, 5)), '200/600(1)', 200, new Date(Date.UTC(2024, 1, 5)), '200/600(2)', 200, new Date(Date.UTC(2024, 1, 5)), '', '', 'ASHA', 350],
    ['BENNY (paid by Ravi)', 350, new Date(Date.UTC(2024, 0, 6)), 'Ravi', 200, new Date(Date.UTC(2024, 1, 6)), '', 200, new Date(Date.UTC(2024, 3, 1)), 'cash'],
    ['CHARU', 200, '05 Mar 2024', ''],
    ['TOTAL', 750],
  ], { cellDates: true });
  // Summary copy to the right is formula-based and must never become payments.
  month['P4'] = { t: 'n', v: 350, f: 'B4' };
  XLSX.utils.book_append_sheet(wb, month, '2024');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Tags'], ['', 'ASHA'], ['', 'BENNY'], ['', 'CHARITY'], ['', 'INTEREST']]), 'TAGS');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['SL No', 'Date', 'Beneficiary Details', 'Remarks', 'Amount Paid', 'Suggested By'], [1, new Date(Date.UTC(2024, 1, 20)), 'Mr X', 'Medicines', 1000, 'ASHA']], { cellDates: true }), 'Charity New');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Summary'], ['Share Collected', 1500]]), 'Consolidated Details of Credits');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

describe('workbook migration (fictional workbook)', () => {
  const s = migrateWorkbook(emptyState(), fictionalWorkbook(), 'fictional.xlsx', 'hash');
  const m = (n: string) => s.members.find(x => x.name === n)!;

  it('1. imports members, receipts and month allocations without counting any receipt twice', () => {
    validate(s);
    expect(s.members.map(x => x.name).sort()).toEqual(['ASHA', 'BENNY', 'CHARU']);
    expect(m('BENNY').notes).toMatch(/paid by Ravi/);
    expect(s.receipts).toHaveLength(6);
    const d = dashboard(s, '2024-12-31');
    expect(d.credits).toBe(151250);
    expect(d.bankBalance).toBe(51250);
    // Formula copy (P4) and TOTAL row are ignored; the 7 real cells are preserved.
    expect(s.allocations).toHaveLength(8);
    expect(s.archives.find(a => a.name === '2024')!.cells.P4.formula).toBe('B4');
  });

  it('preserves joining ₹350 whole with the joining date separate from the start month', () => {
    expect(m('ASHA')).toMatchObject({ joiningMonth: '2024-01', joined: '2024-01-05', start: '2024-02' });
    const joining = s.allocations.filter(a => a.kind === 'joining');
    expect(joining.map(a => a.amount)).toEqual([35000, 35000]);
  });

  it('links a ₹600 receipt to the three months recorded against it, keeping workbook months', () => {
    const r = s.receipts.find(x => x.credit === 60000)!;
    expect(s.allocations.filter(a => a.receiptId === r.id).map(a => a.month).sort()).toEqual(['2024-02', '2024-03', '2024-04']);
  });

  it('keeps unmatched allocations as legacy records, never as bank income', () => {
    const legacy = s.allocations.filter(a => !a.receiptId);
    expect(legacy.map(a => [s.members.find(x => x.id === a.memberId)!.name, a.month])).toEqual(expect.arrayContaining([['BENNY', '2024-03'], ['CHARU', '2024-01']]));
    expect(s.issues.filter(i => i.kind === 'Unmatched historical allocation')).toHaveLength(2);
    expect(dashboard(s, '2024-12-31').credits).toBe(151250); // unchanged by legacy allocations
  });

  it('asks for a start month instead of inventing one', () => {
    expect(m('CHARU').start).toBeUndefined();
    expect(m('CHARU').suggestedStart).toBe('2024-01');
    expect(s.issues.some(i => i.kind === 'Contribution start month' && i.memberId === m('CHARU').id)).toBe(true);
    expect(s.issues.some(i => i.kind === 'Name only in monthly sheet' && i.memberId === m('CHARU').id)).toBe(true);
  });

  it('classifies categories, links supplementary charity to the bank payment, and learns rules', () => {
    expect(s.receipts.find(r => r.debit === 100000)!.category).toBe('Charity expenditure');
    expect(s.receipts.find(r => r.credit === 1250)!.category).toBe('Bank interest');
    expect(s.charity[0].receiptId).toBe(s.receipts.find(r => r.debit === 100000)!.id);
    const rule = s.rules.find(r => r.token === 'UPI:**RAVI@OKSBI')!;
    expect(rule.memberId).toBe(m('BENNY').id); // third-party payer RAVI → BENNY
    expect(rule.validated).toBe(true);
  });

  it('refuses to migrate twice or into a non-empty register', () => {
    expect(() => migrateWorkbook(s, fictionalWorkbook(), 'fictional.xlsx', 'hash')).toThrow(/already/);
    expect(() => migrateWorkbook(demoState(), fictionalWorkbook(), 'f.xlsx', 'other')).toThrow(/empty register/);
  });
});

/** Year sheets whose member lists change: DAVE leaves after 2023, ELLA joins in 2024. */
function rosterWorkbook() {
  const wb = XLSX.utils.book_new();
  const sheet = (year: number, rows: unknown[][]) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['NAME', year], ['', 'January', '', '', 'February'], ['', 'Share', 'Paid on', 'Note', 'Share'], ...rows, [], ['INTEREST'], ['TOTAL'], ['CUMULATIVE TOTAL'],
  ]), String(year));
  sheet(2023, [['ASHA', 350, '', '', 200], ['DAVE (left)', 350, '', '', 200]]);
  sheet(2024, [['ASHA', 200], ['ELLA', 350, '', '', 200]]);
  sheet(2025, [['ASHA'], ['ELLA (200-2025)']]);
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

describe('year-sheet rosters', () => {
  const s = migrateWorkbook(emptyState(), rosterWorkbook(), 'roster.xlsx', 'roster');
  const m = (n: string) => s.members.find(x => x.name === n)!;
  const listed = (year: number) => s.members.filter(x => onRoster(s, x, year)).map(x => x.name).sort();

  it('records the years each member is listed and marks members dropped from later sheets inactive', () => {
    validate(s);
    expect(s.members.map(x => x.name).sort()).toEqual(['ASHA', 'DAVE', 'ELLA']);
    expect(m('ASHA').rosterYears).toEqual([2023, 2024, 2025]);
    expect(m('DAVE').rosterYears).toEqual([2023]);
    expect(m('ELLA').rosterYears).toEqual([2024, 2025]);
    expect(m('DAVE').inactiveFrom).toBe('2024-01');
    expect(m('ASHA').inactiveFrom).toBeUndefined();
    expect(s.issues.some(i => i.kind === 'Left the register' && i.memberId === m('DAVE').id)).toBe(true);
  });

  it('lists only the members of each year sheet, and carries the last roster forward', () => {
    expect(listed(2023)).toEqual(['ASHA', 'DAVE']);
    expect(listed(2024)).toEqual(['ASHA', 'ELLA']);
    expect(listed(2025)).toEqual(['ASHA', 'ELLA']);
    expect(listed(2026)).toEqual(['ASHA', 'ELLA']);
    expect(listed(2022)).toEqual([]);
  });

  it('recovers rosters from the archived sheets for registers migrated earlier', () => {
    const old = structuredClone(s);
    for (const x of old.members) delete x.rosterYears;
    const up = upgrade(old);
    expect(up.members.find(x => x.name === 'DAVE')!.rosterYears).toEqual([2023]);
    expect(up.members.find(x => x.name === 'ELLA')!.rosterYears).toEqual([2024, 2025]);
  });
});

describe('storage', () => {
  it('saves atomically and refuses stale writes from another tab', async () => {
    const first = await load();
    const saved = await save(demoState(), first.revision);
    expect(saved.revision).toBe(first.revision + 1);
    await expect(save(demoState(), first.revision)).rejects.toBeInstanceOf(ConflictError);
    const reloaded = await load();
    expect(reloaded.members.length).toBe(saved.members.length);
  });

  it('undo import restores the previous records and lists later edits first', () => {
    const base = demoState();
    const text = demoStatementCSV();
    const t = readStatement(new TextEncoder().encode(text).buffer as ArrayBuffer, 'd.csv', base);
    const st = stageStatement(base, t, 'd.csv', 'h1').state;
    st.audit.push({ id: 'later', at: 'x', action: 'Review approved', detail: 'later edit' });
    expect(undoPreview(st)!.laterEdits).toHaveLength(1);
    expect(() => undoImport(st)).toThrow(/later change/);
    const back = undoImport(st, true);
    expect(back.receipts).toHaveLength(base.receipts.length);
    expect(back.batches.at(-1)!.undone).toBe(true);
    expect(back.audit.some(a => a.action === 'Import undone')).toBe(true);
  });

  it('rejects invalid money values', () => {
    const s = demoState();
    s.receipts[0].credit = 1.5;
    expect(() => validate(s)).toThrow();
  });
});
