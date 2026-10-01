# TiDB Cloud TLS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable verified TLS automatically for non-loopback MySQL hosts and log safe connection diagnostics at API startup.

**Architecture:** Keep the one shared `mysql2/promise` pool in `server/db.js`; its existing consumers, including `server/server/db/queries.js`, continue using that pool. Compute the host, numeric port, and SSL setting once, apply TLS 1.2 with certificate verification whenever explicitly requested or the host is remote, and log the resulting endpoint without credentials.

**Tech Stack:** Node.js ESM, `mysql2/promise`, Node built-in `assert`, PowerShell.

## Global Constraints

- Enable SSL when `process.env.DB_SSL === "true"` OR the DB host is not `localhost`, `127.0.0.1`, or `::1`.
- Use `ssl: { minVersion: "TLSv1.2", rejectUnauthorized: true }`.
- Read host, port, user, password, and database from `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, with `DB_PORT` converted to a number.
- Log one line at startup containing host, port, and SSL enabled state, never the password.
- Keep local XAMPP working without SSL by default.
- Keep `server/db.js` as the only `mysql.createPool()` site; queries continue using its exported pool.
- Modify no unrelated code.

---

### Task 1: Enable automatic remote TLS and startup diagnostics

**Files:**
- Modify: `server/db.js`
- Verify unchanged: `server/server/db/queries.js`

**Interfaces:**
- Consumes: Existing `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME` environment variables and the existing exported MySQL pool.
- Produces: The existing default pool export, configured with `ssl` for explicit SSL or remote hosts; one startup line formatted as `[db] MySQL connection host=<host> port=<number> ssl=<true|false>`.

- [ ] **Step 1: Confirm the single pool creation and shared query consumer**

Run:

```powershell
rg -n "mysql2|createPool|createConnection" server
rg -n "from '../../db.js'|pool\.query" server/server/db/queries.js
```

Expected: the only Node pool creation is `mysql.createPool()` in `server/db.js`; `server/server/db/queries.js` imports `../../db.js` and runs its queries through that imported pool. `server/backup.mjs` invokes the external `mysqldump` utility and is not another Node.js pool.

- [ ] **Step 2: Set host, port, and automatic SSL state once**

In `server/db.js`, compute the effective host and numeric port using the existing defaults, then determine if it is a loopback host and derive `sslEnabled`:

```js
const databaseHost = process.env.DB_HOST || localDefaults?.host;
const databasePort = Number(process.env.DB_PORT || localDefaults?.port);
const normalizedHost = databaseHost.toLowerCase().replace(/^\[|\]$/g, '');
const isLoopbackHost = normalizedHost === 'localhost'
  || normalizedHost === '127.0.0.1'
  || normalizedHost === '::1';
const sslEnabled = process.env.DB_SSL === 'true' || !isLoopbackHost;
```

Use `databaseHost` and `databasePort` in the pool options, retaining the existing `DB_USER`, `DB_PASSWORD`, and `DB_NAME` configuration unchanged.

- [ ] **Step 3: Add verified TLS options and the safe startup log**

Add this conditional property to `mysql.createPool()`:

```js
...(sslEnabled
  ? { ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true } }
  : {}),
```

Immediately after creating the pool, emit exactly one diagnostic line:

```js
console.log(`[db] MySQL connection host=${databaseHost} port=${databasePort} ssl=${sslEnabled}`);
```

Do not add the username or password to the diagnostic.

- [ ] **Step 4: Verify syntax and connection option behavior**

Run:

```powershell
node --check server/db.js
```

Run the following assertion in separate PowerShell processes/environments, importing the pool and examining `pool.pool.config.connectionConfig`; call `await pool.end()` after each assertion:

1. `DB_HOST=localhost`, `DB_PORT=3306`, and `DB_SSL=false`: expect port `3306` and no SSL.
2. `DB_HOST=127.0.0.1` and `DB_SSL=false`: expect no SSL.
3. `DB_HOST=::1` and `DB_SSL=false`: expect no SSL.
4. `DB_HOST=tidb.example`, `DB_PORT=4000`, and `DB_SSL=false`: expect numeric port `4000`, `ssl.minVersion === 'TLSv1.2'`, and `ssl.rejectUnauthorized === true`.
5. `DB_HOST=localhost` and `DB_SSL=true`: expect those same TLS options.

For each process, set non-secret dummy `DB_USER`, `DB_PASSWORD`, and `DB_NAME`. Capture import output and assert it has exactly one `[db] MySQL connection` line containing the chosen host, numeric port, and SSL boolean, and does not contain the dummy password.

- [ ] **Step 5: Verify the shared pool and final diff**

Run:

```powershell
rg -n "createPool\(" server
git diff --check
git status --short
```

Expected: there is one `createPool()` site, only `server/db.js` is modified, and `git diff --check` succeeds. Confirm `server/server/db/queries.js` remains unchanged and continues importing `../../db.js`.

- [ ] **Step 6: Commit the focused change**

```text
fix: enable TLS for remote MySQL connections

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```
