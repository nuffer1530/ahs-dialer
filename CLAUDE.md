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
