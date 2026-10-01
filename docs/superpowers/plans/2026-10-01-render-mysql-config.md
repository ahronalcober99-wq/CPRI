# Render MySQL Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure the API's MySQL pool for Render environment variables without loading local `.env` values in production.

**Architecture:** Add a local-only dotenv bootstrap as the first dependency of the server entry point, before any route or database modules initialize. Configure the existing `mysql2/promise` pool from `DB_*`, conditionally enable verified SSL, and expose the optional setting in the existing example and Render blueprint.

**Tech Stack:** Node.js 18+ ESM, `mysql2/promise`, `dotenv`, Render Blueprint YAML.

## Global Constraints

- Only load `.env` when `NODE_ENV` is not `production`.
- Keep local database defaults: `localhost`, port `3306`, user `root`, empty password, and database `cpri`.
- Convert `DB_PORT` to a number.
- Include `ssl: { rejectUnauthorized: true }` only when `DB_SSL === "true"`.
- Preserve the current server behavior that honors a valid `process.env.PORT` and falls back to `3000`.
- Keep `.env` listed in `.gitignore`; never add real credentials to tracked files.
- Do not change localhost references used by local tooling or documentation.

---

### Task 1: Configure local-only dotenv and Render MySQL options

**Files:**
- Create: `server/load-env.js`
- Modify: `server/server.js`
- Modify: `server/db.js`
- Modify: `.env.example`
- Modify: `render.yaml`
- Verify, do not modify: `.gitignore`

**Interfaces:**
- `server/load-env.js` has no exports; importing it loads the repository `.env` only outside production, before dependent server modules initialize.
- `server/db.js` continues to default-export the existing MySQL pool and named-export `testConnection()`.
- The pool consumes `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, and optional `DB_SSL`.

- [ ] **Step 1: Add local-only dotenv bootstrap**

Create `server/load-env.js`:

```js
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

if (process.env.NODE_ENV !== 'production') {
  const { config } = await import('dotenv');
  config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') });
}
```

- [ ] **Step 2: Load the bootstrap before other server modules**

In `server/server.js`, replace `import 'dotenv/config';` with `import './load-env.js';` as the first import. Leave the current `PORT` parsing and `app.listen(PORT, ...)` unchanged.

- [ ] **Step 3: Use the requested environment-backed database options**

In `server/db.js`, remove its duplicate optional dotenv loading and its now-unused path/URL imports. Keep the `mysql2/promise` pool and use:

```js
const databaseName = process.env.DB_NAME || 'cpri';
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: databaseName,
  ...(process.env.DB_SSL === 'true'
    ? { ssl: { rejectUnauthorized: true } }
    : {}),
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_LIMIT || 10),
  charset: 'utf8mb4',
  timezone: 'Z'
});
```

Use `databaseName` in the existing successful-connection log rather than reconstructing the fallback expression.

- [ ] **Step 4: Document the optional SSL setting in both env templates**

In `.env.example`, add `DB_SSL=false` beside `DB_NAME` and the existing database variables. In `render.yaml`, add a `DB_SSL` entry with the value `'false'` beside the existing `DB_*` settings, so it can be set to `'true'` when the hosted database requires TLS.

- [ ] **Step 5: Check syntax, configuration shape, and ignored credentials**

Run:

```powershell
node --check server/load-env.js
node --check server/db.js
node --check server/server.js
git check-ignore .env
```

Expected: all three syntax checks succeed, and `git check-ignore .env` prints `.env`.

Then verify pool configuration for custom values and both SSL states by importing `server/db.js` in separate Node processes with the corresponding `DB_*` environment variables set; confirm host, numeric port, user, password, database, and the presence or absence of `ssl.rejectUnauthorized`. Do not print or inspect the real `.env` contents.

For each process, set `NODE_ENV=production`, `DB_HOST=db.example`, `DB_PORT=4406`, `DB_USER=sample-user`, `DB_PASSWORD=sample-password`, and `DB_NAME=sample-db` in the PowerShell environment. Run this assertion with `DB_SSL=true`:

```powershell
$env:DB_SSL = 'true'
node --input-type=module -e "import assert from 'node:assert/strict'; const { default: pool } = await import('./server/db.js'); const c = pool.pool.config.connectionConfig; assert.deepEqual({ host: c.host, port: c.port, user: c.user, password: c.password, database: c.database, rejectUnauthorized: c.ssl?.rejectUnauthorized }, { host: 'db.example', port: 4406, user: 'sample-user', password: 'sample-password', database: 'sample-db', rejectUnauthorized: true }); await pool.end();"
```

Run this assertion with `DB_SSL=false`:

```powershell
$env:DB_SSL = 'false'
node --input-type=module -e "import assert from 'node:assert/strict'; const { default: pool } = await import('./server/db.js'); const c = pool.pool.config.connectionConfig; assert.deepEqual({ host: c.host, port: c.port, user: c.user, password: c.password, database: c.database, ssl: Boolean(c.ssl) }, { host: 'db.example', port: 4406, user: 'sample-user', password: 'sample-password', database: 'sample-db', ssl: false }); await pool.end();"
```

- [ ] **Step 6: Review only intended changes and commit**

Run `git diff --check` and inspect `git diff -- server/db.js server/server.js server/load-env.js .env.example render.yaml .gitignore`. Confirm `.gitignore` is unchanged and `PORT` handling is unchanged. Commit the implementation with:

```text
fix: use Render database environment

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```
