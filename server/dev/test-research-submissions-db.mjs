// ============================================================
//  CPRI — Research Submission Module: database-backed tests
//
//  The offline suite (research-submissions.test.mjs) proves the router's rules
//  with a fake data layer. This one proves the other half: that the module's
//  SQL, its schema and its real session lookups actually work against the
//  configured database (MySQL/TiDB), by driving the REAL router — no injected
//  data layer — over HTTP.
//
//  Every row it creates is identifiable by the `test-rsub-` id prefix, and
//  test.after removes all of it (rows, files and users) even when a test
//  fails. Nothing else in the database is touched.
//
//  If the database is unreachable the suite skips itself with a clear reason
//  rather than reporting a pass.
//
//  Run: npm run test:research-submissions:db
// ============================================================
import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { createResearchSubmissionsRouter, ensureResearchSubmissionsSchema } from '../research-submissions.js';
import { all, get, insert, run } from '../server/db/queries.js';

// users.id is varchar(36), so the marker has to stay short.
const PREFIX = `rsub-t-${Date.now().toString(36)}-`;
const PASSWORD_HASH = await bcrypt.hash('not-a-real-password', 4);

// ---- Is the database there at all? ----------------------------------------
let skip = false;
try {
  await all('SELECT 1 AS ok');
} catch (err) {
  skip = `database unreachable (${err.message}) — run \`npm run db:init\` and check .env`;
  console.warn(`[research-submissions db test] SKIPPED: ${skip}`);
}

const opts = skip ? { skip } : {};

// ---- State shared by the suite --------------------------------------------
const users = {};
const createdSubmissionIds = [];
let server;
let base;
let uploadDir;
let app;

let userSeq = 0;

async function makeUser(role) {
  const n = ++userSeq;
  const id = `${PREFIX}${n}`;
  const tag = `rsub${n}`;
  await insert('users', {
    id,
    username: `${tag}${role.replace(/[^a-z]/g, '')}`.slice(0, 40),
    email: `${tag}@rsub-test.local`,
    fullName: `${role} (module test)`,
    role,
    passwordHash: PASSWORD_HASH,
    status: 'active'
  });
  users[role] = { id, role, fullName: `${role} (module test)`, username: tag, email: `${tag}@rsub-test.local` };
  return users[role];
}

const as = (user) => ({ 'x-test-user': user.id });

async function req(user, path, init = {}) {
  const res = await fetch(base + path, {
    ...init,
    headers: { ...as(user), ...(init.headers || {}) }
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, text };
}

const PDF = 'application/pdf';
function uploadForm(files, fields = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  for (const [slot, file] of Object.entries(files)) {
    form.append(slot, new Blob([file.body], { type: file.type }), file.name);
  }
  return form;
}
const pdf = (name) => ({ name, body: `bytes:${name}`, type: PDF });
const docx = (name) => ({
  name, body: `bytes:${name}`,
  type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
});

const STUDENT_FIELDS = {
  stage: 'initial',
  title: 'DB test working title',
  authors: 'Test Author',
  program: 'BS Biology',
  category: 'Life Sciences',
  research_type: 'student_thesis',
  school_year: '2026-2027',
  semester: '1st',
  adviser: 'Dr. Adviser',
  facilitator: 'Ms. Facilitator'
};
const STUDENT_FILES = {
  manuscript_docx: docx('manuscript.docx'),
  manuscript_pdf: pdf('manuscript.pdf'),
  form_a: pdf('form-a.pdf'),
  form_b: pdf('form-b.pdf'),
  form_d: pdf('form-d.pdf'),
  form_e1: pdf('form-e1.pdf'),
  form_f: pdf('form-f.pdf'),
  defense_photos: pdf('photos.pdf'),
  official_receipt: pdf('receipt.pdf')
};

// ===========================================================================
test.before(async () => {
  if (skip) return;

  // If this is a fresh database, apply the module's own DDL first — the same
  // call server.js makes on boot.
  await ensureResearchSubmissionsSchema();

  app = express();
  app.use(express.json());
  // Stands in for express-session: the id lands in req.session, and the module
  // then resolves the account (and its role) from the database — the real path.
  app.use((req, res, next) => {
    const id = req.headers['x-test-user'];
    req.session = id ? { userId: id } : {};
    next();
  });
  app.use('/api/research-submissions', createResearchSubmissionsRouter({ uploadDir: undefined }));

  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  server.unref();
  base = `http://127.0.0.1:${server.address().port}/api/research-submissions`;

  await makeUser('student_researcher');
  await makeUser('non_teaching_researcher');
  await makeUser('presenter');
  await makeUser('cpri_staff');
  await makeUser('ethics_reviewer');
  await makeUser('adviser');
  await makeUser('facilitator');
});

test.after(async () => {
  if (skip) return;
  // Remove every row this suite created, whatever happened above. Submission
  // ids are server-generated UUIDs, so they are tracked explicitly rather than
  // matched by prefix.
  const placeholders = createdSubmissionIds.map(() => '?').join(',');
  if (createdSubmissionIds.length) {
    for (const table of [
      'research_ethics_clearances', 'research_comments', 'research_status_history',
      'research_submission_files'
    ]) {
      try {
        await run(`DELETE FROM ${table} WHERE submission_id IN (${placeholders})`, createdSubmissionIds);
      } catch (err) {
        console.error(`[research-submissions db test] could not clean ${table}:`, err.message);
      }
    }
    try {
      await run(`DELETE FROM research_submissions WHERE id IN (${placeholders})`, createdSubmissionIds);
    } catch (err) {
      console.error('[research-submissions db test] could not clean submissions:', err.message);
    }

    // Files: the module writes server/data/research-submissions/<id>/.
    for (const id of createdSubmissionIds) {
      await rm(join(process.cwd(), 'server', 'data', 'research-submissions', id), {
        recursive: true, force: true
      }).catch(() => {});
    }
  }

  // Notifications the module wrote for these runs. They are matched by the
  // submission ids this suite created (the link points at the detail page), so
  // nothing a real user ever receives is touched — including the notification
  // the real CPRI staff/admin accounts got for the test submission.
  try {
    for (const id of createdSubmissionIds) {
      await run('DELETE FROM notifications WHERE link LIKE ?', [`%${id}%`]);
    }
    await run('DELETE FROM notifications WHERE userId LIKE ?', [`${PREFIX}%`]);
  } catch (err) {
    console.error('[research-submissions db test] could not clean notifications:', err.message);
  }

  try {
    await run('DELETE FROM users WHERE id LIKE ?', [`${PREFIX}%`]);
  } catch (err) {
    console.error('[research-submissions db test] could not clean users:', err.message);
  }
  if (server) await new Promise(resolve => server.close(resolve));
  if (uploadDir) await rm(uploadDir, { recursive: true, force: true }).catch(() => {});

  const usersLeft = await all('SELECT id FROM users WHERE id LIKE ?', [`${PREFIX}%`]);
  const rowsLeft = createdSubmissionIds.length
    ? await all(`SELECT id FROM research_submissions WHERE id IN (${placeholders})`, createdSubmissionIds)
    : [];
  console.log(`[research-submissions db test] cleaned up — test users left: ${usersLeft.length}, submissions left: ${rowsLeft.length}`);
});

// ===========================================================================
//  Schema
// ===========================================================================
test('the module tables exist in the database', opts, async () => {
  const rows = await all(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE 'research\\_%'"
  );
  const names = rows.map(r => r.name || Object.values(r)[0]).sort();
  for (const table of [
    'research_comments', 'research_ethics_clearances', 'research_status_history',
    'research_submission_files', 'research_submissions'
  ]) {
    assert.ok(names.includes(table), `${table} exists`);
  }
  const cols = await all('SHOW COLUMNS FROM research_submissions');
  const fields = cols.map(c => c.Field);
  for (const col of ['owner_id', 'owner_role', 'stage', 'status', 'adviser_id', 'facilitator_id']) {
    assert.ok(fields.includes(col), `research_submissions.${col} exists`);
  }
});

// ===========================================================================
//  The whole lifecycle, against the real database
// ===========================================================================
test('a student can submit, the row and files persist, and every rule holds', opts, async () => {
  const student = users.student_researcher;
  const faculty = users.non_teaching_researcher;
  const presenter = users.presenter;
  const staff = users.cpri_staff;
  const reviewer = users.ethics_reviewer;

  // --- who am I / form-config, resolved from the session + users table ---
  const me = await req(student, '/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.role, 'student_researcher');

  const cfg = await req(student, '/form-config');
  assert.deepEqual(cfg.body.stages.map(s => s.stage), ['initial', 'final']);

  // --- create with every required file, stored on the real disk ---
  const created = await req(student, '/', {
    method: 'POST',
    body: uploadForm(STUDENT_FILES, { ...STUDENT_FIELDS, role: 'admin', owner_id: 'someone-else' })
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.submission.id;
  createdSubmissionIds.push(id);
  assert.match(id, /^[0-9a-f-]{36}$/, 'the id is a server-generated UUID');

  // The row really is in the database, owned by the session's user.
  const row = await get('SELECT * FROM research_submissions WHERE id = ?', [id]);
  assert.equal(row.owner_id, student.id);
  assert.equal(row.owner_role, 'student_researcher');
  assert.equal(row.status, 'submitted');

  const files = await all('SELECT * FROM research_submission_files WHERE submission_id = ?', [id]);
  assert.equal(files.length, Object.keys(STUDENT_FILES).length);
  assert.ok(files.every(f => f.stored_path.startsWith(`research-submissions/${id}/files/`)));

  // --- isolation, through the real DB lookups ---
  const other = await makeUser('student_researcher');
  assert.equal((await req(other, `/${id}`)).status, 403);
  assert.equal((await req(other, `/${id}/files/${files[0].id}`)).status, 403);
  assert.equal((await req(other, `/${id}/form-config`)).status, 403);

  // --- the resubmission panel describes this submission ---
  const subCfg = await req(student, `/${id}/form-config`);
  assert.equal(subCfg.body.canUpload, true);
  assert.equal(subCfg.body.ownerRole, 'student_researcher');

  // --- a new upload is a new version, and the old one still downloads ---
  const up = await req(student, `/${id}/files`, {
    method: 'POST', body: uploadForm({ manuscript_pdf: pdf('revision-2.pdf') })
  });
  assert.equal(up.status, 201);
  assert.equal(up.body.file.version, 2);

  const first = files.find(f => f.slot_key === 'manuscript_pdf');
  const dl = await req(student, `/${id}/files/${first.id}`);
  assert.equal(dl.status, 200);
  assert.equal(dl.text, `bytes:${first.original_name}`);

  const versions = await req(student, `/${id}/versions`);
  assert.deepEqual(versions.body.versions.map(v => v.version).sort((a, b) => a - b), [1, 2]);

  // --- faculty rules ---
  const facultyCreated = await req(faculty, '/', {
    method: 'POST',
    body: uploadForm(
      { manuscript_docx: docx('f.docx'), manuscript_pdf: pdf('f.pdf') },
      {
        stage: 'initial', title: 'Faculty work', authors: 'F', program: 'CPRI',
        category: 'Institutional', research_type: 'faculty_research',
        school_year: '2026-2027', semester: '1st'
      }
    )
  });
  assert.equal(facultyCreated.status, 201, JSON.stringify(facultyCreated.body));
  const facultyId = facultyCreated.body.submission.id;
  createdSubmissionIds.push(facultyId);
  const studentOnly = await req(faculty, `/${facultyId}/files`, {
    method: 'POST', body: uploadForm({ form_a: pdf('form-a.pdf') })
  });
  assert.equal(studentOnly.status, 403);

  // --- a presenter still has no initial stage ---
  const presenterInitial = await req(presenter, '/', {
    method: 'POST', body: uploadForm({ manuscript_pdf: pdf('p.pdf') }, { ...STUDENT_FIELDS, stage: 'initial' })
  });
  assert.equal(presenterInitial.status, 403);

  // --- status transitions, recorded in the history table ---
  const badMove = await req(staff, `/${id}/status`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'published' })
  });
  assert.equal(badMove.status, 400);

  // Approval cannot be granted from checking without the ethics decision.
  const skipEthics = await req(staff, `/${id}/status`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'approved' })
  });
  assert.equal(skipEthics.status, 400);

  const move = await req(staff, `/${id}/status`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'under_initial_checking' })
  });
  assert.equal(move.status, 200);
  assert.equal((await get('SELECT status FROM research_submissions WHERE id = ?', [id])).status, 'under_initial_checking');

  const history = await all(
    'SELECT * FROM research_status_history WHERE submission_id = ? ORDER BY changed_at ASC', [id]
  );
  assert.equal(history.length, 2);
  assert.equal(history[1].from_status, 'submitted');
  assert.equal(history[1].changed_by, staff.id);

  // --- notifications really are written to the site's notifications table ---
  const notices = await all(
    'SELECT * FROM notifications WHERE userId = ? ORDER BY createdAt ASC', [student.id]
  );
  assert.ok(
    notices.some(n => n.action === 'research_submission_status'),
    'the owner got an in-app notification for the status change'
  );
  assert.ok(
    notices.every(n => String(n.link).includes(id)),
    'every notification links back to this submission'
  );

  // --- comments land in the database with the session's role ---
  const comment = await req(staff, `/${id}/comments`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'Please attach the signed form.', role: 'admin' })
  });
  assert.equal(comment.status, 201);
  const stored = await get('SELECT * FROM research_comments WHERE id = ?', [comment.body.comment.id]);
  assert.equal(stored.author_id, staff.id);
  assert.equal(stored.author_role, 'cpri_staff', 'the role comes from the session, not the body');

  const reply = await req(student, `/${id}/comments`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'Uploaded.', parent_id: comment.body.comment.id })
  });
  assert.equal(reply.status, 201);

  // --- ethics: only a reviewer, only while under ethics review ---
  const tooEarly = await req(reviewer, `/${id}/ethics`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approved' })
  });
  assert.equal(tooEarly.status, 403);

  const notReviewer = await req(staff, `/${id}/ethics`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approved' })
  });
  assert.equal(notReviewer.status, 403);

  // Walk it to Under Ethics Review and approve with a clearance PDF.
  const toEthics = await req(staff, `/${id}/status`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'under_ethics_review' })
  });
  assert.equal(toEthics.status, 200, JSON.stringify(toEthics.body));

  const ethicsForm = new FormData();
  ethicsForm.append('decision', 'approved');
  ethicsForm.append('ethics_clearance', new Blob(['clearance'], { type: PDF }), 'clearance.pdf');
  const decision = await req(reviewer, `/${id}/ethics`, { method: 'POST', body: ethicsForm });
  assert.equal(decision.status, 200, JSON.stringify(decision.body));

  const clearance = await get(
    'SELECT * FROM research_ethics_clearances WHERE submission_id = ?', [id]
  );
  assert.equal(clearance.decision, 'approved');
  assert.equal(clearance.reviewer_id, reviewer.id);
  assert.ok(clearance.file_path, 'the clearance file path was recorded');

  // --- drafts: storable while incomplete, handed in only when complete ---
  const draftRes = await req(student, '/', {
    method: 'POST',
    body: uploadForm({}, { stage: 'initial', title: 'Unfinished draft', as_draft: '1' })
  });
  assert.equal(draftRes.status, 201, JSON.stringify(draftRes.body));
  const draftId = draftRes.body.submission.id;
  createdSubmissionIds.push(draftId);
  assert.equal((await get('SELECT status FROM research_submissions WHERE id = ?', [draftId])).status, 'draft');

  const handInEarly = await req(student, `/${draftId}/status`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'submitted' })
  });
  assert.equal(handInEarly.status, 400);
  assert.equal(handInEarly.body.draftIncomplete, true);
  assert.equal(
    (await get('SELECT status FROM research_submissions WHERE id = ?', [draftId])).status,
    'draft',
    'a refused hand-in leaves the draft untouched'
  );

  // --- an adviser / facilitator monitors EVERY submission, assigned or not ---
  // The role is the portal's oversight seat: it sees the student record, the
  // faculty record and anything recorded by staff, from both research stores.
  // What it must never reach is a write — that is asserted after this.
  const adviser = users.adviser;
  const list = await req(adviser, '/');
  assert.equal(list.status, 200);
  assert.ok(list.body.submissions.some(s => s.id === id),
    'an adviser monitors the student submission, assigned or not');
  assert.ok(list.body.submissions.some(s => s.id === facultyId),
    'and the faculty record too — nothing about a submission hides it');
  assert.equal(list.body.count, list.body.submissions.length,
    'the count is the list it was given');
  const entry = list.body.submissions.find(s => s.id === id);
  for (const field of ['title', 'studentName', 'program', 'status', 'statusLabel', 'research_type', 'created_at', 'updated_at']) {
    assert.ok(entry[field] !== undefined && entry[field] !== null && entry[field] !== '',
      `a listed record carries ${field}`);
  }
  assert.ok(Array.isArray(entry.files) && Array.isArray(entry.comments),
    'documents and comments come with the list');
  assert.ok(entry.detailUrl, 'and so does the link to its full page');
  assert.equal((await req(adviser, `/${facultyId}`)).status, 200,
    'opening a record it does not own works — reading is not owning');
  assert.equal((await req(adviser, `/${facultyId}/files`, {
    method: 'POST', body: uploadForm({ manuscript_docx: docx('not-mine.docx') })
  })).status, 403,
    'but uploading into one is refused');
  assert.equal((await req(adviser, `/${facultyId}`)).status, 200,
    'a faculty record is readable by the oversight seat even when it never named them');
});

// ===========================================================================
//  A record whose owner_id is not the account id
//
//  Rows copied from the classic `submissions` module carry the owner's email or
//  username there. Against the real database this proves both halves: the
//  widened owner match is valid SQL for MySQL/TiDB, and such a row is listed for
//  its owner — the "You have no submissions yet" bug — while staying invisible
//  to everybody else.
// ===========================================================================
test('a record keyed by the owner email is listed for that owner, and only them', async () => {
  const student = await makeUser('student_researcher');
  const other = await makeUser('student_researcher');
  const importedId = `${PREFIX}legacy-email`;
  createdSubmissionIds.push(importedId);

  const now = new Date().toISOString();
  await insert('research_submissions', {
    id: importedId,
    owner_id: student.email,
    owner_name: student.fullName,
    owner_role: 'student_researcher',
    stage: 'initial',
    title: 'Imported from the classic form',
    authors: 'A. Author',
    program: 'BSIT',
    institution: '',
    nationality: '',
    category: '',
    research_type: 'student_thesis',
    school_year: '',
    semester: '',
    adviser_id: null,
    facilitator_id: null,
    abstract: null,
    keywords: null,
    status: 'legacy_pending',
    created_at: now,
    updated_at: now,
    adviser_eval_link: ''
  });

  const list = await req(student, '/');
  assert.equal(list.status, 200);
  assert.ok(list.body.submissions.some(s => s.id === importedId),
    'a row keyed by the owner email is listed for its owner');

  const detail = await req(student, `/${importedId}`);
  assert.equal(detail.status, 200, 'and its owner may open it');
  assert.equal(detail.body.submission.isOwner, true);
  assert.equal(detail.body.submission.status, 'legacy_pending', 'an unknown status is reported, never hidden');
  assert.equal(detail.body.submission.statusLabel, 'legacy_pending');

  assert.equal((await req(other, `/${importedId}`)).status, 403, 'and it is still nobody else\'s');
});
