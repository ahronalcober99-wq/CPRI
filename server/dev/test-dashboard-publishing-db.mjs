// ============================================================
//  CPRI — admin dashboard, repository publishing and recommendations,
//  against a real database
//
//  Drives the REAL routers (classic submissions, Research Submission Module,
//  repository, admin dashboard) over HTTP with real SQL. Proves:
//
//   1. The dashboard counts submissions from both forms, once each, without
//      drafts — in its totals, its status chart and its record lists — and
//      the Recent Submissions table says which ones are in the repository.
//   2. Approval publishes to the repository + Publications page (classic form
//      and Final Submissions alike); a later rejection hides it again.
//   3. An admin can publish anything else by hand; nobody else can, and
//      drafts / rejected work cannot be published.
//   4. Recommendations are served for repository entries and submissions.
//
//  SAFETY: this suite writes rows. It refuses to run unless the database is on
//  this machine (localhost / 127.0.0.1 / ::1), so it can never touch a hosted
//  database by accident. Point it at a throwaway one, e.g.
//
//    DB_HOST=127.0.0.1 DB_PORT=3399 DB_USER=root DB_PASSWORD= \
//    DB_NAME=cpri_throwaway DB_SSL_MODE=disable npm run test:dashboard-publishing:db
//
//  Every row it creates carries the run's id prefix and is removed afterwards.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import bcrypt from 'bcryptjs';

import { describeDbTarget } from '../db.js';
import { all, get, insert, run } from '../server/db/queries.js';

// ---- Only ever a local database -------------------------------------------
const target = describeDbTarget();
const host = String(target.host || '').toLowerCase().replace(/^\[|\]$/g, '');
let skip = ['localhost', '127.0.0.1', '::1'].includes(host)
  ? false
  : `DB_HOST is "${target.host}", not a local database — this suite writes rows, so it only runs against a local throwaway database`;

if (!skip) {
  try {
    await all('SELECT 1 AS ok');
  } catch (err) {
    skip = `database unreachable (${err.message})`;
  }
}
if (skip) console.warn(`[dashboard-publishing db test] SKIPPED: ${skip}`);
const opts = skip ? { skip } : {};

// Imported only once the target is known to be safe: these routers use the
// same pool and would otherwise connect on import of their schema helpers.
const { submissionsRouter } = await import('../submissions.js');
const { createResearchSubmissionsRouter, ensureResearchSubmissionsSchema } = await import('../research-submissions.js');
const { repositoryRouter } = await import('../repository.js');
const { adminDashboardRouter } = await import('../admin-dashboard.js');

const PREFIX = `dpt-${Date.now().toString(36)}-`;
const ids = (name) => `${PREFIX}${name}`;
// Keywords and a department unique to this run, so whatever else is in the
// database can never change the recommendation ranking asserted below.
const KW = `${PREFIX}mangroves`;
const DEPT = `${PREFIX}Biology`;
const users = {};
let server;
let base;

async function makeUser(key, role) {
  const id = ids(key);
  await insert('users', {
    id,
    username: `${PREFIX}${key}`.slice(0, 40),
    email: `${PREFIX}${key}@dashboard-test.local`,
    fullName: `${key} (dashboard test)`,
    role,
    passwordHash: await bcrypt.hash('not-a-real-password', 4),
    status: 'active'
  });
  users[key] = { id, role };
}

async function call(user, path, init = {}) {
  const res = await fetch(base + path, {
    ...init,
    headers: {
      ...(user ? { 'x-test-user': user.id } : {}),
      ...(init.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {})
    }
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

const patchStatus = (user, path, status) =>
  call(user, path, { method: 'PATCH', body: JSON.stringify({ status }) });

function classicSubmission(name, fields = {}) {
  return {
    id: ids(name),
    submitterId: users.student.id,
    submitterName: 'student (dashboard test)',
    title: `Classic ${name}`,
    authors: 'C. Author',
    program: DEPT,
    researchType: 'student_thesis',
    abstract: 'Classic abstract.',
    keywords: `${KW}, coastal erosion`,
    schoolYear: '2025-2026',
    status: 'submitted',
    statusHistory: JSON.stringify([]),
    files: JSON.stringify({}),
    createdAt: '2026-09-01 08:00:00',
    updatedAt: '2026-09-01 08:00:00',
    ...fields
  };
}

function moduleSubmission(name, fields = {}) {
  return {
    id: ids(name),
    owner_id: users.student.id,
    owner_name: 'student (dashboard test)',
    owner_role: 'student_researcher',
    stage: 'final',
    title: `Module ${name}`,
    authors: 'M. Author',
    program: DEPT,
    category: 'Life Sciences',
    research_type: 'student_thesis',
    school_year: '2025-2026',
    semester: '1st',
    abstract: 'Module abstract.',
    keywords: `${KW}, carbon`,
    status: 'submitted',
    created_at: '2026-09-02 08:00:00',
    updated_at: '2026-09-02 08:00:00',
    ...fields
  };
}

const submissionIds = () => Object.values(created).flat();
const created = { classic: [], module: [] };

async function addClassic(name, fields) {
  const row = classicSubmission(name, fields);
  await insert('submissions', row);
  created.classic.push(row.id);
  return row;
}

async function addModule(name, fields) {
  const row = moduleSubmission(name, fields);
  await insert('research_submissions', row);
  created.module.push(row.id);
  return row;
}

const publicRepoFor = async (sourceId) =>
  get("SELECT * FROM repository WHERE sourceSubmissionId = ? AND status IN ('approved', 'published')", [sourceId]);
const publicationFor = async (sourceId) =>
  get('SELECT * FROM publications WHERE sourceSubmissionId = ?', [sourceId]);

// ===========================================================================
test.before(async () => {
  if (skip) return;
  await ensureResearchSubmissionsSchema();

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const id = req.headers['x-test-user'];
    req.session = id ? { userId: id } : {};
    next();
  });
  app.use('/api/submissions', submissionsRouter);
  app.use('/api/research-submissions', createResearchSubmissionsRouter());
  app.use('/api/repository', repositoryRouter);
  app.use('/api/admin', adminDashboardRouter);

  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  server.unref();
  base = `http://127.0.0.1:${server.address().port}`;

  await makeUser('admin', 'admin');
  await makeUser('staff', 'cpri_staff');
  await makeUser('student', 'student_researcher');
});

test.after(async () => {
  if (skip) return;
  const clean = async (sql, params) => {
    try { await run(sql, params); } catch (err) { console.error('[dashboard-publishing db test] cleanup:', err.message); }
  };
  for (const id of submissionIds()) {
    await clean('DELETE FROM publications WHERE sourceSubmissionId = ?', [id]);
    await clean('DELETE FROM repository WHERE sourceSubmissionId = ?', [id]);
    await clean('DELETE FROM research_status_history WHERE submission_id = ?', [id]);
    await clean('DELETE FROM notifications WHERE link LIKE ?', [`%${id}%`]);
  }
  await clean('DELETE FROM repository WHERE id LIKE ?', [`${PREFIX}%`]);
  for (const id of created.classic) await clean('DELETE FROM submissions WHERE id = ?', [id]);
  for (const id of created.module) await clean('DELETE FROM research_submissions WHERE id = ?', [id]);
  await clean('DELETE FROM notifications WHERE userId LIKE ?', [`${PREFIX}%`]);
  await clean('DELETE FROM system_logs WHERE userId LIKE ?', [`${PREFIX}%`]);
  await clean('DELETE FROM users WHERE id LIKE ?', [`${PREFIX}%`]);
  if (server) await new Promise(resolve => server.close(resolve));
  const { default: pool } = await import('../db.js');
  await pool.end().catch(() => {});
});

// ===========================================================================
test('the dashboard counts both forms, once each, without drafts', opts, async () => {
  const before = (await call(users.admin, '/api/admin/dashboard/stats')).body.data;
  const chartBefore = (await call(users.admin, '/api/admin/reports/submissions-status')).body.report;

  await addClassic('c-count');
  await addModule('m-count');
  await addModule('m-draft', { status: 'draft' });
  // Migrated: the same id in both stores; the module copy moved on later.
  await addModule('shared', { status: 'approved', updated_at: '2026-09-20 00:00:00', created_at: '2026-08-01 00:00:00' });
  await addClassic('shared', { status: 'submitted', createdAt: '2026-08-01 00:00:00', updatedAt: '2026-08-01 00:00:00' });

  const stats = await call(users.admin, '/api/admin/dashboard/stats');
  assert.equal(stats.status, 200);
  assert.equal(stats.body.data.submitted - before.submitted, 3, 'classic + module + the shared record once; the draft is not counted');
  assert.equal(stats.body.data.approved - before.approved, 1, 'the shared record counts with its newest status');

  const countOf = (report, status) => (report.find(r => r.status === status) || { count: 0 }).count;
  const chart = (await call(users.admin, '/api/admin/reports/submissions-status')).body.report;
  assert.equal(countOf(chart, 'submitted') - countOf(chartBefore, 'submitted'), 2, 'status chart: two submitted');
  assert.equal(countOf(chart, 'approved') - countOf(chartBefore, 'approved'), 1, 'status chart: one approved');
  assert.equal(countOf(chart, 'draft') - countOf(chartBefore, 'draft'), 0, 'drafts never reach the chart');

  const list = await call(users.admin, '/api/admin/research?limit=100');
  assert.equal(list.body.total, stats.body.data.submitted, 'the card and its list agree');
  const listed = list.body.data.map(r => r.id);
  for (const id of [ids('c-count'), ids('m-count'), ids('shared')]) assert.ok(listed.includes(id), `${id} is listed`);
  assert.equal(listed.filter(id => id === ids('shared')).length, 1, 'listed once');
  assert.ok(!listed.includes(ids('m-draft')));

  const approvedList = await call(users.admin, '/api/admin/research?status=approved&limit=100');
  assert.equal(approvedList.body.total, stats.body.data.approved);
  assert.ok(approvedList.body.data.some(r => r.id === ids('shared')));

  const recent = await call(users.admin, '/api/admin/dashboard/recent-submissions?limit=100');
  assert.equal(recent.status, 200);
  const moduleRow = recent.body.data.find(r => r.id === ids('m-count'));
  assert.equal(moduleRow.source, 'module');
  assert.equal(moduleRow.statusLabel, 'Submitted');
  assert.equal(moduleRow.inRepository, false);
  assert.equal(moduleRow.canPublish, true);
  assert.equal(moduleRow.detailUrl, `/research-submission-detail.html?id=${ids('m-count')}`);
  assert.ok(recent.body.data.some(r => r.id === ids('c-count') && r.source === 'classic'));
  assert.ok(!recent.body.data.some(r => r.id === ids('m-draft')));

  assert.equal((await call(users.student, '/api/admin/dashboard/recent-submissions')).status, 403);
});

test('approving a classic submission publishes it; rejecting it hides it again', opts, async () => {
  const sub = await addClassic('c-approve');
  const path = `/api/submissions/${sub.id}/status`;

  assert.equal((await patchStatus(users.staff, path, 'approved')).status, 200);
  const entry = await publicRepoFor(sub.id);
  assert.ok(entry, 'in the repository');
  assert.equal(entry.title, 'Classic c-approve');
  assert.ok(await publicationFor(sub.id), 'and on the Publications page');

  const anonymousList = await call(null, '/api/repository');
  assert.ok(anonymousList.body.records.some(r => r.id === entry.id), 'the public can see it');
  const recent = await call(users.admin, '/api/admin/dashboard/recent-submissions?limit=100');
  assert.equal(recent.body.data.find(r => r.id === sub.id).inRepository, true);

  assert.equal((await patchStatus(users.staff, path, 'rejected')).status, 200);
  assert.equal(await publicRepoFor(sub.id), null, 'no longer public');
  assert.ok(await get('SELECT id FROM repository WHERE id = ?', [entry.id]), 'but the entry is kept');
  assert.equal(await publicationFor(sub.id), null, 'and off the Publications page');
  const afterReject = await call(null, '/api/repository');
  assert.ok(!afterReject.body.records.some(r => r.id === entry.id));
  assert.equal((await call(null, `/api/repository/${entry.id}`)).status, 404);
});

test('approving a Final Submission publishes it; rejecting it hides it again', opts, async () => {
  const sub = await addModule('m-approve');
  const path = `/api/research-submissions/${sub.id}/status`;

  assert.equal((await patchStatus(users.admin, path, 'under_initial_checking')).status, 200);
  assert.equal(await publicRepoFor(sub.id), null);

  const approved = await patchStatus(users.admin, path, 'approved');
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.repository, 'published');
  const entry = await publicRepoFor(sub.id);
  assert.ok(entry);
  assert.equal(entry.category, 'student_thesis');
  assert.equal(entry.keywords, `${KW}, carbon`);
  const publication = await publicationFor(sub.id);
  assert.equal(publication.status, 'published');
  assert.equal(publication.authorType, 'student');

  const rejected = await patchStatus(users.admin, path, 'rejected');
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  assert.equal(rejected.body.repository, 'hidden');
  assert.equal(await publicRepoFor(sub.id), null);
  assert.equal(await publicationFor(sub.id), null);
});

test('an admin can publish other submissions by hand', opts, async () => {
  const proposal = await addModule('m-manual', { stage: 'initial', status: 'approved' });
  const classic = await addClassic('c-manual', { status: 'under_initial_checking' });
  const draft = await addModule('m-manual-draft', { status: 'draft' });
  const rejected = await addClassic('c-manual-rejected', { status: 'rejected' });
  const publish = (user, id) => call(user, `/api/admin/submissions/${id}/publish`, { method: 'POST' });

  assert.equal((await publish(users.student, proposal.id)).status, 403);
  assert.equal((await publish(users.staff, proposal.id)).status, 403, 'admins only');
  assert.equal((await publish(null, proposal.id)).status, 401);
  assert.equal((await publish(users.admin, ids('does-not-exist'))).status, 404);
  assert.equal((await publish(users.admin, draft.id)).status, 400);
  assert.equal((await publish(users.admin, rejected.id)).status, 400);

  const first = await publish(users.admin, proposal.id);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.ok(await publicRepoFor(proposal.id));
  assert.ok(await publicationFor(proposal.id));
  const again = await publish(users.admin, proposal.id);
  assert.equal(again.body.repositoryId, first.body.repositoryId, 'publishing twice reuses the entry');
  assert.equal((await all('SELECT id FROM repository WHERE sourceSubmissionId = ?', [proposal.id])).length, 1);

  assert.equal((await publish(users.admin, classic.id)).status, 200);
  assert.equal((await publicRepoFor(classic.id)).status, 'approved', 'a pending record is published as approved');

  const recent = await call(users.admin, '/api/admin/dashboard/recent-submissions?limit=100');
  const row = recent.body.data.find(r => r.id === proposal.id);
  assert.equal(row.inRepository, true);
  assert.equal(row.canPublish, false);
});

test('recommended research for repository entries and submissions', opts, async () => {
  // Two public entries sharing a keyword with the submissions above.
  for (const [name, fields] of [
    ['r-match', { keywords: `${KW.toUpperCase()}; tides`, category: `${PREFIX}cat`, department: 'BS IT' }],
    ['r-dept', { keywords: 'robots', category: 'capstone', department: DEPT, yearCompleted: '2099' }],
    ['r-hidden', { keywords: KW, category: 'student_thesis', department: DEPT, status: 'rejected' }]
  ]) {
    await insert('repository', {
      id: ids(name), sourceSubmissionId: null, title: `Repo ${name}`, authors: 'R. Author',
      abstract: '', yearCompleted: '2025', status: 'published', accessLevel: 'public_abstract',
      citation: JSON.stringify({}), createdAt: '2026-09-01 00:00:00', updatedAt: '2026-09-01 00:00:00',
      ...fields
    });
  }

  const forEntry = await call(null, `/api/repository/${ids('r-match')}/recommendations`);
  assert.equal(forEntry.status, 200);
  assert.ok(!forEntry.body.recommendations.some(r => r.id === ids('r-match')), 'never itself');
  assert.ok(!forEntry.body.recommendations.some(r => r.id === ids('r-hidden')), 'never a hidden entry');
  assert.equal((await call(null, `/api/repository/${ids('r-hidden')}/recommendations`)).status, 404,
    'a hidden entry is not probeable through its recommendations');

  // Only this run's keyword and a research type nothing else shares, so
  // nothing outside this suite can match.
  const sub = await addClassic('c-recommend', { researchType: `${PREFIX}type`, keywords: KW });
  const forSubmission = await call(users.student, `/api/submissions/${sub.id}/recommendations`);
  assert.equal(forSubmission.status, 200);
  const recs = forSubmission.body.recommendations;
  const match = recs.find(r => r.id === ids('r-match'));
  assert.ok(match, 'the shared keyword is found');
  assert.deepEqual(match.reasons, [`Shares the keyword "${KW.toUpperCase()}"`], 'matched case-insensitively');
  const dept = recs.find(r => r.id === ids('r-dept'));
  assert.ok(dept);
  assert.ok(recs.indexOf(match) < recs.indexOf(dept), 'a shared keyword ranks above a shared department');
  assert.ok(!recs.some(r => r.id === ids('r-hidden')));
  assert.equal((await call(users.staff, `/api/submissions/${sub.id}/recommendations`)).status, 200, 'reviewers may read it too');
  assert.equal((await call(null, `/api/submissions/${sub.id}/recommendations`)).status, 401);

  const mod = await addModule('m-recommend');
  const forModule = await call(users.student, `/api/research-submissions/${mod.id}/recommendations`);
  assert.equal(forModule.status, 200);
  assert.ok(forModule.body.recommendations.some(r => r.id === ids('r-match')));
});
