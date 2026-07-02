-- ═══════════════════════════════════════════════════════════
-- BBW Push Notifications — database setup
-- Run this in Supabase SQL Editor (one time).
-- ═══════════════════════════════════════════════════════════

-- 1. Table to store one push subscription per device
create table if not exists bbw_push_subs (
  id         bigint generated always as identity primary key,
  endpoint   text unique not null,
  p256dh     text not null,
  auth       text not null,
  tech       text,
  ua         text,
  created_at timestamptz default now()
);

-- 2. Enable Row Level Security
alter table bbw_push_subs enable row level security;

-- 3. Allow the anon key to INSERT (subscribe) and DELETE (unsubscribe)
--    The app uses the anon key, so it needs these.
drop policy if exists "anon insert push subs" on bbw_push_subs;
create policy "anon insert push subs"
  on bbw_push_subs for insert
  to anon
  with check (true);

drop policy if exists "anon delete push subs" on bbw_push_subs;
create policy "anon delete push subs"
  on bbw_push_subs for delete
  to anon
  using (true);

-- NOTE: We deliberately do NOT grant anon SELECT — only the Edge Function
-- (service role) reads the subscriptions, which bypasses RLS.

-- 4. Upsert support: merge-duplicates on endpoint needs a unique constraint,
--    which the UNIQUE on endpoint above already provides.
