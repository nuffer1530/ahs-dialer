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
alter table profiles enable row level security;
create policy "Users can view all profiles" on profiles for select using (true);
create policy "Users can update own profile" on profiles for update using (auth.uid() = id);
create policy "Service can insert profiles" on profiles for insert with check (true);

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
