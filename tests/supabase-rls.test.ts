// Verifies the Supabase migration (row-level security + compare-and-swap save) on an embedded Postgres.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import { expect, test } from 'vitest';

test('Supabase migration: only treasurers can read/save, stale saves are refused', async () => {
  const db = new PGlite();
  const migration = readFileSync('supabase/migrations/20260926000000_sahho_state.sql', 'utf8');
  // Minimal Supabase stand-ins: API roles, auth schema and auth.uid() from the JWT subject.
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    grant usage on schema public to anon, authenticated;
    create schema auth; grant usage on schema auth to anon, authenticated;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    insert into auth.users values ('11111111-1111-1111-1111-111111111111', 't@x'), ('22222222-2222-2222-2222-222222222222', 'other@x');
  `);
  await db.exec(migration);
  await db.exec(migration); // safe to re-run
  await db.exec(`insert into public.treasurers (user_id) values ('11111111-1111-1111-1111-111111111111')`);

  const T = '11111111-1111-1111-1111-111111111111', O = '22222222-2222-2222-2222-222222222222';
  type Result = { rows?: any[]; error?: string };
  async function as(role: string, sub: string | null, sql: string, params: unknown[] = []): Promise<Result> {
    await db.exec('begin');
    try {
      await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [sub ?? '']);
      await db.exec(`set local role ${role}`);
      const r = await db.query(sql, params);
      await db.exec('commit');
      return { rows: r.rows };
    } catch (e) { await db.exec('rollback'); return { error: `${(e as { code?: string }).code} ${(e as Error).message}` }; }
  }
  const check = (name: string, cond: boolean, detail: unknown) => expect(cond, `${name}: ${JSON.stringify(detail)}`).toBe(true);
  const doc = (n: string) => JSON.stringify({ schema: 1, revision: 0, members: [{ n }] });

  let r: Result = await as('authenticated', T, 'select * from public.sahho_state'); check('treasurer reads empty state', r.rows?.length === 0, r);
  r = await as('authenticated', T, 'select public.save_sahho_state(0, $1::jsonb) as v', [doc('a')]); check('first save creates revision 1', r.rows?.[0]?.v === 1, r);
  r = await as('authenticated', T, 'select public.save_sahho_state(0, $1::jsonb) as v', [doc('b')]); check('stale save (expected 0) rejected 40001', r.error?.startsWith('40001'), r);
  r = await as('authenticated', T, 'select public.save_sahho_state(1, $1::jsonb) as v', [doc('c')]); check('save with current revision -> 2', r.rows?.[0]?.v === 2, r);
  r = await as('authenticated', T, `select revision, data->'revision' as dr, data->'members' as m, updated_by from public.sahho_state`);
  check('stored data revision synced + content', r.rows?.[0]?.revision === 2 && r.rows[0].dr === 2 && r.rows[0].m[0].n === 'c' && r.rows[0].updated_by === T, r);
  r = await as('authenticated', O, 'select * from public.sahho_state'); check('non-treasurer sees nothing', r.rows?.length === 0, r);
  r = await as('authenticated', O, 'select * from public.treasurers'); check('non-treasurer cannot list treasurers', r.rows?.length === 0, r);
  r = await as('authenticated', O, 'select public.save_sahho_state(2, $1::jsonb) as v', [doc('x')]); check('non-treasurer save rejected 42501', r.error?.startsWith('42501'), r);
  r = await as('authenticated', O, `update public.sahho_state set data='{}'::jsonb`); 
  let after: Result = await as('authenticated', T, `select data->'members'->0->>'n' as n from public.sahho_state`); check('non-treasurer direct update changes nothing', after.rows?.[0]?.n === 'c', { r, after });
  r = await as('authenticated', O, `insert into public.treasurers values ('${O}')`); check('non-treasurer cannot self-enrol', !!r.error, r);
  r = await as('anon', null, 'select * from public.sahho_state'); check('anon denied table', !!r.error, r);
  r = await as('anon', null, 'select public.save_sahho_state(2, $1::jsonb)', [doc('x')]); check('anon denied rpc', !!r.error, r);
  r = await as('authenticated', T, 'delete from public.sahho_state'); check('delete not permitted', !!r.error, r);
  r = await as('authenticated', T, `update public.sahho_state set id='other'`); check('cannot rename row', !!r.error, r);
});
