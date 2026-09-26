// Read-only calculations for dashboard, grid and reports. Independent of UI components.
import { Allocation, Category, Member, Receipt, State, categories, contributionCategories } from './model';
import { LATEST, addMonth, allocationActive, due, lastDueMonth, months, monthOf } from './engine';
import { balanceBreaks } from './importer';

/** Rows counted as real bank movements: excludes confirmed duplicates and unresolved duplicate candidates. */
export function countedRows(s: State, cutoff = LATEST) {
  return s.receipts.filter(r => r.status !== 'duplicate' && !(r.status === 'review' && r.duplicateOf) && r.date <= cutoff);
}

export function sortRows(rows: Receipt[], s: State) {
  const batchOrder = new Map(s.batches.map((b, i) => [b.id, i]));
  return [...rows].sort((a, b) => a.date.localeCompare(b.date) || (batchOrder.get(a.batch) ?? 0) - (batchOrder.get(b.batch) ?? 0) || a.order - b.order);
}

export interface MemberSummary {
  member: Member;
  outstanding: number;
  advance: number;
  unapplied: number;
  total: number;
  joiningPaid: boolean;
  joiningDate?: string;
  last?: string;
  unpaid: string[];
  partial: string[];
  legacyUndated: number;
}

export type CellStatus = 'paid' | 'partly paid' | 'unpaid' | 'waived' | 'future' | 'advance' | 'joining' | 'n/a' | 'legacy';

export interface Cell { status: CellStatus; due: number; paid: number; allocations: Allocation[] }

/** Precomputed index of active allocations by member and month for a cutoff. */
export class Ledger {
  readonly byMemberMonth = new Map<string, Allocation[]>();
  readonly receipts: Map<string, Receipt>;
  readonly until: string;
  constructor(readonly s: State, readonly cutoff: string) {
    this.receipts = new Map(s.receipts.map(r => [r.id, r]));
    this.until = lastDueMonth(s, cutoff);
    for (const a of s.allocations) {
      if (!allocationActive(s, a, cutoff, this.receipts)) continue;
      const key = `${a.memberId}|${a.month}`;
      const list = this.byMemberMonth.get(key);
      if (list) list.push(a); else this.byMemberMonth.set(key, [a]);
    }
  }
  allocations(memberId: string, month: string) { return this.byMemberMonth.get(`${memberId}|${month}`) ?? []; }
  paid(memberId: string, month: string) {
    return this.allocations(memberId, month).filter(a => a.kind === 'regular').reduce((v, a) => v + a.amount, 0);
  }
  cell(m: Member, month: string): Cell {
    const allocations = this.allocations(m.id, month);
    const p = allocations.filter(a => a.kind === 'regular').reduce((v, a) => v + a.amount, 0);
    const d = due(this.s, m, month);
    if (allocations.some(a => a.kind === 'joining')) return { status: 'joining', due: d, paid: p, allocations };
    if (!m.start || month < m.start || (m.inactiveFrom && month >= m.inactiveFrom)) {
      return { status: p ? 'legacy' : 'n/a', due: 0, paid: p, allocations };
    }
    if (d === 0) return { status: 'waived', due: 0, paid: p, allocations };
    if (month > this.until) return { status: p >= d ? 'advance' : p > 0 ? 'partly paid' : 'future', due: d, paid: p, allocations };
    return { status: p >= d ? 'paid' : p > 0 ? 'partly paid' : 'unpaid', due: d, paid: p, allocations };
  }
  summary(m: Member): MemberSummary {
    const s = this.s;
    const obligations = m.start ? months(m.start, this.until) : [];
    const unpaid: string[] = [], partial: string[] = [];
    let outstanding = 0;
    for (const month of obligations) {
      const d = due(s, m, month), p = this.paid(m.id, month);
      if (p < d) { outstanding += d - p; (p ? partial : unpaid).push(month); }
    }
    let advance = 0, total = 0, legacyUndated = 0, joiningPaid = false, joiningDate: string | undefined;
    const dates: string[] = [];
    for (const [key, list] of this.byMemberMonth) {
      if (!key.startsWith(m.id + '|')) continue;
      for (const a of list) {
        total += a.amount;
        if (a.kind === 'joining') { joiningPaid = true; joiningDate = a.received ?? joiningDate; }
        else if (a.month > this.until) advance += a.amount;
        const date = a.receiptId ? this.receipts.get(a.receiptId)?.date : a.received;
        if (date) dates.push(date); else legacyUndated += a.amount;
      }
    }
    let unapplied = 0;
    for (const r of s.receipts) {
      if (r.memberId !== m.id || r.status !== 'confirmed' || !r.credit || r.date > this.cutoff || r.reversalOf) continue;
      if (s.receipts.some(x => x.reversalOf === r.id && x.status === 'confirmed' && x.date <= this.cutoff)) continue;
      const used = s.allocations.filter(a => a.receiptId === r.id).reduce((v, a) => v + a.amount, 0);
      unapplied += Math.max(0, r.credit - used);
      dates.push(r.date);
    }
    total += unapplied;
    return { member: m, outstanding, advance, unapplied, total, joiningPaid, joiningDate: m.joined ?? joiningDate, last: dates.sort().at(-1), unpaid, partial, legacyUndated };
  }
}

export function dashboard(s: State, cutoff: string) {
  const rows = sortRows(countedRows(s, cutoff), s);
  const confirmed = rows.filter(r => r.status === 'confirmed');
  const reversed = new Set(s.receipts.filter(r => r.reversalOf && r.status === 'confirmed' && r.date <= cutoff).map(r => r.reversalOf!));
  const sum = (list: Receipt[], f: (r: Receipt) => number) => list.reduce((v, r) => v + f(r), 0);
  const byCat = (cat: Category) => confirmed.filter(r => r.category === cat && !reversed.has(r.id));
  const ledger = new Ledger(s, cutoff);
  const summaries = s.members.map(m => ledger.summary(m));
  const lastBalance = [...rows].reverse().find(r => r.balance !== undefined);
  const statementBatches = s.batches.filter(b => !b.undone);
  const latestStatement = [...statementBatches].reverse().find(b => b.kind !== 'workbook') ?? statementBatches.at(-1);
  const reversalDebits = sum(confirmed.filter(r => r.reversalOf && r.debit), r => r.debit);
  return {
    dataThrough: rows.at(-1)?.date,
    bankBalance: lastBalance?.balance,
    balanceDate: lastBalance?.date,
    credits: sum(rows, r => r.credit),
    debits: sum(rows, r => r.debit),
    joining: sum(byCat('Joining contribution'), r => r.credit),
    regular: sum(byCat('Member contribution'), r => r.credit) ,
    reversalDebits,
    charity: sum(byCat('Charity expenditure'), r => r.debit),
    interest: sum(byCat('Bank interest'), r => r.credit),
    otherReceipts: sum(confirmed.filter(r => r.credit && !contributionCategories.includes(r.category) && r.category !== 'Bank interest' && !r.reversalOf), r => r.credit),
    otherExpenses: sum(confirmed.filter(r => r.debit && r.category !== 'Charity expenditure' && !r.reversalOf), r => r.debit),
    pendingCredits: sum(rows.filter(r => r.status === 'review'), r => r.credit),
    pendingDebits: sum(rows.filter(r => r.status === 'review'), r => r.debit),
    outstanding: summaries.reduce((v, x) => v + x.outstanding, 0),
    advance: summaries.reduce((v, x) => v + x.advance, 0),
    unapplied: summaries.reduce((v, x) => v + x.unapplied, 0),
    review: reviewCount(s),
    latestBatch: latestStatement,
    reconciliation: reconciliationStatus(s),
    members: summaries,
    ledger,
    until: ledger.until,
  };
}

export function reviewCount(s: State) {
  return s.receipts.filter(r => r.status === 'review').length + s.issues.filter(i => !i.resolved).length;
}

/** Running-balance check over all counted rows in original order. Differences are flagged, never balanced. */
export function reconciliationStatus(s: State) {
  const issues: { receipt: Receipt; expected: number; reported: number }[] = [];
  const bySource = new Map<string, Receipt[]>();
  for (const r of countedRows(s)) {
    const key = r.batch;
    bySource.set(key, [...(bySource.get(key) ?? []), r]);
  }
  for (const rows of bySource.values()) issues.push(...balanceBreaks(rows).breaks);
  const batches = s.batches.filter(b => !b.undone && b.reconciliation.difference);
  return { ok: !issues.length && !batches.length, rowIssues: issues, batchDifferences: batches };
}

// ---------- Report tables ----------

export type Table = {
  title: string; columns: string[]; rows: (string | number)[][]; note?: string;
  /** Optional per-row group number (parallel to rows); rows sharing a number are shown as one group. */
  groups?: (number | undefined)[];
  /** Column names whose header and cells are centred. */
  center?: string[];
};

const rupees = (p: number) => (p / 100).toFixed(2);

export function memberStatement(s: State, memberId: string, cutoff: string): Table {
  const m = s.members.find(x => x.id === memberId)!;
  const ledger = new Ledger(s, cutoff);
  const allocs = s.allocations.filter(a => a.memberId === memberId).sort((a, b) => a.month.localeCompare(b.month));
  // One payment split across several months/types: same bank receipt, or (workbook only) same "Paid on" date and sheet.
  const payKey = (a: Allocation) => a.receiptId ? `r|${a.receiptId}` : a.received ? `w|${a.received}|${a.source?.sheet ?? ''}` : undefined;
  const parts = new Map<string, Allocation[]>();
  for (const a of allocs) { const k = payKey(a); if (k) parts.set(k, [...parts.get(k) ?? [], a]); }
  const received = (a: Allocation) => (a.receiptId ? ledger.receipts.get(a.receiptId)?.date : undefined) ?? a.received ?? '';
  const splits = [...parts].filter(([, list]) => list.length > 1)
    .sort(([, x], [, y]) => received(x[0]).localeCompare(received(y[0])) || x[0].month.localeCompare(y[0].month));
  const splitNo = new Map(splits.map(([k], i) => [k, i + 1]));
  const rows: (string | number)[][] = [];
  const groups: (number | undefined)[] = [];
  for (const a of allocs) {
    const r = a.receiptId ? ledger.receipts.get(a.receiptId) : undefined;
    const active = allocationActive(s, a, cutoff, ledger.receipts);
    const k = payKey(a), n = k ? splitNo.get(k) : undefined;
    let split = '';
    if (n) {
      const list = parts.get(k!)!, whole = r?.credit || list.reduce((t, x) => t + x.amount, 0);
      split = `#${n} · part ${list.indexOf(a) + 1} of ${list.length} · ${rupees(whole)} total`;
    }
    rows.push([a.month, a.kind === 'joining' ? 'Joining contribution' : 'Regular', rupees(a.amount), r?.date ?? a.received ?? 'Unknown', split, r ? r.sender || r.narration.slice(0, 40) : a.legacy ? 'Workbook record (no linked receipt)' : '', active ? 'Counted' : a.reversedBy ? 'Reversed' : 'After cutoff / unconfirmed', a.note]);
    groups.push(n);
  }
  const sm = ledger.summary(m);
  return {
    title: `Member statement — ${m.name} (as of ${cutoff})`,
    columns: ['Month', 'Type', 'Amount (₹)', 'Received', 'Split payment', 'Paid by / source', 'Status', 'Note'],
    rows,
    groups,
    note: `Outstanding ${rupees(sm.outstanding)} · Advance ${rupees(sm.advance)} · Unapplied ${rupees(sm.unapplied)} · Start ${m.start ?? 'not confirmed'} · Joining ${m.joined ?? m.joiningMonth ?? 'not recorded'}` +
      (splits.length ? ` · Rows marked #1, #2 … under “Split payment” are parts of one amount received on that date.` : ''),
  };
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2025-09".."2026-09" -> "2025: Sep to Dec (4 months), 2026: Jan to Sep (9 months)"; gaps within a year are listed separately. */
export function monthRanges(list: string[]): string {
  const byYear = new Map<string, number[]>();
  for (const m of [...new Set(list)].sort()) {
    const [y, mm] = m.split('-');
    byYear.set(y, [...(byYear.get(y) ?? []), Number(mm)]);
  }
  return [...byYear].map(([y, ms]) => {
    const parts: string[] = [];
    for (let i = 0; i < ms.length;) {
      let j = i;
      while (j + 1 < ms.length && ms[j + 1] === ms[j] + 1) j++;
      parts.push(i === j ? MONTH_NAMES[ms[i] - 1] : `${MONTH_NAMES[ms[i] - 1]} to ${MONTH_NAMES[ms[j] - 1]}`);
      i = j + 1;
    }
    return `${y}: ${parts.join(', ')} (${ms.length} month${ms.length === 1 ? '' : 's'})`;
  }).join(', ');
}

export function outstandingReport(s: State, cutoff: string): Table {
  const ledger = new Ledger(s, cutoff);
  const rows = s.members.map(m => ledger.summary(m)).filter(x => x.outstanding > 0 || !x.member.start)
    .map(x => [x.member.name, x.member.start ?? 'Not confirmed', rupees(x.outstanding), x.unpaid.length, x.partial.length, monthRanges([...x.unpaid, ...x.partial])]);
  return { title: `Outstanding contributions as of ${cutoff}`, columns: ['Member', 'Start month', 'Outstanding (₹)', 'Unpaid', 'Partly paid', 'Months'], center: ['Unpaid', 'Partly paid'], rows, note: `Months due through ${ledger.until} (a month falls due on day ${s.settings.dueDay}). Payments received after ${cutoff} are excluded. Members without a confirmed start month have no dues calculated.` };
}

export function receivedByReceiptMonth(s: State, cutoff: string): Table {
  const map = new Map<string, { joining: number; regular: number; count: number }>();
  for (const r of countedRows(s, cutoff)) {
    if (r.status !== 'confirmed' || !contributionCategories.includes(r.category) || !r.credit) continue;
    const k = monthOf(r.date), e = map.get(k) ?? { joining: 0, regular: 0, count: 0 };
    if (r.category === 'Joining contribution') e.joining += r.credit; else e.regular += r.credit;
    e.count++; map.set(k, e);
  }
  for (const r of countedRows(s, cutoff)) {
    if (r.status !== 'confirmed' || !r.reversalOf) continue;
    const o = s.receipts.find(x => x.id === r.reversalOf);
    if (!o || !contributionCategories.includes(o.category)) continue;
    const k = monthOf(r.date), e = map.get(k) ?? { joining: 0, regular: 0, count: 0 };
    if (o.category === 'Joining contribution') e.joining -= r.debit; else e.regular -= r.debit;
    map.set(k, e);
  }
  const rows = [...map].sort().map(([k, e]) => [k, e.count, rupees(e.joining), rupees(e.regular), rupees(e.joining + e.regular)]);
  return { title: 'Contributions by BANK RECEIPT month', columns: ['Receipt month', 'Receipts', 'Joining (₹)', 'Regular (₹)', 'Total (₹)'], rows, note: 'Grouped by the date money reached the bank. Reversals are deducted in the month they occur. Workbook allocations without a bank receipt are not bank income and are excluded.' };
}

export function allocatedByObligationMonth(s: State, cutoff: string): Table {
  const ledger = new Ledger(s, cutoff);
  const map = new Map<string, { bank: number; legacy: number; joining: number }>();
  for (const list of ledger.byMemberMonth.values()) for (const a of list) {
    const e = map.get(a.month) ?? { bank: 0, legacy: 0, joining: 0 };
    if (a.kind === 'joining') e.joining += a.amount; else if (a.receiptId) e.bank += a.amount; else e.legacy += a.amount;
    map.set(a.month, e);
  }
  const rows = [...map].sort().map(([k, e]) => [k, rupees(e.joining), rupees(e.bank), rupees(e.legacy), rupees(e.joining + e.bank + e.legacy)]);
  return { title: 'Contributions by CONTRIBUTION (obligation) month', columns: ['Contribution month', 'Joining (₹)', 'Regular, bank-linked (₹)', 'Regular, workbook only (₹)', 'Total (₹)'], rows, note: `Grouped by the month a payment covers. Only payments received on or before ${cutoff} are counted.` };
}

export function annualReport(s: State, cutoff: string): Table {
  const years = new Map<string, Map<Category, { credit: number; debit: number }>>();
  for (const r of countedRows(s, cutoff)) {
    if (r.status !== 'confirmed') continue;
    const y = r.date.slice(0, 4), cats = years.get(y) ?? new Map();
    const e = cats.get(r.category) ?? { credit: 0, debit: 0 };
    e.credit += r.credit; e.debit += r.debit; cats.set(r.category, e); years.set(y, cats);
  }
  const rows: (string | number)[][] = [];
  for (const [y, cats] of [...years].sort()) {
    for (const c of categories) { const e = cats.get(c); if (e) rows.push([y, c, rupees(e.credit), rupees(e.debit)]); }
    const t = [...cats.values()].reduce((v, e) => ({ credit: v.credit + e.credit, debit: v.debit + e.debit }), { credit: 0, debit: 0 });
    rows.push([y, 'Total', rupees(t.credit), rupees(t.debit)]);
  }
  return { title: 'Annual receipts and expenditure (confirmed bank transactions)', columns: ['Year', 'Category', 'Receipts (₹)', 'Payments (₹)'], rows, note: 'Items awaiting review are excluded.' };
}

export function charityReport(s: State, cutoff: string): Table {
  const rows: (string | number)[][] = [];
  for (const r of countedRows(s, cutoff).filter(r => r.category === 'Charity expenditure' && r.status === 'confirmed')) {
    const details = s.charity.filter(c => c.receiptId === r.id);
    rows.push([r.date, rupees(r.debit), details.map(d => d.description).join('; ') || r.remarks || r.type || r.narration.slice(0, 50), details.map(d => d.beneficiary).filter(Boolean).join('; '), details.map(d => d.referral).filter(Boolean).join('; '), 'Bank']);
  }
  for (const c of s.charity.filter(c => !c.receiptId && (!c.date || c.date <= cutoff))) {
    rows.push([c.date ?? 'Unknown', rupees(c.amount), c.description, c.beneficiary, c.referral, `Supplementary record only (${c.source.sheet}) — not added to totals`]);
  }
  rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return { title: 'Charity spending', columns: ['Date', 'Amount (₹)', 'Description', 'Beneficiary', 'Referred by', 'Source'], rows, note: 'Bank debits are the spending total. Supplementary charity records are linked to a bank payment where the date and amount match uniquely, so nothing is counted twice.' };
}

export function reconciliationReport(s: State): Table {
  const rows: (string | number)[][] = s.batches.filter(b => !b.undone).map(b => [b.file, b.kind, b.from ?? '', b.to ?? '', b.reconciliation.opening === undefined ? '' : rupees(b.reconciliation.opening), rupees(b.reconciliation.credits), rupees(b.reconciliation.debits), b.reconciliation.closing === undefined ? '' : rupees(b.reconciliation.closing), b.reconciliation.difference === undefined ? 'n/a' : rupees(b.reconciliation.difference), b.reconciliation.rowIssues.length]);
  return { title: 'Bank reconciliation by import', columns: ['File', 'Kind', 'From', 'To', 'Opening (₹)', 'Credits (₹)', 'Debits (₹)', 'Closing (₹)', 'Difference (₹)', 'Row balance breaks'], rows, note: 'Opening + credits − debits should equal closing. Differences are flagged for review; no balancing entries are created.' };
}

export function toCSV(t: Table) {
  const esc = (v: unknown) => { const x = String(v ?? ''); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
  return [t.columns, ...t.rows].map(r => r.map(esc).join(',')).join('\r\n');
}

export { addMonth };
