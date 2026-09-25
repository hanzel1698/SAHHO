import type { ScreenProps } from '../App';
import { demoState } from '../demo';
import { ErrorLine, useAsync } from './common';
import { cloud } from '../cloud';

export function Welcome({ store, go }: ScreenProps) {
  const { busy, error, run } = useAsync();
  return (
    <section className="welcome">
      <h1>SAHHO contributions</h1>
      <p className="lead">Download a bank statement, upload it here, and the app records familiar contributions automatically. You only review the uncertain entries.</p>
      <div className="cards">
        <div className="card">
          <h3>1. Bring in your existing records</h3>
          <p>Migrate <i>Sahho Detailed Account</i> (.xlsx). Every populated cell is archived as evidence; monthly allocations are preserved exactly as recorded.</p>
          <button className="primary" onClick={() => go('import', 'workbook')}>Migrate workbook</button>
        </div>
        <div className="card">
          <h3>Try it with fictional data</h3>
          <p>Loads invented members and 2½ years of invented bank history, plus a demo statement you can import to see automatic matching and the review queue.</p>
          <button disabled={busy} onClick={() => void run(async () => { await store.replace({ ...demoState(), revision: store.state.revision }); go('dashboard'); })}>Load demo data</button>
        </div>
        <div className="card">
          <h3>Restore a backup</h3>
          <p>Continue from a SAHHO backup file exported on this or another device.</p>
          <button onClick={() => go('settings')}>Restore backup</button>
        </div>
      </div>
      <ErrorLine error={error} />
      <p className="note">{cloud
        ? 'Your records are saved to SAHHO’s private Supabase database and are available on any device where a treasurer signs in. Export backups regularly as well.'
        : 'Your records stay in this browser on this device (IndexedDB). Nothing is uploaded. They do not synchronise to other devices — use backups to move or protect them.'}</p>
    </section>
  );
}
