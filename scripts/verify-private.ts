// Runs the real workbook migration and a statement import locally and writes a report to .private/.
// Usage: npm run verify:private -- "<workbook.xlsx>" "<statement.csv>"
// Paths default to SAHHO_WORKBOOK / SAHHO_STATEMENT environment variables. Output never leaves .private/.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { emptyState, money, State } from '../src/model';
import { migrateWorkbook } from '../src/migration';
import { readStatement, stageStatement } from '../src/importer';
import { validate } from '../src/storage';
import { dashboard } from '../src/reports';

const [workbookPath = process.env.SAHHO_WORKBOOK, statementPath = process.env.SAHHO_STATEMENT] = process.argv.slice(2);
if (!workbookPath) { console.error('Give the workbook path as the first argument or set SAHHO_WORKBOOK.'); process.exit(1); }
const out = resolve('.private');
mkdirSync(out, { recursive: true });

const buffer = (p: string) => { const b = readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };
const sha = (b: ArrayBuffer) => createHash('sha256').update(Buffer.from(b)).digest('hex');

const t0 = Date.now();
const wb = buffer(workbookPath);
let s: State = migrateWorkbook(emptyState(), wb, workbookPath.split(/[\\/]/).pop()!, sha(wb));
validate(s);
const report = s.batches[0].report as Record<string, unknown>;
const lines: string[] = ['# SAHHO migration & reconciliation report (PRIVATE — do not publish)', '', `Generated ${new Date().toISOString()} in ${Date.now() - t0} ms`, ''];
const fmt = (k: string, v: unknown) => (/Paise$/.test(k) && typeof v === 'number' ? money(v) : typeof v === 'object' ? '' : String(v));
lines.push('## Counts and totals', '', '| Item | Value |', '|---|---|');
for (const [k, v] of Object.entries(report)) if (typeof v !== 'object') lines.push(`| ${k} | ${fmt(k, v)} |`);
lines.push('', '## Unresolved items by kind', '', '| Kind | Count |', '|---|---|');
for (const [k, v] of Object.entries(report.unresolvedByKind as Record<string, number>)) lines.push(`| ${k} | ${v} |`);
lines.push('', '## Per-sheet bank reconciliation', '', '| Sheet | Rows | Opening | Credits | Debits | Closing | Balance breaks |', '|---|---|---|---|---|---|---|');
for (const r of report.perSheetReconciliation as Record<string, number>[]) lines.push(`| ${r.sheet} | ${r.rows} | ${money(r.opening)} | ${money(r.credits)} | ${money(r.debits)} | ${money(r.closing)} | ${r.balanceBreaks} |`);
lines.push('', '## Members where monthly-sheet allocations differ from bank receipts assigned to them', '', '| Member | Allocated in monthly sheets | Receipts in transaction sheets | Difference |', '|---|---|---|---|');
for (const r of report.membersWhereAllocatedDiffersFromReceived as { name: string; allocatedPaise: number; receivedPaise: number }[]) lines.push(`| ${r.name} | ${money(r.allocatedPaise)} | ${money(r.receivedPaise)} | ${money(r.allocatedPaise - r.receivedPaise)} |`);
const d = dashboard(s, '2099-12-31');
lines.push('', '## Computed totals vs workbook summary figures', '', `Computed from bank rows: joining ${money(d.joining)}, regular ${money(d.regular)}, charity ${money(d.charity)}, interest ${money(d.interest)}, other expenses ${money(d.otherExpenses)}, closing balance ${money(d.bankBalance)} on ${d.balanceDate}.`, '');
for (const [k, v] of Object.entries(report.workbookSummaryFigures as Record<string, unknown>)) lines.push(`- ${k}: ${v}`);
lines.push('', '## Items needing a decision (first 400)', '');
for (const i of s.issues.filter(i => !i.resolved).slice(0, 400)) lines.push(`- **${i.kind}** — ${i.reason}${i.source ? ` _(${i.source.sheet} row ${i.source.row}${i.source.cells ? ' ' + i.source.cells : ''})_` : ''}`);
lines.push('', '## Transactions needing review', '');
for (const r of s.receipts.filter(r => r.status === 'review')) lines.push(`- ${r.date} ${money(r.credit || -r.debit)} — ${r.reason} — \`${r.narration.slice(0, 90)}\` _(${r.source.sheet} row ${r.source.row}; label ${r.label || '—'}; type ${r.type || '—'})_`);

if (statementPath) {
  const st = buffer(statementPath);
  const name = statementPath.split(/[\\/]/).pop()!;
  const table = readStatement(st, name, s);
  const staged = stageStatement(s, table, name, sha(st));
  validate(staged.state);
  const rec = staged.batch.reconciliation;
  lines.push('', `## Statement import test: ${name}`, '', `Format recognised: ${table.known}. Period ${staged.batch.from} → ${staged.batch.to}.`,
    `Opening ${money(rec.opening)} + credits ${money(rec.credits)} − debits ${money(rec.debits)} vs closing ${money(rec.closing)} → difference ${money(rec.difference)}; running-balance breaks: ${rec.rowIssues.length}.`,
    `New: ${staged.batch.imported} (automatic ${staged.auto.length}, review ${staged.review.length}); already recorded and skipped: ${staged.skipped.length}; invalid: ${staged.invalid.length}.`, '');
  for (const x of staged.skipped) lines.push(`- skipped ${x.row.date} ${money(x.row.credit || -x.row.debit)} = ${x.original.source.sheet} row ${x.original.source.row}`);
  for (const x of staged.auto) lines.push(`- automatic ${x.date} ${money(x.credit || -x.debit)} → ${x.category} ${x.memberId ? s.members.find(m => m.id === x.memberId)?.name ?? staged.state.members.find(m => m.id === x.memberId)?.name : ''} — ${x.reason}`);
  for (const x of staged.review) lines.push(`- review ${x.date} ${money(x.credit || -x.debit)} — ${x.reason}`);
  let again = 'n/a';
  try { stageStatement(staged.state, table, name, sha(st)); again = 'accepted (unexpected)'; } catch (e) { again = `refused: ${(e as Error).message}`; }
  lines.push('', `Re-importing the same file: ${again}`);
  s = staged.state;
}
writeFileSync(resolve(out, 'migration-report.md'), lines.join('\n'), 'utf8');
writeFileSync(resolve(out, 'migration-report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(lines.slice(0, 60).join('\n'));
console.log(`\nFull report: ${resolve(out, 'migration-report.md')}`);
