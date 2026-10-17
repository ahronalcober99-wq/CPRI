// ============================================================
//  CPRI — end-to-end workflows against a real database
//
//  Drives the REAL routers over HTTP with real SQL, one account per role, and
//  proves the fixes for the known blockers and feature gaps:
//
//   1. The Ethics Application is created by ONE multipart request carrying
//      the text and the four required files (the old page sent JSON, so it
//      always failed with "Required file missing").
//   2. An ethics reviewer lists and opens Initial papers and approves them
//      with the decision endpoint, so they move past Under Ethics Review.
//   3. A faculty / non-teaching Initial paper can go back For Revision.
//   4. Repository records carry the facilitator and the researcher's own
//      category, and the repository can be searched by that category.
//   5. Every report counts submissions from both forms.
//
//  SAFETY: it writes rows, so it refuses to run unless the database is on
//  this machine (localhost / 127.0.0.1 / ::1). Point it at a throwaway one:
//
//    DB_HOST=127.0.0.1 DB_PORT=3399 DB_USER=root DB_PASSWORD= \
//    DB_NAME=cpri_e2e DB_SSL_MODE=disable npm run test:workflows:db
//
//  Every row and uploaded file it creates is removed afterwards.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import bcrypt from 'bcryptjs';
import { rm, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { describeDbTarget } from '../db.js';
import { all, get, insert, run } from '../server/db/queries.js';

const here = dirname(fileURLToPath(import.meta.url));

// ---- Only ever a local database -------------------------------------------
const target = describeDbTarget();
const host = String(target.host || '').toLowerCase().replace(/^\[|\]$/g, '');
let skip = ['localhost', '127.0.0.1', '::1'].includes(host)
  ? false
  : `DB_HOST is "${target.host}", not a local database — this suite writes rows, so it only runs against a local throwaway database`;
if (!skip) {
  try { await all('SELECT 1 AS ok'); } catch (err) { skip = `database unreachable (${err.message})`; }
}
if (skip) console.warn(`[workflows db test] SKIPPED: ${skip}`);
const opts = skip ? { skip } : {};

const { ethicsRouter } = await import('../ethics.js');
const { createResearchSubmissionsRouter, ensureResearchSubmissionsSchema } = await import('../research-submissions.js');
const { repositoryRouter, ensureRepositorySchema } = await import('../repository.js');
const { reportsRouter } = await import('../reports.js');
const { adminDashboardRouter } = await import('../admin-dashboard.js');
const { adminInsightsRouter } = await import('../admin-insights.js');
const { messagesRouter, ensureMessagesTable } = await import('../messages.js');

const PREFIX = `wf-${Date.now().toString(36)}-`;
const ids = (name) => `${PREFIX}${name}`;
const UNIQUE_CATEGORY = `${PREFIX}Marine Ecology`;
const users = {};
const created = { module: [], classic: [], ethics: [] };
let server;
let base;

async function makeUser(key, role) {
  const id = ids(key);
  await insert('users', {
    id,
    username: `${PREFIX}${key}`.slice(0, 40),
    email: `${PREFIX}${key}@workflow-test.local`,
    fullName: `${key} (workflow test)`,
    role,
    passwordHash: await bcrypt.hash('not-a-real-password', 4),
    status: 'active'
  });
  users[key] = { id, role, fullName: `${key} (workflow test)` };
}

async function call(user, path, init = {}) {
  const res = await fetch(base + path, {
    ...init,
    headers: {
      ...(user ? { 'x-test-user': user.id } : {}),
      ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {})
    }
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, text };
}

const doc = (name, type = 'application/pdf') => new Blob([`bytes of ${name}`], { type });

function ethicsForm({ omit = [] } = {}) {
  const form = new FormData();
  const text = {
    title: `${PREFIX}Ethics of tidal surveys`, researchers: 'A. Researcher', adviser: 'Dr. Adviser',
    department: 'BS Biology', participantType: 'Adults', riskLevel: 'low'
  };
  for (const [k, v] of Object.entries(text)) form.append(k, v);
  for (const key of ['ethics_application', 'informed_consent', 'research_instrument', 'proposal_manuscript']) {
    if (!omit.includes(key)) form.append(key, doc(`${key}.pdf`), `${key}.pdf`);
  }
  return form;
}

async function addModule(name, fields = {}) {
  const row = {
    id: ids(name),
    owner_id: users.student.id,
    owner_name: users.student.fullName,
    owner_role: 'student_researcher',
    stage: 'initial',
    title: `Module ${name}`,
    authors: 'M. Author',
    program: 'BS Biology',
    category: UNIQUE_CATEGORY,
    research_type: 'student_thesis',
    school_year: '2025-2026',
    semester: '1st',
    adviser_id: 'Dr. Adviser',
    facilitator_id: 'Ms. Facilitator',
    abstract: 'Abstract.',
    keywords: 'tides',
    status: 'submitted',
    created_at: '2026-10-01 08:00:00',
    updated_at: '2026-10-01 08:00:00',
    ...fields
  };
  await insert('research_submissions', row);
  created.module.push(row.id);
  return row;
}

async function addClassic(name, fields = {}) {
  const row = {
    id: ids(name),
    submitterId: users.student.id,
    submitterName: users.student.fullName,
    title: `Classic ${name}`,
    authors: 'C. Author',
    program: 'BS IT',
    category: 'Robotics',
    researchType: 'capstone',
    schoolYear: '2025-2026',
    status: 'submitted',
    statusHistory: JSON.stringify([]),
    files: JSON.stringify({}),
    createdAt: '2026-10-02 08:00:00',
    updatedAt: '2026-10-02 08:00:00',
    ...fields
  };
  await insert('submissions', row);
  created.classic.push(row.id);
  return row;
}

// ===========================================================================
test.before(async () => {
  if (skip) return;
  await ensureResearchSubmissionsSchema();
  await ensureRepositorySchema();
  await ensureMessagesTable();

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const id = req.headers['x-test-user'];
    req.session = id ? { userId: id } : {};
    next();
  });
  app.use('/api/ethics', ethicsRouter);
  app.use('/api/research-submissions', createResearchSubmissionsRouter());
  app.use('/api/repository', repositoryRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/admin', adminDashboardRouter);
  app.use('/api/admin', adminInsightsRouter);
  app.use('/api/messages', messagesRouter);

  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  server.unref();
  base = `http://127.0.0.1:${server.address().port}`;

  await makeUser('admin', 'admin');
  await makeUser('staff', 'cpri_staff');
  await makeUser('student', 'student_researcher');
  await makeUser('other', 'student_researcher');
  await makeUser('faculty', 'faculty_researcher');
  await makeUser('nonteaching', 'non_teaching_researcher');
  await makeUser('reviewer', 'ethics_reviewer');
});

test.after(async () => {
  if (skip) return;
  const clean = async (sql, params) => {
    try { await run(sql, params); } catch (err) { console.error('[workflows db test] cleanup:', err.message); }
  };
  const subIds = [...created.module, ...created.classic];
  for (const id of subIds) {
    for (const table of ['research_status_history', 'research_ethics_clearances', 'research_comments', 'research_submission_files']) {
      await clean(`DELETE FROM ${table} WHERE submission_id = ?`, [id]);
    }
    await clean('DELETE FROM publications WHERE sourceSubmissionId = ?', [id]);
    await clean('DELETE FROM repository WHERE sourceSubmissionId = ?', [id]);
    await clean('DELETE FROM notifications WHERE link LIKE ?', [`%${id}%`]);
    await rm(join(process.cwd(), 'server', 'data', 'research-submissions', id), { recursive: true, force: true }).catch(() => {});
  }
  for (const id of created.module) await clean('DELETE FROM research_submissions WHERE id = ?', [id]);
  for (const id of created.classic) await clean('DELETE FROM submissions WHERE id = ?', [id]);
  const ethicsRows = await all('SELECT id FROM ethics WHERE submitterId LIKE ?', [`${PREFIX}%`]).catch(() => []);
  for (const { id } of ethicsRows) {
    await rm(join(here, '..', '..', 'public', 'assets', 'uploads', 'ethics', id), { recursive: true, force: true }).catch(() => {});
  }
  await clean('DELETE FROM ethics WHERE submitterId LIKE ?', [`${PREFIX}%`]);
  const sentMessages = await all('SELECT id FROM direct_messages WHERE senderId LIKE ?', [`${PREFIX}%`]).catch(() => []);
  for (const { id } of sentMessages) {
    await rm(join(process.cwd(), 'server', 'data', 'messages', id), { recursive: true, force: true }).catch(() => {});
  }
  await clean('DELETE FROM direct_messages WHERE senderId LIKE ? OR recipientId LIKE ?', [`${PREFIX}%`, `${PREFIX}%`]);
  await clean('DELETE FROM notifications WHERE userId LIKE ?', [`${PREFIX}%`]);
  await clean('DELETE FROM system_logs WHERE userId LIKE ?', [`${PREFIX}%`]);
  await clean('DELETE FROM users WHERE id LIKE ?', [`${PREFIX}%`]);
  if (server) await new Promise(resolve => server.close(resolve));
  const { default: pool } = await import('../db.js');
  await pool.end().catch(() => {});
});

// ===========================================================================
//  1. Ethics Application: text and files in one request
// ===========================================================================
test('the Ethics Application is created by one request with its text and files', opts, async () => {
  // What the old page did: JSON first, files "later". The server can never
  // accept that, because the files are required at creation.
  const jsonOnly = await call(users.student, '/api/ethics', {
    method: 'POST',
    body: JSON.stringify({ title: 'x', researchers: 'x', adviser: 'x', department: 'x', participantType: 'x', riskLevel: 'low' })
  });
  assert.equal(jsonOnly.status, 400);
  assert.match(jsonOnly.body.error, /Required file missing/);

  const uploadsDir = join(here, '..', '..', 'public', 'assets', 'uploads', 'ethics');
  const foldersBefore = await readdir(uploadsDir).catch(() => []);
  const missingOne = await call(users.student, '/api/ethics', { method: 'POST', body: ethicsForm({ omit: ['informed_consent'] }) });
  assert.equal(missingOne.status, 400);
  assert.match(missingOne.body.error, /informed_consent/);
  assert.deepEqual((await readdir(uploadsDir).catch(() => [])).sort(), foldersBefore.sort(),
    'a refused application leaves none of its uploaded files behind');

  // What the page does now.
  const ok = await call(users.student, '/api/ethics', { method: 'POST', body: ethicsForm() });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const id = ok.body.application.id;
  created.ethics.push(id);

  const opened = await call(users.student, `/api/ethics/${id}`);
  assert.equal(opened.status, 200);
  assert.deepEqual(Object.keys(opened.body.application.files).sort(),
    ['ethics_application', 'informed_consent', 'proposal_manuscript', 'research_instrument']);
  assert.equal(opened.body.application.status, 'submitted');

  const reviewerList = await call(users.reviewer, '/api/ethics');
  assert.ok(reviewerList.body.applications.some(a => a.id === id), 'the review board sees it');
  assert.equal((await call(users.other, `/api/ethics/${id}`)).status, 403, 'another student does not');
});

test('non-teaching researchers can file an ethics application; a stale session cannot read one', opts, async () => {
  const ok = await call(users.nonteaching, '/api/ethics', { method: 'POST', body: ethicsForm() });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  created.ethics.push(ok.body.application.id);

  // A session whose account no longer exists used to pass canAccess().
  const ghost = { id: ids('deleted-account') };
  assert.equal((await call(ghost, `/api/ethics/${ok.body.application.id}`)).status, 403);
  assert.equal((await call(ghost, '/api/ethics')).status, 401);
});

// ===========================================================================
//  2. Ethics reviewer decides Initial papers
// ===========================================================================
test('an ethics reviewer lists, opens and approves an Initial paper under ethics review', opts, async () => {
  const paper = await addModule('ethics-paper', { status: 'under_ethics_review' });
  await addModule('final-paper', { stage: 'final', status: 'submitted' });

  const list = await call(users.reviewer, '/api/research-submissions');
  assert.equal(list.status, 200);
  const listed = list.body.submissions.map(s => s.id);
  assert.ok(listed.includes(paper.id));
  assert.ok(!listed.includes(ids('final-paper')), 'Final papers do not go through ethics review');

  const opened = await call(users.reviewer, `/api/research-submissions/${paper.id}`);
  assert.equal(opened.status, 200);
  assert.equal(opened.body.submission.canDecideEthics, true);

  const form = new FormData();
  form.append('decision', 'approved');
  form.append('ethics_clearance', doc('clearance.pdf'), 'clearance.pdf');
  const decided = await call(users.reviewer, `/api/research-submissions/${paper.id}/ethics`, { method: 'POST', body: form });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal(decided.body.submission.status, 'approved');

  const ownerView = await call(users.student, `/api/research-submissions/${paper.id}`);
  const [clearance] = ownerView.body.submission.ethicsClearances;
  assert.equal(clearance.decision, 'approved');
  const file = await call(users.student, `/api/research-submissions/${paper.id}/ethics-clearance/${clearance.id}`);
  assert.equal(file.status, 200);
  assert.equal(file.text, 'bytes of clearance.pdf');
});

// ===========================================================================
//  3. Faculty Initial: For Revision
// ===========================================================================
test('staff can return a faculty Initial paper For Revision', opts, async () => {
  const paper = await addModule('faculty-paper', {
    owner_id: users.faculty.id, owner_name: users.faculty.fullName, owner_role: 'faculty_researcher',
    research_type: 'faculty_research'
  });
  const move = (status) => call(users.staff, `/api/research-submissions/${paper.id}/status`, {
    method: 'PATCH', body: JSON.stringify({ status })
  });
  assert.equal((await move('for_revision')).status, 200);
  assert.equal((await move('under_ethics_review')).status, 200);
});

// ===========================================================================
//  4. Repository: facilitator and the researcher's own category
// ===========================================================================
test('repository records carry the facilitator and can be searched by research category', opts, async () => {
  assert.deepEqual(await ensureRepositorySchema(), [], 'running it again adds nothing');

  const paper = await addModule('repo-paper', { stage: 'final', status: 'submitted' });
  const published = await call(users.admin, `/api/admin/submissions/${paper.id}/publish`, { method: 'POST' });
  assert.equal(published.status, 200, JSON.stringify(published.body));

  const found = await call(null, `/api/repository?researchCategory=${encodeURIComponent(UNIQUE_CATEGORY.slice(-14))}`);
  assert.equal(found.status, 200);
  const hit = found.body.records.find(r => r.id === published.body.repositoryId);
  assert.ok(hit, 'found by the researcher\'s own category');
  assert.equal(hit.researchCategory, UNIQUE_CATEGORY);
  assert.equal(hit.facilitator, 'Ms. Facilitator');
  const none = await call(null, '/api/repository?researchCategory=' + encodeURIComponent(`${PREFIX}no-such-category`));
  assert.equal(none.body.records.length, 0);

  const detail = await call(null, `/api/repository/${published.body.repositoryId}`);
  assert.equal(detail.body.record.facilitator, 'Ms. Facilitator');
  assert.equal(detail.body.record.researchCategory, UNIQUE_CATEGORY);

  // Staff can correct both on the record.
  const edited = await call(users.staff, `/api/repository/${published.body.repositoryId}`, {
    method: 'PATCH', body: JSON.stringify({ facilitator: 'Mr. New Facilitator', researchCategory: 'Coastal Ecology' })
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.record.facilitator, 'Mr. New Facilitator');
  assert.equal(edited.body.record.researchCategory, 'Coastal Ecology');
});

// ===========================================================================
//  5. Reports include both forms
// ===========================================================================
test('every submission report counts both forms', opts, async () => {
  const moduleStudent = await addModule('report-student', { title: `${PREFIX}Student report paper` });
  const moduleFaculty = await addModule('report-faculty', {
    title: `${PREFIX}Faculty report paper`, owner_id: users.faculty.id, owner_name: users.faculty.fullName,
    owner_role: 'faculty_researcher', research_type: 'faculty_research', status: 'approved'
  });
  const classic = await addClassic('report-classic', { title: `${PREFIX}Classic report paper` });
  await addModule('report-draft', { title: `${PREFIX}Draft paper`, status: 'draft' });

  const list = await call(users.admin, '/api/reports/research-submissions');
  assert.equal(list.status, 200);
  const titles = list.body.report.map(r => r.title);
  assert.ok(titles.includes(moduleStudent.title), 'Research Submission form');
  assert.ok(titles.includes(classic.title), 'classic form');
  assert.ok(!titles.includes(`${PREFIX}Draft paper`), 'drafts are not submissions yet');
  const row = list.body.report.find(r => r.title === moduleStudent.title);
  assert.equal(row.form, 'Research Submission');
  assert.equal(row.researchCategory, UNIQUE_CATEGORY);

  const students = (await call(users.admin, '/api/reports/student-output')).body.report;
  assert.ok(students.some(r => r.researchTitle === moduleStudent.title && r.source === 'Submissions'),
    'student output is no longer empty');

  const faculty = (await call(users.admin, '/api/reports/faculty-productivity')).body.report;
  const facultyRow = faculty.find(r => r.name === users.faculty.fullName);
  assert.ok(facultyRow, 'faculty productivity lists faculty who submitted');
  assert.ok(facultyRow.submittedResearches >= 1);
  assert.ok(facultyRow.completedResearches >= 1, 'the approved paper counts as completed');

  const byStatus = (await call(users.admin, '/api/reports/submissions-by-status')).body.report;
  const total = byStatus.reduce((n, r) => n + r.count, 0);
  assert.equal(total, list.body.report.length, 'the counts and the list agree');

  const csv = await call(users.admin, '/api/reports/export/research-submissions?format=csv');
  assert.equal(csv.status, 200);
  assert.ok(csv.text.includes(moduleStudent.title));

  const analytics = (await call(users.admin, '/api/admin/analytics')).body.analytics;
  assert.equal(analytics.totalSubmissions, list.body.report.length, 'analytics counts both forms');

  const impact = await call(users.admin, `/api/admin/impact-dashboard?department=${encodeURIComponent('BS Biology')}`);
  assert.equal(impact.status, 200);
  assert.ok(impact.body.filters.categories.includes(UNIQUE_CATEGORY), 'impact dashboard reads module records');
  const unfiltered = await call(users.admin, '/api/admin/impact-dashboard');
  assert.equal(unfiltered.body.stats.totalResearchPapers, list.body.report.length);

  const calendar = (await call(users.admin, '/api/admin/calendar')).body.events;
  const entry = calendar.find(e => e.id === moduleStudent.id);
  assert.ok(entry, 'the calendar shows Research Submission records');
  assert.equal(entry.link, `research-submission-detail.html?id=${moduleStudent.id}`);

  assert.ok(faculty.length >= 1 && moduleFaculty.id);
});

// ===========================================================================
//  6. Messages: related research and a private attachment
// ===========================================================================
test('a message can link research and carry a PDF that only the two people can open', opts, async () => {
  const paper = await addModule('message-paper', { title: `${PREFIX}Paper to discuss` });
  const pdf = new Blob(['%PDF-1.4 message attachment'], { type: 'application/pdf' });

  // Plain text still works as JSON, exactly as before.
  const plain = await call(users.student, '/api/messages', {
    method: 'POST', body: JSON.stringify({ recipientId: users.staff.id, body: 'Hello' })
  });
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  assert.equal(plain.body.dm.attachment, null);

  const form = new FormData();
  form.append('recipientId', users.staff.id);
  form.append('body', 'Please check my manuscript.');
  form.append('relatedSubmissionId', paper.id);
  form.append('attachment', pdf, 'manuscript.pdf');
  const sent = await call(users.student, '/api/messages', { method: 'POST', body: form });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal(sent.body.dm.related.title, paper.title);
  assert.equal(sent.body.dm.related.url, `/research-submission-detail.html?id=${paper.id}`);
  assert.equal(sent.body.dm.attachment.name, 'manuscript.pdf');

  // A file alone is a message too. (Sent to someone else, so it is the only
  // message in that conversation: createdAt has one-second precision, so
  // messages sent within the same second have no defined order.)
  const fileOnly = new FormData();
  fileOnly.append('recipientId', users.admin.id);
  fileOnly.append('attachment', pdf, 'only-a-file.pdf');
  assert.equal((await call(users.student, '/api/messages', { method: 'POST', body: fileOnly })).status, 201);

  const thread = await call(users.staff, `/api/messages/${users.student.id}`);
  const withFile = thread.body.messages.find(m => m.attachment && m.attachment.name === 'manuscript.pdf');
  assert.ok(withFile, 'the recipient sees the attachment');
  assert.equal(withFile.related.id, paper.id);
  const inbox = await call(users.admin, '/api/messages');
  assert.equal(inbox.body.conversations.find(c => c.otherId === users.student.id).lastMessage, 'Attachment: only-a-file.pdf');

  const asRecipient = await call(users.staff, withFile.attachment.url);
  assert.equal(asRecipient.status, 200);
  assert.equal(asRecipient.text, '%PDF-1.4 message attachment');
  assert.equal((await call(users.student, withFile.attachment.url)).status, 200, 'the sender can open it too');
  assert.equal((await call(users.other, withFile.attachment.url)).status, 403, 'nobody else can');

  const contacts = await call(users.student, '/api/messages/contacts');
  assert.ok(contacts.body.contacts.every(c => 'program' in c && 'department' in c));
});

test('messages refuse research the sender cannot open and files that are not PDF or Word', opts, async () => {
  const someoneElses = await addModule('not-mine', {
    owner_id: users.other.id, owner_name: 'other', title: `${PREFIX}Someone else's paper`
  });
  const notMine = await call(users.student, '/api/messages', {
    method: 'POST', body: JSON.stringify({ recipientId: users.staff.id, body: 'x', relatedSubmissionId: someoneElses.id })
  });
  assert.equal(notMine.status, 400);
  assert.match(notMine.body.error, /only link research you can open/);

  const exe = new FormData();
  exe.append('recipientId', users.staff.id);
  exe.append('body', 'see attached');
  exe.append('attachment', new Blob(['MZ not a pdf'], { type: 'application/pdf' }), 'virus.pdf');
  const refused = await call(users.student, '/api/messages', { method: 'POST', body: exe });
  assert.equal(refused.status, 400, 'the file signature is checked, not just the name');

  const empty = await call(users.student, '/api/messages', { method: 'POST', body: JSON.stringify({ recipientId: users.staff.id, body: '' }) });
  assert.equal(empty.status, 400);
});
