#!/usr/bin/env node
// ============================================================
//  CPRI — one-time repair: submissions with missing display fields
//
//  WHY THIS EXISTS
//  A submission row has to be able to describe itself: who submitted it, what
//  stage and status it is in, and when it happened. Rows written by an older
//  version of the form, restored from a backup, or copied between the two
//  research stores can be missing those values, and a monitoring dashboard then
//  shows a nameless blank card — or, worse, nothing at all.
//
//  What this script does, and only this:
//    * `research_submissions` — fills owner_name / owner_role from the account
//      named by owner_id, infers `stage` from the status when it is empty, and
//      falls back to 'submitted' / now() for an empty status or timestamp.
//    * `submissions` (classic) — fills submitterName from the account when the
//      stored id still resolves, and the same status / timestamp fallbacks.
//
//  What it never does:
//    * never overwrites a value that is already there (only blank fields are
//      written, so a second run changes nothing);
//    * never changes an owner id, a role assignment into a researcher role, or
//      any status that exists — an unexpected status is left exactly as it is;
//    * never touches files, comments or status history;
//    * never deletes a row.
//
//  Rows whose owner cannot be resolved at all are REPORTED, not invented: the
//  name that is already stored is kept.
//
//  USAGE
//    npm run repair:submissions              # report only (dry run)
//    npm run repair:submissions -- --apply   # back up, then repair
//    npm run repair:submissions -- --help
// ============================================================
'use strict';

import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import './load-env.js';
import { all, withTransaction } from './server/db/queries.js';
import { dumpDatabase } from './lib/backup-service.js';
import { stageForStatus } from './lib/submission-records.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKUPS_DIR = join(__dirname, '..', 'backups');

const HELP = `
Fill in blank display fields on existing submissions so every record can appear
on the dashboards that list it. Dry run by default.

  (no flags)    report what would be filled, write nothing
  --apply       take a full database backup, then write
  --help        this text

Only blank fields are written. A second run reports nothing to do.
`;

const clean = (value) => String(value == null ? '' : value).trim();
const isBlank = (value) => clean(value) === '';

// Which account does this owner id name? An empty result is reported, never
// guessed at — the stored name is left in place.
function accountIndex(users) {
  const byRef = new Map();
  for (const user of users) {
    for (const ref of [user.id, user.email, user.username]) {
      const key = clean(ref).toLowerCase();
      if (key && !byRef.has(key)) byRef.set(key, user);
    }
  }
  return byRef;
}

const MODULE_STATUS_FALLBACK = 'submitted';

/**
 * Plan the updates for one module row. Pure — it returns what it would write.
 */
export function planModuleRepair(row, { byRef = new Map(), now = new Date() } = {}) {
  const changes = {};
  const notes = [];

  const account = byRef.get(clean(row.owner_id).toLowerCase()) || null;
  if (isBlank(row.owner_name) && account) {
    changes.owner_name = clean(account.fullName || account.username).slice(0, 160);
    notes.push(`owner_name from the account (${changes.owner_name})`);
  }
  if (isBlank(row.owner_role) && account) {
    changes.owner_role = clean(account.role);
    notes.push(`owner_role from the account (${changes.owner_role})`);
  }
  if (!account && (isBlank(row.owner_name) || isBlank(row.owner_role))) {
    notes.push(`owner ${clean(row.owner_id) || '(none)'} matches no account — left as it is`);
  }
  if (isBlank(row.status)) {
    changes.status = MODULE_STATUS_FALLBACK;
    notes.push(`status defaulted to ${MODULE_STATUS_FALLBACK}`);
  }
  // `stage` is derived, never invented: an existing status decides it.
  if (isBlank(row.stage)) {
    changes.stage = stageForStatus(changes.status || row.status);
    notes.push(`stage inferred from the status (${changes.stage})`);
  }
  if (isBlank(row.created_at)) {
    changes.created_at = now.toISOString();
    notes.push('created_at defaulted to now');
  }
  if (isBlank(row.updated_at)) {
    changes.updated_at = changes.created_at || row.created_at || now.toISOString();
    notes.push('updated_at defaulted to created_at');
  }

  return { id: row.id, title: clean(row.title), changes, notes };
}

/**
 * The same idea for a classic row: the classic form stored the submitter's NAME
 * as well as their id, so only a row missing both is a problem.
 */
export function planClassicRepair(row, { byRef = new Map(), now = new Date() } = {}) {
  const changes = {};
  const notes = [];

  const account = byRef.get(clean(row.submitterId).toLowerCase()) || null;
  if (isBlank(row.submitterName) && account) {
    changes.submitterName = clean(account.fullName || account.username).slice(0, 160);
    notes.push(`submitterName from the account (${changes.submitterName})`);
  }
  if (isBlank(row.submitterName) && !account) {
    notes.push('no submitter name and no matching account — left as it is');
  }
  if (isBlank(row.status)) {
    changes.status = MODULE_STATUS_FALLBACK;
    notes.push(`status defaulted to ${MODULE_STATUS_FALLBACK}`);
  }
  if (isBlank(row.createdAt)) {
    changes.createdAt = now.toISOString();
    notes.push('createdAt defaulted to now');
  }
  if (isBlank(row.updatedAt)) {
    changes.updatedAt = changes.createdAt || row.createdAt || now.toISOString();
    notes.push('updatedAt defaulted to createdAt');
  }

  return { id: row.id, title: clean(row.title), changes, notes };
}

function describe(table, plan) {
  const fields = Object.keys(plan.changes);
  console.log(`  ${table}  ${plan.id}  "${plan.title.slice(0, 40) || 'untitled'}"`);
  console.log(`        set: ${fields.join(', ')}   (${plan.notes.join('; ')})`);
}

async function main({ apply }) {
  const now = new Date();
  const users = await all('SELECT id, username, email, fullName, role FROM users');
  const byRef = accountIndex(users);

  const moduleRows = await all('SELECT * FROM research_submissions');
  const classicRows = await all('SELECT * FROM submissions');

  const modulePlans = moduleRows
    .map(row => planModuleRepair(row, { byRef, now }))
    .filter(plan => Object.keys(plan.changes).length);
  const classicPlans = classicRows
    .map(row => planClassicRepair(row, { byRef, now }))
    .filter(plan => Object.keys(plan.changes).length);

  console.log(`[repair] ${moduleRows.length} module row(s), ${classicRows.length} classic row(s), ${users.length} account(s)`);
  console.log('');
  for (const plan of modulePlans) describe('research_submissions', plan);
  for (const plan of classicPlans) describe('submissions', plan);

  const untouched = moduleRows.filter(row => isBlank(row.owner_name) || isBlank(row.owner_role))
    .filter(row => !byRef.has(clean(row.owner_id).toLowerCase()));
  if (untouched.length) {
    console.log('');
    console.log(`[repair] ${untouched.length} row(s) keep an owner that matches no account:`);
    for (const row of untouched) {
      console.log(`  ${row.id}  "${clean(row.title).slice(0, 40)}"  owner=${clean(row.owner_id) || '(none)'}  name=${clean(row.owner_name) || '(none)'}`);
    }
  }

  console.log('');
  if (!modulePlans.length && !classicPlans.length) {
    console.log('[repair] nothing to do — every record already carries its own name, status and dates.');
    process.exit(0);
  }
  console.log(`[repair] to write: ${modulePlans.length} module row(s), ${classicPlans.length} classic row(s)`);

  if (!apply) {
    console.log('');
    console.log('[repair] DRY RUN — no changes were made. Re-run with --apply (a full backup is taken first).');
    process.exit(0);
  }

  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const backupPath = join(BACKUPS_DIR, `${stamp}-repair-submissions-database.json`);
  const dump = await dumpDatabase();
  await mkdir(BACKUPS_DIR, { recursive: true });
  await writeFile(backupPath, JSON.stringify(dump, null, 2), 'utf8');
  console.log(`[repair] backup: ${backupPath} (${dump.tables} tables, ${dump.rowCount} rows)`);

  await withTransaction(async (tx) => {
    for (const plan of modulePlans) {
      const keys = Object.keys(plan.changes);
      await tx.run(
        `UPDATE research_submissions SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`,
        [...keys.map(k => plan.changes[k]), plan.id]
      );
    }
    for (const plan of classicPlans) {
      const keys = Object.keys(plan.changes);
      await tx.run(
        `UPDATE submissions SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`,
        [...keys.map(k => plan.changes[k]), plan.id]
      );
    }
  });

  const manifestPath = join(BACKUPS_DIR, `repair-submissions-${stamp}.json`);
  await writeFile(manifestPath, JSON.stringify({
    createdAt: now.toISOString(),
    database: process.env.DB_NAME || '',
    backupPath,
    module: modulePlans.map(p => ({ id: p.id, changes: p.changes })),
    classic: classicPlans.map(p => ({ id: p.id, changes: p.changes }))
  }, null, 2), 'utf8');

  console.log(`[repair] repaired ${modulePlans.length + classicPlans.length} row(s). Nothing was deleted.`);
  console.log(`[repair] record of the changes: ${manifestPath}`);
  process.exit(0);
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }
  main({ apply: argv.includes('--apply') })
    .then(code => process.exit(code || 0))
    .catch((error) => {
      console.error('[repair] failed:', error.message);
      console.error('[repair] nothing was written (the whole run is one transaction).');
      process.exit(1);
    });
}
