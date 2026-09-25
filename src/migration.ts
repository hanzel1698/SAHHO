// Migration of the SAHHO workbook. Preserves every populated cell as evidence, keeps the workbook's
// month allocations as recorded, links them to bank receipts only where the evidence is unique, and
// never creates bank income from an allocation that has no receipt.
import * as XLSX from 'xlsx';
import { Allocation, Batch, Category, Issue, Member, Receipt, Source, State, audit, id, money, norm } from './model';
import { addMonth, available, reversalCandidates } from './engine';
import { fuzzyCandidates, trainRules } from './matching';
import { amount, bankRef, clean, date, findDuplicate, parseRows, reconcile, tableFromRows } from './importer';

const CATEGORY_LABELS = new Set(['CHARITY', 'INTEREST', 'MISC', 'RECHARGE', 'REFUND', 'REVERSAL', 'UNKNOWN']);
const NOT_NAMES = /^(TOTAL|CUMULATIVE TOTAL|GRAND TOTAL|BALANCE|SUM|SHARE|NAMES?|TAGS?|SL ?NO)\b/;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** "NOEL(300-JAN 2025)" → { name: 'NOEL', note: 'NOEL(300-JAN 2025)' } */
export function nameParts(v: unknown) {
  const raw = clean(v);
  const name = norm(raw.replace(/\([^)]*\)?/g, ' ').replace(/\s+/g, ' '));
  return { name, note: /\(/.test(raw) ? raw : '' };
}

/** Workbook Type/label → category. Returns undefined when the workbook does not decide it. */
export function workbookCategory(label: string, type: string, r: Pick<Receipt, 'credit' | 'debit' | 'narration'>): Category | undefined {
  const t = norm(type), l = norm(label);
  if (/REVERSAL|REFUND/.test(t) || l === 'REVERSAL' || l === 'REFUND') return 'Refund / reversal';
  if (/INTEREST/.test(t) || l === 'INTEREST') return r.credit ? 'Bank interest' : undefined;
  if (/RECHARGE/.test(t) || l === 'RECHARGE') return 'Phone recharge';
  if (/BANK CHARGE/.test(t)) return 'Bank charges';
  if (r.debit > 0) {
    if (/CHARITY|MEDICINE|HOSPITAL|TREATMENT|PAID TO/.test(t) || l === 'CHARITY') return 'Charity expenditure';
    if (/PHONE PURCHASE|REIMBURSEMENT|MISC/.test(t)) return 'Other expense';
    if (l === 'MISC') return /CHARGE|SMS|GST|CESS/.test(norm(r.narration)) ? 'Bank charges' : 'Other expense';
  }
  return undefined;
}

type Book = XLSX.WorkBook;
type CellMap = Record<string, XLSX.CellObject>;

function populatedRows(ws: CellMap) {
  const rows = new Set<number>();
  for (const [k, c] of Object.entries(ws)) if (/^[A-Z]+\d+$/.test(k) && c.v !== undefined && c.v !== '') rows.add(XLSX.utils.decode_cell(k).r + 1);
  return [...rows].sort((a, b) => a - b);
}

export interface MigrationReport {
  [key: string]: unknown;
}

export function migrateWorkbook(current: State, data: ArrayBuffer, file: string, digest: string): State {
  if (current.batches.some(b => b.hash === digest && !b.undone)) throw Error('This workbook has already been imported. Records are unchanged.');
  if (current.members.length || current.receipts.length) throw Error('Migrate into an empty register. Export a backup, then choose “Start empty” in Backup & settings.');
  const s: State = structuredClone(current);
  delete s.undo;
  s.demo = false;
  const book: Book = XLSX.read(data, { type: 'array', cellDates: false, cellFormula: true, cellText: false, cellNF: false });
  const batchId = id();
  const sheet = (n: string) => book.Sheets[n] as CellMap;
  const issue = (i: Omit<Issue, 'id' | 'resolved'>) => s.issues.push({ id: id(), resolved: false, ...i });
  const source = (sheetName: string, row: number, cells?: string): Source => {
    const ws = sheet(sheetName);
    const raw: Record<string, unknown> = {};
    for (const [k, c] of Object.entries(ws)) {
      if (!/^[A-Z]+\d+$/.test(k) || XLSX.utils.decode_cell(k).r + 1 !== row || c.v === undefined) continue;
      raw[k] = c.f ? { value: c.v, formula: c.f } : c.v;
    }
    return { file, sheet: sheetName, row, cells, raw };
  };

  // 1. Archive every populated cell (values, formulas, comments) as evidence.
  for (const name of book.SheetNames) {
    const ws = sheet(name);
    const cells: State['archives'][number]['cells'] = {};
    for (const [k, c] of Object.entries(ws)) {
      if (!/^[A-Z]+\d+$/.test(k)) continue;
      const note = (c as { c?: { t: string }[] }).c?.map(x => x.t).join('\n');
      if (c.v === undefined && !c.f && !note) continue;
      cells[k] = { value: c.v ?? null, ...(c.f ? { formula: c.f } : {}), ...(note ? { note } : {}) };
    }
    s.archives.push({ name, cells, populatedRows: populatedRows(ws).length });
  }

  // 2. Members: TAGS first, then names found in monthly sheets. Exact names only; similar names are flagged, never merged.
  const members = new Map<string, Member>();
  const member = (value: unknown, where?: Source): Member | undefined => {
    const { name, note } = nameParts(value);
    if (!name || CATEGORY_LABELS.has(name) || NOT_NAMES.test(name) || !/[A-Z]{2}/.test(name)) return undefined;
    let m = members.get(name);
    if (!m) {
      m = { id: id(), name, aliases: [], notes: '', exceptions: [] };
      const similar = [...members.values()].filter(x => x.name.split(' ')[0] === name.split(' ')[0]);
      members.set(name, m);
      s.members.push(m);
      if (where) issue({ kind: 'Name only in monthly sheet', memberId: m.id, source: where, reason: `${name} appears in ${where.sheet} but not in TAGS${similar.length ? `; similar to ${similar.map(x => x.name).join(', ')} — confirm these are different people` : ''}.` });
    }
    if (note && !m.notes.includes(note)) m.notes = [m.notes, `Workbook annotation: ${note}`].filter(Boolean).join('\n');
    return m;
  };
  if (book.Sheets.TAGS) for (const row of populatedRows(sheet('TAGS'))) member(sheet('TAGS')['B' + row]?.v ?? sheet('TAGS')['A' + row]?.v);

  // 3. Monthly sheets: Share / Paid on / Note groups. Formula cells (summaries, copies) are never payments.
  const legacy: Allocation[] = [];
  let skippedFormulaCells = 0, zeroCells = 0;
  const monthlySheets = book.SheetNames.filter(n => /^20\d{2}$/.test(n)).sort();
  for (const name of monthlySheets) {
    const ws = sheet(name);
    // Month names sit in row 2 above each Share / Paid on / Note group (row 3 labels only some groups).
    // The formula summary copy starts at a second NAME column; nothing from there on is read.
    const summaryStart = Math.min(...Object.entries(ws)
      .filter(([k, c]) => /^[A-Z]+[1-3]$/.test(k) && XLSX.utils.decode_cell(k).c > 0 && norm(c.v) === 'NAME')
      .map(([k]) => XLSX.utils.decode_cell(k).c), Infinity);
    const groups: { col: number; month: string }[] = [];
    for (const [k, c] of Object.entries(ws)) {
      if (!/^[A-Z]+2$/.test(k) || c.f || typeof c.v !== 'string') continue;
      const idx = MONTHS.indexOf(norm(c.v).slice(0, 3));
      const col = XLSX.utils.decode_cell(k).c;
      const header = ws[XLSX.utils.encode_cell({ r: 2, c: col })];
      if (idx < 0 || col >= summaryStart || (header?.v !== undefined && norm(header.v) !== 'SHARE')) continue;
      groups.push({ col, month: `${name}-${String(idx + 1).padStart(2, '0')}` });
    }
    if (new Set(groups.map(g => g.month)).size !== groups.length) throw Error(`Sheet ${name} lists a month twice; migration stopped without saving.`);
    for (const row of populatedRows(ws).filter(r => r >= 4)) {
      const nameCell = ws['A' + row];
      if (!nameCell?.v || nameCell.f) continue;
      const m = member(nameCell.v, source(name, row, 'A' + row));
      if (!m) continue;
      for (const g of groups) {
        const addr = XLSX.utils.encode_cell({ r: row - 1, c: g.col });
        const cell = ws[addr];
        if (!cell || cell.v === undefined || cell.v === '') continue;
        if (cell.f) { skippedFormulaCells++; continue; }
        const paidCell = ws[XLSX.utils.encode_cell({ r: row - 1, c: g.col + 1 })];
        const noteCell = ws[XLSX.utils.encode_cell({ r: row - 1, c: g.col + 2 })];
        const src = source(name, row, addr);
        const p = amount(cell.v);
        const note = clean(noteCell?.v);
        if (p === undefined || p < 0) { issue({ kind: 'Monthly cell needs interpretation', memberId: m.id, source: src, reason: `${m.name} ${g.month}: “${clean(cell.v)}” is not an amount. Kept in the archive only.` }); continue; }
        if (p === 0) { zeroCells++; continue; }
        const received = date(paidCell?.v);
        const paidText = clean(paidCell?.v);
        if (paidText && !received) issue({ kind: 'Unclear payment date', memberId: m.id, source: src, reason: `${m.name} ${g.month}: “Paid on” is “${paidText}”. Allocation kept; it is excluded from dated reports until clarified.` });
        legacy.push({ id: id(), memberId: m.id, month: g.month, amount: p, kind: 'regular', received, source: src, legacy: true, note: [note, paidText && !received ? `Paid on: ${paidText}` : ''].filter(Boolean).join(' · ') });
      }
    }
  }

  // 4. Joining contribution and start month, from the recorded allocations.
  for (const m of s.members) {
    const list = legacy.filter(a => a.memberId === m.id).sort((a, b) => a.month.localeCompare(b.month));
    const first = list[0];
    if (!first) continue;
    if (first.amount === s.settings.joiningAmount) {
      first.kind = 'joining';
      first.note = [first.note, 'Initial joining contribution (kept whole)'].filter(Boolean).join(' · ');
      m.joiningMonth = first.month;
      m.joined = first.received;
      const next = list.find(a => a !== first && a.kind === 'regular');
      if (next && next.month === addMonth(first.month)) m.start = next.month;
      else {
        m.suggestedStart = next?.month ?? addMonth(first.month);
        issue({ kind: 'Contribution start month', memberId: m.id, suggestion: m.suggestedStart, reason: `${m.name}: joined ${first.month} (₹350${first.received ? ` paid ${first.received}` : ''}); ${next ? `first regular payment recorded for ${next.month}` : 'no regular payment recorded yet'}. Confirm when regular contributions start. No dues are calculated until confirmed.` });
      }
    } else {
      m.suggestedStart = first.month;
      issue({ kind: 'Contribution start month', memberId: m.id, suggestion: first.month, reason: `${m.name}: no ₹350 joining entry; first recorded payment is ${money(first.amount)} for ${first.month}. Confirm when regular contributions start. No dues are calculated until confirmed.` });
    }
    for (const a of list.filter(a => a !== first && a.amount === s.settings.joiningAmount)) {
      issue({ kind: 'Later ₹350 entry', memberId: m.id, allocationId: a.id, source: a.source, reason: `${m.name} ${a.month}: ₹350 recorded after joining. Preserved as recorded (not treated as another joining payment).` });
    }
    for (const a of list.filter(a => a.kind === 'regular' && a.amount !== 20000 && a.amount !== s.settings.joiningAmount)) {
      issue({ kind: 'Unusual monthly amount', memberId: m.id, allocationId: a.id, source: a.source, reason: `${m.name} ${a.month}: ${money(a.amount)} recorded. Preserved as recorded.` });
    }
  }

  // 5. Bank transactions from the *_Trxns sheets.
  const bank: Receipt[] = [];
  const sheetRecon: Record<string, unknown>[] = [];
  let duplicates = 0, invalid = 0, order = 0;
  const trxnSheets = book.SheetNames.filter(n => /^20\d{2}_Trxns$/.test(n)).sort();
  let previousClosing: number | undefined;
  for (const name of trxnSheets) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet(name), { header: 1, raw: true, defval: '', blankrows: true });
    const table = tableFromRows(rows, s, name);
    const col = (label: RegExp) => table.headers.findIndex(h => label.test(norm(h)));
    const labelCol = col(/^PAID BY\/PAID FOR$/), typeCol = col(/^TYPE$/), remarksCol = col(/^REMARKS$/);
    const parsed = parseRows(table, file, batchId);
    for (const i of parsed.invalid) { invalid++; issue({ kind: 'Invalid workbook transaction', source: source(name, i.row), reason: `${name} row ${i.row}: ${i.reason}` }); }
    const sheetRows: Receipt[] = [];
    for (const r of parsed.receipts) {
      const raw = rows[r.source.row - 1] ?? [];
      r.source = source(name, r.source.row);
      r.order = order++;
      r.historical = true;
      r.reference = bankRef(r.narration);
      r.label = clean(raw[labelCol]);
      r.type = typeCol >= 0 ? clean(raw[typeCol]) : undefined;
      r.remarks = remarksCol >= 0 ? clean(raw[remarksCol]) : undefined;
      const { name: labelName } = nameParts(r.label);
      const m = members.get(labelName);
      const wb = workbookCategory(labelName, r.type ?? '', r);
      r.status = 'confirmed';
      if (m && r.credit > 0 && wb !== 'Refund / reversal') {
        r.memberId = m.id; r.category = 'Member contribution'; r.reason = `Workbook assignment (${name}!B${r.source.row})`;
      } else if (wb && wb !== 'Refund / reversal') {
        r.category = wb; r.reason = `Workbook category (${[r.label, r.type].filter(Boolean).join(' / ')})`;
      } else if (wb === 'Refund / reversal') {
        r.category = wb; r.status = 'review'; r.reason = 'Workbook reversal/refund — link it to the original transaction';
      } else if (m && r.debit > 0) {
        r.category = 'Other expense'; r.status = 'review'; r.reason = `Debit labelled with member ${m.name} — may be a reimbursement; confirm the category`;
      } else if (labelName === 'UNKNOWN' || !labelName) {
        r.category = 'Unclassified'; r.status = 'review'; r.candidates = r.credit ? fuzzyCandidates(s, r.narration) : [];
        r.reason = r.credit ? 'Workbook marks the contributor as unknown' : 'Workbook gives no category';
      } else if (labelName === 'MISC' && r.credit > 0) {
        r.category = 'Other donation'; r.status = 'review'; r.reason = 'Workbook label MISC on a credit; confirm the category';
      } else {
        r.category = 'Unclassified'; r.status = 'review'; r.candidates = fuzzyCandidates(s, r.narration);
        r.reason = `Workbook label “${r.label}” is not a member or category`;
      }
      const dup = findDuplicate(bank.filter(x => x.source.sheet !== name), r, new Set());
      if (dup.confirmed) { duplicates++; issue({ kind: 'Workbook duplicate skipped', source: r.source, reason: `${name} row ${r.source.row} repeats ${dup.confirmed.source.sheet} row ${dup.confirmed.source.row} (${r.date} ${money(r.credit || r.debit)}). Counted once.` }); continue; }
      if (dup.candidate) { r.duplicateOf = dup.candidate.id; r.status = 'review'; r.reason = `Possible duplicate of ${dup.candidate.source.sheet} row ${dup.candidate.source.row}`; }
      bank.push(r); sheetRows.push(r); s.receipts.push(r);
    }
    const rec = reconcile(sheetRows);
    const first = sheetRows[0];
    const opening = first?.balance !== undefined ? first.balance - first.credit + first.debit : undefined;
    if (previousClosing !== undefined && opening !== undefined && previousClosing !== opening) {
      issue({ kind: 'Reconciliation difference', source: first.source, reason: `${name} opens at ${money(opening)} but the previous sheet closed at ${money(previousClosing)} (difference ${money(opening - previousClosing)}).` });
    }
    for (const msg of rec.rowIssues) issue({ kind: 'Reconciliation difference', reason: `Running balance: ${msg}` });
    previousClosing = rec.closing;
    sheetRecon.push({ sheet: name, rows: sheetRows.length, opening: rec.opening, credits: rec.credits, debits: rec.debits, closing: rec.closing, balanceBreaks: rec.rowIssues.length });
  }

  // 5b. Historical reversals. A failed payment and its reversal are often both labelled REVERSAL: pair
  // them (same amount, opposite direction, within 10 days, unique) so they net to zero; records are kept.
  const open = () => s.receipts.filter(x => x.category === 'Refund / reversal' && x.status === 'review' && !x.reversalOf);
  for (const r of open()) {
    if (r.status !== 'review') continue;
    const pair = open().filter(o => o.id !== r.id && o.status === 'review' && o.credit === r.debit && o.debit === r.credit && o.date <= r.date && (Date.parse(r.date) - Date.parse(o.date)) / 86400000 <= 10);
    const mirror = pair.length === 1 ? open().filter(x => x.id !== pair[0].id && x.status === 'review' && x.credit === pair[0].debit && x.debit === pair[0].credit && Math.abs(Date.parse(x.date) - Date.parse(pair[0].date)) / 86400000 <= 10) : [];
    if (pair.length === 1 && mirror.length === 1 && mirror[0].id === r.id) {
      const o = pair[0];
      o.status = 'confirmed'; o.reason = 'Workbook reversal pair (original)';
      r.status = 'confirmed'; r.reversalOf = o.id; r.reason = `Workbook reversal pair: reverses ${o.date} ${money(o.credit || o.debit)}`;
    }
  }
  // MISC credits that are clearly bank interest.
  for (const r of s.receipts.filter(x => x.status === 'review' && x.credit > 0 && norm(x.label) === 'MISC' && /\bSBINT\b|\bINTEREST\b/.test(norm(x.narration)))) {
    r.category = 'Bank interest'; r.status = 'confirmed'; r.reason = 'Workbook MISC credit recognised as bank interest';
  }
  for (const r of open()) {
    const byRef = s.receipts.filter(o => o.id !== r.id && r.reference && o.reference === r.reference && o.credit === r.debit && o.debit === r.credit);
    const candidates = byRef.length ? byRef : reversalCandidates(s, r).filter(o => (Date.parse(r.date) - Date.parse(o.date)) / 86400000 <= 10);
    r.candidates = candidates.map(x => x.id);
    if (candidates.length !== 1) { r.reason = candidates.length ? 'Workbook reversal: several possible originals — choose one' : 'Workbook reversal/refund without a clear original transaction'; }
  }

  // 6. Link recorded month allocations to bank receipts where the evidence is unique.
  const byMemberDate = new Map<string, Allocation[]>();
  for (const a of legacy) {
    if (!a.received) continue;
    const k = `${a.memberId}|${a.received}`;
    byMemberDate.set(k, [...(byMemberDate.get(k) ?? []), a]);
  }
  s.allocations.push(...legacy);
  const credits = s.receipts.filter(r => r.credit > 0 && r.status === 'confirmed' && r.memberId);
  const dayDiff = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
  const link = (group: Allocation[], r: Receipt, how: string) => {
    for (const a of group) { a.receiptId = r.id; a.legacy = false; a.note = [a.note, how].filter(Boolean).join(' · '); }
    if (group.some(a => a.kind === 'joining') && group.every(a => a.kind === 'joining' || a.memberId !== r.memberId)) r.category = 'Joining contribution';
  };
  let exactLinks = 0, nearLinks = 0, partialLinks = 0;
  const pending: Allocation[][] = [];
  for (const group of byMemberDate.values()) {
    const sum = group.reduce((v, a) => v + a.amount, 0);
    const same = credits.filter(r => r.memberId === group[0].memberId && r.date === group[0].received && available(s, r) >= sum);
    if (same.length === 1) { link(group, same[0], ''); exactLinks++; } else pending.push(group);
  }
  let stillPending: Allocation[][] = [];
  for (const group of pending) {
    const sum = group.reduce((v, a) => v + a.amount, 0);
    const near = credits.filter(r => r.memberId === group[0].memberId && dayDiff(r.date, group[0].received!) <= 4 && available(s, r) >= sum);
    if (near.length === 1) { link(group, near[0], `Linked to receipt of ${near[0].date} (paid-on date ${group[0].received})`); nearLinks++; } else stillPending.push(group);
  }
  // Same member and paid-on date, but the months do not fit one receipt exactly (several receipts that
  // day, or more months recorded than the receipt covers): fill receipts in date order, month by month,
  // never beyond a receipt's amount. Whatever does not fit stays a legacy record.
  for (const pass of [0, 4]) {
    const next: Allocation[][] = [];
    for (const group of stillPending) {
      const receipts = credits.filter(r => r.memberId === group[0].memberId && dayDiff(r.date, group[0].received!) <= pass && available(s, r) > 0)
        .sort((a, b) => dayDiff(a.date, group[0].received!) - dayDiff(b.date, group[0].received!) || a.order - b.order);
      const rest: Allocation[] = [];
      for (const a of [...group].sort((x, y) => x.month.localeCompare(y.month))) {
        const r = receipts.find(x => available(s, x) >= a.amount);
        if (r) { link([a], r, pass ? `Linked to receipt of ${r.date} (paid-on date ${a.received})` : ''); partialLinks++; } else rest.push(a);
      }
      if (rest.length) next.push(rest);
    }
    stillPending = next;
  }
  // A receipt that paid for several members: the sender's receipt has exactly the remaining amount.
  let crossLinks = 0;
  for (const group of stillPending) {
    const sum = group.reduce((v, a) => v + a.amount, 0);
    const other = s.receipts.filter(r => r.credit > 0 && r.status === 'confirmed' && dayDiff(r.date, group[0].received!) <= 1 && available(s, r) === sum && r.memberId !== group[0].memberId);
    if (other.length === 1) { link(group, other[0], `Paid within a receipt labelled ${other[0].label || 'another member'}`); crossLinks++; }
  }
  for (const a of legacy.filter(a => !a.receiptId)) {
    const m = s.members.find(x => x.id === a.memberId)!;
    const credit = credits.filter(r => r.memberId === a.memberId && a.received && dayDiff(r.date, a.received) <= 4);
    issue({
      kind: 'Unmatched historical allocation', memberId: a.memberId, allocationId: a.id, source: a.source,
      reason: `${m.name} ${a.month} ${money(a.amount)}${a.received ? ` paid ${a.received}` : ''}: ${!a.received ? 'no payment date, ' : credit.length ? 'the nearby receipt is already fully allocated or amounts differ, ' : 'no matching bank receipt, '}kept as a legacy workbook record. No bank income added.`,
    });
  }
  // Member receipts without a (full) monthly allocation → unapplied credit, listed for review.
  const unallocated = credits.filter(r => available(s, r) > 0);
  for (const r of unallocated) {
    issue({ kind: 'Receipt not fully allocated in monthly sheets', receiptId: r.id, memberId: r.memberId, source: r.source, reason: `${r.date} ${money(r.credit)} for ${s.members.find(m => m.id === r.memberId)?.name}: ${money(available(s, r))} is not allocated to any month in the workbook. Shown as unapplied credit.` });
  }

  // 7. Supplementary charity records, linked to bank debits by date and amount (never added to totals).
  const debits = s.receipts.filter(r => r.debit > 0 && r.category === 'Charity expenditure');
  const addCharity = (sheetName: string, row: number, dateValue: unknown, amountValue: unknown, description: unknown, beneficiary: unknown, referral: unknown) => {
    const p = amount(amountValue);
    if (!p || p <= 0) return;
    let d = date(dateValue);
    let monthOnly: string | undefined;
    if (!d) { const idx = MONTHS.indexOf(norm(dateValue).slice(0, 3)); if (idx >= 0 && /^\d{4}/.test(sheetName)) monthOnly = `${sheetName.slice(0, 4)}-${String(idx + 1).padStart(2, '0')}`; }
    const exact = debits.filter(r => r.debit === p && d && r.date === d);
    const near = exact.length ? exact : debits.filter(r => r.debit === p && ((d && dayDiff(r.date, d) <= 5) || (monthOnly && r.date.startsWith(monthOnly))));
    s.charity.push({ id: id(), date: d, amount: p, description: [clean(description), monthOnly && !d ? `(month: ${monthOnly})` : ''].filter(Boolean).join(' '), beneficiary: clean(beneficiary), referral: clean(referral), source: source(sheetName, row), receiptId: near.length === 1 ? near[0].id : undefined });
    if (!d && !monthOnly) d = undefined;
  };
  const cs = (n: string) => book.Sheets[n] ? sheet(n) : undefined;
  let ws = cs('Charity New'); if (ws) for (const row of populatedRows(ws).filter(r => r > 1)) addCharity('Charity New', row, ws['B' + row]?.v, ws['E' + row]?.v, ws['D' + row]?.v, ws['C' + row]?.v, ws['F' + row]?.v);
  ws = cs('Charity'); if (ws) for (const row of populatedRows(ws).filter(r => r > 1)) addCharity('Charity', row, ws['A' + row]?.v, ws['B' + row]?.v, ws['C' + row]?.v, '', '');
  ws = cs('2024_CHARITY'); if (ws) {
    let month: unknown;
    for (const row of populatedRows(ws).filter(r => r > 2)) {
      if (ws['A' + row]?.v) month = ws['A' + row].v;
      if (ws['B' + row]?.f) continue;
      addCharity('2024_CHARITY', row, month, ws['B' + row]?.v, ws['C' + row]?.v, ws['D' + row]?.v, ws['E' + row]?.v);
    }
  }
  ws = cs('Sheet12'); if (ws) for (const row of populatedRows(ws)) {
    if (date(ws['F' + row]?.v) && !ws['G' + row]?.f) addCharity('Sheet12', row, ws['F' + row].v, ws['G' + row]?.v, ws['K' + row]?.v, '', '');
    if (date(ws['M' + row]?.v) && !ws['P' + row]?.f) addCharity('Sheet12', row, ws['M' + row].v, ws['P' + row]?.v, ws['O' + row]?.v, ws['N' + row]?.v, '');
  }

  // 8. Candidate matching rules from the confirmed history.
  trainRules(s);
  const conflictingSenders = new Set(s.rules.filter(r => r.memberId && r.note?.startsWith('Conflict')).map(r => r.token));
  if (conflictingSenders.size) issue({ kind: 'Sender pays for several members', reason: `${conflictingSenders.size} bank sender identities have paid for more than one member (for example a relative paying for two people). Payments from them will always go to review. See Matching rules → Conflicting senders.` });

  // 9. Report
  const sum = (list: { amount: number }[]) => list.reduce((v, a) => v + a.amount, 0);
  const confirmedBank = s.receipts.filter(r => r.status === 'confirmed');
  const memberCredits = confirmedBank.filter(r => r.memberId);
  const perMember = s.members.map(m => {
    const allocs = legacy.filter(a => a.memberId === m.id);
    const receipts = memberCredits.filter(r => r.memberId === m.id);
    return { name: m.name, allocatedPaise: sum(allocs), receivedPaise: receipts.reduce((v, r) => v + r.credit, 0) };
  }).filter(x => x.allocatedPaise !== x.receivedPaise);
  const workbookFigures: Record<string, unknown> = {};
  for (const n of ['2025 Statement', 'Consolidated Details of Credits', 'Misc Credit & Debit Details']) {
    const w = cs(n); if (!w) continue;
    for (const row of populatedRows(w)) {
      const cells = Object.entries(w).filter(([k]) => /^[A-Z]+\d+$/.test(k) && XLSX.utils.decode_cell(k).r + 1 === row).map(([, c]) => c.v);
      const label = cells.find(v => typeof v === 'string'); const value = cells.find(v => typeof v === 'number');
      if (label && value !== undefined) workbookFigures[`${n}: ${label}`] = value;
    }
  }
  const openIssues = s.issues.filter(i => !i.resolved);
  const issueCounts: Record<string, number> = {};
  for (const i of openIssues) issueCounts[i.kind] = (issueCounts[i.kind] ?? 0) + 1;
  const report: Record<string, unknown> = {
    sheets: book.SheetNames.length,
    populatedSheets: s.archives.filter(a => a.populatedRows).length,
    archivedCells: s.archives.reduce((v, a) => v + Object.keys(a.cells).length, 0),
    members: s.members.length,
    membersWithConfirmedStart: s.members.filter(m => m.start).length,
    membersNeedingStartMonth: s.members.filter(m => !m.start).length,
    bankTransactions: s.receipts.length,
    bankCreditsPaise: s.receipts.reduce((v, r) => v + r.credit, 0),
    bankDebitsPaise: s.receipts.reduce((v, r) => v + r.debit, 0),
    firstTransaction: bank.map(r => r.date).sort()[0],
    lastTransaction: bank.map(r => r.date).sort().at(-1),
    closingBalancePaise: previousClosing,
    workbookDuplicatesSkipped: duplicates,
    invalidRows: invalid,
    transactionsForReview: s.receipts.filter(r => r.status === 'review').length,
    memberContributionReceipts: memberCredits.length,
    memberContributionPaise: memberCredits.reduce((v, r) => v + r.credit, 0),
    monthlyAllocations: legacy.length,
    monthlyAllocationPaise: sum(legacy),
    joiningContributions: legacy.filter(a => a.kind === 'joining').length,
    allocationsLinkedExactDate: legacy.filter(a => a.receiptId && !a.note.includes('Linked to receipt of') && !a.note.includes('Paid within')).length,
    allocationGroupsLinkedExact: exactLinks,
    allocationGroupsLinkedNearDate: nearLinks,
    allocationGroupsLinkedToOtherLabel: crossLinks,
    allocationsLinkedPartially: partialLinks,
    legacyUnmatchedAllocations: legacy.filter(a => !a.receiptId).length,
    legacyUnmatchedPaise: sum(legacy.filter(a => !a.receiptId)),
    receiptsNotFullyAllocated: unallocated.length,
    unappliedCreditPaise: unallocated.reduce((v, r) => v + available(s, r), 0),
    formulaCellsIgnored: skippedFormulaCells,
    zeroCellsIgnored: zeroCells,
    charityRecords: s.charity.length,
    charityRecordsLinkedToBank: s.charity.filter(c => c.receiptId).length,
    charityBankDebitsPaise: s.receipts.filter(r => r.category === 'Charity expenditure').reduce((v, r) => v + r.debit, 0),
    identityRules: s.rules.filter(r => r.memberId).length,
    validatedIdentityRules: s.rules.filter(r => r.memberId && r.validated).length,
    conflictingSenderTokens: conflictingSenders.size,
    categoryRules: s.rules.filter(r => r.category).length,
    unresolvedItems: openIssues.length,
    unresolvedByKind: issueCounts,
    perSheetReconciliation: sheetRecon,
    membersWhereAllocatedDiffersFromReceived: perMember,
    workbookSummaryFigures: workbookFigures,
  };
  const dates = bank.map(r => r.date).sort();
  const batch: Batch = {
    id: batchId, file, hash: digest, kind: 'workbook', at: new Date().toISOString(), imported: s.receipts.length, duplicates,
    review: s.receipts.filter(r => r.status === 'review').length + openIssues.length, auto: s.receipts.filter(r => r.status === 'confirmed').length,
    from: dates[0], to: dates.at(-1), reconciliation: reconcile(bank), report,
  };
  for (const r of s.receipts) r.batch = batchId;
  s.batches.push(batch);
  audit(s, 'Workbook migrated', `${file}: ${s.members.length} members, ${s.receipts.length} bank transactions, ${legacy.length} month allocations preserved; ${openIssues.length} items for review.`, undefined, report);
  return s;
}
