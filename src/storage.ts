// IndexedDB persistence with optimistic revision checks, validated backups and import rollback.
import { COLLECTIONS, Changes, SCHEMA, State, audit, categories, defaultSettings, emptyState } from './model';
import { rosterFromArchives } from './engine';

const DB = 'sahho-local-v1';
const STORE = 'state';
const KEY = 'current';
export const CHANNEL = 'sahho-updates';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Bring older saved data up to the current schema. Add steps here when the schema changes. */
export function upgrade(raw: unknown): State {
  const s = raw as State & { schema?: number };
  if (!s) return emptyState();
  if (s.schema !== SCHEMA) throw Error(`Saved data uses schema ${s.schema}; this version understands schema ${SCHEMA}.`);
  s.settings = { ...defaultSettings(), ...s.settings };
  s.receipts.forEach((r, i) => { if (r.order === undefined) r.order = i; });
  // Older imports kept a full copy of the previous records for undo; keep only what differs.
  const legacy = s.undo as unknown as { before?: State } | undefined;
  if (legacy?.before) {
    const { before, ...rest } = legacy as { before: State } & Record<string, unknown>;
    s.undo = { ...(rest as Omit<NonNullable<State['undo']>, 'changes'>), changes: changesBetween(before, s) };
  }
  // Registers migrated before rosters were recorded: recover each member's years from the archived year sheets.
  if (s.members.every(m => m.rosterYears === undefined)) {
    const roster = rosterFromArchives(s);
    if (roster.size) for (const m of s.members) {
      const years = new Set([m.name, ...m.aliases].flatMap(n => [...roster.get(n) ?? []]));
      m.rosterYears = [...years].sort((a, b) => a - b);
    }
  }
  return s;
}

export async function load(): Promise<State> {
  const d = await open();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE), r = tx.objectStore(STORE).get(KEY);
    r.onsuccess = () => { try { resolve(r.result ? upgrade(r.result) : emptyState()); } catch (e) { reject(e); } };
    r.onerror = () => reject(r.error);
    tx.oncomplete = () => d.close();
  });
}

export class ConflictError extends Error {}

/** Save only if nobody else saved since `expected` revision (prevents lost updates across tabs). */
export async function save(next: State, expected: number): Promise<State> {
  validate(next);
  const d = await open();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite'), store = tx.objectStore(STORE), get = store.get(KEY);
    let error: Error | undefined;
    let saved: State | undefined;
    get.onsuccess = () => {
      if ((get.result?.revision ?? 0) !== expected) {
        error = new ConflictError('Another tab or window changed the records. Your change was not saved; the latest data has been loaded.');
        tx.abort();
        return;
      }
      saved = { ...next, revision: expected + 1 };
      store.put(saved, KEY);
    };
    tx.oncomplete = () => {
      d.close();
      try { new BroadcastChannel(CHANNEL).postMessage(saved!.revision); } catch { /* not supported */ }
      resolve(saved!);
    };
    tx.onerror = tx.onabort = () => { d.close(); reject(error ?? tx.error ?? Error('Save failed. No changes were committed.')); };
  });
}

/** Structural and financial integrity checks, used before every save and restore. */
export function validate(v: unknown): asserts v is State {
  const s = v as State;
  if (!s || s.schema !== SCHEMA) throw Error(`Unsupported data schema. Expected SAHHO schema ${SCHEMA}.`);
  for (const key of ['members', 'receipts', 'allocations', 'rules', 'issues', 'charity', 'archives', 'batches', 'audit'] as const) {
    if (!Array.isArray(s[key])) throw Error(`Missing ${key}.`);
  }
  if (!s.settings || !Array.isArray(s.settings.rates) || !s.mappings || !Number.isInteger(s.revision)) throw Error('Invalid settings or revision.');
  const paise = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  const month = (x: unknown) => typeof x === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(x);
  const day = (x: unknown) => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x);
  const ids = (arr: { id: string }[], what: string) => {
    const set = new Set(arr.map(x => x.id));
    if (set.size !== arr.length || arr.some(x => typeof x.id !== 'string' || !x.id)) throw Error(`Duplicate or missing ${what} IDs.`);
    return set;
  };
  const ms = ids(s.members, 'member'), rs = ids(s.receipts, 'transaction');
  ids(s.allocations, 'allocation'); ids(s.rules, 'rule'); ids(s.issues, 'review item'); ids(s.batches, 'import'); ids(s.audit, 'audit'); ids(s.charity, 'charity');
  const st = s.settings;
  if (!st.rates.length || st.rates.some(r => !month(r.from) || !paise(r.amount)) || st.dueDay < 1 || st.dueDay > 28 || st.advanceMonths < 0 || st.advanceMonths > 120 || !paise(st.joiningAmount)) {
    throw Error('Invalid contribution policy.');
  }
  for (const m of s.members) {
    if (typeof m.name !== 'string' || !Array.isArray(m.aliases) || !Array.isArray(m.exceptions) || (m.start && !month(m.start)) || (m.joiningMonth && !month(m.joiningMonth)) || (m.inactiveFrom && !month(m.inactiveFrom)) ||
      (m.rosterYears !== undefined && (!Array.isArray(m.rosterYears) || m.rosterYears.some(y => !Number.isInteger(y)))) ||
      m.exceptions.some(e => !month(e.from) || !month(e.to) || e.from > e.to || !paise(e.amount))) throw Error(`Invalid member record: ${m.name}.`);
  }
  for (const r of s.receipts) {
    if (!paise(r.credit) || !paise(r.debit) || (r.credit > 0) === (r.debit > 0) || !day(r.date) || typeof r.narration !== 'string' || !r.source ||
      !categories.includes(r.category) || !['confirmed', 'review', 'duplicate'].includes(r.status) || (r.memberId && !ms.has(r.memberId)) || (r.reversalOf && !rs.has(r.reversalOf))) {
      throw Error(`Invalid transaction (${r.date} ${r.narration?.slice(0, 40)}).`);
    }
  }
  const consumed = new Map<string, number>();
  for (const a of s.allocations) {
    if (!ms.has(a.memberId) || !paise(a.amount) || a.amount === 0 || !month(a.month) || (a.receiptId && !rs.has(a.receiptId)) || (a.reversedBy && !rs.has(a.reversedBy)) || (!a.legacy && !a.receiptId)) {
      throw Error('Invalid allocation or receipt reference.');
    }
    if (a.receiptId) consumed.set(a.receiptId, (consumed.get(a.receiptId) ?? 0) + a.amount);
  }
  for (const r of s.receipts) if ((consumed.get(r.id) ?? 0) > r.credit) throw Error(`Allocations exceed the receipt amount (${r.date} ${r.narration.slice(0, 40)}).`);
  for (const r of s.rules) if ((r.memberId && !ms.has(r.memberId)) || (!r.memberId && !r.category) || typeof r.token !== 'string' || !Array.isArray(r.evidence)) throw Error('Invalid matching rule.');
}

export const BACKUP_APP = 'SAHHO';
export const BACKUP_VERSION = 1;

export function backupText(s: State) {
  const data = structuredClone(s);
  delete data.undo;
  return JSON.stringify({ application: BACKUP_APP, version: BACKUP_VERSION, schema: SCHEMA, exportedAt: new Date().toISOString(), data });
}

export function parseBackup(text: string): State {
  let envelope: { application?: string; version?: number; data?: unknown };
  try { envelope = JSON.parse(text); } catch { throw Error('This file is not valid JSON.'); }
  if (envelope.application !== BACKUP_APP || envelope.version !== BACKUP_VERSION) throw Error('This is not a supported SAHHO backup file.');
  const s = upgrade(envelope.data);
  validate(s);
  return s;
}

// ---------- Import rollback ----------

export function undoPreview(s: State) {
  if (!s.undo) return undefined;
  const batch = s.batches.find(b => b.id === s.undo!.batchId);
  const added = new Set(s.undo.changes.added.receipts);
  const receipts = s.receipts.filter(r => r.batch === s.undo!.batchId && added.has(r.id)); // manual entries it matched are restored, not removed
  const ids = new Set(receipts.map(r => r.id));
  return {
    batch,
    receipts: receipts.length,
    allocations: s.allocations.filter(a => a.receiptId && ids.has(a.receiptId)).length,
    laterEdits: s.audit.slice(s.undo.auditCount),
  };
}

/** What changed from `before` to `after`, enough to put `before` back. Audit history is never rolled back. */
export function changesBetween(before: State, after: State): Changes {
  const changes: Changes = { added: {}, before: {}, mappings: {} };
  for (const key of COLLECTIONS) {
    const old = new Map<string, { id: string }>(before[key].map(x => [x.id, x]));
    const now = new Map<string, { id: string }>(after[key].map(x => [x.id, x]));
    const added = [...now.keys()].filter(k => !old.has(k));
    const changed = [...old.values()].filter(x => !now.has(x.id) || JSON.stringify(x) !== JSON.stringify(now.get(x.id)));
    if (added.length) changes.added[key] = added;
    if (changed.length) changes.before[key] = structuredClone(changed);
  }
  for (const k of new Set([...Object.keys(before.mappings), ...Object.keys(after.mappings)])) {
    if (JSON.stringify(before.mappings[k]) !== JSON.stringify(after.mappings[k])) changes.mappings[k] = before.mappings[k] ? structuredClone(before.mappings[k]) : null;
  }
  if (JSON.stringify(before.settings) !== JSON.stringify(after.settings)) changes.settings = structuredClone(before.settings);
  return changes;
}

/** Take back the last import's changes. Later edits are listed and must be confirmed; those touching its records go with it. */
export function undoImport(s: State, confirmLaterEdits = false): State {
  const preview = undoPreview(s);
  if (!s.undo || !preview) throw Error('There is no import to undo.');
  if (preview.laterEdits.length && !confirmLaterEdits) throw Error(`${preview.laterEdits.length} later change(s) depend on this import. Review them before rolling back.`);
  const { changes } = s.undo;
  const next: State = structuredClone(s);
  delete next.undo;
  for (const key of COLLECTIONS) {
    const added = new Set(changes.added[key]);
    const restore = new Map((changes.before[key] ?? []).map(x => [x.id, x]));
    const list = (next[key] as { id: string }[]).filter(x => !added.has(x.id)).map(x => restore.get(x.id) ?? x);
    const present = new Set(list.map(x => x.id));
    for (const x of restore.values()) if (!present.has(x.id)) list.push(x);
    (next[key] as { id: string }[]) = structuredClone(list);
  }
  for (const [k, m] of Object.entries(changes.mappings)) { if (m) next.mappings[k] = m; else delete next.mappings[k]; }
  if (changes.settings) next.settings = changes.settings;
  dropDangling(next);
  if (preview.batch) next.batches.push({ ...preview.batch, undone: true });
  audit(next, 'Import undone', `${preview.batch?.file}: removed ${preview.receipts} transactions and ${preview.allocations} allocations${preview.laterEdits.length ? `; discarded ${preview.laterEdits.length} later change(s)` : ''}.`);
  return next;
}

/** Remove what pointed at records the undo took away (later allocations, rule evidence, review items ...). */
function dropDangling(s: State) {
  const ms = new Set(s.members.map(m => m.id)), rs = new Set(s.receipts.map(r => r.id));
  const has = (set: Set<string>, v?: string) => !v || set.has(v);
  s.allocations = s.allocations.filter(a => ms.has(a.memberId) && has(rs, a.receiptId));
  for (const a of s.allocations) if (!has(rs, a.reversedBy)) delete a.reversedBy;
  const allocs = new Set(s.allocations.map(a => a.id));
  for (const r of s.receipts) {
    if (!has(ms, r.memberId)) delete r.memberId;
    if (!has(rs, r.reversalOf)) delete r.reversalOf;
    if (!has(rs, r.duplicateOf)) delete r.duplicateOf;
  }
  s.rules = s.rules.filter(r => has(ms, r.memberId));
  for (const r of s.rules) r.evidence = r.evidence.filter(e => rs.has(e));
  s.issues = s.issues.filter(i => has(rs, i.receiptId) && has(ms, i.memberId) && has(allocs, i.allocationId));
  for (const c of s.charity) if (!has(rs, c.receiptId)) delete c.receiptId;
}
