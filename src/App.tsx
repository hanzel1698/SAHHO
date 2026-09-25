import { useEffect, useMemo, useState } from 'react';
import { BarChart3, CalendarDays, ClipboardCheck, Database, FileUp, LayoutDashboard, ListChecks, Settings as Cog, Users, Wand2 } from 'lucide-react';
import { today } from './model';
import { dashboard, reviewCount } from './reports';
import { useStore } from './ui/store';
import { cx } from './ui/common';
import { Dashboard } from './ui/Dashboard';
import { ImportScreen } from './ui/Import';
import { Review } from './ui/Review';
import { Members } from './ui/Members';
import { Grid } from './ui/Grid';
import { Ledger } from './ui/Ledger';
import { Reports } from './ui/Reports';
import { Rules } from './ui/Rules';
import { Settings } from './ui/Settings';
import { Welcome } from './ui/Welcome';
import { SignIn } from './ui/SignIn';
import { cloud, signOut } from './cloud';

const NAV = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'import', label: 'Import statement', icon: FileUp },
  { key: 'review', label: 'Needs your review', icon: ClipboardCheck },
  { key: 'members', label: 'Members', icon: Users },
  { key: 'grid', label: 'Monthly grid', icon: CalendarDays },
  { key: 'ledger', label: 'Transactions', icon: ListChecks },
  { key: 'reports', label: 'Reports', icon: BarChart3 },
  { key: 'rules', label: 'Matching rules', icon: Wand2 },
  { key: 'settings', label: 'Backup & settings', icon: Cog },
] as const;
export type Page = typeof NAV[number]['key'];

const pageFromHash = (): Page => {
  const h = location.hash.replace(/^#\/?/, '').split('?')[0];
  return (NAV.find(n => n.key === h)?.key ?? 'dashboard') as Page;
};

export default function App() {
  const store = useStore();
  const [page, setPage] = useState<Page>(pageFromHash());
  const [cutoff, setCutoff] = useState(today());
  const [focus, setFocus] = useState<string>();
  useEffect(() => {
    const on = () => setPage(pageFromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = (p: Page, f?: string) => { setFocus(f); location.hash = `/${p}`; setPage(p); window.scrollTo(0, 0); };
  const s = store.state;
  const dash = useMemo(() => dashboard(s, cutoff), [s, cutoff]);
  const pending = reviewCount(s);
  const empty = !s.members.length && !s.receipts.length;
  const backupDays = s.lastBackup ? Math.floor((Date.now() - Date.parse(s.lastBackup)) / 86400000) : undefined;
  const needBackup = !empty && (backupDays === undefined || backupDays >= s.settings.backupReminderDays);

  if (cloud && !store.signedIn) return <SignIn />;
  if (!store.ready) return <div className="loading">Loading SAHHO records…</div>;
  if (store.error) return (
    <div className="loading error">Could not open {cloud ? 'the SAHHO records' : 'local records'}: {store.error}
      {cloud && <button onClick={() => void signOut()}>Sign out</button>}
    </div>
  );

  const props = { store, s, cutoff, go, dash, focus };
  return (
    <div className="app">
      <aside className="nav no-print">
        <div className="brand"><Database size={20} /> <span>SAHHO</span></div>
        <nav>
          {NAV.map(n => (
            <a key={n.key} href={`#/${n.key}`} className={cx(page === n.key && 'active')} onClick={() => setFocus(undefined)}>
              <n.icon size={17} /> <span>{n.label}</span>
              {n.key === 'review' && pending > 0 && <b className="count">{pending}</b>}
            </a>
          ))}
        </nav>
        <div className="nav-foot">
          {s.demo && <div className="demo-flag">Demo data (fictional)</div>}
          {cloud ? (
            <div>Stored in Supabase<br /><span className="dim">{store.email}</span><br /><button className="link" onClick={() => void signOut()}>Sign out</button></div>
          ) : <div>Stored only in this browser</div>}
        </div>
      </aside>
      <main>
        <header className="top no-print">
          <div className="data-through">
            Bank data through <b>{dash.dataThrough ?? 'no data yet'}</b>
          </div>
          <label className="cutoff">Reporting date
            <input type="date" value={cutoff} max="2100-12-31" onChange={e => e.target.value && setCutoff(e.target.value)} />
          </label>
        </header>
        {needBackup && page !== 'settings' && (
          <div className="banner warn no-print">
            {backupDays === undefined ? 'No backup has been exported yet.' : `Last backup was ${backupDays} days ago.`} {cloud ? 'Keep your own offline copy in case the online database is lost.' : 'Browser storage is not synchronised or backed up automatically.'}
            <button onClick={() => go('settings')}>Back up now</button>
          </div>
        )}
        {store.notice && <div className="banner info no-print">{store.notice}<button className="link" onClick={() => store.setNotice()}>Dismiss</button></div>}
        {empty && page !== 'settings' && page !== 'import' ? <Welcome {...props} /> : (
          <>
            {page === 'dashboard' && <Dashboard {...props} />}
            {page === 'import' && <ImportScreen {...props} />}
            {page === 'review' && <Review {...props} />}
            {page === 'members' && <Members {...props} />}
            {page === 'grid' && <Grid {...props} />}
            {page === 'ledger' && <Ledger {...props} />}
            {page === 'reports' && <Reports {...props} />}
            {page === 'rules' && <Rules {...props} />}
            {page === 'settings' && <Settings {...props} />}
          </>
        )}
      </main>
    </div>
  );
}

export type ScreenProps = {
  store: ReturnType<typeof useStore>;
  s: ReturnType<typeof useStore>['state'];
  cutoff: string;
  go: (p: Page, focus?: string) => void;
  dash: ReturnType<typeof dashboard>;
  focus?: string;
};
