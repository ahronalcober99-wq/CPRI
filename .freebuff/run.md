# Run doc — CPRI public website (worktree: C:\Users\Nicole\Downloads\CPRI3)

## Reproduce uncommitted artifacts

- `.env` already exists at the project root (this is the main checkout, not a copy).
  It sets `PORT=3000`, DB creds, and Gmail SMTP creds. Never commit it; never print secrets.
- The MySQL database `cpri` must be reachable (see `server/db.js`). MySQL is provided
  by **XAMPP** (`C:\xampp\mysql`). After a machine/Freebuff restart, mysqld is NOT
  auto-started — relaunch it detached before the app server:
  ```bash
  cd /c/xampp/mysql && (nohup ./bin/mysqld --port=3306 >> C:/Users/Nicole/Downloads/CPRI3/.freebuff/mysql.log 2>&1 &)
  # wait ~8s, then confirm: netstat -ano | grep ":3306" | grep LISTEN
  ```
  Note: if mysqld is down, `initAuth()` in `server/auth.js` throws ECONNREFUSED and the
  app server crashes on boot (the "file-only mode" fallback does NOT cover auth init) —
  so MySQL must be up BEFORE `node server/server.js`.
- **Datetime gotcha (fixed):** the DB is MariaDB 10.4 with `STRICT_TRANS_TABLES`, which
  rejects `Date#toISOString()` values carrying fractional seconds (e.g.
  `2026-08-04T00:39:05.438Z`) when written to `DATETIME` columns — this crashed the
  server on submission status changes. Fixed in `server/server/db/queries.js`: ISO
  timestamps are normalized to `YYYY-MM-DD HH:MM:SS` before any insert/update. Don't
  revert that layer; new writes must go through `insert`/`update`/`run`.
- Default admin is seeded automatically on boot: `admin` / `admin12345` (or
  `ADMIN_PASSWORD` from env).
- **Reliability pass (in place):**
  - `server/server.js` registers `process.on('uncaughtException')` and
    `process.on('unhandledRejection')` guards — an error in one request no longer
    kills the whole server (log and keep serving).
  - A central Express error handler returns JSON for failures, and unknown `/api/*`
    routes return `{"error":"Not found."}` (404) instead of the HTML fallback.
  - Sessions are **file-backed** (`express-session` + `session-file-store`, stored in
    `server/data/sessions/`, gitignored) instead of the in-memory MemoryStore —
    logins now survive server restarts and MySQL downtime. Session TTL is 8h.
  - To reinstall deps on a fresh checkout: `npm install` (includes
    `session-file-store`).
- **Demo seed data (optional):** `npm run seed:demo` populates MySQL and the JSON
  content files with realistic sample data (16 submissions, 12 publications, 6
  researchers, 5 events, 6 featured research items, 5 announcements, ethics,
  innovation, registrations, abstracts, logs). Demo rows use `demo-` prefixed IDs
  so `npm run seed:demo:clear` removes ONLY them — real rows (admin user, real
  submissions, user-created announcements) are never touched. Demo researcher
  logins: `mramos` / `kbautista` / `mreyes` / `jdelacruz` / `avillanueva` /
  `ctan`, password `demo12345`. The ethics reviewer demo login is `ahron` /
  `demo12345` (also reset by `seed:demo`). Re-running `seed:demo` wipes + reseeds
  demo data (idempotent).
  - The notification bell is role-aware: guests (no session) see a read-only feed
    of announcements + upcoming events with a sign-in CTA; each logged-in role
    sees personal notifications with its role label (`GET /api/notifications`);
    admins/CPRI staff additionally see the System Activity audit trail. Settings
    gear opens `profile.html#prefs` for signed-in users, `login.html` for guests.
  - Note: `seed.mjs` (the JSON→MySQL migration) is separate from `seed-demo.mjs`
    (demo data). Do not confuse them.
- **Backups:** `npm run backup` dumps the `cpri` database with mysqldump (found
  automatically at `C:/xampp/mysql/bin/mysqldump.exe`; override with
  `MYSQLDUMP_PATH` in `.env`) and copies `server/data/*.json` into a timestamped
  `backups/<timestamp>/` folder (gitignored) with `cpri.sql`, `data/`, and
  `manifest.json`. Keeps the latest 10 by default; `npm run backup -- --keep 5`
  keeps 5; `npm run backup -- --prune` only prunes. Restore:
  ```bash
  mysql -u root cpri < backups/<timestamp>/cpri.sql
  # then copy backups/<timestamp>/data/*.json back into server/data/
  ```
- **Mail (fixed):** BOTH verification codes and password reset links send through
  the Gmail transporter (`GMAIL_USER` + `GMAIL_APP_PASSWORD`). The old
  SMTP_HOST-based transporter was removed — `sendResetEmail()` in
  `server/lib/mail.js` never throws (so `/api/auth/forgot` keeps its
  always-return-success privacy behavior) and prints a `[DEV] Password reset
  link...` fallback to the server console if Gmail is unavailable, so resets are
  always recoverable in dev.
- **Google (Gmail) sign-in:** "Continue with Google" / "Sign up with Google"
  buttons on `login.html`/`register.html` run a standard OAuth 2.0 flow in
  `server/auth.js` (`/api/auth/google` + `/api/auth/google/callback`). Requires
  `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` in `.env` — **configured as of
  Aug 2026** (real client ID/secret pasted by the owner; values live only in
  `.env`, which is gitignored). If they were ever emptied, the button shows a
  "not configured" notice instead. Authorized redirect URI registered:
  `http://localhost:3000/api/auth/google/callback` (add the tunnel host's
  callback URI per share run for public-link testing).
  New Google accounts are created with `setupPending=1` (temporary
  `student_researcher` role) and are redirected to **`complete-profile.html`**
  to pick their account type (Student / Faculty / Adviser) + optional name and
  department (`PUT /api/auth/profile/setup`, one-shot — clears `setupPending`;
  `needsSetup` is exposed via `/api/auth/me`). `main.js` bounces any logged-in
  user with `needsSetup=true` away from other pages back to the setup page.
  When setup completes, every active admin gets a bell notification
  (`google_signup`, "New Google sign-up: …") linking to
  `admin-dashboard.html#users` (the dashboard honors `#<tab>` deep links and
  hash-only tab switches so the link lands directly on User Management).
  The Google photo is saved as `profilePhoto`; existing accounts link by email
  and adopt the photo if they had none. Endpoints are overridable via
  `GOOGLE_AUTH_URL` / `GOOGLE_TOKEN_URL` / `GOOGLE_USERINFO_URL` (defaults:
  Google production).
  - **End-to-end test without real credentials:** run the local mock provider
    (`server/dev/mock-google-oauth.mjs`, port 3200, profile read from
    `server/data/mock-google-profile.json`), then launch a second app instance
    with the env overrides above + `PORT=3100` + fake `GOOGLE_CLIENT_ID`/
    `GOOGLE_CLIENT_SECRET`, and click the button at `localhost:3100`. One
    gotcha: the browser shares the `cpri.sid` cookie + session store across
    ports, so log out first (server-side) before running the flow, and only run
    ONE app instance during the test to avoid session-state clobbering.

## Run the server

```bash
PORT=3000 node server/server.js
```

- **Share with friends (public link):**
  - `npm run share:setup` — downloads `cloudflared` (no account needed) into
    `.tools/` (gitignored).
  - `npm run share` — auto-starts the server on :3000 if it is down, opens a
    public Cloudflare Quick Tunnel (`*.trycloudflare.com`), prints the URL
    (also copied to clipboard), and stays running until Ctrl+C. Works from
    anywhere, not just your LAN.
  - Optional: `npm run share -- --ngrok` forces ngrok (needs a free account +
    `ngrok config add-authtoken` once); `--port 8080` tunnels another port.
  - Note: the script defaults to port 3000 and deliberately ignores any
    ambient `PORT` env var (same gotcha as below) unless `--port` is passed.
  - Each run gets a fresh random URL; the tunnel dies when the script/PC stops.
  - **Google redirect URI in share output:** the printed summary now includes a
    `Google sign-in redirect URI` line — the exact
    `<tunnel-url>/api/auth/google/callback` to add under *Authorized redirect
    URIs* in the Cloud Console client so "Continue with Google" works through
    the public link. It also states whether real Google is configured (reads
    `GOOGLE_CLIENT_ID` from `.env` without printing secrets; demo mode warning
    shown when empty). Fixed a bug where it ALWAYS said "not configured":
    `envFromDotenv` in `server/share.mjs` called `fs.readFileSync` on the
    promises-only `fs` import (`import { promises as fs }`), which threw and
    returned empty — the import now also pulls `readFileSync` from 'fs'.
  - Note: if a share session appears to print a stale/wrong URL or status, a
    leftover `npm run share` from an earlier run may still be alive — kill all
    `npm run share` / `server/share.mjs` / `cloudflared.exe` processes (keep
    `node server/server.js`) before relaunching one clean tunnel.
  - **Full-access link:** `npm run share` also writes a random access key +
    30-day expiry to `server/data/demo-access.key` (gitignored) and prints a
    second link, `<url>/api/auth/demo-login?key=<key>`. Clicking it auto-logs
    the visitor in as admin (via `GET /api/auth/demo-login` in `server/auth.js`)
    and lands on the Admin Console — a one-click demo of full access. The key
    file is deleted (sync) when the share session stops (Ctrl+C), revoking
    outstanding links; the server ALSO self-expires keys after 30 days
    (`DEMO_KEY_TTL_MS` in `server/auth.js`), so even a crashed share session
    can't leave a live link forever. The tunnel process itself has a hard
    30-day lifetime cap (re-armed `setTimeout` in `server/share.mjs` — a plain
    30-day timer would exceed Node's 32-bit delay clamp and fire instantly).
    Without the file or with a bad/expired key the route returns 400/403.

- **Clock-skew gotcha (share tunnel):** the Windows system clock can drift days behind
  real UTC (this machine was ~2.8 days behind on Aug 2026). cloudflared then fails with
  `tls: failed to verify certificate: x509: certificate has expired or is not yet valid`
  and `npm run share` exits. The Windows Time service is disabled on this machine, so fix
  by setting the clock directly (admin):
  ```powershell
  powershell -Command "Set-Date -Date '<YYYY-MM-DD HH:mm:ss local>'; (Get-Date).ToUniversalTime()"
  ```
  Get the true UTC from any HTTP `Date:` header (`curl -sI https://www.google.com/`), then
  convert to GMT+13 local time before setting.

- **Gotcha:** `server.js` reads `process.env.PORT || 3000`, and dotenv does **not**
  override an already-set env var. Some shells (e.g. Freebuff preview infra) carry a
  `PORT` variable pointing at a random port — the server will silently bind that one
  instead of 3000. Always launch with an explicit `PORT=3000` prefix.
- Logs go to the thread's preview log (`.freebuff/preview-*.log`) when launched via
  `nohup ... &`.
- To restart after backend edits: find the listener with
  `netstat -ano | grep ":3000" | grep LISTEN`, `taskkill //PID <pid> //F`, then relaunch
  with the `PORT=3000` prefix (plain `kill <pid>` does not work on Windows).
- The preview is registered at `http://localhost:3000` (PID changes on every restart —
  re-register `register_preview` with the new listener PID after a restart).
