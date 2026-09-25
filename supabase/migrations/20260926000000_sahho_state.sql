-- SAHHO records on Supabase.
-- The whole register is one JSON document (same shape as the local IndexedDB record and backup files),
-- saved with an optimistic revision check so two devices can never overwrite each other's changes.
-- Only users listed in public.treasurers can read or write it.

create table if not exists public.treasurers (
  user_id uuid primary key references auth.users (id) on delete cascade,
  note text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.sahho_state (
  id text primary key default 'main' check (id = 'main'),
  revision integer not null check (revision >= 0),
  data jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

alter table public.treasurers enable row level security;
alter table public.sahho_state enable row level security;

-- A signed-in user can only see whether they themselves are a treasurer. Treasurers are added from the SQL editor.
drop policy if exists "treasurer sees own row" on public.treasurers;
create policy "treasurer sees own row" on public.treasurers
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "treasurers read state" on public.sahho_state;
create policy "treasurers read state" on public.sahho_state
  for select to authenticated
  using (exists (select 1 from public.treasurers t where t.user_id = (select auth.uid())));

drop policy if exists "treasurers create state" on public.sahho_state;
create policy "treasurers create state" on public.sahho_state
  for insert to authenticated
  with check (exists (select 1 from public.treasurers t where t.user_id = (select auth.uid())));

drop policy if exists "treasurers update state" on public.sahho_state;
create policy "treasurers update state" on public.sahho_state
  for update to authenticated
  using (exists (select 1 from public.treasurers t where t.user_id = (select auth.uid())))
  with check (exists (select 1 from public.treasurers t where t.user_id = (select auth.uid())));

-- Projects created before Supabase stopped auto-granting still give anon/authenticated every table privilege
-- (including TRUNCATE, which RLS does not cover). Start from nothing and grant only what the app uses.
revoke all on public.treasurers, public.sahho_state from anon, authenticated;
grant select on public.treasurers to authenticated;
grant select, insert, update on public.sahho_state to authenticated;

-- Compare-and-swap save. Runs as the caller (security invoker), so the RLS policies above still apply.
-- Returns the new revision, or raises SQLSTATE 40001 when someone else saved first.
create or replace function public.save_sahho_state(expected integer, next jsonb)
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

  return saved;
end;
$$;

revoke execute on function public.save_sahho_state(integer, jsonb) from public, anon;
grant execute on function public.save_sahho_state(integer, jsonb) to authenticated;
