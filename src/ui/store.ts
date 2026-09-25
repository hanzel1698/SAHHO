import { useCallback, useEffect, useRef, useState } from 'react';
import { State, emptyState } from '../model';
import { CHANNEL, ConflictError, load as localLoad, save as localSave } from '../storage';
import { cloud, cloudLoad, cloudRevision, cloudSave, session } from '../cloud';

const load = cloud ? cloudLoad : localLoad;
const save = cloud ? cloudSave : localSave;

export interface Store {
  state: State;
  ready: boolean;
  error?: string;
  /** Supabase mode only: false until the treasurer signs in. */
  signedIn: boolean;
  email?: string;
  /** Apply a change to a copy of the records and save it atomically. Throws on failure; nothing is saved. */
  commit: (change: (draft: State) => void | State) => Promise<State>;
  replace: (next: State) => Promise<State>;
  reload: () => Promise<void>;
  notice?: string;
  setNotice: (n?: string) => void;
}

export function useStore(): Store {
  const [state, setState] = useState<State>(emptyState());
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [signedIn, setSignedIn] = useState(!cloud);
  const [email, setEmail] = useState<string>();
  const current = useRef(state);
  current.current = state;

  const reload = useCallback(async () => {
    try { const s = await load(); setState(s); setError(undefined); }
    catch (e) { setError((e as Error).message); }
    finally { setReady(true); }
  }, []);

  useEffect(() => {
    if (!cloud) { void reload(); return; }
    const apply = (user?: { email?: string }) => {
      setSignedIn(!!user); setEmail(user?.email);
      if (user) { setReady(false); void reload(); } else { setState(emptyState()); setError(undefined); setReady(true); }
    };
    void session().then(s => apply(s?.user));
    const { data } = cloud.auth.onAuthStateChange((event, s) => {
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') apply(s?.user);
    });
    return () => data.subscription.unsubscribe();
  }, [reload]);

  // Supabase mode: notice changes saved from another device when this window regains focus, and every minute.
  useEffect(() => {
    if (!cloud || !signedIn) return;
    const check = async () => {
      const rev = await cloudRevision();
      if (rev !== undefined && rev !== current.current.revision) {
        await reload();
        setNotice('Records were updated on another device or tab; the latest data is shown.');
      }
    };
    const onFocus = () => { if (document.visibilityState === 'visible') void check(); };
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);
    const timer = setInterval(onFocus, 60000);
    return () => { document.removeEventListener('visibilitychange', onFocus); window.removeEventListener('focus', onFocus); clearInterval(timer); };
  }, [signedIn, reload]);
  useEffect(() => {
    let channel: BroadcastChannel | undefined;
    try {
      channel = new BroadcastChannel(CHANNEL);
      channel.onmessage = (e) => {
        if (typeof e.data === 'number' && e.data !== current.current.revision) {
          void reload();
          setNotice('Records were updated in another tab; the latest data is shown.');
        }
      };
    } catch { /* unsupported */ }
    return () => channel?.close();
  }, [reload]);

  const persist = useCallback(async (next: State, expected: number) => {
    try {
      const saved = await save(next, expected);
      setState(saved);
      return saved;
    } catch (e) {
      if (e instanceof ConflictError) await reload();
      throw e;
    }
  }, [reload]);

  const commit = useCallback(async (change: (draft: State) => void | State) => {
    const base = current.current;
    const draft = structuredClone(base);
    const result = change(draft) ?? draft;
    return persist(result, base.revision);
  }, [persist]);

  const replace = useCallback(async (next: State) => persist(next, current.current.revision), [persist]);

  return { state, ready, error, signedIn, email, commit, replace, reload, notice, setNotice };
}
