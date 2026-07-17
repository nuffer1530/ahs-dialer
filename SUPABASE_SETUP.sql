-- Run this in your Supabase SQL Editor BEFORE deploying the app
-- This adds the profiles table needed for user roles

-- PROFILES TABLE (links to Supabase auth users)
create table if not exists profiles (
  id uuid references auth.users(id) on delete cascade primary key,
  email text,
  name text,
  role text default 'rep' check (role in ('rep', 'admin')),
  created_at timestamptz default now()
);

-- Auto-create profile when a user signs up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, name, role)
  values (new.id, new.email, split_part(new.email, '@', 1), 'rep')
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Trigger on auth.users insert
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Make yourself admin (run AFTER you sign up — replace with your email)
-- UPDATE profiles SET role = 'admin' WHERE email = 'brandyn@awesomehomeservices.com';

-- Add correction column if not already there
alter table call_logs add column if not exists correction text;

-- Allow public read/write on profiles (needed for role check)
-- CREATE POLICY has no IF NOT EXISTS, so drop first — otherwise re-running this
-- file aborts here ("policy already exists") and every statement below it,
-- including the migrations, silently never runs.
alter table profiles enable row level security;
drop policy if exists "Users can view all profiles" on profiles;
create policy "Users can view all profiles" on profiles for select using (true);
drop policy if exists "Users can update own profile" on profiles;
create policy "Users can update own profile" on profiles for update using (auth.uid() = id);
drop policy if exists "Service can insert profiles" on profiles;
create policy "Service can insert profiles" on profiles for insert with check (true);

-- Note there is deliberately no delete policy on profiles: users are
-- deactivated server-side with the service key, never deleted from the browser.

-- ─────────────────────────────────────────────
-- USER DEACTIVATION (run this on an existing database)
-- ─────────────────────────────────────────────
-- Users are deactivated, never deleted: call_logs and commissions are pay
-- records and must survive. `active = false` hides them everywhere in the app
-- and the server bans their auth.users login. Deactivation is done server-side
-- with the service key (POST /api/admin/user/deactivate) — there is
-- deliberately no RLS delete/deactivate policy for the anon key.
alter table profiles add column if not exists active boolean not null default true;
alter table profiles add column if not exists deactivated_at timestamptz;

-- Partial index: every screen filters on active users.
create index if not exists profiles_active_idx on profiles (active) where active;

-- ─────────────────────────────────────────────
-- COMMISSIONS: pay on ServiceTitan job completion
-- ─────────────────────────────────────────────
-- Commissions used to be written by the browser at booking time at a flat
-- $2 rate from commission_settings, ignoring job_type_spiffs entirely. They
-- are now written server-side by syncCommissions() in server.js when
-- ServiceTitan reports the job Completed, priced from job_type_spiffs.
--
-- Every existing row is test data (confirmed with Brandyn, Jul 2026).
delete from commissions;

alter table commissions add column if not exists st_job_id bigint;
alter table commissions add column if not exists st_membership_id bigint;
alter table commissions add column if not exists st_job_type_id bigint;
alter table commissions add column if not exists st_membership_type_id bigint;
alter table commissions add column if not exists st_customer_id bigint;
alter table commissions add column if not exists job_number text;
alter table commissions add column if not exists booked_at timestamptz;
alter table commissions add column if not exists completed_at timestamptz;
alter table commissions add column if not exists synced_at timestamptz;

-- The sync is idempotent through these: it upserts on the ST id, so a job or
-- membership can never be paid twice, even if two Railway replicas sync at
-- once. Partial, because manual adjustments have no ST id.
create unique index if not exists commissions_st_job_id_key
  on commissions (st_job_id) where st_job_id is not null;
create unique index if not exists commissions_st_membership_id_key
  on commissions (st_membership_id) where st_membership_id is not null;

-- Lets the sync skip bookings that have reached a terminal state instead of
-- re-querying every job Andi has ever booked, forever.
alter table andi_bookings add column if not exists job_status text;
alter table andi_bookings add column if not exists commission_synced_at timestamptz;
create index if not exists andi_bookings_open_idx
  on andi_bookings (job_status) where commission_synced_at is null;

-- Tracks the membership sync watermark (memberships have no andi_bookings row
-- to anchor to, so we page forward from the last successful sync).
create table if not exists sync_state (
  key text primary key,
  last_synced_at timestamptz,
  updated_at timestamptz default now()
);

-- ─────────────────────────────────────────────
-- SELLING MEMBERSHIPS FROM THE DIALER
-- ─────────────────────────────────────────────
-- POST /memberships/sale needs saleTaskId (the Pricebook item that sells the
-- membership) and durationBillingId (which term/price). Nothing in the
-- ServiceTitan API maps a membership type to its sale SKU — the Pricebook API
-- never mentions memberships — so an admin states it once per type under
-- Settings → Commission → Commission Mapping.
alter table membership_type_spiffs add column if not exists sale_task_id bigint;
alter table membership_type_spiffs add column if not exists duration_billing_id bigint;
alter table membership_type_spiffs add column if not exists business_unit_id bigint;
alter table membership_type_spiffs add column if not exists sale_task_name text;

-- Audit trail for memberships Andi sold into ServiceTitan. This creates a real
-- invoice against a real customer, so keep a local record of every attempt
-- independent of what ST reports back.
create table if not exists andi_membership_sales (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references profiles(id),
  csr_name text,
  contact_id uuid,
  st_customer_id bigint not null,
  st_membership_type_id bigint,
  st_sale_task_id bigint,
  st_duration_billing_id bigint,
  st_customer_membership_id bigint,
  st_invoice_id bigint,
  ok boolean not null default false,
  error text,
  created_at timestamptz default now()
);
create index if not exists andi_membership_sales_customer_idx
  on andi_membership_sales (st_customer_id, created_at desc);
