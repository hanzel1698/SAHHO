# SAHHO contributions

A private, browser-only app for SAHHO's treasurer:

**download bank statement → upload it → the app records familiar contributions automatically → review only the uncertain entries.**

It is a static React + TypeScript site (Vite) that can be hosted on GitHub Pages. All records are stored in the browser's IndexedDB on the device you use. By default nothing is uploaded; optionally the records can be stored in a private Supabase database so treasurers can use them from any device (§8–9). No paid AI is used.

> **Privacy:** never commit the real workbook, bank statements, backups or member data. `.gitignore` blocks `*.xlsx`, `*.csv`, backup files and `.private/`. The repository and the deployed site contain only fictional demo data.

---

## 1. Set up (Windows, macOS or Linux)

Requires Node.js 20 or newer.

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm test           # automated tests (fictional data)
npm run build      # production build in dist/
```

The npm scripts call Node entry points directly (for example `node ./node_modules/vite/bin/vite.js`), so they work even when the folder path contains `&` or spaces.

## 2. First use: migrate the workbook

1. Open the app → **Import** → **Migrate SAHHO workbook** and choose *Sahho Detailed Account*.xlsx.
2. Read the preview (counts, totals, unmatched items) and choose **Commit migration**.
3. Go to **Needs your review → Records & migration** and work through the decisions (see §6).

What migration does:

- Archives **every populated cell** of every sheet (value, formula, comment) with its sheet/cell reference, so the original evidence is kept.
- Members come from `TAGS` and the monthly sheets. Categories (CHARITY, INTEREST, MISC, RECHARGE, UNKNOWN, REFUND, REVERSAL) are never treated as members. Names are matched exactly; similar names are flagged, never merged. Annotations such as `NOEL(300-JAN 2025)` are kept as notes.
- Monthly sheets (`2020`…`2026`): each Share / Paid on / Note group becomes an allocation **exactly as recorded** (month, amount, payment date, note). The 2020 sheet starts in June. The formula summary copy to the right, `_Short` sheets and total rows are archived only — they never become payments.
- The first ₹350 is kept as **one joining contribution** in the month the workbook recorded it. Its payment date is kept separately from the regular start month. If the workbook does not clearly show when ₹200 dues begin, the member is listed for you to confirm — no dues are calculated until you do.
- Transaction sheets (`20xx_Trxns`) become bank transactions with their PAID BY/PAID FOR, Type and Remarks. Manual member assignments are kept.
- Allocations are linked to the bank receipt with the same member and payment date. Allocations that cannot be linked stay as **legacy workbook records**: they count towards the member's months, but **never** as bank income.
- Charity sheets (`Charity New`, `Charity`, `2024_CHARITY`, `Sheet12`) are linked to charity bank debits by date and amount, so spending is not counted twice.
- Matching rules are learned from the confirmed history (see §5).

## 3. Regular use: import a bank statement

**Import → Bank statement** and choose the CSV or Excel file downloaded from net banking.

- Canara Bank CSV (account details above the header, `="..."` values, `Rs.` amounts, `DD-MM-YYYY hh:mm:ss` / `DD Mon YYYY` dates) is recognised automatically.
- For an unfamiliar layout, a column-mapping preview appears once. The approved mapping is remembered for that layout.
- Handles Indian date formats, commas in amounts, Dr/Cr columns, repeated headers, blank rows and newest-first statements.
- The import is **staged**: you see what will be recorded automatically, what needs review, what was already recorded, and the statement check (opening + credits − debits = closing). Nothing is saved until **Commit import**, and the commit is all-or-nothing.

**Duplicates / overlapping statements**

- The exact same file is refused.
- Rows already recorded are skipped when the bank reference matches, or the narration, amount and balance match. Transaction date and value date may differ by a few days (common for interest).
- Each existing record can match only one incoming row, so genuine separate payments on the same day for the same amount are kept.
- Uncertain matches go to review as *Possible duplicates* and are **excluded from all totals** until you decide.

**Undo:** *Backup & settings → Undo last import* shows what will be removed. If you made changes after the import, those are listed and you must confirm them too.

## 4. How contributions are allocated (default policy)

For a confidently identified payment:

1. A member's first ₹350 → the joining contribution (kept whole; never 200 + 150 or 1.75 months). A later ₹350 is a regular payment.
2. A month or period clearly stated in the narration (e.g. `sahho 2026`, `March 2025`, `Jan to Mar 2025`) is used when it matches the amount. Unclear mentions send the payment to review, with oldest-unpaid proposed.
3. Otherwise → the oldest unpaid months, completing part-paid months first (₹100 + ₹100 settle one month).
4. Then future months (advance), up to the limit set in Settings (default 24 months).
5. Anything left is kept as **unapplied credit** for that member.

A receipt can never be allocated beyond its amount. A month is due on day 28 (configurable); later months are *future*, not overdue. Contribution rates have effective months, so a future rate change does not alter past obligations. Members can have exceptions, pauses, waivers and an inactive-from month.

## 5. Matching members (sender ≠ member)

The bank shows the **sender**; the app records the **member being paid for** separately.

- Rules are learned from confirmed history: UPI IDs (VPA), sender names (UPI/NEFT/IMPS), account fragments, and text rules you add.
- Only an enabled, **validated** rule pointing to **one** member records a payment automatically. A UPI ID needs one confirmed payment; a sender name needs two.
- A sender who has paid for several members (e.g. a parent paying for two people) is a *conflict*: their payments always go to review with the candidates listed.
- Generic words (UPI, Payment, bank names…) are never identity evidence. Name similarity only suggests candidates.
- A member's name in a **debit** is treated as a possible reimbursement, never a contribution.
- In **Matching rules** you can edit, disable, validate and **Test** a rule against past transactions. Testing lists proposed changes; nothing confirmed changes until you apply it.

## 6. Review queue

**Needs your review** lists only what could not be resolved: unknown contributors, conflicting or ambiguous third-party payments, possible duplicates, unclear periods, unusual amounts, refunds/reversals, invalid rows, reconciliation differences and migration decisions.

Each item shows the narration, dates, amount, bank sender, the suggestion and the proposed months. Actions:

- **Approve** (optionally choose other months, e.g. `2026-01..2026-06`), and optionally **Remember for next time** (saves a rule).
- **+ New member** for an unfamiliar sender, with joining month and regular start month.
- **Link reversal** to the original: the original's months become unpaid again from the reversal date. Both records are kept.
- **Leave unresolved** — nothing else is blocked.
- A correction of an already-confirmed transaction replaces its allocations and is recorded in the audit history.

## 7. Screens and reports

Dashboard, member register, monthly grid (frozen names, status text on every cell, click for details), transactions ledger with filters, matching rules, and reports. Reports cover the member statement, outstanding as of a date, **contributions by bank receipt month**, **contributions by contribution month**, annual receipts and expenditure, charity and bank reconciliation. All reports use the **reporting date** at the top of the screen and exclude money received after it. Each report exports to CSV or Excel and prints cleanly.

## 8. Backups and storage — please read

- Records live **only in this browser on this device**. They do not synchronise to other devices or people. Clearing browser data deletes them.
- **Export full backup** regularly (the app reminds you after 14 days). A backup includes all members, transactions, allocations, rules, review decisions, archived workbook cells and the audit history.
- **Restore** validates the file first (structure, IDs, integer paise, no receipt over-allocated) and downloads your current records before replacing them.
- If the app is open in several tabs, a change saved in one tab is detected in the others. An older tab cannot overwrite newer data; it reloads instead.

The notes above describe **browser-only mode**. With Supabase configured (§9), records are stored online instead — see below.

### Supabase mode (shared, multi-device)

When the site is built with `VITE_SUPABASE_URL` and `VITE_SUPABASE_KEY`, the app asks the treasurer to sign in and stores the register in Supabase instead of IndexedDB:

- The whole register is one JSON record in `public.sahho_state` (same format as a backup file).
- Saves go through `save_sahho_state(expected, next)`, a compare-and-swap: if another device saved first, the save is refused and the latest records are loaded. Nothing is ever silently overwritten.
- Row-level security: only accounts listed in `public.treasurers` can read or write. Anyone else — including other signed-in users — sees nothing.
- Changes from another device are picked up when the window regains focus and every minute.
- Exported backups still work and remain the recommended offline copy.

## 9. Deploy: Supabase backend + GitHub Pages

### 9a. Supabase (once)

1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor** → paste and run [`supabase/migrations/20260926000000_sahho_state.sql`](supabase/migrations/20260926000000_sahho_state.sql).
3. **Authentication → Sign In / Providers**: turn **off** *Allow new users to sign up* (only invited treasurers may have accounts).
4. **Authentication → Users → Add user → Create new user**: the treasurer's email and a strong password (tick *Auto confirm*).
5. **SQL Editor** — make that account a treasurer:
   ```sql
   insert into public.treasurers (user_id, note)
   select id, 'Treasurer' from auth.users where email = 'treasurer@example.com';
   ```
6. **Project Settings → API Keys**: copy the **Project URL** and the **publishable key** (or legacy `anon` key). Never use the `service_role` / secret key in this app.

For local development, copy `.env.example` to `.env.local` and fill in both values (git-ignored). Without them, `npm run dev` runs in browser-only mode.

### 9b. GitHub Pages

1. Push this folder to a GitHub repository (check `git status` first — no `.xlsx`, `.csv` or backup files should be listed).
2. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. **Settings → Secrets and variables → Actions → Variables**: add `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` (these are public values; security comes from row-level security).
4. Pushing to `main` (or **Actions → Deploy to GitHub Pages → Run workflow**) installs, tests, builds and publishes `dist/`.
5. In Supabase, **Authentication → URL Configuration**: set *Site URL* to `https://<user>.github.io/<repository>/`.

The build uses a relative base path and hash-based navigation (`#/review`), so it works at `https://<user>.github.io/<repository>/` without extra configuration. The deployed site itself contains no data. Without the two variables it deploys the browser-only version.

## 10. Checking the real files locally (private)

```bash
npm run verify:private -- "path/to/Sahho Detailed Account-Final.xlsx" "path/to/statement.csv"
```

This runs the real migration and a statement import in Node and writes `.private/migration-report.md` and `.json`: counts, totals, per-sheet reconciliation, unmatched records, conflicting values and the items needing your decision. `.private/` is git-ignored. `scripts/inspect_sources.py <workbook>` dumps the raw workbook structure to `.private/` as well.

## Project layout

| Path | Purpose |
|---|---|
| `src/model.ts` | Data types (money in integer paise) |
| `src/engine.ts` | Obligations, allocation planning, review decisions, reversals |
| `src/matching.ts` | Sender signals, identity/category rules, fuzzy suggestions |
| `src/importer.ts` | CSV/XLSX parsing, column mapping, duplicate detection, staged import, reconciliation |
| `src/migration.ts` | Workbook migration and migration report |
| `src/reports.ts` | Dashboard figures, grid statuses and reports (UI-independent) |
| `src/storage.ts` | IndexedDB, revision checks, backup validation, schema upgrades, undo |
| `src/cloud.ts` | Supabase sign-in, load and compare-and-swap save |
| `supabase/migrations/` | Database table, row-level security and save function |
| `src/demo.ts` | Fictional demo data and demo statement |
| `src/ui/` | React screens |
| `tests/` | Automated tests on fictional data |

### Known limitations

- `npm audit` reports two moderate advisories in `vitest` (the test runner). It is a development-only dependency and is not part of the built site. The fix requires a major upgrade (vitest 5), which has not been done yet.
- Partial refunds must be handled through a review decision; automatic reversal requires the same amount in the opposite direction.
- Rows in the workbook that are out of date order across days are flagged as reconciliation items rather than silently accepted.
