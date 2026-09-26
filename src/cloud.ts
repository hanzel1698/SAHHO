// Supabase storage: the same State document as IndexedDB, kept in one row-level-secured record.
// Enabled when VITE_SUPABASE_URL and VITE_SUPABASE_KEY are set at build time; otherwise the app stays browser-only.
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { State, emptyState } from './model';
import { CHANNEL, ConflictError, upgrade, validate } from './storage';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_KEY as string | undefined;

export const cloud: SupabaseClient | undefined = url && key ? createClient(url, key) : undefined;

export async function session(): Promise<Session | null> {
  if (!cloud) return null;
  const { data } = await cloud.auth.getSession();
  return data.session;
}

export async function signIn(email: string, password: string) {
  const { error } = await cloud!.auth.signInWithPassword({ email, password });
  if (error) throw Error(error.message);
}

export async function signOut() {
  await cloud?.auth.signOut();
}

async function assertTreasurer() {
  const { data, error } = await cloud!.from('treasurers').select('user_id').limit(1);
  if (error) throw Error(error.message);
  if (!data.length) throw Error('This account is signed in but is not registered as a SAHHO treasurer. Ask the administrator to add it.');
}

// The workbook archive is stored in its own row and sent only when it differs from what the database holds.
let storedArchives: string | undefined;

export async function cloudLoad(): Promise<State> {
  await assertTreasurer();
  const [{ data, error }, archive] = await Promise.all([
    cloud!.from('sahho_state').select('data, revision').eq('id', 'main').maybeSingle(),
    cloud!.from('sahho_archive').select('data').eq('id', 'main').maybeSingle(),
  ]);
  if (error) throw Error(error.message);
  // No archive row yet (or the database predates it): archives are still inside the records, and the next save moves them.
  const archives = archive.data?.data as State['archives'] | undefined;
  storedArchives = archives ? JSON.stringify(archives) : undefined;
  if (!data) return emptyState();
  return { ...upgrade({ ...data.data, archives: archives ?? data.data.archives ?? [] }), revision: data.revision };
}

/** Latest saved revision, used to notice changes made on another device. */
export async function cloudRevision(): Promise<number | undefined> {
  const { data, error } = await cloud!.from('sahho_state').select('revision').eq('id', 'main').maybeSingle();
  return error ? undefined : data?.revision ?? 0;
}

export async function cloudSave(next: State, expected: number): Promise<State> {
  validate(next);
  const { archives, ...records } = next;
  const archiveText = JSON.stringify(archives);
  const sendArchives = archiveText !== storedArchives;
  let { data, error } = await cloud!.rpc('save_sahho_state', sendArchives ? { expected, next: records, archives } : { expected, next: records });
  let legacy = false;
  if (error?.code === 'PGRST202') {
    // The database has not had the archive migration yet: save everything in one document as before.
    ({ data, error } = await cloud!.rpc('save_sahho_state', { expected, next }));
    legacy = true;
  }
  if (error) {
    if (error.code === '40001' || error.code === '23505') throw new ConflictError('Another device or tab changed the records. Your change was not saved; the latest data has been loaded.');
    throw Error(`Save failed. No changes were committed. (${error.message})`);
  }
  const revision = data as number;
  if (sendArchives && !legacy) storedArchives = archiveText;
  try { new BroadcastChannel(CHANNEL).postMessage(revision); } catch { /* not supported */ }
  return { ...next, revision };
}
