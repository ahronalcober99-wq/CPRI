# TiDB Cloud TLS Design

## Goal

Ensure the API uses TLS for remote MySQL-compatible database hosts, including
TiDB Cloud, while keeping local XAMPP connections usable without TLS by default.

## Design

- Keep `server/db.js` as the only Node.js MySQL pool creation point. Preserve
  its existing `DB_HOST`, numeric `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and
  `DB_NAME` configuration.
- Enable SSL when `DB_SSL === "true"` or the configured host is not a loopback
  address (`localhost`, `127.0.0.1`, or `::1`). Use
  `{ minVersion: "TLSv1.2", rejectUnauthorized: true }`.
- Emit one startup line with the configured host, numeric port, and SSL state;
  never include the password.
- Leave `server/server/db/queries.js` unchanged because it already imports and
  uses the shared pool.

## Scope and validation

Modify only `server/db.js`. Confirm there is one `mysql.createPool()` site, all
query calls use the pool from that module, SSL selection behaves correctly for
local/remote hosts and the explicit override, the startup diagnostic omits
secrets, and syntax checks pass. Do not alter unrelated files.
