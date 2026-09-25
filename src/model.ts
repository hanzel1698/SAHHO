// Core data model. All money is integer paise. Months are 'YYYY-MM'; dates are 'YYYY-MM-DD'.

export type Category =
  | 'Joining contribution' | 'Member contribution' | 'Other donation' | 'Bank interest'
  | 'Charity expenditure' | 'Phone recharge' | 'Bank charges' | 'Other expense'
  | 'Refund / reversal' | 'Unclassified';

export const categories: Category[] = [
  'Joining contribution', 'Member contribution', 'Other donation', 'Bank interest',
  'Charity expenditure', 'Phone recharge', 'Bank charges', 'Other expense',
  'Refund / reversal', 'Unclassified',
];
export const contributionCategories: Category[] = ['Joining contribution', 'Member contribution'];

export interface MemberException {
  id?: string;
  from: string;          // first month (inclusive)
  to: string;            // last month (inclusive)
  amount: number;        // due per month during the exception; 0 = waiver or pause
  reason: string;
}

export interface Member {
  id: string;
  name: string;
  aliases: string[];
  notes: string;
  joined?: string;          // date the initial ₹350 was received (receipt date)
  joiningMonth?: string;    // month the workbook recorded the joining contribution against
  start?: string;           // first month of regular obligations (confirmed)
  suggestedStart?: string;  // migration suggestion awaiting confirmation; never used for dues
  inactiveFrom?: string;    // no obligations from this month
  rosterYears?: number[];   // years whose workbook sheet lists this member (the register as kept then)
  exceptions: MemberException[];
}

export interface Source {
  file: string;
  sheet?: string;
  row: number;
  cells?: string;
  raw: Record<string, unknown>;
}

export type ReceiptStatus = 'confirmed' | 'review' | 'duplicate';

/** A bank transaction (credit or debit). Original bank fields never change after import. */
export interface Receipt {
  id: string;
  date: string;          // transaction date (value date when that is all the source gives)
  valueDate: string;
  narration: string;
  sender: string;        // sender/payee identity shown by the bank — not necessarily the member
  debit: number;
  credit: number;
  reference: string;
  balance?: number;
  batch: string;
  order: number;         // original row order within the batch
  source: Source;
  // Classification (may change through audited decisions)
  category: Category;
  memberId?: string;     // SAHHO member this money is for
  status: ReceiptStatus;
  reason: string;
  candidates: string[];
  matchedRules?: string[];
  duplicateOf?: string;
  reversalOf?: string;
  historical?: boolean;
  label?: string;        // workbook PAID BY/PAID FOR
  type?: string;         // workbook Type column
  remarks?: string;      // workbook Remarks column
}

export interface Allocation {
  id: string;
  receiptId?: string;
  memberId: string;
  month: string;
  amount: number;
  kind: 'joining' | 'regular';
  received?: string;     // payment date recorded (receipt date or workbook "Paid on")
  source?: Source;
  legacy: boolean;       // true = workbook allocation not linked to a bank receipt (never bank income)
  note: string;
  reversedBy?: string;
}

export interface Rule {
  id: string;
  token: string;         // e.g. UPI:**12345@OKAXIS, SENDER:RAVI K, TEXT:SAHHO ASHA
  memberId?: string;     // identity rule
  category?: Category;   // classification rule (debits, interest ...)
  enabled: boolean;
  evidence: string[];    // receipt ids supporting it
  validated: boolean;
  origin: 'history' | 'manual';
  note?: string;
}

export interface Issue {
  id: string;
  kind: string;
  reason: string;
  source?: Source;
  memberId?: string;
  allocationId?: string;
  receiptId?: string;
  suggestion?: string;
  resolved: boolean;
  resolution?: string;
}

export interface SheetArchive {
  name: string;
  cells: Record<string, { value: unknown; formula?: string; note?: string }>;
  populatedRows: number;
}

export interface Charity {
  id: string;
  date?: string;
  amount: number;
  description: string;
  beneficiary: string;
  referral: string;
  source: Source;
  receiptId?: string;
}

export interface Mapping {
  date: number; valueDate: number; narration: number; debit: number; credit: number;
  reference: number; balance: number; amount: number; direction: number;
}

export interface Reconciliation {
  opening?: number;
  closing?: number;
  credits: number;
  debits: number;
  difference?: number;
  rowIssues: string[];
}

export interface Batch {
  id: string;
  file: string;
  hash: string;
  at: string;
  kind: 'workbook' | 'statement' | 'demo';
  imported: number;
  duplicates: number;
  review: number;
  auto?: number;
  from?: string;
  to?: string;
  reconciliation: Reconciliation;
  report?: Record<string, unknown>;
  undone?: boolean;
}

export interface Audit {
  id: string;
  at: string;
  action: string;
  detail: string;
  before?: unknown;
  after?: unknown;
}

export interface Settings {
  rates: { from: string; amount: number }[];
  joiningAmount: number;
  advanceMonths: number;
  dueDay: number;
  backupReminderDays: number;
}

export const SCHEMA = 1;

export interface State {
  schema: 1;
  revision: number;
  members: Member[];
  receipts: Receipt[];
  allocations: Allocation[];
  rules: Rule[];
  issues: Issue[];
  charity: Charity[];
  archives: SheetArchive[];
  batches: Batch[];
  audit: Audit[];
  mappings: Record<string, Mapping>;
  settings: Settings;
  lastBackup?: string;
  demo: boolean;
  undo?: { batchId: string; revision: number; auditCount: number; before: Omit<State, 'undo'> };
}

export const defaultSettings = (): Settings => ({
  rates: [{ from: '2000-01', amount: 20000 }],
  joiningAmount: 35000,
  advanceMonths: 24,
  dueDay: 28,
  backupReminderDays: 14,
});

export const emptyState = (): State => ({
  schema: 1, revision: 0, members: [], receipts: [], allocations: [], rules: [], issues: [],
  charity: [], archives: [], batches: [], audit: [], mappings: {}, settings: defaultSettings(), demo: false,
});

let counter = 0;
export const id = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Date.now().toString(36)}-${(counter++).toString(36)}`;

export const today = () => new Date().toLocaleDateString('en-CA');

export const money = (p: number | undefined) =>
  p === undefined ? '—' : new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', minimumFractionDigits: p % 100 ? 2 : 0, maximumFractionDigits: 2,
  }).format(p / 100);

export const norm = (s: unknown) => String(s ?? '').trim().replace(/\s+/g, ' ').toUpperCase();

export const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthLabel = (m: string) => `${monthNames[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

export function audit(s: State, action: string, detail: string, before?: unknown, after?: unknown) {
  s.audit.push({ id: id(), at: new Date().toISOString(), action, detail, before, after });
}

export const memberName = (s: State, memberId?: string) =>
  memberId ? s.members.find(m => m.id === memberId)?.name ?? 'Unknown member' : '';
