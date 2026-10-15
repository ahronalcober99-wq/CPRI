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
  SETUP_ROLES,
  PRIVILEGED_ROLES,
  RBAC_PERMISSIONS,
  ROLE_PROFILE_FIELDS,
  ensureUsersSchema,
  authRouter,
  // The role → landing-page map and the user shape that ships it to the
  // browser as `user.home` (login.html and the Google bridge follow it).
  homePageForRole,
  publicUser
} from '../auth.js';
import pool from '../db.js';
import { notificationsRouter } from '../notifications.js';
import { DM_ROLES } from '../messages.js';
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

test('every registered role has its own landing page — none falls back to the account page', () => {
  // homePageForRole() is the single source of truth for where a person goes
  // after signing in; publicUser() ships it as `user.home` so login.html and
  // the Google bridge in main.js follow the same map instead of keeping their
  // own copies (they did, and they drifted). A tenth role added to ROLES
  // without an entry here would silently land its users on account.html.
  const expected = {
    admin: '/admin-dashboard.html',
    cpri_staff: '/staff-dashboard.html',
    ethics_reviewer: '/ethics.html',
    adviser: '/facilitator-dashboard.html',
    presenter: '/presenter-dashboard.html',
    public_visitor: '/index.html',
    student_researcher: '/my-submissions.html',
    faculty_researcher: '/my-submissions.html',
    non_teaching_researcher: '/my-submissions.html'
  };

  for (const role of ROLES) {
    assert.ok(expected[role], `${role} has an explicit entry in the landing map`);
    assert.equal(homePageForRole(role), expected[role], `${role} lands on its own page`);
    assert.notEqual(homePageForRole(role), '/account.html',
      `${role} must not fall back to the account page`);
  }

  // publicUser() is what the browser actually reads — keep it in lockstep.
  for (const role of ROLES) {
    const pub = publicUser({
      id: 1, username: 'u', email: 'u@example.org', fullName: 'U',
      role, status: 'active'
    });
    assert.equal(pub.home, homePageForRole(role), `publicUser().home matches homePageForRole for ${role}`);
  }

  // account.html stays the safety net for a stored role ROLES does not know.
  assert.equal(homePageForRole('retired_role'), '/account.html');
});

test('profile setup can only ever choose one of the five self-selectable account types', () => {
  // PUT /api/auth/profile/setup is what complete-profile.html posts to; this
  // allow-list is the only thing standing between a crafted request and a
  // `role=admin` reaching the users table.
  assert.deepEqual(
    [...SETUP_ROLES].sort(),
    ['adviser', 'faculty_researcher', 'non_teaching_researcher', 'presenter', 'student_researcher'],
    'exactly the five cards on the Account Type list'
  );
  for (const role of ['admin', 'cpri_staff', 'ethics_reviewer']) {
    assert.ok(!SETUP_ROLES.includes(role), `${role} must not be self-selectable`);
    assert.ok(PRIVILEGED_ROLES.includes(role), `${role} is refused by the setup endpoint`);
  }
  // Each option the page offers has to be a registered role with a real label,
  // or the card and the admin dropdown would disagree on what it is called.
  for (const role of SETUP_ROLES) {
    assert.ok(ROLES.includes(role), `${role} is registered in ROLES`);
    assert.ok(ROLE_META[role], `${role} has ROLE_META`);
    assert.ok(String(ROLE_META[role].label || '').trim(), `${role} has a display label`);
  }
});

// ---------------------------------------------------------------
//  PUT /api/auth/profile/setup — the endpoint complete-profile.html posts to.
//
//  The REAL router is mounted in a real Express app and driven over HTTP; only
//  the singleton MySQL pool is stubbed. Tests never load .env, so an
//  unstubbed query would try localhost:3306 and fail loudly instead of
//  reaching a production database.
// ---------------------------------------------------------------
test('profile/setup refuses a crafted role, cannot be replayed, and never downgrades', async () => {
  const users = new Map();
  const sql = [];
  const realQuery = pool.query;

  async function fakeQuery(query, params = []) {
    const q = String(query).replace(/\s+/g, ' ').trim();
    sql.push(q);
    if (/^SELECT \* FROM users WHERE id = \?$/i.test(q)) {
      const row = users.get(params[0]);
      return [row ? [{ ...row }] : []];
    }
    if (/^SELECT user_prefs FROM users WHERE id = \?$/i.test(q)) {
      const row = users.get(params[0]);
      return [row ? [{ id: row.id, user_prefs: row.user_prefs }] : []];
    }
    // No active admin → no notification fan-out during the happy path.
    if (/^SELECT id FROM users WHERE role = 'admin' AND status = 'active'$/i.test(q)) return [[]];
    const upd = q.match(/^UPDATE users SET (.+) WHERE id = \?$/i);
    if (upd) {
      const cols = upd[1].split(',').map(part => part.trim().split(/\s+/)[0]);
      const row = users.get(params[params.length - 1]);
      if (row) cols.forEach((col, i) => { row[col] = params[i]; });
      return [{ affectedRows: row ? 1 : 0 }];
    }
    if (/^INSERT INTO notifications/i.test(q)) return [{ insertId: 1 }];
    throw new Error('unhandled SQL in profile/setup test: ' + q);
  }

  const app = express();
  app.use(express.json());
  let sessionUserId = null;
  app.use((req, _res, next) => { req.session = sessionUserId ? { userId: sessionUserId } : {}; next(); });
  app.use('/api/auth', authRouter);

  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.unref();
  });
  const put = async (body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/profile/setup`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const seed = (id, over = {}) => {
    const row = {
      id, username: id, email: `${id}@test.invalid`, fullName: id,
      role: 'student_researcher', status: 'active', setupPending: 1,
      department: '', user_prefs: null, researches: null,
      ...over
    };
    users.set(id, row);
    return row;
  };

  pool.query = fakeQuery;
  try {
    // (1) A crafted privileged role is refused before a single query runs.
    const newbie = seed('u-new');
    sessionUserId = newbie.id;
    sql.length = 0;
    for (const bad of ['admin', 'cpri_staff', 'ethics_reviewer', 'public_visitor', 'superuser']) {
      const out = await put({ role: bad });
      assert.equal(out.status, 400, `role=${bad} must be rejected with 400`);
      assert.equal(users.get(newbie.id).role, 'student_researcher',
        `role=${bad} must not change the stored role`);
    }
    assert.deepEqual(sql, [], 'a refused role never reaches the database');

    // (2) Once setup is complete the endpoint is closed for that account.
    const done = seed('u-done', { role: 'faculty_researcher', setupPending: 0 });
    sessionUserId = done.id;
    const replay = await put({ role: 'presenter' });
    assert.equal(replay.status, 403, 'profile setup runs once');
    assert.equal(users.get(done.id).role, 'faculty_researcher',
      'revisiting complete-profile.html cannot overwrite an assigned role');

    // (3) Even a stale setupPending cannot downgrade an admin, staff or reviewer.
    for (const privileged of ['admin', 'cpri_staff', 'ethics_reviewer']) {
      const boss = seed(`u-${privileged}`, { role: privileged, setupPending: 1 });
      sessionUserId = boss.id;
      const downgrade = await put({ role: 'student_researcher' });
      assert.equal(downgrade.status, 403, `${privileged} must be refused with 403`);
      assert.equal(users.get(boss.id).role, privileged, `${privileged} is never downgraded`);
    }

    // (4) The happy path: one of the five, saved once, then the door closes.
    sessionUserId = newbie.id;
    const ok = await put({ role: 'presenter', fullName: 'Ada Lovelace', department: 'Library' });
    assert.equal(ok.status, 200, `expected 200, got ${ok.status}: ${JSON.stringify(ok.body)}`);
    assert.equal(users.get(newbie.id).role, 'presenter');
    assert.equal(users.get(newbie.id).setupPending, 0);
    assert.equal(users.get(newbie.id).department, 'Library');
    assert.equal(users.get(newbie.id).fullName, 'Ada Lovelace');
    // The label must come from ROLE_META (not a raw slug fallback), and it is
    // pinned here so a rename has to be a deliberate edit.
    assert.equal(ok.body.profile.roleLabel, ROLE_META.presenter.label);
    assert.equal(ok.body.profile.roleLabel, 'Presenter');
    assert.equal((await put({ role: 'admin' })).status, 400, 'a completed profile stays closed');
    assert.equal(users.get(newbie.id).role, 'presenter');
  } finally {
    pool.query = realQuery;
    await new Promise(resolve => server.close(resolve)).catch(() => {});
  }
});

// ---------------------------------------------------------------
//  The bell's role pill must never disagree with the account page. Both files
//  keep their OWN copy of the labels, which is exactly how they drifted apart
//  before: notifications.js missed non_teaching_researcher and presenter
//  entirely, so those pills rendered a raw slug.
// ---------------------------------------------------------------
test('the notification pill reports the same role label as the account page for every role', async () => {
  const realQuery = pool.query;
  const rolesByUser = new Map();

  async function fakeQuery(query, params = []) {
    const q = String(query).replace(/\s+/g, ' ').trim();
    if (/^SELECT role FROM users WHERE id = \?$/i.test(q)) {
      const role = rolesByUser.get(params[0]);
      return [role ? [{ role }] : []];
    }
    if (/^SELECT \* FROM notifications WHERE userId = \?/i.test(q)) return [[]];
    if (/^SELECT COUNT\(\*\) AS c FROM notifications/i.test(q)) return [[{ c: 0 }]];
    throw new Error('unhandled SQL in notification label test: ' + q);
  }

  const app = express();
  app.use((req, _res, next) => { req.session = { userId: 'u-1' }; next(); });
  app.use('/api', notificationsRouter);

  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.unref();
  });

  pool.query = fakeQuery;
  try {
    for (const role of ROLES) {
      rolesByUser.set('u-1', role);
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/notifications`);
      assert.equal(res.status, 200, `${role}: notification endpoint answers`);
      const out = await res.json();
      assert.equal(out.roleLabel, ROLE_META[role].label,
        `${role} pill label must equal the account page label`);
      assert.ok(!out.roleLabel.includes('_'), `${role} must not render as a raw slug`);
    }
  } finally {
    pool.query = realQuery;
    await new Promise(resolve => server.close(resolve)).catch(() => {});
  }
});

test('every registered role can use direct messaging, so the Messages link never 403s', () => {
  // The navbar pushes a Messages entry for all 9 roles; DM_ROLES is what the
  // server actually allows. It predates non_teaching_researcher and presenter,
  // so those two were reachable by nav but refused with a 403.
  for (const role of ROLES) {
    assert.ok(DM_ROLES.includes(role), `${role} may send and receive DMs`);
  }
  for (const role of DM_ROLES) {
    assert.ok(ROLES.includes(role), `DM role ${role} is a registered role`);
  }
});

test('every registered role has a display label, and every label belongs to a registered role', () => {
  for (const role of ROLES) {
    assert.ok(ROLE_META[role], `${role} has ROLE_META`);
    assert.ok(String(ROLE_META[role].label || '').trim(), `${role} has a non-empty label`);
  }
  for (const role of Object.keys(ROLE_META)) {
    assert.ok(ROLES.includes(role), `ROLE_META.${role} is a registered role`);
  }
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
