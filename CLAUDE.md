# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Vite dev server on :3000 (frontend only — /api/* calls will 404, see below)
npm run build    # Vite build → dist/
npm run server   # Express API on :3001 (or $PORT), serves dist/ if it exists
npm start        # build + node server.js — the full app on one port; what Railway runs
```

There are no tests, linter, or typechecker configured. `npm run dev` has no proxy to the API server, so any page touching `/api/*` (the dialer, recordings, ServiceTitan panels) needs `npm start` — or run `npm run server` and hit :3001, since Express serves the built `dist/` itself.

## Architecture

Two halves that share a Supabase database but talk to it differently:

**Frontend (`src/`)** — React 18 + Vite + react-router, no CSS framework (inline styles + `src/index.css` CSS variables). It talks to Supabase **directly** from the browser with the anon key (`src/lib/supabase.js`), not through the Express server. The server is only for things needing secrets: Twilio, ServiceTitan, Anthropic.

**Backend (`server.js`, ~1350 lines, single file)** — Express. Uses the Supabase **service key**, so it bypasses RLS. Route groups: `/api/st/*` (ServiceTitan), `/api/twilio/*` (voice tokens, SMS, TwiML webhooks), `/api/commission/*`, plus the catch-all that serves the React SPA (must stay last).

### State flow

`main.jsx` → `AuthProvider` → `App` → (if logged in) `DataProvider` → `DialerLayout`.

- **`src/lib/AuthContext.jsx`** — Supabase auth session + a `profiles` row. `isAdmin` is `profile.role === 'admin'` and gates the `/settings` route and admin UI throughout.
- **`src/lib/DataContext.jsx`** — loads **all** contacts (paginated 1000 at a time) and campaigns into memory once, then keeps them live via a single Supabase realtime channel on `contacts` and `campaigns`. Pages read from this context and filter client-side; they don't re-query. Writes go through `sb.from('contacts').update(...)` and are reflected both by the realtime event and by local `setContacts` — expect both paths to fire.
- **`src/pages/DialerLayout.jsx`** — the app shell: nav, rep status tracking (writes `status_events` rows on status change), and all authenticated routes.

### Dialer domain model

Contact lifecycle lives in `src/lib/constants.js` and `src/lib/utils.js`:

- A contact is **done** when its status is in `DONE_OUTCOMES` (Booked / Not Interested / DNC / Bad Data) or `Max Attempts` (after `MAX_ATTEMPTS` = 3).
- **Claim system**: `contacts.claimed_by` / `claimed_at` hold a rep's name so two reps don't dial the same lead. Cleared on a final outcome, explicit release, or when the rep is removed.
- **Reps are identified two ways** — by `profile_id` FK in most tables, but by **display-name string** (`profile.name || profile.email`) in `call_logs.rep` and `contacts.claimed_by`. Anything keyed by name won't follow a rename and won't disappear when a profile does; Leaderboard filters removed reps by name for exactly this reason.

### User removal

Users are **deactivated, never deleted** — `call_logs` and `commissions` are pay records that must survive. `POST /api/admin/user/deactivate` (server-side, service key) bans the auth login, sets `profiles.active = false`, releases their claimed leads, drops `csr_campaigns` rows, and closes any open `status_event`. Every screen that lists users filters `.eq('active', true)`; `AdminPage` deliberately doesn't, so removed users can be restored.

The anon key has no delete or deactivate rights on `profiles` by design, so this **cannot** be done from the browser. Admin routes are gated by `requireAdmin` in `server.js`, which is the only auth check on the whole server — an `/api/admin` route without it is wide open. Note password changes go through a Supabase **edge function** (`admin-change-password`) that lives outside this repo; new admin operations should use the Express server instead.
- **DNC cascade**: marking DNC applies to every contact sharing the normalized phone number. `dncSet` (from `buildDNCSet`) is a set of normalized phone digits, computed in `DataContext`.
- **Duplicates** are detected by normalized phone via `getDupSet`.

### Twilio voice

Browser uses `@twilio/voice-sdk` with a token from `POST /api/twilio/token`. Outbound calls hit the TwiML app → `/api/twilio/twiml/outbound`; inbound rings `/api/twilio/inbound`, which looks up the contact by phone. Call state is mirrored into the `active_calls` table by the server webhooks, which is how other screens (Live, War Room) see calls in progress. Recording callbacks land in `/api/twilio/recording`.

### Commissions

Reps are paid **when ServiceTitan marks a booked job completed**, not when they book it. `syncCommissions()` in `server.js` owns the `commissions` table — nothing else writes payout rows, and the browser must not (it used to, at a flat $2, which double-counted and ignored the tagged amounts).

The flow: `/api/st/book` writes an `andi_bookings` row (`st_job_id → profile_id`). The sync polls those jobs via `GET /jpm/v2/jobs?ids=` (50 max per call), and on `jobStatus === 'Completed'` prices the payout and upserts a `commissions` row. `Canceled` jobs get `commission_synced_at` set so they stop being polled.

**Payouts are per category, not per job type.** `job_type_spiffs` tags each ST job type with a category (`repair` / `maintenance` / `free_estimate` / `other` / `non_commissionable`); the dollar amount for each category lives in `app_settings.job_category_payouts` as a JSON string. **`job_type_spiffs.amount` is vestigial and always null** — the config UI has never written it. Never hardcode an amount in a UI label; it drifts from what's actually paid (the category dropdown did exactly that for months).

Every category pays on job completion, including the estimate ones — a completed free estimate pays out even if it sold nothing (confirmed with Brandyn, Jul 2026; earlier UI copy promised "on sold", which was never implemented). A category with no amount leaves the job **unsettled** rather than paying $0, so setting the amount later still pays out; a deliberate $0 settles without writing a row.

**Attribution is local, deliberately.** `Job.soldById` is the *technician* who ran the call, not the CSR who booked it — `andi_bookings` is the source of truth. Memberships are the exception: they have no `andi_bookings` anchor, so the sync pages `GET /memberships?createdOnOrAfter=` from a `sync_state` watermark and attributes via `soldById → csr_st_users → profile`. Note `Membership.soldById` is a *user* id while `csr_st_users` is populated from `/settings/v2/employees` — whether those id spaces match is **unverified**.

Idempotency lives in the database: unique partial indexes on `commissions.st_job_id` and `st_membership_id` mean a job can't be paid twice even if two Railway replicas sync at once. Every write is an upsert on those keys. `COMMISSION_SYNC_MINUTES` sets the interval (default 15, `0` disables).

`commission_settings` (the old flat booking/membership rates) is dead — nothing reads it.

### Selling memberships (writes to ServiceTitan)

`POST /api/st/membership/sell` calls ST's `POST /memberships/sale`, which is documented as **"Creates membership sale invoice"** — it bills a real customer and returns `{invoiceId, customerMembershipId}`. Then it PATCHes `soldById` so the membership sync credits the CSR. Admin-only until proven on a real sale; `MEMBERSHIP_SALE_ALL_REPS=1` opens it to everyone.

**The sale POST deliberately passes `_retry = false`.** `stPost`/`stPatch` retry once on timeout, which would bill a customer twice if the first attempt actually succeeded. Never let a retry near a non-idempotent ST write.

`saleTaskId` and `durationBillingId` are **not derivable from the ServiceTitan API** — the Pricebook spec never mentions memberships, and nothing maps a membership type to the SKU that sells it. ("Task" is ST's older name for a Pricebook item; Sales/Estimates confirms this by pairing `skuId` with `membershipDurationBillingId`.) So an admin maps each type by hand in Commission Mapping → stored on `membership_type_spiffs.sale_task_id` / `duration_billing_id`. Only fully-mapped types appear in the dialer's "Sell Membership?" picker. `durationBillingId` must come from `/membership-types/{id}/duration-billing-items` — the `durationBilling` array on the membership type itself carries no ids.

Every attempt, success or failure, is recorded in `andi_membership_sales` — an invoice is real money, so don't rely solely on what ST echoes back.

### ServiceTitan + AI brief

`server.js` holds an OAuth client-credentials token cache (`getSTToken`) and thin `stGet`/`stPost` wrappers with a 25s timeout and one retry — ST is slow and flaky, so keep new calls going through these wrappers rather than bare `fetch`.

`GET /api/st/intelligence/:id` is the pre-call cheat sheet: `gatherCustomerFacts` pulls ST data → `generateBrief` sends it to Claude (Haiku) asking for strict JSON (`headline` / `actions` / `flag`) → cached in the `customer_briefs` table with a TTL. `?refresh=1` forces regeneration. `normalizeBrief` tolerates legacy plain-text cache rows.

## Supabase

Schema is not in the repo — only `SUPABASE_SETUP.sql` (the `profiles` table plus the signup trigger). Everything else was created in the Supabase console; read the queries to infer shape. Tables in active use: `contacts`, `campaigns`, `call_logs`, `profiles`, `schedules`, `schedule_blocks`, `shift_templates`, `status_events`, `attendance_points`, `active_calls`, `app_settings`, `commissions`, `commission_settings`, `job_type_spiffs`, `membership_type_spiffs`, `csr_campaigns`, `csr_st_users`, `scorecard_actuals`, `customer_briefs`, `andi_bookings`.

`app_settings` is a key/value table (`key`, `value` JSON) — `custom_statuses`, `scorecard_weights`, `scorecard_thresholds` live there rather than in code.

## Gotchas

- **`src/utils.js` is dead code.** It's a stale near-copy of `src/lib/utils.js` and imports `./constants`, which doesn't exist. Every page imports from `../lib/utils`. Edit `src/lib/utils.js`.
- **Supabase URL and anon key are hardcoded as fallbacks** in `src/lib/supabase.js`, so the app works without `VITE_*` env vars set.
- Server env vars (`.env`, untracked; set in Railway for prod): `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY`, `TWILIO_API_SECRET`, `TWILIO_PHONE_NUMBER`, `TWILIO_TWIML_APP_SID`, `ST_CLIENT_ID`, `ST_CLIENT_SECRET`, `ST_APP_KEY`, `ANTHROPIC_API_KEY`, `APP_URL`.
- Deploy is Railway from GitHub `main` (`railway.json`); production is `andi.awesomeservice.com`. New hostnames must be added to `allowedHosts` in `vite.config.js`.
