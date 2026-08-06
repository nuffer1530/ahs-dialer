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

-- ─────────────────────────────────────────────
-- TELEPHONY: inbound queue (Twilio TaskRouter)
-- ─────────────────────────────────────────────
-- Inbound used to be a ring-all <Dial> blast with no queue, and nothing
-- recorded when a call was answered — so queue depth, wait time, abandon rate
-- and service level were all uncomputable. Callers now enter a TaskRouter
-- queue and every state change lands here via the events webhook.
--
-- One row per inbound call. The Live wallboard reads only this table.
create table if not exists call_tasks (
  task_sid text primary key,
  call_sid text,
  from_number text,
  contact_id uuid,
  contact_name text,
  -- queued -> assigned -> answered | abandoned | missed
  state text not null default 'queued',
  queued_at timestamptz not null default now(),
  answered_at timestamptz,          -- reservation.accepted: the caller reached a human
  ended_at timestamptz,
  wait_seconds int,                 -- queued_at -> answered_at (or -> hangup if abandoned)
  talk_seconds int,
  agent_profile_id uuid references profiles(id),
  agent_name text,
  -- Abandoned = caller hung up before an agent answered, EXCLUDING hangups
  -- inside ABANDON_GRACE_SECONDS (misdials). Stored, not derived, so changing
  -- the cutoff later doesn't silently rewrite history.
  abandoned boolean not null default false,
  created_at timestamptz default now()
);

-- The wallboard queries "today" constantly; these two carry it.
create index if not exists call_tasks_queued_at_idx on call_tasks (queued_at desc);
create index if not exists call_tasks_live_idx on call_tasks (state) where ended_at is null;

alter table call_tasks enable row level security;
drop policy if exists "Signed-in users can read call_tasks" on call_tasks;
create policy "Signed-in users can read call_tasks" on call_tasks
  for select using (auth.role() = 'authenticated');

-- Realtime for the wallboard. Wrapped: erroring if it's already a member would
-- abort the rest of this file.
do $$
begin
  alter publication supabase_realtime add table call_tasks;
exception when duplicate_object then null;
end $$;

-- Realtime for schedules so the schedule-alert banner reflects an admin's edits
-- instantly instead of on a 5-minute poll.
do $$
begin
  alter publication supabase_realtime add table schedules;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table schedule_blocks;
exception when duplicate_object then null;
end $$;

-- Realtime for commissions so the "You Got Paid!" banner fires the moment the
-- sync records a new payout for a rep.
do $$
begin
  alter publication supabase_realtime add table commissions;
exception when duplicate_object then null;
end $$;

-- ─────────────────────────────────────────────
-- SKILLS-BASED ROUTING (blended inbound + outbound)
-- ─────────────────────────────────────────────
-- Two layers:
--   ENTITLEMENT (admin grants which queues a CSR may work)
--     - inbound: profiles.inbound_skill
--     - outbound: csr_campaigns rows (active = granted, priority = order) — already exists.
--       A new campaign auto-appears as a grantable skill because the admin lists
--       every campaign; granting is just an csr_campaigns upsert.
--   AVAILABILITY (the CSR picks which of their granted queues they're taking now)
--     - inbound: profiles.inbound_available
--     - outbound: profiles.active_campaign_ids (which granted campaigns they're on)
--
-- Routing: inbound always outranks outbound. A CSR available for inbound only
-- takes an outbound lead when no inbound is waiting; outbound campaigns are
-- served in csr_campaigns.priority order among the ones they're available for.
alter table profiles add column if not exists inbound_skill boolean not null default false;
alter table profiles add column if not exists inbound_available boolean not null default false;
alter table profiles add column if not exists active_campaign_ids jsonb not null default '[]';

-- ── AI/paid lead inbox: mirror of the ServiceTitan Bookings tab ──────────────
-- One row per ST booking that still needs a human touch. This is an INBOX, not
-- a work record: when a rep claims a lead it is promoted to a normal contacts
-- row, and the work/call history lives there. That split means a booking that
-- gets dismissed in ServiceTitan after we already called it can leave the inbox
-- without destroying the call log.

create table if not exists st_leads (
  id              bigserial primary key,
  booking_id      bigint not null unique,          -- ST crm/v2 booking id
  name            text,
  phone           text,
  email           text,
  address         text,
  city            text,
  state           text,
  zip             text,
  source          text,                            -- raw ST source, e.g. LeadsIntegration#33
  provider        text,                            -- resolved name, e.g. Angi / Scorpion
  summary         text,                            -- customer message + interview answers
  lead_fee        numeric,                         -- what we paid for it
  urgency         text,                            -- e.g. "Urgent (1-2 days)"
  job_type        text,
  st_status       text,                            -- New / Converted / Dismissed
  submitted_at    timestamptz,                     -- ST createdOn
  claimed_by      text,                            -- rep display name (matches contacts.claimed_by)
  claimed_at      timestamptz,
  contact_id      uuid,                            -- set once promoted into contacts
  resolved_at     timestamptz,                     -- left the inbox (converted/dismissed/worked)
  last_synced_at  timestamptz default now(),
  created_at      timestamptz default now()
);

-- The rail only ever reads unresolved rows, newest first.
create index if not exists st_leads_open_idx on st_leads (resolved_at, submitted_at desc);
create index if not exists st_leads_booking_idx on st_leads (booking_id);

-- Realtime: the rail, the nav badge and the claim state all update live.
alter publication supabase_realtime add table st_leads;

-- Reps read the inbox; only the server (service key) writes the mirror, but
-- claiming happens from the browser, so allow authenticated updates.
alter table st_leads enable row level security;

drop policy if exists "Authenticated can read leads" on st_leads;
create policy "Authenticated can read leads" on st_leads
  for select to authenticated using (true);

drop policy if exists "Authenticated can claim leads" on st_leads;
create policy "Authenticated can claim leads" on st_leads
  for update to authenticated using (true) with check (true);

-- ── Interaction type: what a rep is actually engaged on ──────────────────────
-- Status alone says "On Call" but not whether that's an inbound, an outbound,
-- a paid lead, a text or an email. The Live Dashboard and the floor TV both
-- surface this, so a supervisor can see the shape of the floor at a glance.
-- Null means not engaged (Available / Break / Offline).
alter table profiles add column if not exists interaction_type text;

-- ── Lead inbox: already-booked detection + ST customer link ──────────────────
-- Some partners (Scorpion) book the job through a separate path and never
-- convert the booking, so it sits in the Bookings tab as "New" forever even
-- though a tech is scheduled. Without this a CSR calls a customer who already
-- has an appointment and tries to book them twice.
-- st_customer_id also gives promoted lead contacts a real ServiceTitan customer
-- id, so the intelligence brief / recent jobs / membership panels resolve
-- (they were being handed the booking id, which matches no customer).
alter table st_leads add column if not exists already_booked boolean not null default false;
alter table st_leads add column if not exists booked_job_id bigint;
alter table st_leads add column if not exists booked_job_number text;
alter table st_leads add column if not exists booked_at timestamptz;
alter table st_leads add column if not exists st_customer_id bigint;

-- ── Dispatch for Profit: cached tech scorecard ───────────────────────────────
-- Computing the batting order touches ~100 ServiceTitan endpoints (45 days of
-- appointments, assignment batches, estimates, invoices, memberships) and takes
-- minutes, so it CANNOT run on page load. A scheduled job writes this table and
-- the UI reads it. refreshed_at drives the "as of" stamp.
create table if not exists dispatch_tech_scores (
  id             bigserial primary key,
  tech_id        bigint not null,
  tech_name      text,
  business_unit  text not null,
  jobs           integer not null default 0,      -- raw job count (sample size)
  close_rate     numeric,                          -- opportunity close rate %
  avg_sale       numeric,                          -- MEDIAN value of SOLD ESTIMATES
  expected_value numeric,                          -- close_rate x avg_sale
  total_sold     numeric,                          -- total sold in window
  membership_pct numeric,                          -- memberships sold per job
  score          numeric,                          -- weighted z-score vs peers in BU
  tier           text,                             -- green | yellow | red | unranked
  rank           integer,
  window_days    integer not null default 45,
  refreshed_at   timestamptz not null default now(),
  unique (tech_id, business_unit)
);
create index if not exists dispatch_scores_bu_idx on dispatch_tech_scores (business_unit, rank);

-- Zip value, computed from real invoice history (not assumptions).
create table if not exists dispatch_zip_value (
  zip           text primary key,
  avg_ticket    numeric,
  job_count     integer,
  tier          text,          -- high | mid | low
  refreshed_at  timestamptz not null default now()
);

alter table dispatch_tech_scores enable row level security;
alter table dispatch_zip_value  enable row level security;
drop policy if exists "Authenticated read tech scores" on dispatch_tech_scores;
create policy "Authenticated read tech scores" on dispatch_tech_scores for select to authenticated using (true);
drop policy if exists "Authenticated read zip value" on dispatch_zip_value;
create policy "Authenticated read zip value" on dispatch_zip_value for select to authenticated using (true);

-- Dispatch metrics corrected: average sale must come from SOLD ESTIMATES, not
-- invoices. Sales techs sell the system while the install crew's job carries
-- the invoice, so invoice-based tickets showed a tech who sold $437k in 45 days
-- as a $89 performer. Safe to re-run.
alter table dispatch_tech_scores add column if not exists close_rate numeric;
alter table dispatch_tech_scores add column if not exists avg_sale numeric;
alter table dispatch_tech_scores add column if not exists expected_value numeric;
alter table dispatch_tech_scores add column if not exists total_sold numeric;
alter table dispatch_tech_scores drop column if exists conversion;
alter table dispatch_tech_scores drop column if exists avg_ticket;

-- Dispatch: opportunity-based KPIs (one opportunity = one job, not one
-- estimate — techs present ~2-3 options each). Safe to re-run.
alter table dispatch_tech_scores add column if not exists opportunities integer;
alter table dispatch_tech_scores add column if not exists options_per_opp numeric;

-- ── Dispatch: per-job-type batting order ────────────────────────────────────
-- "Who is my best guy on tanked water heaters?" Written by the same refresh
-- pass as dispatch_tech_scores. Samples are small by nature, so opportunities
-- is surfaced in the UI and thin rows are marked rather than hidden.
create table if not exists dispatch_jobtype_scores (
  id             bigserial primary key,
  tech_id        bigint not null,
  tech_name      text,
  team           text,
  job_type_id    bigint not null,
  job_type       text not null,
  opportunities  integer not null default 0,
  won            integer not null default 0,
  close_rate     numeric,
  avg_sale       numeric,
  total_sold     numeric,
  expected_value numeric,
  thin           boolean not null default false,
  refreshed_at   timestamptz not null default now(),
  unique (tech_id, job_type_id)
);
create index if not exists dispatch_jobtype_idx on dispatch_jobtype_scores (job_type, expected_value desc);
alter table dispatch_jobtype_scores enable row level security;
drop policy if exists "Authenticated read jobtype scores" on dispatch_jobtype_scores;
create policy "Authenticated read jobtype scores" on dispatch_jobtype_scores for select to authenticated using (true);

-- ── Drive-time cache ────────────────────────────────────────────────────────
-- Real drive time is a paid API call, and the Live Board refreshes every 15
-- minutes — without a cache that's ~150k lookups/day. Road distance between two
-- fixed points doesn't change, so every pair is fetched once and reused
-- forever. Coordinates are rounded to ~11m so the same address hits cache.
create table if not exists drive_time_cache (
  pair_key    text primary key,      -- "lat1,lng1|lat2,lng2", rounded, ordered
  minutes     numeric,
  miles       numeric,
  provider    text,
  created_at  timestamptz not null default now()
);
alter table drive_time_cache enable row level security;
drop policy if exists "Authenticated read drive cache" on drive_time_cache;
create policy "Authenticated read drive cache" on drive_time_cache for select to authenticated using (true);

-- ── Dispatcher role (Jul 2026) ──────────────────────────────────────────────
-- The role check was rep/admin only; dispatcher = everything a rep has plus
-- the Dispatch for Profit tab. RUN THIS BEFORE assigning anyone the role —
-- the profiles update fails on the old constraint otherwise.
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check check (role in ('rep', 'admin', 'dispatcher'));

-- ── AI Campaign Builder (Jul 2026) ──────────────────────────────────────────
-- Stores the audience recipe so a campaign can be re-pulled/refreshed later.
-- RUN BEFORE using "Build a campaign with AI" — creating a campaign errors
-- on the missing column otherwise.
alter table campaigns add column if not exists source_query jsonb;
notify pgrst, 'reload schema';

-- ── PTO / sick requests (Jul 2026) ──────────────────────────────────────────
-- CSRs request time off from My Page; their manager approves/denies there.
-- RUN BEFORE the feature works. profiles.manager_id says who approves.
alter table profiles add column if not exists manager_id uuid references profiles(id);
create table if not exists pto_requests (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id),
  manager_id uuid references profiles(id),
  date date not null,
  end_date date,
  kind text not null default 'pto' check (kind in ('pto','sick')),
  reason text,
  status text not null default 'pending' check (status in ('pending','approved','denied')),
  decided_by uuid references profiles(id),
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz default now()
);
alter table pto_requests enable row level security;
drop policy if exists "pto_requests all" on pto_requests;
create policy "pto_requests all" on pto_requests for all using (true) with check (true);
-- errors harmlessly if already in the publication; needed for the red-dot badge
alter publication supabase_realtime add table pto_requests;

-- ── Meeting notes on schedule blocks (Jul 2026) ─────────────────────────────
alter table schedule_blocks add column if not exists note text;


-- ═══ Ask Andi knowledge assistant (Jul 2026) ═══════════════════════════════
create table if not exists kb_articles (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null default '',
  category text not null default 'general',
  source text not null default 'manual',
  source_url text,
  active boolean not null default true,
  review_days int default 90,
  last_reviewed_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz default now(),
  created_at timestamptz default now()
);

create table if not exists kb_revisions (
  id bigint generated always as identity primary key,
  article_id uuid references kb_articles(id) on delete cascade,
  title text, body text, category text,
  edited_by text,
  edited_at timestamptz default now(),
  note text
);

create table if not exists assistant_logs (
  id bigint generated always as identity primary key,
  profile_id uuid,
  rep_name text,
  question text,
  answer text,
  sources text[],
  covered boolean default true,
  helpful boolean,
  created_at timestamptz default now()
);

-- Starter articles: objection craft is generic and safe; policy articles are
-- DRAFTS with [FILL IN] markers so the assistant never invents company facts
-- (it treats the whole article as company knowledge once you edit it).
insert into kb_articles (title, category, body, updated_by) values
('Objection: I want to think about it', 'objections',
'Acknowledge first, never argue: "Totally fair — it''s your home and your money."

Then find the real objection: "So I make sure I''ve done my job — is it the timing, the price, or something I didn''t explain well?"

If timing: remind them the diagnostic locks in today''s findings, and the problem usually grows ("no-cools rarely fix themselves in July").
If price: move to the dispatch-fee framing — they''re deciding on a diagnosis, not a repair.
Close soft: "How about I hold tomorrow''s 8–12 window while you talk it over? Cancelling is one call."', 'seed'),
('Objection: I already have a company I use', 'objections',
'Never knock the other company. "That''s great — sounds like they''ve taken care of you."

Position as a second opinion, not a switch: "A lot of folks keep us as their second set of eyes. If your regular company quoted a big repair, a free second look can only help you."

If they''re calling US while having "a company" — point that out gently: something made them call. "Since you''re on the phone anyway, let''s at least get you on the board — no commitment past the visit."', 'seed'),
('Objection: The dispatch fee is too much', 'objections',
'[FILL IN the actual fee amount and waive policy before relying on this]

Frame it as a professional visit, not a fee: a licensed tech, a stocked truck, and a full diagnosis at their house.

If we waive it with repair: lead with that — "and if you move forward with the work, that fee disappears entirely."

Compare the alternative: guessing at the problem or a DIY fix that grows. "The fee is the cheapest part of any HVAC problem."', 'seed'),
('Service areas', 'product',
'[DRAFT — FILL IN before relying on this]
We serve Colorado Springs, Pueblo, and Castle Rock and surrounding areas. List exact zips/areas we do NOT serve, and any trip-charge rules for the edges of the territory.', 'seed'),
('Dispatch fee policy', 'policy',
'[DRAFT — FILL IN before relying on this]
Standard dispatch/diagnostic fee: $___. Waived when: ___. Member rate: $___. After-hours/emergency rate: $___.', 'seed');


-- ═══ Shift swaps (Jul 2026) ════════════════════════════════════════════════
create table if not exists shift_swaps (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null,
  requester_date date not null,
  target_id uuid not null,
  target_date date,                       -- null = give-away
  status text not null default 'pending_peer',  -- pending_peer | pending_manager | approved | denied | declined | canceled
  note text,
  manager_id uuid,
  peer_decided_at timestamptz,
  decided_by text,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz default now()
);
alter table shift_swaps enable row level security;
drop policy if exists "shift_swaps_read" on shift_swaps;
create policy "shift_swaps_read" on shift_swaps for select to authenticated using (true);
alter publication supabase_realtime add table shift_swaps;


-- ═══ Live call state persistence (Jul 2026) ════════════════════════════════
-- Transcripts/notes survive server restarts; rows are deleted at call end.
create table if not exists live_call_state (
  call_sid text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);


-- Realtime status updates on the wallboards (Jul 2026): profiles must be in
-- the publication for UPDATE events to reach the TV/dashboard at all.
alter publication supabase_realtime add table profiles;

-- ── Call recordings registry (Jul 2026) ─────────────────────────────────────
-- One row per completed Twilio recording, written the moment the recording
-- exists — NOT dependent on the rep filing an outcome. The Recordings tab
-- reads this and joins outcome/notes/booking on at read time. Also adds the
-- columns the recording webhook had been writing into the void (call_logs
-- never had recording_url/call_sid, so every attach silently failed).
create table if not exists call_recordings (
  id uuid primary key default gen_random_uuid(),
  recording_sid text unique not null,
  call_sid text,
  url text not null,
  duration int,
  direction text,                 -- 'inbound' | 'outbound'
  rep text,                       -- display name, same convention as call_logs.rep
  contact_id uuid,
  contact_name text,
  phone text,                     -- last-10 digits of the customer number
  call_started_at timestamptz,
  st_job_id bigint,               -- set when a job was booked on this call
  st_job_number text,
  created_at timestamptz default now()
);
create index if not exists call_recordings_contact_idx on call_recordings (contact_id, created_at desc);
create index if not exists call_recordings_created_idx on call_recordings (created_at desc);
alter table call_recordings enable row level security;
drop policy if exists "authenticated read call_recordings" on call_recordings;
create policy "authenticated read call_recordings" on call_recordings for select to authenticated using (true);

alter table call_logs add column if not exists call_sid text;
alter table call_logs add column if not exists recording_url text;
alter table call_logs add column if not exists recording_duration int;
alter table active_calls add column if not exists recording_url text;
alter table active_calls add column if not exists recording_sid text;
alter table active_calls add column if not exists recording_duration int;
-- Booking → recording linkage: the dialer now sends its contact id when booking.
alter table andi_bookings add column if not exists contact_id uuid;
alter table andi_bookings add column if not exists st_job_number text;

-- ── Call routing / voicemails (Jul 2026) ────────────────────────────────────
-- Routing config itself lives in app_settings ('call_routing') — no table.
-- Voicemails land in call_recordings (direction 'voicemail'); these columns
-- hold the Whisper transcript and the heard/unheard state for the inbox.
alter table call_recordings add column if not exists transcript text;
alter table call_recordings add column if not exists heard_at timestamptz;

-- ── Automated call evaluations (Jul 2026) ───────────────────────────────────
-- One row per scored inbound call. scores holds per-criterion detail
-- ({items:[{criterion,max,earned,applicable,evidence}], coaching_tip}).
-- Monthly averages auto-fill scorecard_actuals.call_quality.
create table if not exists call_evaluations (
  id uuid primary key default gen_random_uuid(),
  call_sid text unique,
  recording_sid text,
  contact_id uuid,
  contact_name text,
  phone text,
  rep text,
  profile_id uuid,
  scores jsonb,
  earned int,
  possible int,
  pct numeric,
  summary text,
  created_at timestamptz default now()
);
create index if not exists call_evaluations_profile_idx on call_evaluations (profile_id, created_at desc);
create index if not exists call_evaluations_rep_idx on call_evaluations (rep, created_at desc);
alter table call_evaluations enable row level security;
drop policy if exists "authenticated read call_evaluations" on call_evaluations;
create policy "authenticated read call_evaluations" on call_evaluations for select to authenticated using (true);

-- ── Dispatch line (Jul 2026) ────────────────────────────────────────────────
-- Dedicated tech line (719) 259-2681 → TaskRouter Dispatch queue. The skill
-- lives on profiles and syncs onto the worker's attributes; call_tasks.line
-- tags dispatch calls so dashboards can tell them apart.
alter table profiles add column if not exists dispatch_skill boolean default false;
alter table call_tasks add column if not exists line text;

-- ── Draft vs published schedules (Jul 2026) ─────────────────────────────────
-- Brittany's When-I-Work-style flow: schedule edits are DRAFTS (hatched in
-- WFM, invisible to reps) until Publish + Email flips them live. Existing
-- rows backfill as published so nothing vanishes from anyone's schedule.
alter table schedules add column if not exists published_at timestamptz;
update schedules set published_at = now() where published_at is null;
-- Dispatch self-toggle (Queues dropdown): granted people flip themselves in/out.
alter table profiles add column if not exists dispatch_available boolean default true;
-- ═══════════════════════════════════════════════════════════════════════════
-- SECURITY FIX — close public access to 15 tables (Supabase alert, Aug 2026)
-- Run this whole block at once in the Supabase SQL editor.
--
-- What it does: turns Row-Level Security ON everywhere it's missing, then
-- grants access ONLY to logged-in users ("authenticated"), matching how the
-- app actually uses each table. The server keeps full access — it uses the
-- service key, which bypasses RLS by design. Nothing in the app should
-- change; anonymous strangers lose all access.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Tables ONLY the server touches → no browser access at all ───────────
alter table kb_articles       enable row level security;
alter table kb_revisions      enable row level security;
alter table assistant_logs    enable row level security;
alter table customer_briefs   enable row level security;
alter table andi_bookings     enable row level security;
alter table csr_st_users      enable row level security;
alter table live_call_state   enable row level security;
alter table sync_state        enable row level security;
-- (no policies = only the service key can reach them)

-- ── 2. Tables the app READS from the browser ───────────────────────────────
alter table job_type_spiffs        enable row level security;
alter table membership_type_spiffs enable row level security;

drop policy if exists "auth read job_type_spiffs" on job_type_spiffs;
create policy "auth read job_type_spiffs" on job_type_spiffs
  for select to authenticated using (true);

drop policy if exists "auth read membership_type_spiffs" on membership_type_spiffs;
create policy "auth read membership_type_spiffs" on membership_type_spiffs
  for select to authenticated using (true);

-- ── 3. Tables the app READS AND WRITES from the browser ────────────────────
alter table profiles           enable row level security;
alter table app_settings       enable row level security;
alter table commissions        enable row level security;
alter table scorecard_actuals  enable row level security;
alter table shift_templates    enable row level security;

drop policy if exists "auth all profiles" on profiles;
create policy "auth all profiles" on profiles
  for all to authenticated using (true) with check (true);

drop policy if exists "auth all app_settings" on app_settings;
create policy "auth all app_settings" on app_settings
  for all to authenticated using (true) with check (true);

drop policy if exists "auth all commissions" on commissions;
create policy "auth all commissions" on commissions
  for all to authenticated using (true) with check (true);

drop policy if exists "auth all scorecard_actuals" on scorecard_actuals;
create policy "auth all scorecard_actuals" on scorecard_actuals
  for all to authenticated using (true) with check (true);

drop policy if exists "auth all shift_templates" on shift_templates;
create policy "auth all shift_templates" on shift_templates
  for all to authenticated using (true) with check (true);

-- ── 4. Verify: every table below should now say rowsecurity = true ─────────
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
order by rowsecurity, tablename;
-- ═══════════════════════════════════════════════════════════════════════════
-- SECURITY FIX — ROUND 2. Run this whole block at once.
--
-- Round 1 enabled RLS, but four tables carry LEGACY policies from early setup
-- that grant access to everyone — those override the new rules. This sweeps
-- every policy off those four and recreates only the logged-in-users one.
-- Also locks the three remaining rowsecurity=false tables from your results.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Sweep ALL policies off the four still-open tables (names vary, so this
--    drops whatever exists rather than guessing).
do $$
declare p record;
begin
  for p in
    select policyname, tablename from pg_policies
    where schemaname = 'public'
      and tablename in ('profiles','shift_templates','app_settings','scorecard_actuals')
  loop
    execute format('drop policy %I on %I', p.policyname, p.tablename);
  end loop;
end $$;

-- 2. Recreate exactly one rule each: full access for logged-in users only.
create policy "auth all profiles" on profiles
  for all to authenticated using (true) with check (true);
create policy "auth all app_settings" on app_settings
  for all to authenticated using (true) with check (true);
create policy "auth all shift_templates" on shift_templates
  for all to authenticated using (true) with check (true);
create policy "auth all scorecard_actuals" on scorecard_actuals
  for all to authenticated using (true) with check (true);

-- 3. The three stragglers from your verification output (server-only tables:
--    RLS on, no policies = only the service key reaches them).
alter table andi_membership_sales enable row level security;
alter table commission_events     enable row level security;
alter table commission_settings   enable row level security;

-- 4. Verify: should return ZERO rows.
select tablename from pg_tables
where schemaname = 'public' and rowsecurity = false;

-- ── Weekly Leadership Report (Aug 2026) ─────────────────────────────────────
-- One row per week (keyed by its Sunday). facts/ai are generated; notes holds
-- the meeting fill-ins (topics, projects, parking lot, wins, overrides).
-- Server-only table: RLS on, NO policies — the browser goes through
-- /api/admin/leadership/* (service key bypasses RLS).
create table if not exists leadership_reports (
  week_ending date primary key,
  facts jsonb,
  ai jsonb,
  notes jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table leadership_reports enable row level security;
