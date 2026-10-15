// Tests for the gap-analysis work:
//   • the new roles (Non-Teaching Researcher, Presenter, self-registered CPRI
//     Staff) and their RBAC permissions;
//   • the Research Gala API — ownership, review decisions, event validation,
//     upload safety — over a real Express + multer stack;
//   • the account-approval endpoints' rules;
//   • the generated ethics certificate PDF;
//   • the publication-monitoring schema addition;
//   • the backups API and its retention setting.
//
// Runs offline: every route here takes its data layer through dependency
// injection, so nothing touches MySQL or Supabase.
//
// Run: npm run test:gap
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  ROLES,
  ROLE_META,
  SELF_REGISTER_ROLES,
  RBAC_PERMISSIONS,
  ROLE_PROFILE_FIELDS,
  ensureUsersSchema
} from '../auth.js';
import { createGalaRouter, GALA_STATUS, ensureGalaSchema } from '../gala.js';
import { createBackupsRouter } from '../backups.js';
import { keepCount, dumpDatabase, ensureBackupSchema } from '../lib/backup-service.js';
import { ensurePublicationSchema } from '../publications.js';
import { createPdf } from '../lib/pdf.js';

// ---------------------------------------------------------------
// Roles and RBAC
// ---------------------------------------------------------------
test('the new roles are registered with a label, a description and permissions', () => {
  for (const role of ['non_teaching_researcher', 'presenter']) {
    assert.ok(ROLES.includes(role), `${role} is in ROLES`);
    assert.ok(ROLE_META[role], `${role} has ROLE_META`);
    assert.ok(ROLE_META[role].label, `${role} has a human-readable label`);
    assert.ok(Array.isArray(RBAC_PERMISSIONS[role]), `${role} has a permission list`);
  }
  assert.equal(ROLE_META.non_teaching_researcher.label, 'Non-Teaching Researcher');
  assert.equal(ROLE_META.presenter.label, 'Presenter');
});

test('Research Adviser / Facilitator is the Adviser role relabelled, not a duplicate role', () => {
  // The proposal's "Target Users of the System" table lists ONE role for
  // "Research Advisers or Facilitators", and the portal already had `adviser`.
  // Relabelling it keeps every existing row and every role === 'adviser' check
  // working, so no data migration was needed.
  assert.equal(ROLE_META.adviser.label, 'Research Adviser / Facilitator');
  assert.ok(ROLES.includes('adviser'));
  assert.ok(SELF_REGISTER_ROLES.includes('adviser'));
  assert.ok(!ROLES.includes('facilitator'),
    'facilitator is the research module\'s assignment column, not a second registered role');

  // Monitoring and commenting only — never a review or admin capability.
  const perms = RBAC_PERMISSIONS.adviser;
  assert.ok(perms.includes('monitor_submissions'), 'may monitor student submissions');
  assert.ok(perms.includes('comment_submissions'), 'may leave comments/recommendations');
  assert.ok(!perms.includes('manage_users'), 'never manages users or roles');
  assert.ok(!perms.includes('manage_content'));
  assert.ok(!perms.includes('approve_reviewers'));
  assert.ok(!perms.includes('review_ethics'), 'never does the Ethics Reviewer\'s work');
});

test('Non-Teaching Researcher gets exactly the same permissions as Faculty Researcher', () => {
  // The brief: "Give it the same submission permissions as faculty."
  assert.deepEqual(
    [...RBAC_PERMISSIONS.non_teaching_researcher].sort(),
    [...RBAC_PERMISSIONS.faculty_researcher].sort()
  );
  assert.ok(RBAC_PERMISSIONS.non_teaching_researcher.includes('submit_research'));
});

test('Presenter may submit to the Research Gala', () => {
  assert.ok(RBAC_PERMISSIONS.presenter.includes('submit_gala'));
  assert.ok(RBAC_PERMISSIONS.presenter.includes('view_public'));
});

test('all three new sign-up paths are self-registerable, with staff gated by approval', () => {
  for (const role of ['non_teaching_researcher', 'presenter', 'cpri_staff']) {
    assert.ok(SELF_REGISTER_ROLES.includes(role), `${role} can self-register`);
  }
  // CPRI Staff must not become active on its own — an admin confirms it.
  assert.equal(ROLE_META.cpri_staff.approvable, true);
  assert.equal(ROLE_META.non_teaching_researcher.approvable, false);
  assert.equal(ROLE_META.presenter.approvable, false);
});

test('each new role owns a distinct set of profile fields', () => {
  assert.deepEqual(ROLE_PROFILE_FIELDS.non_teaching_researcher, ['officeUnit', 'position']);
  assert.deepEqual(ROLE_PROFILE_FIELDS.presenter, ['institution', 'nationality']);
});

test('the public role list exposes the new roles to the registration form', () => {
  // /api/auth/rbac returns ROLE_META verbatim; the register page renders the
  // same options, so this is the contract between the two.
  const labels = Object.values(ROLE_META).map(m => m.label);
  assert.ok(labels.includes('Non-Teaching Researcher'));
  assert.ok(labels.includes('Presenter'));
  assert.ok(labels.includes('CPRI Staff'));
});

// ---------------------------------------------------------------
// Research Gala API (real HTTP, injected data layer)
// ---------------------------------------------------------------
const PUBLISHED_EVENT = { id: 'evt-1', title: '2026 Research Gala', dateTime: '2026-11-20' };

// The driver returns JSON columns parsed (gala_submissions declares
// statusHistory/files as JSON), so the fake store does the same on read.
function hydrate(row) {
  if (!row) return row;
  const copy = { ...row };
  for (const key of ['statusHistory', 'files']) {
    if (typeof copy[key] === 'string') {
      try { copy[key] = JSON.parse(copy[key]); } catch { copy[key] = []; }
    }
  }
  return copy;
}

function galaStore(seed = []) {
  const rows = [...seed];
  return {
    rows,
    all: async (sql, params = []) => {
      if (/FROM events_module/.test(sql)) return [PUBLISHED_EVENT];
      if (/FROM gala_submissions/.test(sql)) {
        // GET / uses `userId = ?`; the owner scoping is what we assert on.
        if (/userId = \?/.test(sql)) return rows.filter(r => r.userId === params[0]).map(hydrate);
        return rows.map(hydrate);
      }
      return [];
    },
    get: async (sql, params = []) => {
      if (/FROM events_module/.test(sql)) return params[0] === PUBLISHED_EVENT.id ? PUBLISHED_EVENT : null;
      if (/FROM gala_submissions/.test(sql)) return hydrate(rows.find(r => r.id === params[0])) || null;
      return null;
    },
    insert: async (table, record) => { rows.push({ ...record }); },
    update: async (table, id, changes) => {
      const row = rows.find(r => r.id === id);
      if (row) Object.assign(row, changes);
    },
    remove: async (table, id) => {
      const i = rows.findIndex(r => r.id === id);
      if (i >= 0) rows.splice(i, 1);
    }
  };
}

const PRESENTER = { id: 'u-presenter', role: 'presenter', status: 'active', fullName: 'Pat Presenter', username: 'pat' };
const OTHER = { id: 'u-other', role: 'presenter', status: 'active', fullName: 'Other Person', username: 'other' };
const REVIEWER = { id: 'u-admin', role: 'admin', status: 'active', fullName: 'Site Admin', username: 'admin' };

async function startGalaServer({ user = PRESENTER, store = galaStore(), reviewGate = null, allowAll = true } = {}) {
  const logs = [];
  const app = express();
  app.use(express.json());
  const router = createGalaRouter({
    ...store,
    requireAuth: (req, res, next) => (allowAll ? next() : res.status(401).json({ error: 'Not authenticated.' })),
    caller: async () => user,
    addLog: async (action, details) => { logs.push({ action, details }); },
    reviewGate: reviewGate || ((req, res, next) => next())
  });
  app.use('/api/gala', router);

  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  server.unref();
  return {
    base: `http://127.0.0.1:${server.address().port}/api/gala`,
    store,
    logs,
    close: () => new Promise((resolve, reject) => server.close(e => (e ? reject(e) : resolve())))
  };
}

function multipart({ fields = {}, file = null, fieldName = 'abstractFile' } = {}) {
  const boundary = '----cprigala' + Date.now();
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${file.filename}"\r\n`
      + `Content-Type: ${file.type}\r\n\r\n`
    ));
    parts.push(Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body));
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

const VALID_ENTRY = {
  title: 'Adaptive Learning in Rural Schools',
  authors: 'A. Cruz, M. Reyes',
  abstractText: 'A study of adaptive learning platforms in rural secondary schools.'
};

test('POST /gala requires authentication', async () => {
  const api = await startGalaServer({ allowAll: false });
  const res = await fetch(api.base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 401);
  await api.close();
});

test('POST /gala creates a submitted entry owned by the signed-in presenter', async () => {
  const api = await startGalaServer();
  const form = multipart({ fields: VALID_ENTRY });
  const res = await fetch(api.base, { method: 'POST', headers: { 'content-type': form.contentType }, body: form.body });
  const out = await res.json();
  assert.equal(res.status, 201);
  assert.equal(out.submission.status, 'submitted');
  assert.equal(out.submission.userId, PRESENTER.id, 'owner always comes from the session');
  assert.equal(api.store.rows.length, 1);
  assert.equal(api.logs.at(-1).action, 'gala_submitted');
  await api.close();
});

test('POST /gala rejects a missing required field', async () => {
  const api = await startGalaServer();
  const form = multipart({ fields: { title: 'No abstract' } });
  const res = await fetch(api.base, { method: 'POST', headers: { 'content-type': form.contentType }, body: form.body });
  const out = await res.json();
  assert.equal(res.status, 400);
  assert.match(out.error, /required/i);
  await api.close();
});

test('POST /gala refuses an event id that does not exist', async () => {
  const api = await startGalaServer();
  const form = multipart({ fields: { ...VALID_ENTRY, eventId: 'evt-does-not-exist' } });
  const res = await fetch(api.base, { method: 'POST', headers: { 'content-type': form.contentType }, body: form.body });
  const out = await res.json();
  assert.equal(res.status, 400);
  assert.match(out.error, /does not exist/i);
  await api.close();
});

test('POST /gala accepts a link to a real event from the Events module', async () => {
  const api = await startGalaServer();
  const form = multipart({ fields: { ...VALID_ENTRY, eventId: PUBLISHED_EVENT.id } });
  const res = await fetch(api.base, { method: 'POST', headers: { 'content-type': form.contentType }, body: form.body });
  const out = await res.json();
  assert.equal(res.status, 201);
  assert.equal(out.submission.eventId, PUBLISHED_EVENT.id);
  await api.close();
});

test('POST /gala refuses an unsupported file type through the shared upload guard', async () => {
  const api = await startGalaServer();
  const form = multipart({
    fields: VALID_ENTRY,
    file: { filename: 'payload.svg', type: 'image/svg+xml', body: '<svg/>' }
  });
  const res = await fetch(api.base, { method: 'POST', headers: { 'content-type': form.contentType }, body: form.body });
  const out = await res.json();
  assert.equal(res.status, 400);
  assert.match(out.error, /not allowed/i);
  await api.close();
});

test('GET /gala only lists the presenter their own entries', async () => {
  const store = galaStore([
    { id: 'g1', userId: PRESENTER.id, title: 'Mine', status: 'submitted' },
    { id: 'g2', userId: OTHER.id, title: 'Someone else', status: 'submitted' }
  ]);
  const api = await startGalaServer({ store });
  const res = await fetch(api.base);
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.submissions.length, 1);
  assert.equal(out.submissions[0].id, 'g1');
  await api.close();
});

test('GET /gala shows a reviewer every entry', async () => {
  const store = galaStore([
    { id: 'g1', userId: PRESENTER.id, title: 'Mine', status: 'submitted' },
    { id: 'g2', userId: OTHER.id, title: 'Someone else', status: 'accepted' }
  ]);
  const api = await startGalaServer({ store, user: REVIEWER });
  const res = await fetch(api.base);
  const out = await res.json();
  assert.equal(out.submissions.length, 2);
  assert.equal(out.submissions[0].statusLabel, GALA_STATUS[out.submissions[0].status]);
  await api.close();
});

test('PATCH /gala/:id/status rejects an unknown status', async () => {
  const store = galaStore([{ id: 'g1', userId: PRESENTER.id, title: 'Mine', status: 'submitted' }]);
  const api = await startGalaServer({ store, user: REVIEWER });
  const res = await fetch(`${api.base}/g1/status`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'maybe' })
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /invalid status/i);
  await api.close();
});

test('a reviewer decision records who made it and the status history', async () => {
  const store = galaStore([{ id: 'g1', userId: PRESENTER.id, title: 'Mine', status: 'submitted' }]);
  const api = await startGalaServer({ store, user: REVIEWER });
  const res = await fetch(`${api.base}/g1/status`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'accepted', note: 'Strong dataset' })
  });
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.submission.status, 'accepted');
  assert.equal(out.submission.reviewedBy, REVIEWER.fullName);
  assert.equal(out.submission.reviewNote, 'Strong dataset');
  assert.equal(out.submission.statusHistory.at(-1).status, 'accepted');
  assert.equal(api.logs.at(-1).action, 'gala_reviewed');
  await api.close();
});

test('a presenter cannot withdraw someone else\'s entry', async () => {
  const store = galaStore([{ id: 'g2', userId: OTHER.id, title: 'Not mine', status: 'submitted' }]);
  const api = await startGalaServer({ store, user: PRESENTER });
  const res = await fetch(`${api.base}/g2`, { method: 'DELETE' });
  assert.equal(res.status, 403);
  assert.equal(store.rows.length, 1, 'the entry is untouched');
  await api.close();
});

test('a presenter can withdraw their own open entry, but not a decided one', async () => {
  const store = galaStore([
    { id: 'g1', userId: PRESENTER.id, title: 'Open', status: 'under_review' },
    { id: 'g3', userId: PRESENTER.id, title: 'Decided', status: 'accepted' }
  ]);
  const api = await startGalaServer({ store, user: PRESENTER });
  const decided = await fetch(`${api.base}/g3`, { method: 'DELETE' });
  assert.equal(decided.status, 409);
  const open = await fetch(`${api.base}/g1`, { method: 'DELETE' });
  assert.equal(open.status, 200);
  assert.equal(store.rows.length, 1);
  await api.close();
});

// ---------------------------------------------------------------
// Schema additions
// ---------------------------------------------------------------
test('ensureGalaSchema creates the gala_submissions table with its indexes', async () => {
  const run = [];
  await ensureGalaSchema({ run: async (sql) => run.push(sql) });
  assert.equal(run.length, 1);
  assert.match(run[0], /CREATE TABLE IF NOT EXISTS gala_submissions/);
  assert.match(run[0], /idx_gala_user/);
  assert.match(run[0], /status varchar\(40\) DEFAULT 'submitted'/);
});

test('ensurePublicationSchema adds only the four missing monitoring columns', async () => {
  const run = [];
  await ensurePublicationSchema({
    all: async () => [{ Field: 'id' }, { Field: 'journalOrConference' }, { Field: 'volume' }, { Field: 'doi' }],
    run: async (sql) => run.push(sql)
  });
  assert.deepEqual(
    run.map(sql => sql.match(/ADD COLUMN (\w+)/)[1]),
    ['issn', 'isbn', 'indexing', 'impactFactor']
  );
});

test('ensurePublicationSchema is a no-op once the columns exist', async () => {
  const run = [];
  await ensurePublicationSchema({
    all: async () => [{ Field: 'issn' }, { Field: 'isbn' }, { Field: 'indexing' }, { Field: 'impactFactor' }],
    run: async (sql) => run.push(sql)
  });
  assert.equal(run.length, 0);
});

test('ensureBackupSchema creates the backup index table', async () => {
  const run = [];
  await ensureBackupSchema({ run: async (sql) => run.push(sql) });
  assert.match(run[0], /CREATE TABLE IF NOT EXISTS db_backups/);
});

test('ensureUsersSchema still adds the four role-profile columns for an old database', async () => {
  const run = [];
  await ensureUsersSchema({
    all: async () => [{ Field: 'id' }],
    run: async (sql) => run.push(sql)
  });
  for (const column of ['officeUnit', 'position', 'institution', 'nationality']) {
    assert.ok(run.some(sql => sql.includes(`ADD COLUMN ${column}`)), `adds ${column}`);
  }
});

// ---------------------------------------------------------------
// Ethics certificate PDF
// ---------------------------------------------------------------
test('the certificate PDF is a structurally valid, self-contained PDF', () => {
  const pdf = createPdf({
    title: 'Ethics Clearance CPRI-ERB-2026-ABC123',
    border: { x: 40, y: 60, width: 515, height: 740 },
    lines: [
      { text: 'CERTIFICATE OF ETHICAL CLEARANCE', y: 650, size: 19, bold: true, align: 'center' },
      { text: 'Research Title', y: 540, size: 9, bold: true },
      { text: 'A study of adaptive learning', y: 524, size: 12 }
    ]
  });
  const text = pdf.toString('latin1');
  assert.ok(pdf.length > 500, 'produces a non-trivial file');
  assert.ok(text.startsWith('%PDF-1.4'), 'starts with the PDF header');
  assert.ok(text.trimEnd().endsWith('%%EOF'), 'ends with the EOF marker');
  assert.match(text, /\/Type \/Catalog/);
  assert.match(text, /CERTIFICATE OF ETHICAL CLEARANCE/);
  // The xref must declare exactly the objects the file contains, or readers
  // refuse to open it.
  const size = Number(text.match(/\/Size (\d+)/)[1]);
  const xrefEntries = text.match(/xref\n0 \d+\n([\s\S]*?)trailer/)[1].trim().split('\n').length;
  assert.equal(xrefEntries, size, 'one xref entry per declared object');
  assert.ok(text.includes('startxref'), 'has a startxref offset');
});

test('the certificate PDF escapes the characters that would break a PDF string', () => {
  const pdf = createPdf({ lines: [{ text: "O'Brien (Jr.) \\ Smith \\ Test", y: 100 }] });
  const text = pdf.toString('latin1');
  assert.match(text, /O'Brien \\\(Jr\.\\\)/);
  assert.ok(!/\n[^\\]*\bstream\b[\s\S]*?\)\s*Tj/.test(text.split('stream')[1] || ''), 'no unescaped parens inside the content stream');
});

test('the certificate PDF drops glyphs the standard fonts cannot render', () => {
  const pdf = createPdf({ lines: [{ text: 'José Ñuñez — 日本語 emoji 🎓', y: 100 }] });
  const text = pdf.toString('latin1');
  assert.match(text, /José Ñuñez/);
  assert.ok(!text.includes('日本語'), 'non-Latin scripts are removed, not corrupted');
  assert.ok(!text.includes('🎓'), 'emoji are removed');
});

// ---------------------------------------------------------------
// Backups
// ---------------------------------------------------------------
test('retention defaults to 7 and honours BACKUP_KEEP', () => {
  assert.equal(keepCount({}), 7);
  assert.equal(keepCount({ BACKUP_KEEP: '3' }), 3);
  assert.equal(keepCount({ BACKUP_KEEP: 'nonsense' }), 7);
  assert.equal(keepCount({ BACKUP_KEEP: '0' }), 7, 'a zero/negative keep falls back to the default');
});

test('dumpDatabase captures the schema and every row of every table', async () => {
  const dump = await dumpDatabase({
    all: async (sql) => {
      if (/information_schema\.tables/.test(sql)) return [{ name: 'users' }, { name: 'ethics' }];
      if (/SHOW CREATE TABLE `users`/.test(sql)) return [{ 'Create Table': 'CREATE TABLE `users` (id varchar(36))' }];
      if (/SHOW CREATE TABLE `ethics`/.test(sql)) return [{ 'Create Table': 'CREATE TABLE `ethics` (id varchar(36))' }];
      if (/FROM `users`/.test(sql)) return [{ id: 'u1' }, { id: 'u2' }];
      if (/FROM `ethics`/.test(sql)) return [{ id: 'e1' }];
      return [];
    }
  });
  assert.equal(dump.format, 'cpri-backup/1');
  assert.equal(dump.tables, 2);
  assert.equal(dump.rowCount, 3);
  assert.equal(dump.rows.users.length, 2);
  assert.match(dump.schema.ethics, /CREATE TABLE/);
});

test('the backups API is admin-only and reports the configuration', async () => {
  const created = [];
  const app = express();
  app.use(express.json());
  app.use('/api/admin/backups', createBackupsRouter({
    requireAdmin: (req, res, next) => (req.headers['x-admin'] === 'yes' ? next() : res.status(403).json({ error: 'Admin access required.' })),
    addLog: async () => {},
    ensureBackupSchema: async () => {},
    listBackups: async () => [{ id: 'b1', createdAt: '2026-01-01T00:00:00.000Z', bytes: 2048, tableCount: 12, rowCount: 900, storage: 'supabase', createdBy: 'admin', triggerSource: 'manual' }],
    createBackup: async ({ actor, triggerSource }) => {
      created.push({ actor, triggerSource });
      return { backup: { id: 'b2', bytes: 4096, tableCount: 12, storage: 'supabase' }, pruned: 0 };
    },
    readBackup: async (id) => (id === 'b1'
      ? { record: { id: 'b1', createdAt: '2026-01-01T00:00:00.000Z' }, filename: 'b1.json', buffer: Buffer.from('{"ok":true}') }
      : null)
  }));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  server.unref();
  const base = `http://127.0.0.1:${server.address().port}/api/admin/backups`;

  // Signed out / not an admin.
  assert.equal((await fetch(base)).status, 403);
  assert.equal((await fetch(base, { method: 'POST' })).status, 403);

  const admin = { headers: { 'x-admin': 'yes' } };
  const list = await (await fetch(base, admin)).json();
  assert.equal(list.backups.length, 1);
  assert.equal(list.keep, 7);

  const config = await (await fetch(`${base}/config`, admin)).json();
  assert.equal(typeof config.intervalHours, 'number');
  assert.equal(config.keep, 7);

  const createdRes = await fetch(base, { method: 'POST', ...admin });
  assert.equal(createdRes.status, 201);
  assert.equal(created.length, 1);
  assert.equal(created[0].triggerSource, 'manual');

  const download = await fetch(`${base}/b1/download`, admin);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /attachment; filename="cpri-backup-/);
  assert.equal(await download.text(), '{"ok":true}');

  assert.equal((await fetch(`${base}/nope/download`, admin)).status, 404);
  await new Promise((resolve, reject) => server.close(e => (e ? reject(e) : resolve())));
});
