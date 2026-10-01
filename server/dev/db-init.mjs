#!/usr/bin/env node
// ============================================================
//  Create the CPRI tables in whatever database DB_* points at.
//
//  Usage:
//    npm run db:init                 # imports server/init-db.sql
//    npm run db:init -- db/schema.sql
//
//  The target database must already exist (the API connects straight to
//  DB_NAME). The connection reuses the exact host/credentials/TLS settings
//  that `server/db.js` uses, so if this works, the API will too.
//
//  The statements are idempotent (CREATE TABLE IF NOT EXISTS), so running it
//  again is safe. The admin account is NOT created here — the API seeds it on
//  the next boot from ADMIN_EMAIL / ADMIN_PASSWORD.
// ============================================================
import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

// Imported dynamically so `.env` is loaded before db.js reads the DB_* vars.
const db = await import('../db.js');
const mysql = (await import('mysql2/promise')).default;

const requested = process.argv.slice(2).find((a) => !a.startsWith('-')) || 'server/init-db.sql';
const file = resolve(repoRoot, requested);

if (!existsSync(file)) {
  console.error(`Schema file not found: ${file}`);
  process.exit(1);
}

// The dump may begin with `CREATE DATABASE …; USE …;` (often for a database
// whose name differs from DB_NAME). The connection is already bound to
// DB_NAME, so those two statements are dropped rather than executed.
const raw = readFileSync(file, 'utf8');
const sql = raw
  .split(/\r?\n/)
  .filter((line) => !/^\s*(CREATE\s+DATABASE|USE)\b/i.test(line))
  .join('\n');

const { host, port, user, database } = db.connectionOptions;
const sslOn = Boolean(db.connectionOptions.ssl);
console.log(`Importing ${requested} into ${database} at ${host}:${port} (user ${user}, ssl ${sslOn ? 'on' : 'off'})…`);

let connection;
try {
  connection = await mysql.createConnection({ ...db.connectionOptions, multipleStatements: true });
  const [result] = await connection.query(sql);
  const statements = Array.isArray(result) ? result.length : 1;
  console.log(`  ok   executed ${statements} statement${statements === 1 ? '' : 's'}`);

  const [tables] = await connection.query('SHOW TABLES');
  const names = tables.map((row) => Object.values(row)[0]).sort();
  console.log(`  ok   database now has ${names.length} tables:`);
  console.log('         ' + names.join(', '));

  const [hasUsers] = await connection.query("SHOW TABLES LIKE 'users'");
  if (hasUsers.length === 0) {
    console.log('\n  WARNING: the `users` table is still missing — sign-in will not work.');
  } else {
    const [[admins]] = await connection.query(
      "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'"
    );
    if (admins.n === 0) {
      console.log('\nNext: restart the API — it creates the admin account on boot from');
      console.log('      ADMIN_EMAIL / ADMIN_PASSWORD (or logs a generated password once).');
    } else {
      console.log(`\n  ok   ${admins.n} active admin account already present.`);
    }
  }
  console.log('');
  await connection.end();
  process.exit(0);
} catch (err) {
  console.error(`\n  FAIL  ${err.code || 'ERROR'}: ${err.message}`);
  const hint = db.explainDbError(err);
  if (hint) console.error('\n' + hint);
  console.error('\nRun `node server/dev/db-doctor.mjs` first to check the connection.\n');
  if (connection) await connection.end().catch(() => {});
  process.exit(1);
}
