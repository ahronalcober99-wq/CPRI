# Fix: “The server cannot reach its database right now.”

## Symptom

The login page shows this banner, and `POST /api/auth/login` returns HTTP `503`:

> The server cannot reach its database right now. Please try again in a moment.

```bash
curl -s https://cpri.onrender.com/healthz
# {"ok":false,"db":"down","error":"Access denied for user '4CzTnQVXYdwj5F4.root'@'74.220.48.29' (using password: YES)"}
```

## What the error actually means

`Access denied … (using password: YES)` is **MySQL error 1045**. Read it literally:

* the API *did* reach the database server — it completed the network + TLS
  handshake and was then **rejected at the login step**;
* a password **was** sent (`using password: YES`);
* the user name the API sent is ``4CzTnQVXYdwj5F4.root`` and the database saw
  the request coming from `74.220.48.29` (a Render outbound IP).

So the network, port, TLS and username are all fine. Only two things can still
be wrong:

| # | Cause | How to tell |
|---|-------|-------------|
| **A** | `DB_PASSWORD` in Render is wrong or stale | `npm run doctor` (below) fails locally with the **same** 1045 |
| **B** | The TiDB firewall does not allow Render's IP | `npm run doctor` **succeeds** locally with the same values |

> TiDB Cloud Starter/Essential firewall rules **allow all IPs by default**
> (`Allow_all_public_connections`). If that entry was deleted and replaced with
> “Add Current IP”, only the machine that added it can connect — a Render
> service never can.

## Step 1 — Find out which one it is (2 minutes)

```bash
npm run doctor
```

It prints the target it is using (host/port/user/database/ssl — never the
password) and either a green result or the likely cause:

```
 FAIL  ER_ACCESS_DENIED_ERROR (1045): Access denied for user '…'@'203.0.113.9' (using password: YES)

Cause: the database rejected the username/password.
  • DB_PASSWORD is wrong or stale — re-copy it from the database console.
  • The database firewall does not allow this host's public IP …
```

* **Fails the same way → it is Cause A.** Go to Step 2.
* **Succeeds → it is Cause B.** Go to Step 3.

## Step 2 — Cause A: reset the password and re-copy it

1. In the **TiDB Cloud console**, open your instance → **Connect**.
2. Copy the connection details exactly as shown. The password is shown once per
   generation; if you no longer have it, click **Reset password** and copy the
   new one.
3. In **Render → your `cpri-api` service → Environment**, replace `DB_PASSWORD`
   with the copied value.
   * Paste the password **only** — no wrapping quotes, no leading/trailing
     spaces. (The API logs a warning at boot if it detects that shape.)
   * Confirm the other values match the console too:

     | Key | Value for TiDB Cloud Starter |
     |-----|------------------------------|
     | `DB_HOST` | the `…tidbcloud.com` host from Connect |
     | `DB_PORT` | `4000` (**not** 3306) |
     | `DB_USER` | e.g. `4CzTnQVXYdwj5F4.root` (keep the prefix) |
     | `DB_NAME` | `cpri` (or the database you created) |
     | `DB_SSL` | `true` |
4. **Save Changes** — Render redeploys automatically.

## Step 3 — Cause B: allow Render’s IPs in the TiDB firewall

Render services send outbound traffic from **shared CIDR ranges** for their
region (they are not one fixed IP, and they can change), so allow the **whole
range**, not just `74.220.48.29`:

1. **Render → `cpri-api` → Connect → Outbound** tab. Copy the IP ranges
   (e.g. `74.220.48.0/24`).
2. **TiDB Cloud → your instance → Settings → Networking → Public Endpoint**.
3. Either
   * **keep/restore `Allow_all_public_connections`** (simplest — the instance is
     still protected by TLS + the password), or
   * delete it and **Add rule** for each Render CIDR range (Start IP = network
     address, End IP = broadcast address).
4. Click **Save**. No redeploy is needed — the next request is allowed.

> Use **Add current IP** only if you also want to connect from your own laptop;
> it does *not* help Render.

## Step 4 — Verify

```bash
# 1. The API reports a healthy database
curl -s https://cpri.onrender.com/healthz
#    {"ok":true,"db":"up","uptime":…}

# 2. The same credentials work from here
npm run doctor

# 3. Sign in
#    https://cpri.onrender.com/login.html
#    or https://ahronalcober99-wq.github.io/CPRI/public/login.html
```

If `/healthz` is green but login says **“Invalid credentials”**, the database is
reachable — the `admin` user simply has not been created yet:

```bash
# Import the schema, then create the admin account:
mysql -h <DB_HOST> -P 4000 -u <DB_USER> -p <DB_NAME> < db/schema.sql
npm run seed     # uses ADMIN_EMAIL / ADMIN_PASSWORD
```

## Why this keeps happening

* **A password re-copied from the wrong line** (e.g. the *host* instead of the
  *password*) still produces a clean 1045 that looks like a firewall problem.
  Always run `npm run doctor` before blaming the network.
* **Pasting `"secret"` with quotes** sends the quotes as part of the password.
  The API now warns about this in the deploy log (`[db] DB_PASSWORD has
  surrounding whitespace or quotation marks …`).
* **A laptop-only firewall rule** makes the app work locally and never on the
  host. Prefer `Allow_all_public_connections` for a managed database, or allow
  the host's full outbound CIDR range.

## Related

* `npm run doctor` — `server/dev/db-doctor.mjs`
* Startup hints — `explainDbError()` / `describeDbTarget()` in `server/db.js`
* Deploy reference — [`SETUP-DEPLOY-TEST.md`](./SETUP-DEPLOY-TEST.md)
