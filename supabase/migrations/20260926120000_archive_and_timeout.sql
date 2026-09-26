-- Keep saves small and within the API time limit.
-- Run after 20260926000000_sahho_state.sql. Safe to re-run.
--
-- 1. The workbook archive (every cell of every migrated sheet) never changes after migration, yet it was re-sent
--    and rewritten with every save. It now lives in its own row, written only when it changes, in the same
--    transaction as the records.
-- 2. Supabase stops API requests by signed-in users after 8 seconds; allow up to 60 for large saves
--    (e.g. the one-time workbook migration).

alter role authenticated set statement_timeout = '60s';

create table if not exists public.sahho_archive (
  id text primary key default 'main' check (id = 'main'),
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.sahho_archive enable row level security;

drop policy if exists "treasurers read archive" on public.sahho_archive;
create policy "treasurers read archive" on public.sahho_archive
  for select to authenticated
  using (exists (select 1 from public.treasurers t where t.user_id = (select auth.uid())));

drop policy if exists "treasurers create archive" on public.sahho_archive;
create policy "treasurers create archive" on public.sahho_archive
  for insert to authenticated
  with check (exists (select 1 from public.treasurers t where t.user_id = (select auth.uid())));

drop policy if exists "treasurers update archive" on public.sahho_archive;
create policy "treasurers update archive" on public.sahho_archive
  for update to authenticated
  using (exists (select 1 from public.treasurers t where t.user_id = (select auth.uid())))
  with check (exists (select 1 from public.treasurers t where t.user_id = (select auth.uid())));

revoke all on public.sahho_archive from anon, authenticated;
grant select, insert, update on public.sahho_archive to authenticated;

-- Compare-and-swap save, now with an optional archive. The archive is never kept inside the records document:
-- when `archives` is null but the document still carries them (an app version from before this change),
-- they are moved to the archive row, so nothing is lost.
drop function if exists public.save_sahho_state(integer, jsonb);
create or replace function public.save_sahho_state(expected integer, next jsonb, archives jsonb default null)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  saved integer;
begin
  if not exists (select 1 from public.treasurers t where t.user_id = (select auth.uid())) then
    raise exception 'Not authorised: this account is not a SAHHO treasurer.' using errcode = '42501';
  end if;

  archives := coalesce(archives, next -> 'archives');
  next := next - 'archives';

  update public.sahho_state
     set data = jsonb_set(next, '{revision}', to_jsonb(expected + 1)),
         revision = expected + 1,
         updated_at = now(),
         updated_by = (select auth.uid())
   where id = 'main' and revision = expected
  returning revision into saved;

  if saved is null then
    if expected = 0 and not exists (select 1 from public.sahho_state where id = 'main') then
      insert into public.sahho_state (id, revision, data)
      values ('main', 1, jsonb_set(next, '{revision}', '1'))
      returning revision into saved;
    else
      raise exception 'Records were changed on another device or tab.' using errcode = '40001';
    end if;
  end if;

  if archives is not null then
    insert into public.sahho_archive (id, data) values ('main', archives)
    on conflict (id) do update set data = excluded.data, updated_at = now();
  end if;

  return saved;
end;
$$;

revoke execute on function public.save_sahho_state(integer, jsonb, jsonb) from public, anon;
grant execute on function public.save_sahho_state(integer, jsonb, jsonb) to authenticated;

-- Make the API pick up the new function and timeout now.
notify pgrst, 'reload schema';
notify pgrst, 'reload config';
