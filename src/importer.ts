// Bank statement parsing, duplicate detection and staged (all-or-nothing) import.
import * as XLSX from 'xlsx';
import { Batch, Mapping, Receipt, Reconciliation, State, audit, id, money, norm } from './model';
import { processReceipt } from './engine';
import { changesBetween } from './storage';
import { senderOf } from './matching';

/** Strip Excel text wrappers such as ="123" and surrounding whitespace. */
export function clean(v: unknown) {
  return String(v ?? '').trim().replace(/^="([\s\S]*)"$/, '$1').replace(/^=$/, '').trim();
}

/** Parse an amount to integer paise. Returns undefined when the text is not a valid amount. */
export function amount(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : undefined;
  const t0 = clean(v);
  if (t0 === '' || t0 === '-') return 0;
  let text = t0.replace(/^(?:Rs\.?|INR|₹)\s*/i, '').replace(/,/g, '').replace(/\s+/g, '');
  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1); }
  const suffix = text.match(/(CR|DR)$/i);
  if (suffix) { text = text.slice(0, -2); if (suffix[1].toUpperCase() === 'DR') negative = !negative; }
  if (text.startsWith('-')) { negative = !negative; text = text.slice(1); }
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return undefined;
  const [whole, fraction = ''] = text.split('.');
  const p = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(p) ? (negative ? -p : p) : undefined;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function validDate(y: number, m: number, d: number) {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : undefined;
}

/** Parse Indian-style dates (DD-MM-YYYY, DD Mon YYYY), ISO dates, Excel serials and Date objects. */
export function date(v: unknown): string | undefined {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : validDate(v.getFullYear(), v.getMonth() + 1, v.getDate());
  if (typeof v === 'number') {
    if (v < 1 || v > 100000) return undefined;
    const d = XLSX.SSF.parse_date_code(v);
    return d ? validDate(d.y, d.m, d.d) : undefined;
  }
  const t = clean(v);
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]|$)/);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{1,2})[-/ .](\d{1,2})[-/ .](\d{2}|\d{4})(?=\s|$|T)/);
  if (m) return validDate(+m[3] + (m[3].length === 2 ? 2000 : 0), +m[2], +m[1]);
  m = t.match(/^(\d{1,2})[-/ .]?([A-Za-z]{3,9})[-/ .,]*(\d{2}|\d{4})(?=\s|$)/);
  if (m) {
    const month = MONTHS.indexOf(m[2].slice(0, 3).toUpperCase()) + 1;
    return month ? validDate(+m[3] + (m[3].length === 2 ? 2000 : 0), month, +m[1]) : undefined;
  }
  return undefined;
}

/** RFC-4180 CSV parser that also understands Excel's ="..." text wrappers. */
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], value = '', quoted = false, wrapped = false;
  text = text.replace(/^﻿/, '');
  const push = () => { row.push(wrapped && value.startsWith('=') ? value.slice(1) : value); value = ''; wrapped = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { value += '"'; i++; } else quoted = false; }
      else value += c;
    } else if (c === '"' && (value === '' || value === '=')) { quoted = true; wrapped = value === '='; }
    else if (c === ',') push();
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; push(); rows.push(row); row = []; }
    else value += c;
  }
  if (quoted) throw Error('The CSV has an unclosed quoted field. Nothing was saved.');
  if (value || row.length) { push(); rows.push(row); }
  return rows;
}

export interface Table {
  rows: unknown[][];
  header: number;
  headers: string[];
  signature: string;
  mapping: Mapping;
  known: boolean;
  sheet?: string;
  opening?: number;
  closing?: number;
}

export const emptyMapping = (): Mapping => ({ date: -1, valueDate: -1, narration: -1, debit: -1, credit: -1, reference: -1, balance: -1, amount: -1, direction: -1 });

export const mappingFields: { key: keyof Mapping; label: string; required?: boolean }[] = [
  { key: 'date', label: 'Transaction date', required: true },
  { key: 'valueDate', label: 'Value date' },
  { key: 'narration', label: 'Narration / description', required: true },
  { key: 'debit', label: 'Debit (withdrawal)' },
  { key: 'credit', label: 'Credit (deposit)' },
  { key: 'amount', label: 'Single amount column' },
  { key: 'direction', label: 'Dr/Cr indicator' },
  { key: 'reference', label: 'Reference / cheque no.' },
  { key: 'balance', label: 'Balance' },
];

const HEADER_PATTERNS: Record<keyof Mapping, RegExp> = {
  date: /^(TXN DATE|TRANSACTION DATE|TRAN DATE|DATE|POSTING DATE)$/,
  valueDate: /^(VALUE DATE|VALUE DT)$/,
  narration: /^(DESCRIPTION|NARRATION|PARTICULARS|DETAILS|TRANSACTION DETAILS|REMARKS)$/,
  debit: /^(DEBIT|WITHDRAWAL|WITHDRAWALS|WITHDRAWAL AMT\.?|WITHDRAWAL AMOUNT|DEBIT AMOUNT|DR)$/,
  credit: /^(CREDIT|DEPOSIT|DEPOSITS|DEPOSIT AMT\.?|DEPOSIT AMOUNT|CREDIT AMOUNT|CR)$/,
  reference: /^(CHEQUE NO\.?|CHQ\.?\/REF\.? NO\.?|REFERENCE|REFERENCE NO\.?|TRANSACTION ID|REF NO\.?|UTR)$/,
  balance: /^(BALANCE|CLOSING BALANCE|RUNNING BALANCE|BALANCE AMT\.?)$/,
  amount: /^(AMOUNT|TRANSACTION AMOUNT)$/,
  direction: /^(DR\/CR|CR\/DR|TYPE|DIRECTION)$/,
};

/** Formats the app recognises without asking for a mapping. Add new bank signatures here. */
export const KNOWN_FORMATS: { name: string; test: (signature: string) => boolean }[] = [
  { name: 'Canara Bank CSV', test: sig => sig.startsWith('TXN DATE|VALUE DATE|CHEQUE NO.|DESCRIPTION') },
  { name: 'SAHHO workbook transactions', test: sig => sig.startsWith('DESCRIPTION|PAID BY/PAID FOR|DEBIT|CREDIT|VALUE DATE') },
];

export function tableFromRows(rows: unknown[][], s: State, sheet?: string): Table {
  const isDate = (c: unknown) => HEADER_PATTERNS.date.test(norm(clean(c))) || HEADER_PATTERNS.valueDate.test(norm(clean(c)));
  let header = rows.findIndex(r => r.some(isDate) && r.some(c => HEADER_PATTERNS.narration.test(norm(clean(c)))));
  if (header < 0) header = rows.findIndex(r => r.filter(c => clean(c)).length >= 4);
  if (header < 0) throw Error('No transaction table was found in this file.');
  const headers = rows[header].map(c => clean(c));
  const signature = headers.map(norm).filter(Boolean).join('|');
  const map = emptyMapping();
  for (const key of Object.keys(map) as (keyof Mapping)[]) map[key] = headers.findIndex(c => HEADER_PATTERNS[key].test(norm(c)));
  if (map.date < 0) map.date = map.valueDate;
  const meta = (label: RegExp) => {
    const r = rows.slice(0, header).find(r => label.test(norm(clean(r[0]))));
    if (!r) return undefined;
    const v = r.slice(1).find(c => clean(c));
    return v === undefined ? undefined : amount(v);
  };
  const saved = s.mappings[signature];
  return {
    rows, header, headers, signature, sheet,
    mapping: saved ?? map,
    known: !!saved || KNOWN_FORMATS.some(f => f.test(signature)),
    opening: meta(/^OPENING BALANCE/), closing: meta(/^CLOSING BALANCE/),
  };
}

export function readStatement(data: ArrayBuffer, name: string, s: State): Table {
  if (/\.(csv|txt)$/i.test(name)) return tableFromRows(parseCSV(new TextDecoder().decode(data)), s);
  const book = XLSX.read(data, { type: 'array', cellDates: false });
  for (const sheetName of book.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[sheetName], { header: 1, raw: true, defval: '', blankrows: true });
    try { return tableFromRows(rows, s, sheetName); } catch { /* try the next sheet */ }
  }
  throw Error('No supported transaction table was found in this workbook.');
}

/** Reference embedded in a narration (UPI RRN, NEFT UTR, IMPS ref). */
export function bankRef(narration: string) {
  return narration.match(/UPI\/(?:CR|DR)\/(\d{6,})/i)?.[1]
    ?? narration.match(/NEFT\s*Cr-([A-Z]{4}[A-Z0-9]{8,})-/i)?.[1]
    ?? narration.match(/IMPS\/P2A\/(\d{6,})/i)?.[1]
    ?? '';
}

export interface InvalidRow { row: number; reason: string; raw: Record<string, unknown> }

export function parseRows(table: Table, file: string, batch: string): { receipts: Receipt[]; invalid: InvalidRow[] } {
  const map = table.mapping;
  if (map.date < 0 || map.narration < 0 || (map.debit < 0 && map.credit < 0 && (map.amount < 0 || map.direction < 0))) {
    throw Error('Map the date, narration, and either debit/credit or amount with a Dr/Cr column.');
  }
  const receipts: Receipt[] = [], invalid: InvalidRow[] = [];
  const cell = (row: unknown[], i: number) => (i < 0 ? '' : row[i]);
  table.rows.slice(table.header + 1).forEach((row, index) => {
    const rowNum = table.header + index + 2;
    if (!row.some(c => clean(c))) return;
    if (norm(clean(cell(row, map.date))) === norm(table.headers[map.date])) return; // repeated header
    const raw = Object.fromEntries(row.map((v, i) => [`${i + 1}:${table.headers[i] ?? ''}`, v]).filter(([, v]) => clean(v) !== ''));
    const narration = clean(cell(row, map.narration)).replace(/\s+/g, ' ');
    if (/^(TOTAL|GRAND TOTAL|CLOSING BALANCE|OPENING BALANCE|END OF STATEMENT|\*\*)/i.test(narration)) return;
    const hasAmount = [map.debit, map.credit, map.amount].some(i => clean(cell(row, i)));
    if (!clean(cell(row, map.date)) && !hasAmount) return; // footer / note line
    const d = date(cell(row, map.date));
    const vd = map.valueDate < 0 ? d : date(cell(row, map.valueDate)) ?? d;
    let debit = amount(cell(row, map.debit)), credit = amount(cell(row, map.credit));
    if (map.debit < 0 && map.credit < 0) {
      const a = amount(cell(row, map.amount)), dir = norm(clean(cell(row, map.direction)));
      if (a !== undefined && /^(D|DR|DEBIT|WITHDRAWAL)$/.test(dir)) { debit = Math.abs(a); credit = 0; }
      else if (a !== undefined && /^(C|CR|CREDIT|DEPOSIT)$/.test(dir)) { credit = Math.abs(a); debit = 0; }
      else { debit = undefined; credit = undefined; }
    }
    if (map.debit < 0 && map.credit >= 0 && credit !== undefined && credit < 0) { debit = -credit; credit = 0; }
    const balRaw = cell(row, map.balance);
    const balance = map.balance >= 0 && clean(balRaw) ? amount(balRaw) : undefined;
    const reasons: string[] = [];
    if (!d) reasons.push('invalid or missing date');
    if (!narration) reasons.push('missing narration');
    if (debit === undefined || credit === undefined || debit < 0 || credit < 0) reasons.push('unreadable amount');
    else if ((debit > 0) === (credit > 0)) reasons.push(debit > 0 ? 'both debit and credit present' : 'missing amount');
    if (map.balance >= 0 && clean(balRaw) && balance === undefined) reasons.push('unreadable balance');
    if (reasons.length) { invalid.push({ row: rowNum, reason: reasons.join(', '), raw }); return; }
    receipts.push({
      id: id(), date: d!, valueDate: vd!, narration, sender: senderOf(narration), debit: debit!, credit: credit!, balance,
      reference: clean(cell(row, map.reference)) || bankRef(narration), batch, order: index,
      source: { file, sheet: table.sheet, row: rowNum, raw },
      category: 'Unclassified', status: 'review', reason: '', candidates: [],
    });
  });
  return { receipts, invalid };
}

/**
 * Running-balance check in original row order. Rows of the same day may be listed in a different order
 * than the bank processed them, so a day passes when its closing balance is explained; otherwise every
 * row of that day that cannot be explained is reported.
 */
export function balanceBreaks(input: Receipt[], opening?: number) {
  const rows = [...input].sort((a, b) => a.order - b.order);
  if (rows.length > 1 && rows[0].date > rows.at(-1)!.date) rows.reverse(); // newest-first statement
  const breaks: { receipt: Receipt; expected: number; reported: number }[] = [];
  let reorderedDays = 0;
  let balance = opening ?? (rows[0]?.balance !== undefined ? rows[0].balance - rows[0].credit + rows[0].debit : undefined);
  for (let i = 0; i < rows.length;) {
    let j = i;
    while (j < rows.length && rows[j].date === rows[i].date) j++;
    const day = rows.slice(i, j);
    const reported = day.filter(r => r.balance !== undefined);
    if (balance !== undefined && reported.length) {
      let running = balance, sequential = true;
      for (const r of day) { running += r.credit - r.debit; if (r.balance !== undefined && r.balance !== running) sequential = false; }
      const end = balance + day.reduce((v, r) => v + r.credit - r.debit, 0);
      if (!sequential) {
        if (reported.some(r => r.balance === end)) reorderedDays++;
        else {
          let run = balance;
          for (const r of day) { run += r.credit - r.debit; if (r.balance !== undefined && r.balance !== run) breaks.push({ receipt: r, expected: run, reported: r.balance }); }
        }
      }
      balance = reported.some(r => r.balance === end) ? end : reported.at(-1)!.balance;
    } else if (balance !== undefined) balance += day.reduce((v, r) => v + r.credit - r.debit, 0);
    else balance = reported.at(-1)?.balance;
    i = j;
  }
  return { breaks, reorderedDays, rows };
}

/** Opening + credits − debits vs closing, plus unexplained running-balance breaks. */
export function reconcile(input: Receipt[], opening?: number, closing?: number): Reconciliation {
  const { breaks, rows } = balanceBreaks(input, opening);
  const credits = rows.reduce((v, r) => v + r.credit, 0), debits = rows.reduce((v, r) => v + r.debit, 0);
  if (opening === undefined && rows[0]?.balance !== undefined) opening = rows[0].balance - rows[0].credit + rows[0].debit;
  const rowIssues = breaks.map(b => `${b.receipt.source.sheet ?? b.receipt.source.file} row ${b.receipt.source.row} (${b.receipt.date}): reported ${money(b.reported)}, expected ${money(b.expected)}`);
  if (closing === undefined) {
    // Closing = balance after the last day (same-day rows may be listed out of order).
    const lastDate = rows.at(-1)?.date;
    const lastDay = rows.filter(r => r.date === lastDate && r.balance !== undefined);
    const end = opening !== undefined ? opening + credits - debits : undefined;
    closing = lastDay.find(r => r.balance === end)?.balance ?? lastDay.at(-1)?.balance;
  }
  return { opening, closing, credits, debits, difference: opening !== undefined && closing !== undefined ? opening + credits - debits - closing : undefined, rowIssues };
}

const dayDiff = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;

/**
 * Compare an incoming row with rows from earlier imports. `used` holds existing rows already matched in
 * this import so one existing record can absorb only one incoming row (keeps genuine same-day repeats).
 */
export function findDuplicate(existing: Receipt[], r: Receipt, used: Set<string>): { confirmed?: Receipt; candidate?: Receipt } {
  const pool = existing.filter(x => !used.has(x.id) && x.status !== 'duplicate' && x.credit === r.credit && x.debit === r.debit &&
    Math.min(dayDiff(x.date, r.date), dayDiff(x.valueDate, r.valueDate), dayDiff(x.date, r.valueDate), dayDiff(x.valueDate, r.date)) <= 3);
  if (!pool.length) return {};
  const refOK = (x: string) => x && x.replace(/\W/g, '').length >= 6;
  if (refOK(r.reference)) {
    const byRef = pool.find(x => x.reference === r.reference);
    if (byRef) return { confirmed: byRef };
  }
  const sameText = (x: Receipt) => norm(x.narration) === norm(r.narration);
  const sameDay = (x: Receipt) => x.date === r.date || x.valueDate === r.valueDate || x.date === r.valueDate || x.valueDate === r.date;
  const balanceMatch = pool.find(x => sameText(x) && x.balance !== undefined && x.balance === r.balance);
  if (balanceMatch) return { confirmed: balanceMatch };
  // Different strong references on both sides = different transactions.
  const comparable = pool.filter(x => !(refOK(x.reference) && refOK(r.reference) && x.reference !== r.reference));
  const textMatch = comparable.find(x => sameText(x) && sameDay(x));
  if (textMatch) {
    // Same text and day but balances disagree: the bank shows two separate movements.
    if (textMatch.balance !== undefined && r.balance !== undefined && textMatch.balance !== r.balance) return { candidate: textMatch };
    return { candidate: textMatch };
  }
  const balanceOnly = comparable.find(x => x.balance !== undefined && x.balance === r.balance && sameDay(x));
  if (balanceOnly) return { candidate: balanceOnly };
  return {};
}

export async function hash(data: ArrayBuffer) {
  const bytes = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

export interface StagedImport {
  state: State;
  batch: Batch;
  auto: Receipt[];
  review: Receipt[];
  skipped: { row: Receipt; original: Receipt }[];
  invalid: InvalidRow[];
}

/** Parse, validate and process a statement on a copy of the records. Nothing is saved until commit. */
export function stageStatement(current: State, table: Table, file: string, digest: string): StagedImport {
  if (current.batches.some(b => b.hash === digest && !b.undone)) throw Error('This exact file has already been imported. Records are unchanged.');
  const s: State = structuredClone(current);
  delete s.undo;
  const batchId = id();
  const { receipts, invalid } = parseRows(table, file, batchId);
  if (!receipts.length && !invalid.length) throw Error('No transactions were found in this file.');
  const existing = s.receipts.slice();
  const used = new Set<string>();
  const skipped: StagedImport['skipped'] = [];
  const kept: Receipt[] = [];
  const chronological = [...receipts].sort((a, b) => a.order - b.order);
  if (chronological.length > 1 && chronological[0].date > chronological.at(-1)!.date) chronological.reverse();
  for (const r of chronological) {
    const dup = findDuplicate(existing, r, used);
    if (dup.confirmed) { used.add(dup.confirmed.id); skipped.push({ row: r, original: dup.confirmed }); continue; }
    s.receipts.push(r);
    kept.push(r);
    if (dup.candidate) {
      used.add(dup.candidate.id);
      r.duplicateOf = dup.candidate.id;
      r.status = 'review';
      r.category = dup.candidate.category;
      r.reason = 'Possible duplicate of an earlier record. It is excluded from totals until you decide.';
      continue;
    }
    const sameRef = kept.find(x => x !== r && x.reference && x.reference === r.reference && x.credit === r.credit && x.debit === r.debit);
    if (sameRef) { r.duplicateOf = sameRef.id; r.status = 'review'; r.reason = 'Same bank reference appears twice in this file.'; continue; }
    processReceipt(s, r);
  }
  for (const i of invalid) s.issues.push({ id: id(), kind: 'Invalid statement row', reason: `Row ${i.row}: ${i.reason}`, source: { file, sheet: table.sheet, row: i.row, raw: i.raw }, resolved: false });
  const reconciliation = reconcile(receipts, table.opening, table.closing);
  if (reconciliation.difference || reconciliation.rowIssues.length) {
    s.issues.push({ id: id(), kind: 'Reconciliation difference', reason: `${file}: ${reconciliation.difference ? `opening + credits − debits differs from closing by ${money(reconciliation.difference)}. ` : ''}${reconciliation.rowIssues.slice(0, 5).join('; ')}`, resolved: false });
  }
  const dates = receipts.map(r => r.date).sort();
  const auto = kept.filter(r => r.status === 'confirmed');
  const review = kept.filter(r => r.status === 'review');
  const batch: Batch = {
    id: batchId, file, hash: digest, at: new Date().toISOString(), kind: 'statement',
    imported: kept.length, duplicates: skipped.length, review: review.length + invalid.length, auto: auto.length,
    from: dates[0], to: dates.at(-1), reconciliation,
  };
  s.batches.push(batch);
  s.mappings[table.signature] = table.mapping;
  audit(s, 'Statement imported', `${file}: ${kept.length} new (${auto.length} automatic, ${review.length} for review), ${skipped.length} already recorded, ${invalid.length} invalid rows`);
  s.undo = { batchId, revision: current.revision + 1, auditCount: s.audit.length, changes: changesBetween(current, s) };
  return { state: s, batch, auto, review, skipped, invalid };
}
