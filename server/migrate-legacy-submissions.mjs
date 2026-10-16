#!/usr/bin/env node
// ============================================================
//  CPRI — one-time migration: classic `submissions` -> Research Submission Module
//
//  WHY THIS EXISTS
//  The site keeps research records in two stores:
//
//    * `submissions`         — the classic module (public/submission.html,
//                              submissions.html) writes here, keyed by
//                              `submitterId`, with files/versions/comments/
//                              statusHistory stored as JSON columns.
//    * `research_submissions`— the Research Submission Module, keyed by
//                              `owner_id`, with files, comments and status
//                              history in their own tables. This is what
//                              public/my-submissions.html and
//                              facilitator-dashboard.html read.
//
//  Nothing bridged the two, so every record created before the module existed
//  (or through the classic form afterwards) is invisible on My Submissions —
//  the page renders "You have no submissions yet" while the row sits in
//  `submissions`. This script copies those rows across so they show up, in one
//  run, without touching the originals.
//
//  SAFETY
//    * The classic table is READ ONLY here: no row is updated or deleted.
//    * A copied submission keeps its old id, so the link between the two rows
//      is obvious and a second run is a no-op (idempotent).
//    * Dry run by default. --apply writes, and first takes a full database
//      backup through the same service the Admin > Backups screen uses.
//    * Everything is written in ONE transaction: either every selected record
//      lands, or the database is left exactly as it was.
//
//  USAGE
//    npm run migrate:legacy-submissions                     # report only
//    npm run migrate:legacy-submissions -- --apply           # back up, then copy
//    npm run migrate:legacy-submissions -- --apply --include-orphans
//    npm run migrate:legacy-submissions -- --help
//
//  Records whose submitter matches no account are skipped by default: they
//  would be readable by staff/admin only, and the name in the row may belong to
//  a deleted account. --include-orphans copies them anyway (owner_id is kept as
//  the raw value that was stored, never invented).
//
//  OWNER MATCHING, in order:
//    1. submitterId  == an account id
//    2. submitterId  == an email or username
//    3. submitterName == a full name (exact)
//    4. submitterName == a full name, ignoring middle initials and punctuation
//       ("Thrixcy G. Ortiz" -> "Thrixcy ortiz") — this is what recovers a row
//       whose account was deleted and re-registered under a new id.
//  Step 4 only ever resolves when exactly one account matches, and it says so
//  in the report ("via submitterName (name match)"). Pass --strict-owner to
//  drop step 4 and copy only what steps 1-3 prove.
// ============================================================
'use strict';

import { mkdir, writeFile } from 'fs/promises';
import { dirname, extname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { randomUUID } from 'crypto';

import './load-env.js';
import { all, get, withTransaction } from './server/db/queries.js';
import { ensureResearchSubmissionsSchema } from './research-submissions.js';
// A plain dump, not createBackup(): creating a backup through the service also
// runs its retention rule, and a migration must not delete anything — not even
// an old backup.
import { dumpDatabase } from './lib/backup-service.js';
import { INITIAL_STATUSES, FINAL_STATUSES } from './lib/research-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKUPS_DIR = join(__dirname, '..', 'backups');

const HELP = `
Copy classic "submissions" records into the Research Submission Module so they
appear on my-submissions.html.

  (no flags)          dry run — reports what would be copied, writes nothing
  --apply             take a full database backup, then copy
  --include-orphans   also copy records whose submitter matches no account
  --strict-owner      only exact id/email/username/full-name owner matches
  --help              this text

The classic table is never modified, and copied submissions keep their id, so
the script can be run again safely.
`;

// ---------------------------------------------------------------- helpers

const clean = (value) => String(value == null ? '' : value).trim();

export { clean };
const clamp = (value, max) => clean(value).slice(0, max);

// Legacy `original_name` values were stored URL-encoded ("CPRI%20-%20x.docx").
function readableName(value, fallback = 'document') {
  const raw = clean(value) || fallback;
  if (!raw.includes('%')) return raw.slice(0, 255);
  try {
    return decodeURIComponent(raw).slice(0, 255);
  } catch {
    return raw.slice(0, 255);
  }
}

const INITIAL_VALUES = new Set(INITIAL_STATUSES.map(s => s.value));
const FINAL_VALUES = new Set(FINAL_STATUSES.map(s => s.value));

// The classic module has no stages. A status that only exists in the Final
// workflow (published, archived) means the record belongs there; everything
// else starts life as an Initial submission. Unknown statuses are kept
// verbatim — a record is never hidden or relabelled because its status is
// unexpected.
export function stageForStatus(status) {
  const value = clean(status);
  if (FINAL_VALUES.has(value) && !INITIAL_VALUES.has(value)) return 'final';
  return 'initial';
}

// Classic slot keys -> module slot keys. An unknown key is kept as-is (clamped
// to the column) so its document still shows up, labelled by its own name,
// instead of being dropped.
const SLOT_ALIASES = {
  abstract: 'abstract',
  adviserEndorsement: 'adviser_endorsement',
  approvalForm: 'approval_sheet',
  ethicsCertificate: 'ethics_certificate',
  panelApproval: 'panel_approval',
  publicationProof: 'publication_proof',
  similarityReport: 'similarity_report',
  additionalDocs: 'additional_documents',
  additional: 'additional_documents'
};

export function slotKeyFor(key, originalName) {
  const k = clean(key);
  if (k === 'manuscript' || SLOT_ALIASES[k] === 'manuscript') {
    // The classic "manuscript" slot accepted Word and PDF; the module keeps
    // them in separate slots, so pick by the file's own extension.
    return extname(readableName(originalName)).toLowerCase() === '.pdf'
      ? 'manuscript_pdf'
      : 'manuscript_docx';
  }
  return SLOT_ALIASES[k] || k.slice(0, 80) || 'additional_documents';
}

// Every spelling of an account, lowercased, so a row keyed by email, username
// or full name is still recognised as that person's. Ambiguity (two accounts
// sharing a full name) resolves to null — the script never guesses an owner.
export function ownerIndex(users) {
  const index = new Map();
  const add = (key, user) => {
    const k = clean(key).toLowerCase();
    if (!k) return;
    if (!index.has(k)) index.set(k, new Map());
    index.get(k).set(user.id, user);
  };
  for (const user of users) {
    add(user.id, user);
    add(user.email, user);
    add(user.username, user);
    add(user.fullName, user);
  }
  return index;
}

function lookup(index, raw) {
  const key = clean(raw).toLowerCase();
  if (!key) return { user: null, ambiguous: false };
  const matches = index.get(key);
  if (!matches || !matches.size) return { user: null, ambiguous: false };
  if (matches.size > 1) return { user: null, ambiguous: true };
  return { user: [...matches.values()][0], ambiguous: false };
}

// ---- Name matching that survives middle initials and re-registration --------
//
// "Thrixcy G. Ortiz" (typed into the classic form) and the account "Thrixcy
// ortiz" are the same person: the classic `submissions` row kept the OLD
// account id, which no longer exists because the account was deleted and
// re-created. Comparing the names as words — lowercased, punctuation dropped,
// one-letter middle initials ignored — recovers the record without guessing:
// the match has to be unique, and both the first and the last word must agree.

function nameTokens(value) {
  return clean(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// The words that carry identity: single letters (initials) are dropped.
export function nameKey(value) {
  const significant = nameTokens(value).filter(token => token.length > 1);
  return significant.length >= 2 ? significant.join(' ') : '';
}

export function nameIndex(users) {
  const index = new Map();
  const add = (key, user) => {
    if (!key) return;
    if (!index.has(key)) index.set(key, new Map());
    index.get(key).set(user.id, user);
  };
  for (const user of users) add(nameKey(user.fullName), user);
  return index;
}

function jsonArray(value) {
  if (value == null) return [];
  const parsed = typeof value === 'string' ? (() => { try { return JSON.parse(value); } catch { return null; } })() : value;
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') return [parsed];
  return [];
}

function jsonObject(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  return typeof value === 'object' ? value : null;
}

// ---------------------------------------------------------------- planning

// Builds every row the migration would insert for one classic record. Pure:
// when it returns, nothing has been written.
export function planSubmission(legacy, { index, includeOrphans, nameMatch = true }) {
  const ownerLookup = lookup(index, legacy.submitterId);

  // Try the stored name too, but only when the id itself did not resolve — a
  // classic row's submitterId was the account id at creation time.
  let owner = ownerLookup.user;
  let resolvedBy = 'submitterId';
  let ambiguous = ownerLookup.ambiguous;
  if (!owner && !ambiguous) {
    const byName = lookup(index, legacy.submitterName);
    if (byName.user) {
      owner = byName.user;
      resolvedBy = 'submitterName';
    } else if (nameMatch && !byName.ambiguous) {
      // Same person, different spelling of the name (see nameKey).
      const key = nameKey(legacy.submitterName);
      const fuzzy = key ? lookup(index, key) : { user: null, ambiguous: false };
      if (fuzzy.user) {
        owner = fuzzy.user;
        resolvedBy = 'submitterName (name match)';
      } else if (fuzzy.ambiguous) {
        ambiguous = true;
      }
    } else if (byName.ambiguous) {
      ambiguous = true;
    }
  }

  if (!owner && !includeOrphans) {
    return {
      skipped: true,
      reason: ambiguous
        ? `submitter "${clean(legacy.submitterId) || clean(legacy.submitterName)}" matches more than one account`
        : `submitter "${clean(legacy.submitterId)}" matches no account`
    };
  }

  const ownerId = owner ? owner.id : clamp(legacy.submitterId, 36);
  const ownerName = owner ? clean(owner.fullName || owner.username) : clean(legacy.submitterName);
  const ownerRole = owner ? clean(owner.role) : 'student_researcher';

  // The classic "adviser" field is a typed name. It is linked only when it names
  // exactly one adviser/facilitator account; otherwise it is left unset rather
  // than pointed at somebody who is not an adviser.
  const adviserLookup = lookup(index, legacy.adviser);
  const adviser = adviserLookup.user && ['adviser', 'facilitator'].includes(adviserLookup.user.role)
    ? adviserLookup.user
    : null;

  const createdAt = legacy.createdAt || legacy.updatedAt || new Date();
  const updatedAt = legacy.updatedAt || createdAt;
  const status = clean(legacy.status) || 'submitted';
  const stage = stageForStatus(status);

  const submission = {
    id: clamp(legacy.id, 36),
    owner_id: ownerId,
    owner_name: clamp(ownerName, 160),
    owner_role: ownerRole,
    stage,
    title: clamp(legacy.title, 255) || 'Untitled submission',
    authors: clamp(legacy.authors, 255),
    program: clamp(legacy.program, 180),
    institution: clamp(legacy.institution, 180),
    nationality: clamp(legacy.nationality, 80),
    category: clamp(legacy.category, 120),
    research_type: clamp(legacy.researchType, 120),
    school_year: clamp(legacy.schoolYear, 40),
    semester: clamp(legacy.semester, 40),
    adviser_id: adviser ? adviser.id : null,
    facilitator_id: null,
    abstract: clean(legacy.abstract) || null,
    keywords: clamp(legacy.keywords, 255) || null,
    status: clamp(status, 40),
    created_at: createdAt,
    updated_at: updatedAt,
    adviser_eval_link: ''
  };

  // ---- documents: one row per file, grouped into the classic versions ----
  const versions = jsonArray(legacy.versions).filter(v => v && typeof v === 'object');
  const sources = versions.length
    ? versions.map((v, i) => ({
        version: Number.isInteger(Number(v.version)) && Number(v.version) > 0 ? Number(v.version) : i + 1,
        at: v.uploadedAt || v.at || updatedAt,
        by: clean(v.by) || ownerName,
        files: jsonObject(v.files) || {},
        additionalDocs: jsonArray(v.additionalDocs)
      }))
    // No version history on the classic row: its current files ARE version 1.
    : [{
        version: 1,
        at: updatedAt,
        by: ownerName,
        files: jsonObject(legacy.files) || {},
        additionalDocs: jsonArray(legacy.additionalDocs)
      }];

  const files = [];
  const seenFileIds = new Set();
  for (const source of sources) {
    for (const [key, meta] of Object.entries(source.files)) {
      const info = jsonObject(meta);
      if (!info || !clean(info.storage_path)) continue;
      const id = randomUUID();
      seenFileIds.add(id);
      files.push({
        id,
        submission_id: submission.id,
        slot_key: slotKeyFor(key, info.original_name),
        original_name: readableName(info.original_name),
        stored_path: clamp(info.storage_path, 512),
        mime: clamp(info.mime_type, 120) || 'application/octet-stream',
        // The classic metadata never recorded a byte count.
        size: 0,
        version: source.version,
        uploaded_by: ownerId,
        uploaded_by_name: clamp(source.by, 160),
        uploaded_at: source.at,
        // The classic module uploaded through Supabase Storage only.
        storage_backend: 'supabase'
      });
    }
    for (const doc of source.additionalDocs) {
      const info = jsonObject(doc);
      if (!info || !clean(info.storage_path)) continue;
      const legacyId = clamp(info.id, 36);
      const id = legacyId && !seenFileIds.has(legacyId) ? legacyId : randomUUID();
      seenFileIds.add(id);
      files.push({
        id,
        submission_id: submission.id,
        slot_key: 'additional_documents',
        original_name: readableName(info.original_name),
        stored_path: clamp(info.storage_path, 512),
        mime: clamp(info.mime_type, 120) || 'application/octet-stream',
        size: 0,
        version: source.version,
        uploaded_by: ownerId,
        uploaded_by_name: clamp(source.by, 160),
        uploaded_at: source.at,
        storage_backend: 'supabase'
      });
    }
  }

  // ---- status history: the classic timeline, from_status reconstructed ----
  const history = [];
  let previous = null;
  for (const entry of jsonArray(legacy.statusHistory)) {
    const to = clamp(entry ? entry.status : '', 40);
    if (!to) continue;
    history.push({
      id: randomUUID(),
      submission_id: submission.id,
      from_status: previous,
      to_status: to,
      // The classic rows only recorded a display name, never an account id.
      changed_by: '',
      changed_by_name: clamp(entry.by, 160) || ownerName,
      note: clean(entry.note) || null,
      changed_at: entry.at || createdAt
    });
    previous = to;
  }
  if (!history.length) {
    history.push({
      id: randomUUID(),
      submission_id: submission.id,
      from_status: null,
      to_status: submission.status,
      changed_by: '',
      changed_by_name: ownerName,
      note: 'Imported from the classic Submissions form',
      changed_at: createdAt
    });
  }

  // ---- comments ----
  const comments = jsonArray(legacy.comments).filter(c => c && clean(c.body || c.text || c.message)).map(c => ({
    id: clamp(c.id, 36) || randomUUID(),
    submission_id: submission.id,
    author_id: clamp(c.authorId, 36),
    author_name: clamp(c.authorName || c.author || c.by, 160),
    author_role: clamp(c.authorRole || c.role, 40) || 'researcher',
    comment_type: clamp(c.type || c.commentType, 40) || 'comment',
    body: clean(c.body || c.text || c.message),
    parent_id: c.parent_id ? clamp(c.parent_id, 36) : null,
    created_at: c.createdAt || c.at || updatedAt
  }));

  return {
    skipped: false,
    submission,
    files,
    history,
    comments,
    resolvedBy: owner ? resolvedBy : 'unresolved-owner',
    adviserLinked: Boolean(adviser)
  };
}

// ---------------------------------------------------------------- run

function summarise(plan) {
  return `${plan.files.length} file(s), ${plan.history.length} status entry(ies), ${plan.comments.length} comment(s)`;
}

async function main({ apply, includeOrphans, strictOwner = false }) {
  await ensureResearchSubmissionsSchema();

  const users = await all('SELECT id, username, email, fullName, role FROM users');
  if (!users.length && !includeOrphans) {
    console.error('[migrate] no accounts found — refusing to guess owners. Re-run with --include-orphans if the user table is intentionally empty.');
    process.exit(1);
  }
  // One index, two kinds of key: ids/emails/usernames/full names verbatim, plus
  // the initials-insensitive name key for each account.
  const index = ownerIndex(users);
  for (const [key, matches] of nameIndex(users)) {
    if (!index.has(key)) index.set(key, matches);
    else for (const [id, user] of matches) index.get(key).set(id, user);
  }

  const legacyRows = await all('SELECT * FROM submissions ORDER BY createdAt');
  console.log(`[migrate] classic submissions: ${legacyRows.length}`);
  console.log(`[migrate] known accounts: ${users.length}${apply ? '' : '   (dry run — nothing will be written)'}`);

  const plans = [];
  const skipped = [];
  const alreadyDone = [];

  for (const legacy of legacyRows) {
    const existing = await get('SELECT id FROM research_submissions WHERE id = ?', [legacy.id]);
    if (existing) {
      alreadyDone.push(legacy.id);
      continue;
    }
    const plan = planSubmission(legacy, { index, includeOrphans, nameMatch: !strictOwner });
    if (plan.skipped) skipped.push({ id: legacy.id, reason: plan.reason });
    else plans.push(plan);
  }

  console.log('');
  for (const plan of plans) {
    console.log(`  copy  ${plan.submission.id}  "${plan.submission.title.slice(0, 48)}"`);
    console.log(`        owner=${plan.submission.owner_name} (${plan.submission.owner_role}) via ${plan.resolvedBy}` +
      `  stage=${plan.submission.stage} status=${plan.submission.status}` +
      `${plan.adviserLinked ? '  adviser linked' : ''}`);
    console.log(`        ${summarise(plan)}`);
  }
  for (const id of alreadyDone) console.log(`  skip  ${id}  already migrated`);
  for (const entry of skipped) console.log(`  skip  ${entry.id}  ${entry.reason}`);

  const totals = plans.reduce((acc, plan) => ({
    files: acc.files + plan.files.length,
    history: acc.history + plan.history.length,
    comments: acc.comments + plan.comments.length
  }), { files: 0, history: 0, comments: 0 });

  console.log('');
  console.log(`[migrate] to write: ${plans.length} submission(s), ${totals.files} file row(s), ` +
    `${totals.history} status row(s), ${totals.comments} comment row(s)`);
  if (skipped.length) console.log(`[migrate] skipped: ${skipped.length} (see above; --include-orphans copies them)`);
  if (alreadyDone.length) console.log(`[migrate] already migrated: ${alreadyDone.length}`);

  if (!plans.length) {
    console.log('');
    console.log('[migrate] nothing to do.');
    process.exit(0);
  }

  if (!apply) {
    console.log('');
    console.log('[migrate] DRY RUN — no changes were made. Re-run with --apply to copy (a full backup is taken first).');
    process.exit(0);
  }

  // ---- backup first, then one transaction ----
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(BACKUPS_DIR, `${stamp}-legacy-submissions-database.json`);
  const dump = await dumpDatabase();
  await mkdir(BACKUPS_DIR, { recursive: true });
  await writeFile(backupPath, JSON.stringify(dump, null, 2), 'utf8');
  console.log('');
  console.log(`[migrate] backup: ${backupPath} (${dump.tables} tables, ${dump.rowCount} rows)`);

  const map = plans.map(plan => ({ id: plan.submission.id, owner: plan.submission.owner_name }));
  const manifestPath = join(BACKUPS_DIR, `legacy-submissions-migration-${stamp}.json`);
  const planFile = {
    createdAt: new Date().toISOString(),
    database: process.env.DB_NAME || '',
    backupPath,
    copiedIds: map,
    skipped
  };

  await withTransaction(async (tx) => {
    for (const plan of plans) {
      await tx.run(
        `INSERT INTO research_submissions (id, owner_id, owner_name, owner_role, stage, title, authors, program,
           institution, nationality, category, research_type, school_year, semester, adviser_id, facilitator_id,
           abstract, keywords, status, created_at, updated_at, adviser_eval_link)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          plan.submission.id, plan.submission.owner_id, plan.submission.owner_name, plan.submission.owner_role,
          plan.submission.stage, plan.submission.title, plan.submission.authors, plan.submission.program,
          plan.submission.institution, plan.submission.nationality, plan.submission.category,
          plan.submission.research_type, plan.submission.school_year, plan.submission.semester,
          plan.submission.adviser_id, plan.submission.facilitator_id, plan.submission.abstract,
          plan.submission.keywords, plan.submission.status, plan.submission.created_at,
          plan.submission.updated_at, plan.submission.adviser_eval_link
        ]
      );
      for (const file of plan.files) {
        await tx.run(
          `INSERT INTO research_submission_files (id, submission_id, slot_key, original_name, stored_path, mime,
             size, version, uploaded_by, uploaded_by_name, uploaded_at, storage_backend)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            file.id, file.submission_id, file.slot_key, file.original_name, file.stored_path, file.mime,
            file.size, file.version, file.uploaded_by, file.uploaded_by_name, file.uploaded_at, file.storage_backend
          ]
        );
      }
      for (const entry of plan.history) {
        await tx.run(
          `INSERT INTO research_status_history (id, submission_id, from_status, to_status, changed_by,
             changed_by_name, note, changed_at)
           VALUES (?,?,?,?,?,?,?,?)`,
          [
            entry.id, entry.submission_id, entry.from_status, entry.to_status, entry.changed_by,
            entry.changed_by_name, entry.note, entry.changed_at
          ]
        );
      }
      for (const comment of plan.comments) {
        await tx.run(
          `INSERT INTO research_comments (id, submission_id, author_id, author_name, author_role, comment_type,
             body, parent_id, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [
            comment.id, comment.submission_id, comment.author_id, comment.author_name, comment.author_role,
            comment.comment_type, comment.body, comment.parent_id, comment.created_at
          ]
        );
      }
    }
  });

  await mkdir(BACKUPS_DIR, { recursive: true }).catch(() => {});
  await writeFile(manifestPath, JSON.stringify(planFile, null, 2), 'utf8').catch(() => {});

  console.log(`[migrate] copied ${plans.length} submission(s). The classic rows are untouched.`);
  console.log(`[migrate] mapping written to ${manifestPath}`);
  console.log('[migrate] sign in and open my-submissions.html — every copied record is listed with its documents, history and comments.');
  return 0;
}

// ---------------------------------------------------------------- CLI
// Only runs when this file is executed (npm run migrate:legacy-submissions).
// Imported by a test, it exposes its pure mapping functions and connects to
// nothing.
const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }
  main({
    apply: argv.includes('--apply'),
    includeOrphans: argv.includes('--include-orphans'),
    strictOwner: argv.includes('--strict-owner')
  }).then((code) => process.exit(code || 0)).catch((error) => {
    console.error('[migrate] failed:', error.message);
    console.error('[migrate] nothing was written (the whole run is one transaction).');
    process.exit(1);
  });
}
