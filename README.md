# AHS Dialer

Full-stack dialer application for Awesome Home Services.

## Deploy to Railway

### Step 1 — Supabase Setup
1. Open your Supabase project → SQL Editor
2. Paste and run the contents of `SUPABASE_SETUP.sql`
3. After running, sign up in the app, then run:
   ```sql
   UPDATE profiles SET role = 'admin' WHERE email = 'brandyn@awesomehomeservices.com';
   ```

### Step 2 — GitHub
1. Create a new GitHub repo named `ahs-dialer`
2. Upload all these files to it (drag and drop on GitHub.com)

### Step 3 — Railway
1. In Railway, click **New Project → Deploy from GitHub repo**
2. Select your `ahs-dialer` repo
3. Add these environment variables in Railway settings:
   - `VITE_SUPABASE_URL` = `https://zadiisjngiuwuxggmyqu.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = (your anon key)
4. Railway auto-deploys — your app is live in ~2 minutes

### Updating the app
Push changes to GitHub → Railway auto-redeploys. Zero downtime.

## Features
- Email/password login with admin and rep roles
- Real-time contact updates across all screens
- Full dialer with claim system, callbacks, DNC cascade, duplicate detection
- Campaign management with CSV upload/export (admin only)
- Dashboard with timeframe filters and rep performance
- Live rep activity feed
- Notes search
- Mobile responsive
