#!/usr/bin/env node
// ============================================================
//  CPRI database doctor — says *why* the API cannot reach MySQL.
//
//  Usage:
//    npm run doctor                          # uses the DB_* in .env
//    DB_HOST=... DB_PORT=4000 DB_USER=... DB_PASSWORD=... \
//      DB_NAME=cpri npm run doctor           # test a different target
//
//  Run it with the SAME values the host (Render, Railway, …) uses. A green
//  result here plus a "db down" /healthz on the host means the database is
//  refusing the host's IP address — see docs/FIX-DB-CONNECTION.md.
//
//  Exit code is 0 when the database is usable, 1 otherwise.
// ============================================================
import 'dotenv/config';

// Imported dynamically so `.env` is loaded before db.js reads the DB_* vars.
// `pool` is db.js's default export; the helpers are named exports.
const db = await import('../db.js');
const pool = db.default;
const { explainDbError, describeDbTarget } = db;

const target = describeDbTarget();
const password = String(process.env.DB_PASSWORD ?? '');
const username = process.env.DB_USER || '(default)';

const RULE = '─'.repeat(60);
console.log('CPRI database doctor');
console.log(RULE);
console.log(`  host      ${target.host ?? '(unset)'}`);
console.log(`  port      ${target.port || '(unset)'}`);
console.log(`  user      ${username}`);
console.log(`  database  ${target.database ?? '(unset)'}`);
console.log(`  ssl       ${target.ssl ? 'on (TLS 1.2+, certificate verified)' : 'off'}`);
console.log(`  password  ${password ? `set (${password.length} chars)` : 'EMPTY'}`);
console.log(RULE);

function ok(label, detail) { console.log(`   ok   ${label}${detail ? ' ' + detail : ''}`); }
function bad(label, detail) { console.log(` FAIL  ${label}${detail ? ' ' + detail : ''}`); }

let connection;
const startedAt = Date.now();
try {
  connection = await pool.getConnection();
} catch (err) {
  console.log(`\n  connecting … failed after ${Date.now() - startedAt} ms\n`);
  bad(`${err.code || 'ERROR'}${err.errno ? ` (${err.errno})` : ''}`, err.message);
  const hint = explainDbError(err);
  if (hint) {
    console.log('\n' + hint);
    console.log('\nNext: docs/FIX-DB-CONNECTION.md, or run again with corrected values:');
    console.log('  DB_HOST=... DB_PORT=4000 DB_USER=... DB_PASSWORD=... DB_NAME=... npm run doctor\n');
  } else {
    console.log('\n  No canned cause for this error — read the message above.\n');
  }
  await pool.end().catch(() => {});
  process.exit(1);
}

try {
  console.log(`\n  connecting … ok in ${Date.now() - startedAt} ms\n`);

  const [[meta]] = await connection.query(
    'SELECT VERSION() AS version, USER() AS user, DATABASE() AS db'
  );
  ok('SELECT 1');
  ok('server', meta.version);
  ok('user  ', meta.user);
  ok('schema', meta.db || '(none selected)');

  // The login endpoint reads this table, so its presence is what makes sign-in
  // possible. A missing table means the schema was never imported.
  const [tables] = await connection.query("SHOW TABLES LIKE 'users'");
  if (tables.length === 0) {
    console.log('');
    bad('table users', 'missing — import db/schema.sql, then `npm run seed`');
  } else {
    const [[counts]] = await connection.query(
      "SELECT COUNT(*) AS total, SUM(status = 'active') AS active FROM users"
    );
    ok('table users', `— ${counts.total} rows`);
    const [[admins]] = await connection.query(
      "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'"
    );
    if (admins.n > 0) {
      ok('admin ', `${admins.n} active admin account${admins.n > 1 ? 's' : ''} — login will work`);
    } else {
      bad('admin ', 'no active admin — set ADMIN_EMAIL / ADMIN_PASSWORD and restart the API');
    }
  }

  console.log(`\n${RULE}`);
  console.log('  Database is healthy and these credentials work.');
  console.log('  If https://<your-api-host>/healthz still reports db "down", the host');
  console.log('  is not using these values (or its IP is blocked by the database).');
  console.log(RULE + '\n');
  connection.release();
  await pool.end();
  process.exit(0);
} catch (err) {
  bad(err.code || 'QUERY', err.message);
  connection.release();
  await pool.end().catch(() => {});
  process.exit(1);
}
