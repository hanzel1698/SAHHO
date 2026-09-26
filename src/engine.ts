// Obligations, allocation and review decisions. Pure functions over State (no UI).
import { Allocation, Category, Member, Receipt, State, audit, contributionCategories, id, memberName, money, monthLabel, norm, today } from './model';
import { matchCategory, matchMember, patternCategory, senderOf, validateToken } from './matching';

export function addMonth(month: string, n = 1) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}
export function months(from: string, to: string) {
  const out: string[] = [];
  for (let m = from; m <= to && out.length < 1200; m = addMonth(m)) out.push(m);
  return out;
}
export const monthOf = (date: string) => date.slice(0, 7);

export function rateFor(s: State, month: string) {
  return [...s.settings.rates].sort((a, b) => b.from.localeCompare(a.from)).find(r => r.from <= month)?.amount ?? 0;
}

/** Regular contribution due for a month. Zero before the confirmed start month or after leaving. */
export function due(s: State, m: Member, month: string) {
  if (!m.start || month < m.start || (m.inactiveFrom && month >= m.inactiveFrom)) return 0;
  const exception = m.exceptions.find(e => month >= e.from && month <= e.to);
  if (exception) return exception.amount;
  return rateFor(s, month);
}

/** Latest year covered by a workbook roster, if the register was migrated from the workbook. */
export function lastRosterYear(s: State) {
  let last: number | undefined;
  for (const m of s.members) for (const y of m.rosterYears ?? []) if (last === undefined || y > last) last = y;
  return last;
}

/**
 * Whether a member belongs on the register for a year. Workbook years follow that year's sheet exactly
 * (members removed later or joining later are left out); years after the workbook carry its last roster
 * forward until the member becomes inactive. Members without a roster (added in the app) follow their
 * start and inactive months.
 */
export function onRoster(s: State, m: Member, year: number, last = lastRosterYear(s)) {
  const inactive = !!m.inactiveFrom && m.inactiveFrom <= `${year}-01`;
  if (m.rosterYears?.length && last !== undefined) {
    if (year <= last) return m.rosterYears.includes(year);
    return m.rosterYears.includes(last) && !inactive;
  }
  const from = m.start ?? m.joiningMonth ?? m.suggestedStart;
  return !inactive && (!from || from <= `${year}-12`);
}

/** Workbook year sheets archived at migration → the years each member name is listed in column A. */
export function rosterFromArchives(s: State) {
  const byName = new Map<string, Set<number>>();
  for (const a of s.archives) {
    if (!/^20\d{2}$/.test(a.name)) continue;
    for (const [addr, c] of Object.entries(a.cells)) {
      const row = /^A(\d+)$/.exec(addr);
      if (!row || Number(row[1]) < 4 || c.formula || typeof c.value !== 'string') continue;
      const name = norm(c.value.replace(/\([^)]*\)?/g, ' '));
      if (!byName.has(name)) byName.set(name, new Set());
      byName.get(name)!.add(Number(a.name));
    }
  }
  return byName;
}

/** Last month whose contribution is due on the cutoff date (a month is due on settings.dueDay). */
export function lastDueMonth(s: State, cutoff: string) {
  return Number(cutoff.slice(8, 10)) >= s.settings.dueDay ? monthOf(cutoff) : addMonth(monthOf(cutoff), -1);
}

export const LATEST = '9999-12-31';

/**
 * Whether an allocation counts at the cutoff. Bank-linked allocations count from the receipt date;
 * legacy allocations count from their recorded payment date. Undated legacy allocations count only in
 * current views (cutoff today or later), never in historical as-of reports.
 */
export function allocationActive(s: State, a: Allocation, cutoff = LATEST, receipts?: Map<string, Receipt>) {
  const find = (rid: string) => receipts?.get(rid) ?? s.receipts.find(r => r.id === rid);
  if (a.receiptId) {
    const r = find(a.receiptId);
    if (!r || r.status !== 'confirmed' || r.date > cutoff) return false;
  } else if (a.received) {
    if (a.received > cutoff) return false;
  } else if (cutoff < today()) return false;
  if (a.reversedBy) {
    const rev = find(a.reversedBy);
    if (rev && rev.status === 'confirmed' && rev.date <= cutoff) return false;
  }
  return true;
}

export function paid(s: State, memberId: string, month: string, cutoff = LATEST) {
  return s.allocations
    .filter(a => a.memberId === memberId && a.month === month && a.kind === 'regular' && allocationActive(s, a, cutoff))
    .reduce((v, a) => v + a.amount, 0);
}

export function allocated(s: State, receiptId: string) {
  return s.allocations.filter(a => a.receiptId === receiptId && !a.reversedBy).reduce((v, a) => v + a.amount, 0);
}
export function available(s: State, r: Receipt) {
  return Math.max(0, r.credit - allocated(s, r.id));
}

// ---------- Allocation planning ----------

export interface PlanLine { month: string; amount: number; kind: 'joining' | 'regular'; note: string }
export interface Plan {
  memberId: string;
  lines: PlanLine[];
  unapplied: number;
  joining: boolean;
  method: string;
  problem?: string;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** Months stated in a narration. `ambiguous` means a period is mentioned but cannot be read safely. */
export function explicitMonths(text: string, receiptDate?: string): { months?: string[]; ambiguous?: boolean } {
  // Remove timestamps like 02/01/2026 10:57:45 and bank references so they are not read as periods.
  const n = norm(text).replace(/\b\d{1,2}\/\d{1,2}\/\d{4}(\s+\d{1,2}:\d{2}(:\d{2})?)?/g, ' ');
  const iso = [...n.matchAll(/\b(20\d{2})-(0[1-9]|1[0-2])\b/g)].map(m => m[0]);
  if (iso.length === 1) return { months: iso };
  if (iso.length === 2 && /\bTO\b|THROUGH/.test(n) && iso[0] <= iso[1]) return { months: months(iso[0], iso[1]) };
  const monthWord = '(JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUNE?|JULY?|AUG(?:UST)?|SEPT?(?:EMBER)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)';
  const range = n.match(new RegExp(`\\b${monthWord}\\s*(20\\d{2})?\\s*(?:TO|-)\\s*${monthWord}\\s+(20\\d{2})\\b`));
  if (range) {
    const y2 = range[4], y1 = range[2] ?? y2;
    const a = `${y1}-${String(MONTHS.indexOf(range[1].slice(0, 3)) + 1).padStart(2, '0')}`;
    const b = `${y2}-${String(MONTHS.indexOf(range[3].slice(0, 3)) + 1).padStart(2, '0')}`;
    if (a <= b) return { months: months(a, b) };
  }
  const named = [...n.matchAll(new RegExp(`\\b${monthWord}\\s+(20\\d{2})\\b`, 'g'))];
  if (named.length === 1 && !new RegExp(`\\b${monthWord}\\b.*\\b${monthWord}\\b`).test(n.replace(named[0][0], ''))) {
    return { months: [`${named[0][2]}-${String(MONTHS.indexOf(named[0][1].slice(0, 3)) + 1).padStart(2, '0')}`] };
  }
  const year = n.match(/\b(?:SAHHO|CONTRIBUTION|SHARE|FOR|YEAR)\s+(20\d{2})\b/);
  if (year && !named.length) return { months: months(`${year[1]}-01`, `${year[1]}-12`) };
  const mentions = new RegExp(`\\b${monthWord}\\b|\\bMONTHS?\\b|\\bARREARS?\\b|\\bADVANCE\\b`).test(n);
  void receiptDate;
  return { ambiguous: mentions || named.length > 1 || iso.length > 0 };
}

function history(s: State, memberId: string, excludeReceipt?: string) {
  const allocs = s.allocations.filter(a => a.memberId === memberId && a.receiptId !== excludeReceipt && allocationActive(s, a));
  return {
    hasJoining: allocs.some(a => a.kind === 'joining'),
    hasAny: allocs.length > 0 || s.receipts.some(r => r.id !== excludeReceipt && r.memberId === memberId && r.status === 'confirmed' && r.credit > 0),
  };
}

/** Fill months in order: complete partial months first, then later months, up to the advance limit. */
function oldestUnpaid(s: State, m: Member, amount: number, receiptDate: string): { lines: PlanLine[]; left: number } {
  const lines: PlanLine[] = [];
  let left = amount;
  const until = addMonth(monthOf(receiptDate), s.settings.advanceMonths);
  for (const month of months(m.start!, until)) {
    if (left <= 0) break;
    const need = Math.max(0, due(s, m, month) - paid(s, m.id, month));
    const take = Math.min(left, need);
    if (take > 0) { lines.push({ month, amount: take, kind: 'regular', note: 'Oldest unpaid first, then advance' }); left -= take; }
  }
  return { lines, left };
}

export function planAllocation(
  s: State, r: Receipt, memberId: string,
  opts: { months?: string[]; ignorePeriod?: boolean; amount?: number; treatAsJoining?: boolean } = {},
): Plan {
  const m = s.members.find(x => x.id === memberId);
  const amount = opts.amount ?? available(s, r);
  const base = { memberId, lines: [] as PlanLine[], unapplied: amount, joining: false, method: '' };
  if (!m) return { ...base, problem: 'Member not found.' };
  if (!r.credit) return { ...base, problem: 'Only credits can be allocated to contributions.' };
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > available(s, r)) return { ...base, problem: 'Allocation exceeds the unallocated amount of this receipt.' };

  const { hasJoining, hasAny } = history(s, memberId, r.id);
  const joiningAmount = s.settings.joiningAmount;
  if (!hasJoining && (opts.treatAsJoining || (!hasAny && amount === joiningAmount))) {
    if (amount !== joiningAmount) return { ...base, problem: `The joining contribution is ${money(joiningAmount)}; this amount differs.` };
    const month = m.joiningMonth ?? monthOf(r.date);
    return {
      memberId, joining: true, unapplied: 0, method: 'Initial joining contribution',
      lines: [{ month, amount, kind: 'joining', note: `Initial joining contribution (${money(joiningAmount)}), kept whole` }],
    };
  }
  if (!hasAny && !hasJoining && !opts.months) {
    return { ...base, problem: `First payment from this member is ${money(amount)}, not the ${money(joiningAmount)} joining contribution. Confirm how to treat it.` };
  }
  if (!m.start) return { ...base, problem: `Regular contribution start month for ${m.name} is not confirmed.` };

  let problem: string | undefined;
  let target = opts.months;
  let method = opts.months ? 'Months chosen by treasurer' : '';
  if (!target && !opts.ignorePeriod) {
    const ex = explicitMonths(r.narration, r.date);
    if (ex.ambiguous) problem = 'The narration mentions a period that could not be read reliably. Proposed: oldest unpaid months.';
    else if (ex.months) {
      const need = ex.months.reduce((v, x) => v + Math.max(0, due(s, m, x) - paid(s, memberId, x)), 0);
      if (ex.months.some(x => x < m.start! || due(s, m, x) === 0) || need !== amount) {
        problem = `Narration names ${ex.months.length === 1 ? monthLabel(ex.months[0]) : `${monthLabel(ex.months[0])}–${monthLabel(ex.months.at(-1)!)}`} but that does not match ${money(amount)} and existing allocations. Proposed: oldest unpaid months.`;
      } else { target = ex.months; method = 'Period stated in narration'; }
    }
  }
  if (target) {
    const lines: PlanLine[] = [];
    let left = amount;
    for (const month of target) {
      const take = Math.min(left, Math.max(0, due(s, m, month) - paid(s, memberId, month)));
      if (take > 0) { lines.push({ month, amount: take, kind: 'regular', note: method }); left -= take; }
    }
    return { memberId, lines, unapplied: left, joining: false, method, problem };
  }
  const { lines, left } = oldestUnpaid(s, m, amount, r.date);
  return { memberId, lines, unapplied: left, joining: false, method: 'Oldest unpaid months first, then advance', problem };
}

export function commitPlan(s: State, r: Receipt, plan: Plan) {
  const total = plan.lines.reduce((v, l) => v + l.amount, 0);
  if (total > available(s, r)) throw Error('Allocation exceeds available receipt credit.');
  const m = s.members.find(x => x.id === plan.memberId)!;
  for (const l of plan.lines) {
    s.allocations.push({ id: id(), receiptId: r.id, memberId: plan.memberId, month: l.month, amount: l.amount, kind: l.kind, received: r.date, legacy: false, note: l.note });
  }
  if (plan.joining) {
    m.joined = r.date;
    m.joiningMonth = plan.lines[0].month;
    r.category = 'Joining contribution';
  } else r.category = 'Member contribution';
  r.memberId = plan.memberId;
  r.reason = `${r.reason ? r.reason + '. ' : ''}${plan.method}${plan.unapplied ? `; ${money(plan.unapplied)} kept as unapplied credit` : ''}`;
}

// ---------- Automatic processing ----------

/** Classify and, where safe, allocate a new bank transaction. Anything uncertain goes to review. */
export function processReceipt(s: State, r: Receipt) {
  r.candidates = [];
  r.memberId = undefined;
  const pattern = patternCategory(r);
  if (pattern === 'Refund / reversal') {
    const original = reversalCandidates(s, r);
    const strong = referencedOriginals(s, r);
    r.category = 'Refund / reversal';
    r.status = 'review';
    r.candidates = original.slice(0, 10).map(x => x.id);
    r.reason = strong.length === 1
      ? `Reversal of ${strong[0].date} ${money(strong[0].credit || strong[0].debit)} (same bank reference): confirm to reverse its allocations`
      : original.length ? 'Reversal/refund: choose the original transaction to reverse its allocations' : 'Refund or reversal without a clear original transaction';
    return;
  }
  if (r.credit > 0) {
    if (pattern === 'Bank interest') { r.category = pattern; r.status = 'confirmed'; r.reason = 'Recognised bank interest'; return; }
    const match = matchMember(s, r);
    r.candidates = match.candidates;
    r.matchedRules = match.rules;
    r.reason = match.reason;
    if (!match.memberId) { r.category = 'Unclassified'; r.status = 'review'; return; }
    const plan = planAllocation(s, r, match.memberId);
    if (plan.problem) { r.category = 'Member contribution'; r.status = 'review'; r.reason = `${match.reason}. ${plan.problem}`; return; }
    r.status = 'confirmed';
    commitPlan(s, r, plan);
    return;
  }
  // Debits
  const rule = matchCategory(s, r);
  if (rule.category && rule.validated) {
    r.category = rule.category; r.status = 'confirmed'; r.matchedRules = rule.rules;
    r.reason = 'Category from validated payee rule'; return;
  }
  if (pattern === 'Bank charges' || pattern === 'Phone recharge') { r.category = pattern; r.status = 'confirmed'; r.reason = 'Recognised bank transaction pattern'; return; }
  r.category = rule.category ?? pattern ?? 'Unclassified';
  r.status = 'review';
  const memberNamed = s.members.some(m => m.name.length >= 4 && norm(r.narration).includes(m.name));
  r.reason = `Confirm expenditure category${rule.category ? ' (suggested from similar payments)' : ''}` +
    (memberNamed ? '. A member is named in this debit — it may be a reimbursement, not a contribution' : '');
}

// ---------- Review decisions (all audited) ----------

function removeReceiptAllocations(s: State, r: Receipt) {
  const removed = s.allocations.filter(a => a.receiptId === r.id && !a.legacy);
  const legacyLinked = s.allocations.filter(a => a.receiptId === r.id && a.legacy);
  if (legacyLinked.length) throw Error('This receipt is linked to preserved workbook allocations. Unlink those first.');
  s.allocations = s.allocations.filter(a => !removed.includes(a));
  return removed;
}

export interface Decision {
  memberId?: string;
  category: Category;
  months?: string[];
  treatAsJoining?: boolean;
  ruleToken?: string;
  note?: string;
}

/** Approve or correct a transaction. Replaces any earlier automatic allocation of this receipt. */
export function decide(s: State, receiptId: string, d: Decision) {
  const r = s.receipts.find(x => x.id === receiptId);
  if (!r) throw Error('Transaction not found.');
  const before = { receipt: structuredClone(r), allocations: s.allocations.filter(a => a.receiptId === r.id) };
  if (contributionCategories.includes(d.category)) {
    if (!r.credit) throw Error('Only credits can be contributions.');
    if (!d.memberId) throw Error('Choose the member this payment is for.');
  }
  if (d.ruleToken) {
    const problem = validateToken(d.ruleToken);
    if (problem) throw Error(problem);
  }
  const removed = removeReceiptAllocations(s, r);
  r.duplicateOf = undefined;
  r.memberId = undefined;
  r.category = d.category;
  r.reason = `Confirmed by treasurer${d.note ? `: ${d.note}` : ''}`;
  if (contributionCategories.includes(d.category)) {
    const plan = planAllocation(s, r, d.memberId!, { months: d.months, ignorePeriod: !d.months, treatAsJoining: d.treatAsJoining || d.category === 'Joining contribution' });
    if (plan.problem) {
      s.allocations.push(...removed);
      Object.assign(r, before.receipt);
      throw Error(plan.problem);
    }
    commitPlan(s, r, plan);
  } else if (d.memberId && r.credit) r.memberId = d.memberId;
  r.status = 'confirmed';
  if (d.ruleToken) {
    const token = norm(d.ruleToken);
    const target = contributionCategories.includes(d.category) ? { memberId: d.memberId } : { category: d.category };
    s.rules.push({ id: id(), token, ...target, enabled: true, validated: true, evidence: [r.id], origin: 'manual', note: 'Saved from a review decision' });
  }
  const leftover = detachedFrom(s, r.id);
  for (const a of leftover) {
    a.unlinkedFrom = undefined;
    s.issues.push({ id: id(), kind: 'Unmatched historical allocation', memberId: a.memberId, allocationId: a.id, source: a.source, resolved: false,
      reason: `${memberName(s, a.memberId)} ${a.month}: workbook allocation of ${money(a.amount)} was unlinked from the ${r.date} transaction when it was corrected. Kept as a workbook record without a bank receipt.` });
  }
  audit(s, removed.length ? 'Transaction corrected' : 'Review approved',
    `${r.date} ${money(r.credit || r.debit)} → ${d.category}${d.memberId ? ` / ${s.members.find(m => m.id === d.memberId)?.name}` : ''}`,
    before, { receipt: structuredClone(r), allocations: s.allocations.filter(a => a.receiptId === r.id) });
}

const isWorkbook = (a: Allocation) => !!a.source?.sheet;

/**
 * Send a confirmed transaction back to review so it can be corrected. Allocations the app made from it are
 * removed; workbook allocations linked to it become unlinked workbook records again (never deleted here).
 * Bank fields are untouched.
 */
export function reopenReceipt(s: State, receiptId: string) {
  const r = s.receipts.find(x => x.id === receiptId);
  if (!r) throw Error('Transaction not found.');
  if (r.status !== 'confirmed') throw Error('Only confirmed transactions can be reopened.');
  if (r.reversalOf || s.receipts.some(x => x.reversalOf === r.id)) throw Error('This transaction is part of a linked reversal and cannot be reopened.');
  const linked = s.allocations.filter(a => a.receiptId === r.id);
  const before = { receipt: structuredClone(r), allocations: structuredClone(linked) };
  const detached = linked.filter(isWorkbook);
  s.allocations = s.allocations.filter(a => a.receiptId !== r.id || isWorkbook(a));
  for (const a of detached) { a.receiptId = undefined; a.legacy = true; a.unlinkedFrom = r.id; }
  r.status = 'review';
  r.reason = `Reopened by treasurer (was ${r.category}${r.memberId ? ` / ${memberName(s, r.memberId)}` : ''}${linked.length ? `, ${linked.length} month allocation(s)` : ''})`;
  audit(s, 'Transaction reopened', `${r.date} ${money(r.credit || r.debit)} sent back to review`, before,
    { receipt: structuredClone(r), allocations: structuredClone(detached) });
  return { removed: linked.length - detached.length, detached: detached.length };
}

/** Workbook allocations detached from this receipt when it was reopened. */
export const detachedFrom = (s: State, receiptId: string) => s.allocations.filter(a => a.unlinkedFrom === receiptId);

/** Undo the detachment: link the workbook months back to the receipt and confirm it as before. */
export function relinkDetached(s: State, receiptId: string) {
  const r = s.receipts.find(x => x.id === receiptId);
  const list = detachedFrom(s, receiptId);
  if (!r || !list.length) throw Error('There are no workbook months to link back.');
  const members = [...new Set(list.map(a => a.memberId))];
  if (list.reduce((v, a) => v + a.amount, 0) > r.credit) throw Error('The workbook months exceed this transaction amount.');
  for (const a of list) { a.receiptId = r.id; a.legacy = false; a.unlinkedFrom = undefined; }
  r.status = 'confirmed';
  r.memberId = members.length === 1 ? members[0] : r.memberId;
  r.category = list.some(a => a.kind === 'joining') ? 'Joining contribution' : 'Member contribution';
  r.reason = 'Workbook months linked back by treasurer';
  audit(s, 'Workbook months linked back', `${r.date} ${money(r.credit)} → ${list.map(a => a.month).sort().join(', ')}`);
}

/** Delete the workbook months detached from a reopened receipt (the archived workbook cells are kept). */
export function removeDetached(s: State, receiptId: string) {
  const list = detachedFrom(s, receiptId);
  if (!list.length) throw Error('There are no workbook months to remove.');
  s.allocations = s.allocations.filter(a => !list.includes(a));
  for (const i of s.issues.filter(i => i.allocationId && list.some(a => a.id === i.allocationId) && !i.resolved)) { i.resolved = true; i.resolution = 'Workbook allocation removed'; }
  audit(s, 'Workbook months removed', `${list.map(a => `${memberName(s, a.memberId)} ${a.month} ${money(a.amount)}`).join('; ')} (unlinked from a reopened transaction)`, list);
}

/** Correct the amount of a month recorded in the workbook (e.g. a typing error). The archived cell is kept. */
export function editWorkbookAmount(s: State, allocationId: string, amount: number, reason = '') {
  const a = s.allocations.find(x => x.id === allocationId);
  if (!a || !isWorkbook(a)) throw Error('Only months recorded in the workbook can be edited here.');
  if (!Number.isSafeInteger(amount) || amount <= 0) throw Error('Enter an amount greater than zero.');
  if (a.reversedBy) throw Error('This month was reversed by a refund and cannot be edited.');
  if (a.receiptId) {
    const r = s.receipts.find(x => x.id === a.receiptId)!;
    if (allocated(s, r.id) - a.amount + amount > r.credit) throw Error(`The linked bank payment is only ${money(r.credit)}; the months linked to it would exceed that.`);
  }
  const before = structuredClone(a);
  const was = a.amount;
  a.amount = amount;
  a.note = [a.note, `Corrected from ${money(was)}${reason ? `: ${reason}` : ''}`].filter(Boolean).join(' · ');
  for (const i of s.issues.filter(i => i.allocationId === a.id && i.kind === 'Unusual monthly amount' && !i.resolved)) { i.resolved = true; i.resolution = `Amount corrected to ${money(amount)}`; }
  audit(s, 'Workbook amount corrected', `${memberName(s, a.memberId)} ${monthLabel(a.month)}: ${money(was)} → ${money(amount)}${reason ? ` (${reason})` : ''}`, before, structuredClone(a));
}

/** Workbook months of a member not backed by any bank payment. */
export const unlinkedWorkbook = (s: State, memberId: string) =>
  s.allocations.filter(a => a.memberId === memberId && a.legacy && !a.receiptId && !a.reversedBy).sort((a, b) => a.month.localeCompare(b.month));

/**
 * Link workbook months to a bank payment (instead of allocating the payment again) and confirm it.
 * Any remainder of the payment stays as unapplied credit.
 */
export function linkWorkbookMonths(s: State, receiptId: string, allocationIds: string[]) {
  const r = s.receipts.find(x => x.id === receiptId);
  if (!r || !r.credit) throw Error('Choose a credit transaction.');
  if (r.status === 'duplicate') throw Error('This transaction is marked as a duplicate.');
  const list = s.allocations.filter(a => allocationIds.includes(a.id));
  if (!list.length || list.length !== allocationIds.length || list.some(a => !a.legacy || a.receiptId || a.reversedBy)) throw Error('Choose workbook months that are not linked to a bank payment.');
  const members = new Set(list.map(a => a.memberId));
  if (members.size !== 1) throw Error('Choose months of one member.');
  const total = list.reduce((v, a) => v + a.amount, 0);
  if (total > available(s, r)) throw Error(`The chosen months total ${money(total)}, more than the ${money(available(s, r))} available on this payment.`);
  const before = structuredClone(r);
  for (const a of list) { a.receiptId = r.id; a.legacy = false; a.unlinkedFrom = undefined; }
  for (const i of s.issues.filter(i => i.allocationId && allocationIds.includes(i.allocationId) && !i.resolved)) { i.resolved = true; i.resolution = `Linked to the ${r.date} bank payment`; }
  r.memberId = list[0].memberId;
  r.category = list.some(a => a.kind === 'joining') ? 'Joining contribution' : 'Member contribution';
  r.status = 'confirmed';
  r.duplicateOf = undefined;
  r.reason = `Linked by treasurer to workbook months ${list.map(a => monthLabel(a.month)).join(', ')}${total < r.credit ? `; ${money(r.credit - total)} kept as unapplied credit` : ''}`;
  audit(s, 'Workbook months linked', `${r.date} ${money(r.credit)} (${memberName(s, r.memberId)}) → ${list.map(a => `${monthLabel(a.month)} ${money(a.amount)}`).join(', ')}`, before, structuredClone(r));
}

// ---------- Manual entries ----------

export const MANUAL_BATCH = 'manual';

export interface ManualInput {
  date: string;
  narration: string;
  credit: number;
  debit: number;
  reference?: string;
  decision: Decision;
}

/**
 * Record a transaction the bank statement does not show yet. It is confirmed and counted like any other
 * record, and stays marked as awaiting the bank until a statement import finds the matching row.
 */
export function addManualReceipt(s: State, input: ManualInput) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || Number.isNaN(Date.parse(input.date))) throw Error('Enter the transaction date.');
  const narration = input.narration.trim().replace(/\s+/g, ' ');
  if (!narration) throw Error('Enter a description.');
  const { credit, debit } = input;
  if (!Number.isSafeInteger(credit) || !Number.isSafeInteger(debit) || credit < 0 || debit < 0 || (credit > 0) === (debit > 0)) throw Error('Enter an amount greater than zero.');
  const reference = (input.reference ?? '').trim();
  const r: Receipt = {
    id: id(), date: input.date, valueDate: input.date, narration, sender: senderOf(narration), credit, debit, reference,
    batch: MANUAL_BATCH, order: s.receipts.filter(x => x.batch === MANUAL_BATCH).length,
    source: { file: 'Manual entry', row: 0, raw: {} },
    category: 'Unclassified', status: 'review', reason: '', candidates: [],
    manual: { entered: new Date().toISOString(), date: input.date, narration, reference: reference || undefined },
  };
  s.receipts.push(r);
  decide(s, r.id, input.decision);
  r.reason = `Entered manually; awaiting the bank statement${r.reason ? `. ${r.reason}` : ''}`;
  audit(s, 'Manual entry added', `${r.date} ${money(credit || debit)} ${credit ? 'credit' : 'debit'}: ${narration}`, undefined, structuredClone(r));
  return r;
}

/** Remove a manual entry that has not been matched to the bank yet (e.g. it was entered by mistake). */
export function deleteManualReceipt(s: State, receiptId: string) {
  const r = s.receipts.find(x => x.id === receiptId);
  if (!r || !r.manual) throw Error('Only manual entries can be deleted.');
  if (r.manual.matched) throw Error('This entry is already matched to a bank statement row and cannot be deleted.');
  if (r.reversalOf || s.receipts.some(x => x.reversalOf === r.id || x.duplicateOf === r.id)) throw Error('Another transaction refers to this entry. Resolve that link first.');
  const linked = s.allocations.filter(a => a.receiptId === r.id);
  const workbook = linked.filter(isWorkbook);
  for (const a of workbook) { a.receiptId = undefined; a.legacy = true; }
  s.allocations = s.allocations.filter(a => a.receiptId !== r.id);
  s.receipts = s.receipts.filter(x => x.id !== r.id);
  for (const i of s.issues.filter(i => i.receiptId === r.id && !i.resolved)) { i.resolved = true; i.resolution = 'Manual entry deleted'; }
  audit(s, 'Manual entry deleted', `${r.date} ${money(r.credit || r.debit)}: ${r.narration}${workbook.length ? ` (${workbook.length} workbook month(s) kept unlinked)` : ''}`, { receipt: structuredClone(r), allocations: structuredClone(linked) });
}

export function markDuplicate(s: State, receiptId: string, originalId?: string) {
  const r = s.receipts.find(x => x.id === receiptId);
  if (!r) throw Error('Transaction not found.');
  if (s.allocations.some(a => a.receiptId === r.id)) throw Error('Remove allocations before marking as duplicate.');
  r.status = 'duplicate';
  r.duplicateOf = originalId ?? r.duplicateOf;
  r.reason = 'Confirmed duplicate; excluded from totals';
  audit(s, 'Marked duplicate', `${r.date} ${money(r.credit || r.debit)} duplicate of ${r.duplicateOf ?? 'earlier record'}`);
}

export function notDuplicate(s: State, receiptId: string) {
  const r = s.receipts.find(x => x.id === receiptId);
  if (!r) throw Error('Transaction not found.');
  const was = r.duplicateOf;
  r.duplicateOf = undefined;
  processReceipt(s, r);
  audit(s, 'Kept as separate transaction', `${r.date} ${money(r.credit || r.debit)} is not a duplicate of ${was}`);
}

const longNumbers = (text: string) => new Set(text.match(/\d{9,}/g) ?? []);

/** Originals whose bank reference appears in the reversal (strong evidence). */
export function referencedOriginals(s: State, r: Receipt) {
  const refs = longNumbers(`${r.narration} ${r.reference}`);
  return reversalCandidates(s, r).filter(o => [...longNumbers(`${o.narration} ${o.reference}`)].some(x => refs.has(x)));
}

/** Possible originals for a refund/reversal, best first: shared bank reference, same sender, nearest date. */
export function reversalCandidates(s: State, r: Receipt) {
  const refs = longNumbers(`${r.narration} ${r.reference}`);
  const text = norm(r.narration);
  const score = (o: Receipt) =>
    ([...longNumbers(`${o.narration} ${o.reference}`)].some(x => refs.has(x)) ? 1000 : 0) +
    (o.sender && text.includes(o.sender) ? 100 : 0) -
    (Date.parse(r.date) - Date.parse(o.date)) / 86400000;
  return s.receipts.filter(o =>
    o.id !== r.id && o.status === 'confirmed' && !o.reversalOf &&
    o.credit === r.debit && o.debit === r.credit && o.date <= r.date &&
    !s.receipts.some(x => x.reversalOf === o.id) &&
    (Date.parse(r.date) - Date.parse(o.date)) / 86400000 <= 90)
    .sort((a, b) => score(b) - score(a));
}

/** Link a refund/reversal to its original and reverse the original's allocations (records are kept). */
export function linkReversal(s: State, reversalId: string, originalId: string) {
  const r = s.receipts.find(x => x.id === reversalId), o = s.receipts.find(x => x.id === originalId);
  if (!r || !o || o.id === r.id || o.status !== 'confirmed' || r.debit !== o.credit || r.credit !== o.debit || r.date < o.date || s.receipts.some(x => x.reversalOf === o.id)) {
    throw Error('Choose an unreversed, confirmed original of the same amount and opposite direction. Partial refunds need a manual allocation adjustment.');
  }
  r.reversalOf = o.id;
  r.category = 'Refund / reversal';
  r.status = 'confirmed';
  r.memberId = o.memberId;
  r.reason = `Reverses ${o.date} ${money(o.credit || o.debit)}`;
  for (const a of s.allocations.filter(a => a.receiptId === o.id)) a.reversedBy = r.id;
  audit(s, 'Reversal confirmed', `${r.date} reverses ${o.date} ${o.narration.slice(0, 60)}`);
}

export function createMember(s: State, input: { name: string; aliases?: string[]; start?: string; joiningMonth?: string; notes?: string }) {
  const name = norm(input.name);
  if (name.length < 2) throw Error('Enter the member name.');
  if (s.members.some(m => m.name === name)) throw Error('A member with this name already exists. Use aliases to distinguish people with similar names.');
  if (input.start && !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.start)) throw Error('Start month must be YYYY-MM.');
  const m: Member = { id: id(), name, aliases: (input.aliases ?? []).map(norm).filter(Boolean), notes: input.notes ?? '', start: input.start, joiningMonth: input.joiningMonth, exceptions: [] };
  s.members.push(m);
  audit(s, 'Member created', `${m.name}${m.start ? `, regular contributions from ${m.start}` : ''}`);
  return m;
}

export function updateMember(s: State, memberId: string, patch: Partial<Member>) {
  const m = s.members.find(x => x.id === memberId);
  if (!m) throw Error('Member not found.');
  const before = structuredClone(m);
  Object.assign(m, patch);
  if (patch.start) {
    m.suggestedStart = undefined;
    for (const i of s.issues.filter(i => i.memberId === m.id && i.kind === 'Contribution start month' && !i.resolved)) {
      i.resolved = true; i.resolution = `Start month confirmed as ${patch.start}`;
    }
  }
  audit(s, 'Member updated', m.name, before, structuredClone(m));
}

export function resolveIssue(s: State, issueId: string, resolution: string) {
  const i = s.issues.find(x => x.id === issueId);
  if (!i) throw Error('Item not found.');
  i.resolved = true;
  i.resolution = resolution;
  audit(s, 'Issue resolved', `${i.kind}: ${resolution}`);
}

/** Link a preserved workbook allocation to a bank receipt (manual reconciliation). */
export function linkLegacy(s: State, allocationId: string, receiptId: string) {
  const a = s.allocations.find(x => x.id === allocationId), r = s.receipts.find(x => x.id === receiptId);
  if (!a || !r || a.receiptId) throw Error('Choose an unlinked historical allocation and a receipt.');
  if (a.amount > available(s, r)) throw Error('The receipt does not have enough unallocated credit.');
  a.receiptId = r.id;
  a.legacy = false;
  if (r.memberId && r.memberId !== a.memberId) a.note = `${a.note} Paid by the sender of a receipt assigned to another member.`.trim();
  for (const i of s.issues.filter(i => i.allocationId === a.id && !i.resolved)) { i.resolved = true; i.resolution = `Linked to receipt ${r.date}`; }
  audit(s, 'Historical allocation linked', `${a.month} ${money(a.amount)} → receipt ${r.date} ${money(r.credit)}`);
}
