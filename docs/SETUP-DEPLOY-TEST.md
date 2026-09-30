# CPRI — setup, deploy, and test guide

Everything below was verified against this working copy on 1 October 2026
(MySQL on `localhost:3306`, Express on `localhost:3000`, front end served from `public/`).

---

## 1. Why the live GitHub Pages site said "HTTP 405"

`https://ahronalcober99-wq.github.io/CPRI/` is a **static host**. It has no Node
process, so a request to `https://ahronalcober99-wq.github.io/api/auth/login`
is handled by GitHub Pages, which only serves `GET`/`HEAD` and answers every
other method with **405 Not Allowed** and an HTML body.

Proved locally:

```bash
curl -i -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" -d '{}'
# HTTP/1.1 400 · content-type: application/json

curl -i -X POST https://ahronalcober99-wq.github.io/api/auth/login \
  -H "Content-Type: application/json" -d '{}'
# HTTP/2 405 · content-type: text/html   <-- GitHub Pages, not Express
```

So there was **no route, method, or CORS bug in the back end**. The deployed
front end simply had no API origin configured, so every `/api/...` call stayed
root-relative and landed on the static host. `POST /api/auth/login` has existed
in `server/auth.js` all along and answers JSON on the correct origin.

The one remaining step that only you can do: **host the API on a public HTTPS
URL** and point the front end at it (§9–§11). Until then the Pages site is a
read-only static copy of the interface, and it now says so by name instead of
reporting a generic 405.

---

## 2. Local: install and start

MySQL must be running **before** the server, or every `/api/` call fails.

```bash
# 1. MySQL (XAMPP MariaDB on Windows)
"C:\xampp\mysql\bin\mysqld.exe" --console      # or start MySQL from the XAMPP panel

# 2. Dependencies
npm install

# 3. Server
npm start                    # = node server/server.js
#   or: node server/server.js
#   or during development: npm run dev   (node --watch)
```

The server only honours a real, positive `PORT`; an empty or `0` value (some
shells export `PORT=0`, and dotenv never overwrites an existing variable)
falls back to 3000, so `npm start` puts the site on <http://localhost:3000>
without any prefix. To stop a stale listener:
`taskkill //PID <pid> //F` (find it with `netstat -ano | grep :3000`).

## 3. Local website URL

<http://localhost:3000> — the Express server serves `public/` itself, so the
whole site works from one origin:

| Page | URL |
| --- | --- |
| Home | <http://localhost:3000/> |
| Login | <http://localhost:3000/login.html> |
| Register | <http://localhost:3000/register.html> |
| Account dashboard | <http://localhost:3000/account.html> |
| Admin console | <http://localhost:3000/admin-dashboard.html> |
| Research impact dashboard | <http://localhost:3000/research-impact-dashboard.html> |
| Health probe | <http://localhost:3000/healthz> → `{"ok":true,"db":"up"}` |

## 4. API origin

`public/assets/js/main.js` holds the **single** API setting:

```js
window.CPRI_API_BASE = window.CPRI_API_BASE || '';
```

* `''` (default) — same origin. Correct for `npm start`; nothing else to change.
* Static front end + hosted API — put the API origin there, e.g.
  `window.CPRI_API_BASE = 'https://cpri-api.onrender.com';` (scheme required,
  no trailing slash).
* Per-browser override, no redeploy needed:
  `localStorage.setItem('cpri-api-base', 'https://cpri-api.onrender.com')`.

Every `/api/` call goes through `CPRI.apiFetch()` / `CPRI.apiBase()`, which
rewrite the path, send `credentials: 'include'` when a base is set, and turn a
non-JSON answer into a readable error instead of `Unexpected token '<'`.

## 5. MySQL configuration

`server/server/db/` reads `mysql2/promise` with a pool; defaults are
`localhost:3306`, user `root`, empty password, database `cpri`.
Tables in use: `users`, `submissions`, `repository`, `publications`,
`researchers`, `ethics`, `events_module`, `event_abstracts`,
`event_registrations`, `innovation_extension`, `announcements` (content JSON),
`inquiries`, `notifications`, `direct_messages`, `system_logs`.

```bash
# check the connection the app sees
node --env-file=.env --input-type=module -e "
import mysql from 'mysql2/promise';
const c = await mysql.createConnection({host:process.env.DB_HOST,port:+process.env.DB_PORT,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});
const [r] = await c.query('SELECT COUNT(*) AS users FROM users');
console.log(r[0]); await c.end();"

# or from the MySQL client
mysql -u root cpri -e "SHOW TABLES;"
```

## 6. Environment variables

Copy `.env.example` → `.env` (`cp .env.example .env`) and fill it in. `.env` is
gitignored; `.env.example` contains placeholders only.

| Variable | Purpose |
| --- | --- |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_POOL_LIMIT` | MySQL connection |
| `PORT` | HTTP port (default 3000; hosts usually inject their own) |
| `SESSION_SECRET` | Signs session cookies — long random string in production |
| `CORS_ORIGINS` | Comma-separated front-end origins allowed to call the API with cookies |
| `TRUST_PROXY` | `1` when behind a reverse proxy that terminates TLS |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `MAIL_FROM_NAME` | Verification / reset emails |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | "Continue with Google" (optional) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Bootstrap admin account |

> **Rotate the Gmail app password.** It was committed in `.env.example` in the
> public repository (commit `37e1fca`). It is replaced with a placeholder as of
> `dd3e74c`, but the old value is still in history and must be treated as
> compromised: Google Account → Security → App passwords → revoke and generate
> a new one, then put it in `.env` only.

## 7. GitHub Pages configuration

The Pages workflow (`.github/workflows/pages.yml`) publishes `public/`, stamps
`assets/js/main.js` and `assets/css/styles.css` with the commit SHA so a stale
600-second Pages cache can never serve an old script again, and writes
`.nojekyll`.

Repository → Settings → Pages:

* **Source: GitHub Actions** — publishes only the built site. This is the
  correct setting for this repository.
* If it is left on **Deploy from a branch** (main, `/`), GitHub publishes the
  whole repository, which is why `https://ahronalcober99-wq.github.io/CPRI/server/server.js`
  currently downloads the back-end source. Nothing secret is exposed (`.env`,
  sessions, uploads, backups all 404), but the source tree should not be served.

Also add the Pages origin to the API host's `CORS_ORIGINS`:

```
CORS_ORIGINS=https://ahronalcober99-wq.github.io
```

A cross-site session cookie needs `SameSite=None; Secure`, and browsers only
accept `Secure` over HTTPS — so the hosted API **must** be HTTPS. With
`TRUST_PROXY=1` and a proxy sending `X-Forwarded-Proto: https`, the server emits
exactly that cookie. Over plain HTTP the cookie is dropped and login silently
fails; that is a browser rule, not an app bug.

## 8. Deploying the API

`Dockerfile` and `.dockerignore` are committed and ready.

**Docker (any Node host: Render, Railway, Fly, VPS, …)**

```bash
docker build -t cpri-api .
docker run -p 3000:3000 \
  -e DB_HOST=... -e DB_PORT=3306 -e DB_USER=... -e DB_PASSWORD=... -e DB_NAME=cpri \
  -e SESSION_SECRET=... -e CORS_ORIGINS=https://ahronalcober99-wq.github.io \
  -e TRUST_PROXY=1 \
  cpri-api
```

**Buildpack host (Render / Railway / Heroku)**

* Build: `npm ci --omit=dev` · Start: `node server/server.js`
* Health check path: `/healthz`
* Set the same variables as above in the host's dashboard.
* Point `DB_HOST` at a managed MySQL that the host can reach (a database on your
  laptop is not reachable from the internet).

**Render blueprint.** `render.yaml` is committed: Render → New → Blueprint →
this repository. It prompts for `DB_*`, `ADMIN_*`, `GMAIL_*` and `GOOGLE_*`
(`sync: false`), generates `SESSION_SECRET`, and presets `CORS_ORIGINS` and
`TRUST_PROXY=1`.

**Back-end host must have the data.** Content pages read tracked JSON in
`server/data/`, but users, submissions, repository records, inquiries and the
impact dashboard read MySQL. Migrate/seed the managed database before the front
end is pointed at it:

```bash
DB_HOST=<managed-host> DB_USER=... DB_PASSWORD=... DB_NAME=cpri npm run migrate
```

Uploaded files live on local disk (`public/assets/uploads/`), so a host with an
ephemeral filesystem loses them on redeploy — mount a volume or switch to object
storage if that matters.

Then set the origin in `public/assets/js/main.js` (§4), commit, push, and let the
Pages workflow redeploy.

## 9. How to test login

```bash
# wrong password → 401 JSON
curl -i -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"identifier":"admin","password":"nope"}'      # {"error":"Invalid username/email or password."}

# right password → 200 + session cookie
curl -i -c jar.txt -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"identifier":"admin","password":"<your admin password>"}'

curl -b jar.txt http://localhost:3000/api/auth/me     # 200, the same user
```

In the browser: open `/login.html`, submit wrong credentials → the page shows
*"Invalid username/email or password."* (the old `HTTP 405` text is gone when
the API is reachable). Submit valid credentials → redirect to
`account.html` / `admin-dashboard.html` by role. Admin-only endpoints answer
`401 {"error":"Not authenticated."}` — always JSON, never HTML.

## 10. How to test registration

Registration is two-step by design: request a code, then register with it.

```bash
curl -X POST http://localhost:3000/api/auth/send-verification-code \
  -H "Content-Type: application/json" -d '{"email":"you@example.com"}'
# the 6-digit code is printed in the SERVER CONSOLE:
#   [auth] Stored verification code for you@example.com: 123456

curl -X POST http://localhost:3000/api/auth/verify-code \
  -H "Content-Type: application/json" -d '{"email":"you@example.com","code":"123456"}'

curl -i -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"you","email":"you@example.com","password":"longenough1",
       "fullName":"Your Name","role":"student_researcher","code":"123456"}'
# 201 + JSON user row

mysql -u root cpri -e "SELECT username,email,role,status FROM users WHERE email='you@example.com';"
```

Passwords are bcrypt (`$2a$10$…`) and never returned by any endpoint.

## 11. How to test admin

```bash
curl -c admin.txt -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"identifier":"<ADMIN_EMAIL>","password":"<ADMIN_PASSWORD>"}'

for p in summary analytics users hero-stats public-summary impact-dashboard; do
  printf "%-18s %s\n" "$p" \
    "$(curl -s -o /dev/null -w '%{http_code}' -b admin.txt http://localhost:3000/api/admin/$p)"
done
# all 200 application/json
```

Then open `/admin-dashboard.html` and `/research-impact-dashboard.html` in the
browser while signed in as admin.

## 12. How to verify every endpoint

The whole surface is covered by one command:

```bash
npm run check:api
# CPRI API check against http://localhost:3000
#   ok   GET /healthz — status 200, db up
#   ok   GET /api/site — status 200, JSON, object
#   ...
#   36/36 checks passed
```

It checks that every public endpoint answers JSON, that every protected and
admin endpoint answers `401` JSON **rather than an HTML page** when anonymous,
that an unknown route is a JSON `404`, that the contact form writes a row, that
a wrong password is a `401`, and — when `ADMIN_EMAIL`/`ADMIN_PASSWORD` are set
in `.env` — that admin login works, every admin endpoint answers `200`, and that
logout really invalidates the session. Exit code is non-zero on any failure, so
it can run in CI. It writes one `inquiries` row; the command prints the SQL to
delete it. Point it at a deployed API with
`CPRI_BASE=https://your-api.example.com npm run check:api`.

By hand:

```bash
for p in site announcements events research agenda researchers publications \
         events-module notifications repository innovation-extension; do
  printf "%-22s %s\n" "$p" \
    "$(curl -s -o /dev/null -w '%{http_code} %{content_type}' http://localhost:3000/api/$p)"
done
# 200 application/json each

curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/healthz          # 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/contact \
  -H 'Content-Type: application/json' \
  -d '{"name":"A","email":"a@example.com","subject":"s","message":"m"}'          # 201, row in `inquiries`

curl -s -o /dev/null -w '%{http_code} %{content_type}\n' \
     http://localhost:3000/api/does-not-exist                                    # 404 application/json
```

## 13. Protected pages

`server/server.js` gates the member and admin page shells themselves, not just
their data:

* anonymous → `302 /login.html?next=<the page you asked for>`
* signed in as a non-admin on an admin page → `302 /account.html`
* `login.html` follows a site-relative `?next=` after a successful sign-in

Admin pages: `admin-dashboard.html`, `research-impact-dashboard.html`,
`audit-logs.html`, `calendar.html`, `file-manager.html`,
`email-notifications.html`, `reports.html`.
Member pages: `account.html`, `profile.html`, `messages.html`,
`submissions.html`, `submission.html`, `submit.html`, `ethics*.html`,
`researcher-form.html`, `publication-form.html`,
`innovation-extension-form.html`, `event-abstract.html`,
`event-registration.html`. Public pages are untouched.

This guard runs on the Express server. A statically hosted copy of the front
end (GitHub Pages) has no server to run it, so there the JSON `401` from the API
is what protects the data — the page shell is downloadable but shows nothing.
If you serve the front end from the API host as well, visitors also get the
redirect.

Research records live at `/api/submissions` and `/api/repository` (both
authenticated); `/api/research` is the public content feed. There are no
`/api/research/:id` CRUD routes in this project, and the admin dashboards are
`account.html` and `admin-dashboard.html` — there is no `user-dashboard.html`,
`login.js`, or `register.js` to fix.
