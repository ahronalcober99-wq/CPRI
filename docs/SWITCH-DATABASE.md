# Switching the API to a different MySQL database

TiDB Cloud Starter is the fiddliest option for this app: a serverless username
prefix (`abc123.root`), a non-standard port (**4000**), mandatory TLS, and a
firewall that can silently block the host's IP — which is exactly the
`Access denied … (using password: YES)` you were seeing.

Any standard MySQL 8 / MariaDB 10.4+ host works. This guide uses **Aiven for
MySQL**, which is free forever and needs no credit card.

> ⚠️ This repository is **public**. Never commit `ca.pem` or a real password —
> they belong in `.env` (gitignored) and in Render's Environment settings only.

## What the API needs

| Variable | Meaning |
|---|---|
| `DB_HOST` | database hostname |
| `DB_PORT` | port (3306 for most MySQL; the provider's port otherwise) |
| `DB_USER` | username |
| `DB_PASSWORD` | password |
| `DB_NAME` | database name (must already exist) |
| `DB_SSL_MODE` | `auto` (default) · `require` · `disable` |
| `DB_SSL_CA` | the provider's CA certificate, if it signs with its own CA |
| `DB_SSL_REJECT_UNAUTHORIZED` | `false` keeps TLS but skips the certificate check |

`DB_SSL_MODE=auto` (the default) already means “TLS for any non-localhost host”.

## Option A — Aiven for MySQL (free, no credit card) ✅ recommended

### 1. Create the service

1. Sign up at <https://aiven.io>.
2. **Create service → MySQL → plan `Free`**. On the free tier you cannot pick a
   cloud/region; that only affects latency, not correctness.
3. Wait until the service status is **Running** (a couple of minutes).

### 2. Collect the connection details

On the service **Overview** page copy:

* **Host** → `DB_HOST`
* **Port** → `DB_PORT` (Aiven uses a high port such as `25000`, **not** 3306 — copy it exactly)
* **User** → `avnadmin` → `DB_USER`
* **Password** → `DB_PASSWORD` (use *Reset password* if it is not shown)
* the default database name (`defaultdb`) → `DB_NAME`

Then click **Download CA certificate** on the same page and save the file to the
project folder as `ca.pem`. Aiven signs its certificates with its own CA, which
Node does not trust by default — **without this file the connection fails with a
certificate error.**

### 3. Create the tables

In PowerShell, in the project folder, point the tooling at Aiven and import the
schema. `server/db.js` accepts the CA as a **file path** or as PEM text:

```powershell
$env:DB_HOST='<host>'
$env:DB_PORT='<port>'
$env:DB_USER='avnadmin'
$env:DB_PASSWORD='<password>'
$env:DB_NAME='defaultdb'
$env:DB_SSL_MODE='require'
$env:DB_SSL_CA='.\ca.pem'          # read straight from the downloaded file

node server/dev/db-doctor.mjs      # expect a green result first
node server/dev/db-init.mjs        # creates the tables (safe to re-run)
```

> Your machine blocks `npm` scripts (PowerShell execution policy), which is why
> these are invoked as `node server/dev/…` rather than `npm run …`.

`db:init` reports the tables it created. It cannot create the *database* itself —
`DB_NAME` must already exist.

### 4. Point Render at Aiven

Render → **`cpri-api` → Environment** → set/overwrite:

| Key | Value |
|---|---|
| `DB_HOST` | the Aiven host |
| `DB_PORT` | the Aiven port |
| `DB_USER` | `avnadmin` |
| `DB_PASSWORD` | the Aiven password |
| `DB_NAME` | `defaultdb` |
| `DB_SSL_MODE` | `require` |
| `DB_SSL_CA` | **paste the entire contents of `ca.pem`** (including the `-----BEGIN/END CERTIFICATE-----` lines) |

Click **Save changes** — Render redeploys automatically.

> Render's env-var box keeps line breaks, so paste the PEM as-is. If your tools
> flatten it, `server/db.js` also accepts a single line with literal `\n`
> sequences.

### 5. Verify

```bash
curl -s https://cpri.onrender.com/healthz      # {"ok":true,"db":"up",...}
```

The API seeds the `admin` account on boot from `ADMIN_EMAIL` / `ADMIN_PASSWORD`,
so sign-in works as soon as `/healthz` is green. Then log in at
<https://cpri.onrender.com/login.html>.

## Option B — any other managed MySQL

Same recipe, different values. Set `DB_SSL_MODE=require` (or `auto`) plus
`DB_SSL_CA` when the provider uses its own CA, then run the doctor and `db:init`.

* **Railway** — easiest, but ~US$5/month after the trial; TLS is not required, so
  `DB_SSL_MODE` can stay `auto`/`disable`.
* **Clever Cloud**, **db4free.net**, self-hosted — same variables.
* A provider that does **not** offer TLS at all: set `DB_SSL_MODE=disable`.
* A provider whose CA you cannot obtain: `DB_SSL_REJECT_UNAUTHORIZED=false`
  keeps the traffic encrypted but stops checking the certificate. Prefer the CA.

For a fully local database, the defaults already work (`DB_HOST=localhost`,
`DB_PORT=3306`, `DB_SSL_MODE` unset).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Access denied … (using password: YES)` | wrong password, or the machine's IP is not allowed |
| certificate / TLS error | set `DB_SSL_MODE=require` and supply `DB_SSL_CA` |
| `ECONNREFUSED` | wrong `DB_PORT` (Aiven is **not** 3306) or wrong host |
| `Unknown database` | `DB_NAME` does not exist — create it first |
| `db down` on Render but `doctor` is green | Render is not using these values, or its IP is blocked |

## Aiven free-tier caveats

* Free services are **powered off after long inactivity** (and after creation
  with no usage). Your API polling `/healthz` counts as activity, but if the
  service is off in the console, power it back on.
* No region choice, 1 GB storage, `max_connections` 76 — fine for this app.

## Related

* `node server/dev/db-doctor.mjs` — diagnose a connection
* `node server/dev/db-init.mjs` — create the tables
* [`FIX-DB-CONNECTION.md`](./FIX-DB-CONNECTION.md) — diagnosing the TiDB case
* [`SETUP-DEPLOY-TEST.md`](./SETUP-DEPLOY-TEST.md) — full deploy reference
