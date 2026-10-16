// ============================================================
//  CPRI — Research Submission Module integration tests
//
//  Runs offline: the router takes its data layer and its session guard through
//  dependency injection (the same pattern as server/gala.js), so nothing here
//  touches MySQL, TiDB or Supabase. Everything else is real — the router, the
//  multer upload pipeline, the validation, and the HTTP surface — so the
//  assertions prove the shipped code, not a re-implementation.
//
//  Proves:
//   1. A user cannot read, edit, upload to, or download another user's
//      submission, even by changing the ID in the URL.
//   2. A presenter cannot create an initial submission.
//   3. A faculty user cannot upload student-only forms
//      (form_a, form_b, form_d, form_e1, form_e2, form_f, form_g, form_i).
//   4. A client-sent role or owner_id is ignored.
//   5. Invalid status transitions are rejected.
//
//  Run: npm run test:research-submissions
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, readdir, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import {
  createResearchSubmissionsRouter,
  ensureResearchSubmissionsSchema
} from '../research-submissions.js';
import {
  FORM_CONFIG,
  HAS_INITIAL_STAGE,
  REVIEWER_ROLES,
  STATUS_CHANGE_ROLES,
  STUDENT_ONLY_SLOTS,
  WORD_EXTENSIONS
} from '../lib/research-config.js';
import { createSupabaseStorage } from '../storage/supabase-storage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
//  A tiny fake data layer.
//
//  It understands exactly the query shapes this module issues: a single
//  `FROM <table>`, `col = ?` or `col = 'literal'` conditions joined by AND
//  and/or OR, and an optional ORDER BY that the assertions do not depend on.
//
//  The OR matters: GET /api/research-submissions asks for the caller's own
//  records (any spelling of their id, email or username) in one query for a
//  researcher; a monitoring role gets every row and the classic store on top,
//  which the assertions below cover.
// ---------------------------------------------------------------------------
function whereMatcher(sql) {
  const afterWhere = sql.split(/\bWHERE\b/i)[1];
  if (!afterWhere) return { test: () => true };
  const clause = afterWhere.split(/\bORDER BY\b/i)[0];

  // OR binds loosest, so each disjunct is a group of AND-ed terms. Parameter
  // positions are assigned up front, in query order, so a disjunct that fails
  // still consumes the right number of `?`s for the ones after it.
  let paramIndex = 0;
  const groups = clause.split(/\bOR\b/i).map(disjunct =>
    disjunct
      .split(/\bAND\b/i)
      .map(term => {
        const m = term.match(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\?|'([^']*)')/);
        if (!m) return null;
        if (m[2] === '?') return { col: m[1], param: paramIndex++ };
        return { col: m[1], value: m[3] };
      })
      .filter(Boolean)
  );

  return {
    test: (row, params) => groups.some(terms => terms.every(term => {
      const expected = term.param === undefined ? term.value : params[term.param];
      const actual = row[term.col];
      return String(actual == null ? '' : actual) === String(expected == null ? '' : expected);
    }))
  };
}

function tableName(sql) {
  const m = sql.match(/\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)/i);
  return m ? m[1] : null;
}

function fakeStore() {
  const tables = new Map();

  const rowsOf = (name) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  };

  const select = (sql, params = []) => {
    const table = tableName(sql);
    if (!table || !tables.has(table)) return [];
    const matcher = whereMatcher(sql);
    return rowsOf(table).filter(row => matcher.test(row, params));
  };

  return {
    tables,
    rowsOf,
    all: async (sql, params = []) => select(sql, params).map(r => ({ ...r })),
    get: async (sql, params = []) => {
      const [row] = select(sql, params);
      return row ? { ...row } : null;
    },
    insert: async (table, record) => {
      rowsOf(table).push({ ...record });
    },
    update: async (table, id, changes) => {
      const row = rowsOf(table).find(r => r.id === id);
      if (row) Object.assign(row, changes);
    },
    remove: async (table, id) => {
      const rows = rowsOf(table);
      const i = rows.findIndex(r => r.id === id);
      if (i >= 0) rows.splice(i, 1);
    }
  };
}

// ---------------------------------------------------------------------------
//  Server harness.
//
//  `x-test-user` stands in for the session cookie: the fake guard writes the
//  id into req.session.userId, and the module then looks the account up in the
//  users table — so the role always comes from the session, never from the
//  request body. That is exactly the production contract.
// ---------------------------------------------------------------------------
const ACCOUNTS = new Map();

function account(role, overrides = {}) {
  const user = {
    id: `u-${role}-${randomUUID().slice(0, 8)}`,
    username: `${role}-${randomUUID().slice(0, 6)}`,
    fullName: `${role} person`,
    role,
    status: 'active',
    ...overrides
  };
  ACCOUNTS.set(user.id, user);
  return user;
}

async function startModule({ uploadDir, notify, sendEmail, storage } = {}) {
  const store = fakeStore();
  const inApp = [];
  const emails = [];
  const dir = uploadDir || await mkdtemp(join(tmpdir(), 'research-subs-'));
  const app = express();
  app.use(express.json());
  // express-session runs app-wide in production, so the session (and the
  // session-backed identity) exists before any route middleware. The header
  // stands in for the session cookie.
  app.use((req, res, next) => {
    const id = req.headers['x-test-user'];
    req.session = id ? { userId: id } : {};
    next();
  });
  app.use(
    '/api/research-submissions',
    createResearchSubmissionsRouter({
      ...store,
      uploadDir: dir,
      // Lets a test point the module at Supabase Storage (a fake fetch stands in
      // for the bucket). Omitted by every other test, which then exercises the
      // local-disk backend — the one a deployment without Supabase uses.
      ...(storage ? { storage } : {}),
      requireAuth: (req, res, next) => {
        if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated.' });
        next();
      },
      caller: async (req) => {
        const user = ACCOUNTS.get(req.session?.userId);
        if (!user || user.status === 'disabled') return null;
        return user;
      },
      // Notification spies: the in-app writer is the site's notify(), the
      // email writer is its mailer. Recorded so the tests can assert on them.
      notify: notify || (async (...args) => { inApp.push(args); }),
      sendEmail: sendEmail || (async (...args) => { emails.push(args); })
    })
  );

  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  server.unref();

  const base = `http://127.0.0.1:${server.address().port}/api/research-submissions`;

  const call = (as, path, init = {}) => fetch(base + path, {
    ...init,
    headers: {
      ...(as ? { 'x-test-user': as.id } : {}),
      ...(init.headers || {})
    }
  });

  const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });

  return {
    store,
    uploadDir: dir,
    inApp,
    emails,
    call,
    json,
    close: () => new Promise((resolve, reject) => server.close(e => (e ? reject(e) : resolve()))),
    cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => {})
  };
}

// ---- Upload helpers --------------------------------------------------------
const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function uploadForm(files = {}, fields = {}) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, String(value));
  for (const [slot, { name, body, type }] of Object.entries(files)) {
    form.append(slot, new Blob([body], { type }), name);
  }
  return form;
}

const pdf = (name = 'doc.pdf', body = 'pdf-bytes') => ({ name, body, type: PDF });
const docx = (name = 'doc.docx', body = 'docx-bytes') => ({ name, body, type: DOCX });

// ---- Fixture: a complete student initial submission -----------------------
const STUDENT_INITIAL_FORM = {
  stage: 'initial',
  title: 'Working title',
  authors: 'A. Author',
  program: 'BS Biology',
  category: 'Life Sciences',
  research_type: 'student_thesis',
  school_year: '2026-2027',
  semester: '1st',
  adviser: 'Dr. Adviser',
  facilitator: 'Ms. Facilitator'
};

const STUDENT_INITIAL_FILES = {
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

async function createStudentInitial(module, student) {
  const res = await module.call(student, '/', {
    method: 'POST',
    body: uploadForm(STUDENT_INITIAL_FILES, STUDENT_INITIAL_FORM)
  });
  const payload = await res.json();
  assert.equal(res.status, 201, `expected the fixture to be created: ${JSON.stringify(payload)}`);
  return payload.submission;
}

// ===========================================================================
//  /form-config — the shared config is the only source of the form
// ===========================================================================
test('form-config renders only the stages a role may use', async () => {
  const module = await startModule();
  try {
    const student = account('student_researcher');
    const presenter = account('presenter');
    const faculty = account('non_teaching_researcher');
    const staff = account('cpri_staff');

    const studentCfg = await module.json(await module.call(student, '/form-config'));
    assert.equal(studentCfg.status, 200);
    assert.deepEqual(studentCfg.body.stages.map(s => s.stage), ['initial', 'final']);

    const presenterCfg = await module.json(await module.call(presenter, '/form-config'));
    assert.deepEqual(presenterCfg.body.stages.map(s => s.stage), ['final'],
      'a presenter must never see an Initial tab');

    const facultyCfg = await module.json(await module.call(faculty, '/form-config'));
    assert.deepEqual(facultyCfg.body.stages.map(s => s.stage), ['initial', 'final']);
    const facultySlots = facultyCfg.body.stages.flatMap(s => s.slots.map(f => f.slot_key));
    for (const slot of STUDENT_ONLY_SLOTS) {
      assert.ok(!facultySlots.includes(slot), `faculty must not be offered ${slot}`);
    }

    const staffCfg = await module.json(await module.call(staff, '/form-config'));
    assert.equal(staffCfg.status, 403, 'staff accounts do not submit research');
  } finally {
    await module.close();
    await module.cleanup();
  }
});

test('the student initial slot list matches the brief exactly', () => {
  const slots = FORM_CONFIG.student_researcher.initial.slots;
  const required = slots.filter(s => s.required && !s.conditional).map(s => s.slot_key).sort();
  assert.deepEqual(required, [
    'defense_photos', 'form_a', 'form_b', 'form_d', 'form_e1', 'form_f',
    'manuscript_docx', 'manuscript_pdf', 'official_receipt'
  ]);
  const conditionalRequired = slots.filter(s => s.required && s.conditional).map(s => s.slot_key).sort();
  assert.deepEqual(conditionalRequired, ['form_g'],
    'form_g is the only file required on a condition (adviser changed)');
  const optional = slots.filter(s => !s.required).map(s => s.slot_key).sort();
  assert.deepEqual(optional, ['additional_documents', 'adviser_eval'],
    'the adviser evaluation is a Google Form link, so its file slot is an optional copy');
  const conditional = slots.filter(s => s.conditional).map(s => s.slot_key).sort();
  assert.deepEqual(conditional, ['form_g'],
    'form_g (adviser changed) is the only conditional file slot');
  assert.ok(WORD_EXTENSIONS.has('.doc') && WORD_EXTENSIONS.has('.docx'));
});

test('Word slots accept .doc/.docx and PDF slots accept only .pdf', () => {
  const slots = FORM_CONFIG.student_researcher.initial.slots;
  const byKey = Object.fromEntries(slots.map(s => [s.slot_key, s]));
  // A .pdf in the Word slot and a .docx in the PDF slot are both wrong.
  assert.equal(byKey.manuscript_docx.kind, 'word');
  assert.equal(byKey.manuscript_pdf.kind, 'pdf');
  assert.equal(byKey.additional_documents.kind, 'optional');
});

// ===========================================================================
//  1. Cross-user isolation
// ===========================================================================
test('a user cannot read, edit, upload to, or download another user\'s submission', async () => {
  const module = await startModule();
  try {
    const owner = account('student_researcher');
    const stranger = account('student_researcher');

    const submission = await createStudentInitial(module, owner);
    const ownerFile = module.store
      .rowsOf('research_submission_files')
      .find(f => f.submission_id === submission.id);

    // --- read ---
    const read = await module.call(stranger, `/${submission.id}`);
    assert.equal(read.status, 403);
    assert.equal((await read.json()).error, "You don't have access to this submission.");

    // --- edit (the status is Submitted, so the owner could) ---
    const edit = await module.call(stranger, `/${submission.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Hijacked' })
    });
    assert.equal(edit.status, 403);

    // --- upload ---
    const upload = await module.call(stranger, `/${submission.id}/files`, {
      method: 'POST',
      body: uploadForm({ manuscript_pdf: pdf('mine.pdf') })
    });
    assert.equal(upload.status, 403);

    // --- download ---
    const download = await module.call(stranger, `/${submission.id}/files/${ownerFile.id}`);
    assert.equal(download.status, 403);

    // --- versions / comments ---
    assert.equal((await module.call(stranger, `/${submission.id}/versions`)).status, 403);
    const comment = await module.call(stranger, `/${submission.id}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'not mine' })
    });
    assert.equal(comment.status, 403);

    // --- list ---
    // "My Submissions" must be scoped by the server, not by the page filtering
    // whatever it was given: another researcher's own list never contains it.
    const strangerList = await module.json(await module.call(stranger, '/'));
    assert.equal(strangerList.status, 200);
    assert.deepEqual(strangerList.body.submissions, [],
      'a researcher sees an empty list, not someone else\'s row');
    const ownerList = await module.json(await module.call(owner, '/'));
    assert.deepEqual(ownerList.body.submissions.map(s => s.id), [submission.id]);

    // The owner still sees everything.
    assert.equal((await module.call(owner, `/${submission.id}`)).status, 200);

    // Nothing the stranger tried changed the row.
    const stored = module.store.rowsOf('research_submissions').find(r => r.id === submission.id);
    assert.equal(stored.title, 'Working title');
  } finally {
    await module.close();
    await module.cleanup();
  }
});

test('an unauthenticated request is refused with 401, not 403 or 404', async () => {
  const module = await startModule();
  try {
    const owner = account('student_researcher');
    const submission = await createStudentInitial(module, owner);
    const res = await module.call(null, `/${submission.id}`);
    assert.equal(res.status, 401);
  } finally {
    await module.close();
    await module.cleanup();
  }
});

test('a file id from someone else\'s submission cannot be fetched through your own', async () => {
  const module = await startModule();
  try {
    const a = account('student_researcher');
    const b = account('student_researcher');
    const subA = await createStudentInitial(module, a);
    const subB = await createStudentInitial(module, b);

    const fileOfB = module.store
      .rowsOf('research_submission_files')
      .find(f => f.submission_id === subB.id);

    // A owns subA, so the ownership check passes, but the file belongs to subB.
    const res = await module.call(a, `/${subA.id}/files/${fileOfB.id}`);
    assert.equal(res.status, 404, 'the file must be looked up within the submission in the URL');
  } finally {
    await module.close();
    await module.cleanup();
  }
});

// ===========================================================================
//  2. A presenter cannot create an initial submission
// ===========================================================================
test('a presenter cannot create an initial submission', async () => {
  const module = await startModule();
  try {
    const presenter = account('presenter');
    const res = await module.call(presenter, '/', {
      method: 'POST',
      body: uploadForm(
        { manuscript_pdf: pdf(), manuscript_docx: docx() },
        { ...STUDENT_INITIAL_FORM, stage: 'initial' }
      )
    });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /cannot create initial/i);
    assert.equal(module.store.rowsOf('research_submissions').length, 0);

    // ...and the final stage still works for them.
    const final = await module.call(presenter, '/', {
      method: 'POST',
      body: uploadForm(
        { manuscript_docx: docx(), manuscript_pdf: pdf(), abstract: pdf('abstract.pdf') },
        {
          stage: 'final',
          title: 'Gala paper',
          authors: 'P. Presenter',
          program: 'CPRI',
          category: 'Social Sciences',
          research_type: 'student_thesis',
          school_year: '2026-2027',
          semester: '1st',
          institution: 'CPRI',
          nationality: 'Filipino',
          abstract: 'An abstract.',
          keywords: 'a, b'
        }
      )
    });
    assert.equal(final.status, 201);
  } finally {
    await module.close();
    await module.cleanup();
  }
});

// ===========================================================================
//  3. A faculty user cannot upload student-only forms
// ===========================================================================
test('a faculty user cannot upload student-only forms, but can upload their own', async () => {
  const module = await startModule();
  try {
    for (const role of ['faculty_researcher', 'non_teaching_researcher']) {
      const faculty = account(role);
      const created = await module.call(faculty, '/', {
        method: 'POST',
        body: uploadForm(
          { manuscript_docx: docx(), manuscript_pdf: pdf() },
          {
            stage: 'initial',
            title: 'Faculty work',
            authors: 'F. Faculty',
            program: 'CPRI',
            category: 'Institutional',
            research_type: 'faculty_research',
            school_year: '2026-2027',
            semester: '1st'
          }
        )
      });
      assert.equal(created.status, 201, `${role} can create an initial submission`);
      const submission = (await created.json()).submission;

      for (const slot of STUDENT_ONLY_SLOTS) {
        const res = await module.call(faculty, `/${submission.id}/files`, {
          method: 'POST',
          body: uploadForm({ [slot]: pdf(`${slot}.pdf`) })
        });
        assert.equal(res.status, 403, `${role} must not upload ${slot}`);
      }

      // Their own slot is accepted — and it becomes the next version, since
      // the fixture already uploaded manuscript_pdf once.
      const ok = await module.call(faculty, `/${submission.id}/files`, {
        method: 'POST',
        body: uploadForm({ manuscript_pdf: pdf('faculty-paper.pdf') })
      });
      assert.equal(ok.status, 201);
      assert.equal((await ok.json()).file.version, 2);
    }
  } finally {
    await module.close();
    await module.cleanup();
  }
});

// ===========================================================================
//  4. A client-sent role or owner_id is ignored
// ===========================================================================
test('a client-sent role, owner_id or status is ignored', async () => {
  const module = await startModule();
  try {
    const student = account('student_researcher');
    const victim = account('student_researcher');

    const res = await module.call(student, '/', {
      method: 'POST',
      body: uploadForm(STUDENT_INITIAL_FILES, {
        ...STUDENT_INITIAL_FORM,
        role: 'admin',
        owner_id: victim.id,
        owner_role: 'cpri_staff',
        status: 'approved',
        adviser_id: victim.id
      })
    });
    assert.equal(res.status, 201);

    const row = module.store.rowsOf('research_submissions')[0];
    assert.equal(row.owner_id, student.id, 'owner_id must come from the session');
    assert.equal(row.owner_role, 'student_researcher', 'role must come from the session');
    assert.equal(row.status, 'submitted', 'a new submission always starts at submitted');
    assert.equal(row.adviser_id, 'Dr. Adviser', 'the adviser field is data, not an owner id');

    // The victim cannot see it, and cannot edit it either.
    assert.equal((await module.call(victim, `/${row.id}`)).status, 403);
  } finally {
    await module.close();
    await module.cleanup();
  }
});

test('a status sent on the edit route does not change the status', async () => {
  const module = await startModule();
  try {
    const student = account('student_researcher');
    const submission = await createStudentInitial(module, student);

    const res = await module.call(student, `/${submission.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed', status: 'approved', owner_id: 'someone-else' })
    });
    assert.equal(res.status, 200);

    const row = module.store.rowsOf('research_submissions').find(r => r.id === submission.id);
    assert.equal(row.title, 'Renamed');
    assert.equal(row.status, 'submitted');
    assert.equal(row.owner_id, student.id);
  } finally {
    await module.close();
    await module.cleanup();
  }
});

test('the owner cannot edit once the submission has moved past Submitted', async () => {
  const module = await startModule();
  try {
    const student = account('student_researcher');
    const staff = account('cpri_staff');
    const submission = await createStudentInitial(module, student);

    await module.call(staff, `/${submission.id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'under_initial_checking' })
    });

    const res = await module.call(student, `/${submission.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Too late' })
    });
    assert.equal(res.status, 403);
  } finally {
    await module.close();
    await module.cleanup();
  }
});

// ===========================================================================
//  5. Invalid status transitions are rejected
// ===========================================================================
test('invalid status transitions are rejected and valid ones are recorded', async () => {
  const module = await startModule();
  try {
    const student = account('student_researcher');
    const staff = account('cpri_staff');
    const submission = await createStudentInitial(module, student);

    const patch = (as, status) => module.call(as, `/${submission.id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status })
    });

    // An initial submission can never jump straight to Published or Archived.
    assert.equal((await patch(staff, 'published')).status, 400);
    assert.equal((await patch(staff, 'archived')).status, 400);
    // Nor can it skip the ethics step into Approved from Submitted.
    assert.equal((await patch(staff, 'approved')).status, 400);

    // The researcher cannot move their own submission along.
    assert.equal((await patch(student, 'under_initial_checking')).status, 403);

    // A legitimate step works and lands in status_history.
    const ok = await module.json(await patch(staff, 'under_initial_checking'));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.submission.status, 'under_initial_checking');

    const history = module.store.rowsOf('research_status_history');
    assert.equal(history.length, 2, 'creation + the transition');
    assert.equal(history[1].from_status, 'submitted');
    assert.equal(history[1].to_status, 'under_initial_checking');
    assert.equal(history[1].changed_by, staff.id);

    // Checking -> For Revision, then on to the ethics stage: the ethics stage
    // must actually be reachable, or no student submission could ever get a
    // clearance.
    assert.equal((await patch(staff, 'for_revision')).status, 200);
    assert.equal((await patch(staff, 'under_ethics_review')).status, 200);
    // Approved is reached through the ethics decision, not from checking.
    assert.equal((await patch(staff, 'approved')).status, 400);
    assert.equal((await patch(staff, 'published')).status, 400);

    // Final-stage rules: Published before Approved is refused.
    const finalSub = {
      id: randomUUID(), owner_id: student.id, owner_name: student.fullName,
      owner_role: student.role, stage: 'final', title: 'Final paper', status: 'submitted',
      authors: 'A', program: 'P', category: 'C', research_type: 'student_thesis',
      school_year: '2026-2027', semester: '1st', created_at: '2026-01-01 00:00:00',
      updated_at: '2026-01-01 00:00:00'
    };
    await module.store.insert('research_submissions', finalSub);
    const finalPatch = (status) => module.call(staff, `/${finalSub.id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status })
    });
    assert.equal((await finalPatch('published')).status, 400);
    assert.equal((await finalPatch('under_ethics_review')).status, 400);
    assert.equal((await finalPatch('under_initial_checking')).status, 200);
    assert.equal((await finalPatch('approved')).status, 200);
    assert.equal((await finalPatch('published')).status, 200);
    assert.equal((await finalPatch('archived')).status, 200);
  } finally {
    await module.close();
    await module.cleanup();
  }
});

test('the ethics reviewer only decides on submissions under ethics review', async () => {
  const module = await startModule();
  try {
    const student = account('student_researcher');
    const reviewer = account('ethics_reviewer');
    const staff = account('cpri_staff');
    const submission = await createStudentInitial(module, student);

    const decide = (as, decision) => module.call(as, `/${submission.id}/ethics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision })
    });

    // Not under ethics review yet.
    assert.equal((await decide(reviewer, 'approved')).status, 403);
    // Only an ethics reviewer may decide at all.
    assert.equal((await decide(staff, 'approved')).status, 403);
    // Only "approved" or "rejected" are decisions.
    assert.equal((await decide(reviewer, 'maybe')).status, 403);

    // Walk it to Under Ethics Review, then approve.
    await module.call(staff, `/${submission.id}/status`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'under_initial_checking' })
    });
    const toEthics = await module.call(staff, `/${submission.id}/status`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'under_ethics_review' })
    });
    assert.equal(toEthics.status, 200);

    const approved = await module.json(await decide(reviewer, 'approved'));
    assert.equal(approved.status, 200);
    assert.equal(approved.body.submission.status, 'approved');

    // The clearance is recorded against the reviewer and the submission.
    const clearances = module.store.rowsOf('research_ethics_clearances');
    assert.equal(clearances.length, 1);
    assert.equal(clearances[0].decision, 'approved');
    assert.equal(clearances[0].submission_id, submission.id);
    assert.equal(clearances[0].reviewer_id, reviewer.id);
  } finally {
    await module.close();
    await module.cleanup();
  }
});

test('the resubmission form-config describes the submission, not the caller', async () => {
  const module = await startModule();
  try {
    const student = account('student_researcher');
    const stranger = account('student_researcher');
    const staff = account('cpri_staff');
    const submission = await createStudentInitial(module, student);

    const owner = await module.json(await module.call(student, `/${submission.id}/form-config`));
    assert.equal(owner.status, 200);
    assert.equal(owner.body.stage, 'initial');
    assert.equal(owner.body.ownerRole, 'student_researcher');
    assert.equal(owner.body.canUpload, true);
    assert.ok(owner.body.slots.some(s => s.slot_key === 'form_d' && s.required && !s.conditional));
    assert.ok(owner.body.slots.some(s => s.slot_key === 'form_g' && s.conditional));

    // Someone else's submission is not described to you.
    assert.equal((await module.call(stranger, `/${submission.id}/form-config`)).status, 403);
    // Staff may read it, but cannot resubmit into it.
    const staffView = await module.json(await module.call(staff, `/${submission.id}/form-config`));
    assert.equal(staffView.status, 200);
    assert.equal(staffView.body.canUpload, false);

    // Once it leaves Submitted the owner cannot resubmit either.
    await module.call(staff, `/${submission.id}/status`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'under_initial_checking' })
    });
    const frozen = await module.json(await module.call(student, `/${submission.id}/form-config`));
    assert.equal(frozen.body.canUpload, false);

    // ...and the upload route agrees.
    const upload = await module.call(student, `/${submission.id}/files`, {
      method: 'POST', body: uploadForm({ manuscript_pdf: pdf('late.pdf') })
    });
    assert.equal(upload.status, 403);
  } finally {
    await module.close();
    await module.cleanup();
  }
});

// ===========================================================================
//  Drafts — "Save as draft" stores unfinished work under status 'draft'
// ===========================================================================
test('a draft may be incomplete and is not counted as a submission yet', async () => {
  const module = await startModule();
  try {
    const student = account('student_researcher');

    // Hardly any fields, no files at all: still a valid draft.
    const res = await module.call(student, '/', {
      method: 'POST',
      body: uploadForm({}, { stage: 'initial', title: 'Something I started', as_draft: '1' })
    });
    assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
    const draft = (await res.json()).submission;
    assert.equal(draft.status, 'draft');

    // Submitting the same incomplete content normally is still refused.
    const strict = await module.call(student, '/', {
      method: 'POST',
      body: uploadForm({}, { stage: 'initial', title: 'Something I started' })
    });
    assert.equal(strict.status, 400);

    // The owner can keep working on it...
    const edit = await module.call(student, `/${draft.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ authors: 'A. Author' })
    });
    assert.equal(edit.status, 200);

    // ...and the upload panel counts a draft as editable.
    const cfg = await module.json(await module.call(student, `/${draft.id}/form-config`));
    assert.equal(cfg.body.canUpload, true);

    // Handing it in while it is still incomplete is refused, with the reason.
    const early = await module.call(student, `/${draft.id}/status`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'submitted' })
    });
    assert.equal(early.status, 400);
    const problem = await early.json();
    assert.equal(problem.draftIncomplete, true);
    assert.match(problem.error, /Required field is missing|Required file is missing/);

    // Only the owner can hand in that draft.
    const stranger = account('student_researcher');
    assert.equal((await module.call(stranger, `/${draft.id}/status`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'submitted' })
    })).status, 403);

    // Fill it in and it goes through.
    await module.call(student, `/${draft.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        authors: 'A. Author', program: 'BS Biology', category: 'Life Sciences',
        research_type: 'student_thesis', school_year: '2026-2027', semester: '1st',
        adviser: 'Dr. Adviser', facilitator: 'Ms. Facilitator'
      })
    });
    for (const [slot, file] of Object.entries(STUDENT_INITIAL_FILES)) {
      const up = await module.call(student, `/${draft.id}/files`, {
        method: 'POST', body: uploadForm({ [slot]: file })
      });
      assert.equal(up.status, 201, `${slot} uploads into the draft: ${JSON.stringify(await up.clone().json())}`);
    }

    const handedIn = await module.json(await module.call(student, `/${draft.id}/status`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'submitted' })
    }));
    assert.equal(handedIn.status, 200);
    assert.equal(handedIn.body.submission.status, 'submitted');

    // The move is recorded, and a draft cannot be handed in twice.
    const history = module.store.rowsOf('research_status_history').filter(h => h.submission_id === draft.id);
    assert.deepEqual(history.map(h => h.to_status), ['draft', 'submitted']);
    assert.equal((await module.call(student, `/${draft.id}/status`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'submitted' })
    })).status, 403);
  } finally {
    await module.close();
    await module.cleanup();
  }
});

test('form-config publishes slot tags and the flags they depend on, not functions', async () => {
  const module = await startModule();
  try {
    const student = account('student_researcher');
    const cfg = await module.json(await module.call(student, '/form-config'));

    const slots = cfg.body.stages.find(s => s.stage === 'initial').slots;
    const formG = slots.find(s => s.slot_key === 'form_g');
    assert.equal(formG.conditional, true, 'the flag travels as a boolean');
    assert.equal(formG.condition_key, 'adviser_changed');
    assert.equal(formG.required, true);

    const formD = slots.find(s => s.slot_key === 'form_d');
    assert.equal(formD.conditional, false);
    assert.equal(formD.condition_key, null);

    // The page needs the flags themselves to render the switches.
    assert.deepEqual(cfg.body.conditionalFlags.map(f => f.key), ['adviser_changed', 'end_of_semester']);

    // Nothing in the payload is a function (JSON drops them silently otherwise).
    assert.equal(typeof JSON.parse(JSON.stringify(cfg.body)).stages[0].slots[0].conditional, 'boolean');
  } finally {
    await module.close();
    await module.cleanup();
  }
});

// ===========================================================================
//  Uploads, versions and validation
// ===========================================================================
test('every upload is a new version and old files are kept', async () => {
  const module = await startModule();
  try {
    const student = account('student_researcher');
    const submission = await createStudentInitial(module, student);

    for (const n of [1, 2, 3]) {
      const res = await module.call(student, `/${submission.id}/files`, {
        method: 'POST',
        body: uploadForm({ manuscript_pdf: pdf(`revision-${n}.pdf`, `bytes-${n}`) })
      });
      assert.equal(res.status, 201);
      assert.equal((await res.json()).file.version, n + 1, 'versions keep counting up');
    }

    const versions = await module.json(await module.call(student, `/${submission.id}/versions`));
    const manuscript = versions.body.versions
      .map(v => ({ version: v.version, files: v.files.filter(f => f.slot_key === 'manuscript_pdf') }))
      .filter(v => v.files.length);
    assert.deepEqual(manuscript.map(v => v.version), [1, 2, 3, 4],
      'the original upload survives every revision');

    // The oldest version is still downloadable.
    const first = module.store.rowsOf('research_submission_files')
      .find(f => f.submission_id === submission.id && f.slot_key === 'manuscript_pdf' && f.version === 1);
    const download = await module.call(student, `/${submission.id}/files/${first.id}`);
    assert.equal(download.status, 200);
    assert.equal(await download.text(), 'pdf-bytes');
    assert.match(download.headers.get('content-disposition'), /attachment/);
    assert.equal(download.headers.get('content-type'), PDF);
  } finally {
    await module.close();
    await module.cleanup();
  }
});

test('a submission missing a required file or field is refused', async () => {
  const module = await startModule();
  try {
    const student = account('student_researcher');

    // Missing one required field.
    const { title, ...noTitle } = STUDENT_INITIAL_FORM;
    const missingField = await module.call(student, '/', {
      method: 'POST',
      body: uploadForm(STUDENT_INITIAL_FILES, noTitle)
    });
    assert.equal(missingField.status, 400);
    assert.match((await missingField.json()).error, /Required field is missing: Working Title/);

    // Missing one required slot (form_d).
    const { form_d, ...noFormD } = STUDENT_INITIAL_FILES;
    const missingSlot = await module.call(student, '/', {
      method: 'POST',
      body: uploadForm(noFormD, STUDENT_INITIAL_FORM)
    });
    assert.equal(missingSlot.status, 400);
    assert.match((await missingSlot.json()).error, /Required file is missing: Form D/);

    // A conditional slot is required only when its flag is genuinely true.
    const withChange = await module.call(student, '/', {
      method: 'POST',
      body: uploadForm(STUDENT_INITIAL_FILES, { ...STUDENT_INITIAL_FORM, adviser_changed: 'true' })
    });
    assert.equal(withChange.status, 400, 'form_g becomes required');
    assert.match((await withChange.json()).error, /Form G/);

    // The multipart form posts "false" as a string; that must NOT require it.
    const flagOff = await module.call(student, '/', {
      method: 'POST',
      body: uploadForm(STUDENT_INITIAL_FILES, { ...STUDENT_INITIAL_FORM, adviser_changed: 'false' })
    });
    assert.equal(flagOff.status, 201, 'adviser_changed=false must not require form_g');

    // With the flag on and the file supplied, the submission is accepted.
    const withFormG = await module.call(student, '/', {
      method: 'POST',
      body: uploadForm(
        { ...STUDENT_INITIAL_FILES, form_g: pdf('form-g.pdf') },
        { ...STUDENT_INITIAL_FORM, adviser_changed: 'true' }
      )
    });
    assert.equal(withFormG.status, 201);

    assert.equal(
      module.store.rowsOf('research_submissions').length, 2,
      'only the two valid submissions were written'
    );
  } finally {
    await module.close();
    await module.cleanup();
  }
});

test('wrong file types, unknown slots and oversized files are refused', async () => {
  const module = await startModule();
  try {
    const student = account('student_researcher');
    const submission = await createStudentInitial(module, student);

    const attempt = (slot, file) => module.call(student, `/${submission.id}/files`, {
      method: 'POST',
      body: uploadForm({ [slot]: file })
    });

    // A PDF slot will not take a Word file, or a text file at all.
    assert.equal((await attempt('manuscript_pdf', docx('wrong.docx'))).status, 400);
    assert.equal((await attempt('manuscript_pdf', { name: 'notes.txt', body: 'x', type: 'text/plain' })).status, 400);
    // A Word slot will not take a PDF.
    assert.equal((await attempt('manuscript_docx', pdf('wrong.pdf'))).status, 400);
    // A slot that does not exist in the module is refused.
    assert.equal((await attempt('not_a_slot', pdf())).status, 400);

    // Over the 20 MB limit.
    const big = { name: 'huge.pdf', body: Buffer.alloc(21 * 1024 * 1024), type: PDF };
    const tooBig = await attempt('manuscript_pdf', big);
    assert.equal(tooBig.status, 400);
    assert.match((await tooBig.json()).error, /too large/i);

    // Nothing above was stored.
    assert.equal(
      module.store.rowsOf('research_submission_files').filter(f => f.stored_path.includes('huge')).length,
      0
    );
  } finally {
    await module.close();
    await module.cleanup();
  }
});

test('files land under the private upload directory, never a public one', async () => {
  const module = await startModule();
  try {
    const student = account('student_researcher');
    const submission = await createStudentInitial(module, student);

    const file = module.store.rowsOf('research_submission_files')[0];
    assert.ok(!file.stored_path.startsWith('/'), 'stored_path is relative to the upload root');
    assert.ok(file.stored_path.startsWith(`research-submissions/${submission.id}/files/`));
    assert.match(file.stored_path, /[0-9a-f-]{36}\.docx$/, 'the stored name is random');

    // The bytes really are on disk, at the path the download route uses.
    const onDisk = await readFile(join(module.uploadDir, file.stored_path));
    assert.ok(onDisk.length > 0);
    assert.ok(!module.uploadDir.includes('public'), 'the upload root is outside public/');
  } finally {
    await module.close();
    await module.cleanup();
  }
});

// ===========================================================================
//  Adviser / facilitator scoping
// ===========================================================================
test('reviewer read/comment access is gated separately from status changes', () => {
  // The split that makes a Research Adviser / Facilitator read-only: the role
  // stays a "reviewer" for reading and commenting, but is absent from the
  // status-change set, so PATCH /:id/status refuses it.
  assert.ok(REVIEWER_ROLES.has('adviser'));
  assert.ok(REVIEWER_ROLES.has('facilitator'));
  assert.ok(!STATUS_CHANGE_ROLES.has('adviser'));
  assert.ok(!STATUS_CHANGE_ROLES.has('facilitator'));
  for (const role of ['cpri_staff', 'ethics_reviewer', 'admin']) {
    assert.ok(STATUS_CHANGE_ROLES.has(role), `${role} keeps its review powers`);
  }
});

test('every monitoring role sees every submission in the system, read-only', async () => {
  const module = await startModule();
  try {
    const adviser = account('adviser');
    const otherAdviser = account('adviser');
    const facilitator = account('facilitator');
    const student = account('student_researcher');
    const faculty = account('faculty_researcher');

    const base = {
      stage: 'initial', authors: 'A', program: 'P', category: 'C',
      school_year: '2026-2027', semester: '1st', status: 'submitted',
      adviser_id: '', facilitator_id: ''
    };
    // A student record nobody named this adviser on, and a faculty record that
    // does name them: BOTH are work to monitor, and the old scope hid the second
    // one from every reviewer it did not name — which is how the facilitator
    // dashboard ended up one record short of the admin overview.
    const studentSub = {
      ...base, id: randomUUID(), owner_id: student.id, owner_name: student.fullName,
      owner_role: student.role, title: 'Student work', research_type: 'student_thesis',
      created_at: '2026-03-01 00:00:00', updated_at: '2026-03-01 00:00:00'
    };
    const facultySub = {
      ...base, id: randomUUID(), owner_id: faculty.id, owner_name: faculty.fullName,
      owner_role: faculty.role, title: 'Faculty work', research_type: 'faculty_research',
      adviser_id: adviser.id, created_at: '2026-02-01 00:00:00', updated_at: '2026-02-01 00:00:00'
    };
    // A record whose owner is neither a researcher nor this reviewer (staff ran
    // "New Submission", or a legacy copy kept its own owner role).
    const staffSub = {
      ...base, id: randomUUID(), owner_id: 'u-cpri-staff-someone', owner_name: 'CPRI Staff',
      owner_role: 'cpri_staff', title: 'Staff-recorded work', research_type: 'institutional_research',
      created_at: '2026-01-15 00:00:00', updated_at: '2026-01-15 00:00:00'
    };
    for (const row of [studentSub, facultySub, staffSub]) {
      await module.store.insert('research_submissions', row);
    }
    // The classic store: one record that was never copied into the module, and
    // one that was (same id) — the second must not be listed twice.
    await module.store.insert('submissions', {
      id: 'legacy-1', submitterId: student.id, submitterName: 'Typed At The Time',
      title: 'Legacy paper', authors: 'A, B', program: 'BS Biology', category: 'Life Sciences',
      researchType: 'student_thesis', abstract: 'An abstract.', status: 'rejected',
      createdAt: '2026-01-01 00:00:00', updatedAt: '2026-01-02 00:00:00',
      files: JSON.stringify({
        manuscript: { original_name: 'legacy-manuscript.pdf', storage_path: 'submissions/legacy-1/m.pdf', mime_type: PDF }
      }),
      additionalDocs: JSON.stringify([
        { id: 'doc-1', original_name: 'extra.pdf', storage_path: 'submissions/legacy-1/extra.pdf', mime_type: PDF }
      ]),
      comments: JSON.stringify([{
        id: 'c1', authorName: 'CPRI Staff', authorRole: 'cpri_staff',
        type: 'feedback', body: 'Please revise the title.', createdAt: '2026-01-03 00:00:00'
      }])
    });
    await module.store.insert('submissions', {
      id: studentSub.id, submitterId: student.id, submitterName: student.fullName,
      title: 'Already migrated', program: 'BS Biology', category: 'C',
      researchType: 'student_thesis', status: 'submitted',
      createdAt: '2026-03-01 00:00:00', updatedAt: '2026-03-01 00:00:00'
    });
    // The account behind the legacy row, renamed since it submitted.
    await module.store.insert('users', {
      id: student.id, username: student.username, email: 'student@example.org',
      fullName: 'Renamed Student', role: 'student_researcher'
    });

    const everyId = [staffSub.id, facultySub.id, studentSub.id, 'legacy-1'];
    for (const role of ['adviser', 'facilitator', 'cpri_staff', 'admin']) {
      const viewer = role === 'adviser' ? otherAdviser : account(role);
      const list = await module.json(await module.call(viewer, '/'));
      assert.equal(list.status, 200, `${role} can read the list`);
      assert.deepEqual(
        list.body.submissions.map(s => s.id),
        // newest first: March, February, January 15, January 1
        [studentSub.id, facultySub.id, staffSub.id, 'legacy-1'],
        `${role} sees every record from both stores, once each`
      );
      assert.equal(list.body.count, everyId.length, `${role}'s count matches what it was given`);
      assert.deepEqual(
        list.body.submissions.map(s => s.created_at).map(d => new Date(d).getMonth()),
        [2, 1, 0, 0],
        'newest first'
      );
    }

    // A monitoring role sees the record even though it owns none of them...
    assert.equal((await module.call(otherAdviser, `/${facultySub.id}`)).status, 200,
      'a faculty record is readable by a reviewer it never named');
    assert.equal((await module.call(otherAdviser, `/${staffSub.id}`)).status, 200,
      'and so is a record owned by a staff account');

    // ...but never writes into one. The write rules are unchanged by this
    // widening: the owner, or the staff/admin who run the module.
    const uploaded = await module.call(otherAdviser, `/${facultySub.id}/files`, {
      method: 'POST', body: uploadForm({ manuscript_docx: docx('sneak.docx') })
    });
    assert.equal(uploaded.status, 403, 'a reviewer cannot upload into a record that is not theirs');

    const moved = await module.call(adviser, `/${facultySub.id}/status`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'under_initial_checking' })
    });
    assert.equal(moved.status, 403, 'a facilitator can never change a status');

    const movedStudent = await module.call(adviser, `/${studentSub.id}/status`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'approved' })
    });
    assert.equal(movedStudent.status, 403, 'and never approves a student submission');

    // Commenting is exactly what the role may do — on any record they can read.
    const commented = await module.call(otherAdviser, `/${facultySub.id}/comments`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Please justify the sample size.' })
    });
    assert.equal(commented.status, 201);
    const posted = await commented.json();
    assert.equal(posted.comment.comment_type, 'feedback');
    assert.equal(posted.comment.author_role, 'adviser');

    // The record shape a monitoring dashboard renders.
    const list = await module.json(await module.call(otherAdviser, '/'));
    const byId = new Map(list.body.submissions.map(s => [s.id, s]));
    const moduleEntry = byId.get(studentSub.id);
    assert.equal(moduleEntry.studentName, student.fullName, 'the card has a student name');
    assert.equal(moduleEntry.program, 'P');
    assert.equal(moduleEntry.research_type, 'student_thesis');
    assert.match(moduleEntry.detailUrl, /^\/research-submission-detail\.html\?id=/);
    assert.equal(moduleEntry.source, 'module');

    const legacyEntry = byId.get('legacy-1');
    assert.equal(legacyEntry.studentName, 'Renamed Student', 'the account behind the row, not the typed name');
    assert.equal(legacyEntry.ownerRole, 'student_researcher');
    assert.equal(legacyEntry.status, 'rejected');
    assert.equal(legacyEntry.statusLabel, 'Rejected');
    assert.equal(legacyEntry.source, 'classic');
    assert.equal(legacyEntry.detailUrl, '/submission.html?id=legacy-1');
    assert.equal(legacyEntry.fileCount, 2, 'the manuscript and the additional document');
    assert.equal(legacyEntry.files[0].url, '/api/submissions/legacy-1/file?key=manuscript');
    assert.equal(legacyEntry.files[1].url, '/api/submissions/legacy-1/file?key=additional&docId=doc-1');
    assert.equal(legacyEntry.commentCount, 1);
    assert.equal(legacyEntry.comments[0].body, 'Please revise the title.');
    assert.equal(legacyEntry.created_at, '2026-01-01 00:00:00');
  } finally {
    await module.close();
    await module.cleanup();
  }
});

// ===========================================================================
//  Notifications — the owner hears about status changes and comments
// ===========================================================================
test('the owner is notified about a status change, and staff about a new submission', async () => {
  const module = await startModule();
  try {
    const student = account('student_researcher');
    const staff = account('cpri_staff');
    // The student opted into email notifications; staff kept the default.
    module.store.insert('users', {
      id: student.id, email: `${student.username}@sandbox.example`, fullName: student.fullName,
      role: student.role, status: 'active', user_prefs: { email: true, inApp: true, quietHours: { enabled: false } }
    });
    module.store.insert('users', {
      id: staff.id, email: `${staff.username}@sandbox.example`, fullName: staff.fullName,
      role: staff.role, status: 'active', user_prefs: { email: false, inApp: true, quietHours: { enabled: false } }
    });

    const submission = await createStudentInitial(module, student);

    // Creating the record tells CPRI staff there is something to check.
    const submittedTo = module.inApp.filter(a => a[1] === 'research_submission_new').map(a => a[0]);
    assert.ok(submittedTo.includes(staff.id), 'staff are told about a new submission');
    assert.ok(!submittedTo.includes(student.id), 'the submitter is not notified about their own submission');
    assert.equal(module.emails.length, 0, 'staff have email notifications off by default');

    // A status change notifies the owner in-app AND by email (their choice).
    module.inApp.length = 0;
    const moved = await module.call(staff, `/${submission.id}/status`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'under_initial_checking' })
    });
    assert.equal(moved.status, 200);

    const statusNotice = module.inApp.find(a => a[1] === 'research_submission_status');
    assert.ok(statusNotice, 'the owner gets an in-app notification');
    assert.equal(statusNotice[0], student.id);
    assert.match(statusNotice[3], /Under Initial Checking/);
    assert.equal(statusNotice[4], `/research-submission-detail.html?id=${submission.id}`);

    assert.equal(module.emails.length, 1, 'the owner opted into email, so a copy is sent');
    assert.equal(module.emails[0][0], `${student.username}@sandbox.example`);
    assert.match(module.emails[0][1].title, /updated/i);
    assert.match(module.emails[0][1].link, new RegExp(submission.id));

    // A comment notifies the owner too.
    module.inApp.length = 0;
    module.emails.length = 0;
    const comment = await module.call(staff, `/${submission.id}/comments`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Please attach the signed form.' })
    });
    assert.equal(comment.status, 201);
    assert.equal(module.inApp.filter(a => a[1] === 'research_submission_comment').length, 1);
    assert.equal(module.emails.length, 1);

    // The owner answering their own thread does not notify themselves.
    module.inApp.length = 0;
    module.emails.length = 0;
    await module.call(student, `/${submission.id}/comments`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Uploaded.' })
    });
    assert.equal(module.inApp.filter(a => a[1] === 'research_submission_comment').length, 0);
    assert.equal(module.emails.length, 0);
  } finally {
    await module.close();
    await module.cleanup();
  }
});

test('an account with email off, or inside quiet hours, gets in-app only', async () => {
  const module = await startModule();
  try {
    const quiet = account('student_researcher');
    // Email on, but a quiet window that covers every hour of the day.
    module.store.insert('users', {
      id: quiet.id, email: 'quiet@rsub-test.local', fullName: quiet.fullName,
      role: quiet.role, status: 'active',
      user_prefs: { email: true, inApp: true, quietHours: { enabled: true, start: '00:00', end: '23:59' } }
    });
    const staff = account('cpri_staff');
    module.store.insert('users', {
      id: staff.id, email: 'staff@rsub-test.local', fullName: staff.fullName, role: staff.role,
      status: 'active', user_prefs: { email: true, inApp: true, quietHours: { enabled: false } }
    });

    const submission = await createStudentInitial(module, quiet);
    module.inApp.length = 0;
    module.emails.length = 0;

    await module.call(staff, `/${submission.id}/status`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'under_initial_checking' })
    });

    // In-app still arrives; the email copy is held back by quiet hours.
    assert.equal(module.inApp.filter(a => a[1] === 'research_submission_status').length, 1);
    assert.equal(module.emails.length, 0, 'quiet hours suppress the email copy');
  } finally {
    await module.close();
    await module.cleanup();
  }
});

test('a failing notifier never breaks the request it belongs to', async () => {
  const module = await startModule({
    notify: async () => { throw new Error('bell is broken'); },
    sendEmail: async () => { throw new Error('smtp is down'); }
  });
  try {
    const student = account('student_researcher');
    const staff = account('cpri_staff');
    module.store.insert('users', {
      id: student.id, email: 'owner@rsub-test.local', fullName: student.fullName,
      role: student.role, status: 'active',
      user_prefs: { email: true, inApp: true, quietHours: { enabled: false } }
    });

    const submission = await createStudentInitial(module, student);
    const moved = await module.call(staff, `/${submission.id}/status`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'under_initial_checking' })
    });
    assert.equal(moved.status, 200, 'the status change still succeeds');
    assert.equal(
      module.store.rowsOf('research_submissions').find(r => r.id === submission.id).status,
      'under_initial_checking'
    );
  } finally {
    await module.close();
    await module.cleanup();
  }
});

// ===========================================================================
//  Schema: the boot-time DDL and the hand-written migration must agree
// ===========================================================================
test('the schema file and the boot-time DDL declare the same tables and columns', async () => {
  const schemaSql = await readFile(join(__dirname, '..', 'schema.sql'), 'utf8');
  const migrationSql = await readFile(
    join(__dirname, '..', '..', 'db', 'migrations', '005_research_submissions.sql'),
    'utf8'
  );

  // Capture the DDL the module applies on boot, without touching a database.
  const statemenets = [];
  await ensureResearchSubmissionsSchema({ run: async (sql) => { statemenets.push(sql); } });
  const bootSql = statemenets.join('\n');

  const tables = (sql) => [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)/gi)].map(m => m[1]);
  const expected = ['research_submissions', 'research_submission_files', 'research_comments',
    'research_status_history', 'research_ethics_clearances'];

  assert.deepEqual(tables(bootSql).sort(), [...expected].sort());
  assert.deepEqual(tables(schemaSql).sort(), [...expected].sort());
  assert.deepEqual(tables(migrationSql).sort(), [...expected].sort());

  // Every table in the migration/schema declares the same columns as the DDL.
  for (const table of expected) {
    const block = (sql) => {
      const start = sql.search(new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${table}\\b`, 'i'));
      assert.ok(start >= 0, `${table} is declared`);
      return sql.slice(start, sql.indexOf(') ENGINE', start));
    };
    const columns = (block_) => block_.split('\n')
      .map(line => line.trim().match(/^([a-z_][a-z0-9_]*)\s+[A-Z]/i))
      .filter(Boolean)
      .map(m => m[1])
      .filter(name => !/^(KEY|PRIMARY|INDEX|UNIQUE)$/i.test(name))
      .sort();

    assert.deepEqual(columns(block(schemaSql)), columns(block(bootSql)), `${table} columns match the boot DDL`);
    assert.deepEqual(columns(block(migrationSql)), columns(block(bootSql)), `${table} columns match the migration`);
  }
});

// ===========================================================================
//  File storage — Supabase Storage when configured, the local disk when not
// ===========================================================================

// A stand-in for the Supabase Storage REST API: real Response objects, an
// in-memory bucket, and a record of every call. The adapter's own contract is
// the only thing being faked, so the module is driven end to end without a
// Supabase project (server/dev/mock-supabase-storage.mjs does the same over
// HTTP for manual runs).
function fakeSupabase() {
  const objects = new Map(); // `<bucket>/<object path>` -> Buffer
  const calls = [];
  const bucket = 'private-files';

  const storage = createSupabaseStorage({
    env: {
      SUPABASE_URL: 'https://project.example.test',
      SUPABASE_SERVICE_KEY: 'test-service-secret',
      SUPABASE_BUCKET: bucket
    },
    fetchImpl: async (url, init = {}) => {
      const method = (init.method || 'GET').toUpperCase();
      const path = decodeURIComponent(new URL(url).pathname.replace('/storage/v1/object/', ''));
      calls.push({ method, path });
      if (method === 'POST') {
        objects.set(path, Buffer.from(init.body));
        return new Response('{}', { status: 200 });
      }
      if (method === 'DELETE') {
        const { prefixes = [] } = JSON.parse(init.body || '{}');
        for (const prefix of prefixes) objects.delete(`${bucket}/${prefix}`);
        return new Response('{}', { status: 200 });
      }
      const body = objects.get(path);
      if (!body) return new Response('Object not found', { status: 404 });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/pdf' } });
    }
  });

  return { storage, objects, calls, bucket };
}

test('with Supabase configured, uploads reach the bucket and stream back authorized', async () => {
  const supabase = fakeSupabase();
  const module = await startModule({ storage: supabase.storage });
  try {
    const student = account('student_researcher');
    const sub = await createStudentInitial(module, student);

    // Every row records the backend holding it, and the bytes really landed in
    // the bucket under the submission's own folder.
    const rows = module.store.rowsOf('research_submission_files');
    assert.equal(rows.length, 9);
    assert.ok(rows.every(f => f.storage_backend === 'supabase'),
      'each file row records that Supabase holds it');
    for (const row of rows) {
      assert.ok(supabase.objects.has(`${supabase.bucket}/${row.stored_path}`),
        `${row.stored_path} was uploaded to the bucket`);
    }

    // ...and nothing was written to the local disk at all.
    assert.deepEqual(await readdir(module.uploadDir).catch(() => []), [],
      'no bytes are written locally once Supabase is configured');

    // The authorized download streams the same bytes back as an attachment,
    // from the bucket rather than from a public URL.
    const row = rows[0];
    const res = await module.call(student, `/${sub.id}/files/${row.id}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') || '', /^attachment;/);
    assert.deepEqual(
      Buffer.from(await res.arrayBuffer()),
      supabase.objects.get(`${supabase.bucket}/${row.stored_path}`)
    );
  } finally {
    await module.close();
    await module.cleanup();
  }
});

test('a bucket-stored file is still refused to anyone who cannot read the submission', async () => {
  const supabase = fakeSupabase();
  const module = await startModule({ storage: supabase.storage });
  try {
    const owner = account('student_researcher');
    const stranger = account('student_researcher');
    const sub = await createStudentInitial(module, owner);
    const row = module.store.rowsOf('research_submission_files')[0];

    const denied = await module.call(stranger, `/${sub.id}/files/${row.id}`);
    assert.equal(denied.status, 403,
      'storage being reachable never bypasses the authorization check');
  } finally {
    await module.close();
    await module.cleanup();
  }
});

test('a bucket-stored file explains itself when this server has no Supabase configured', async () => {
  // The deployment lost its credentials, or the file was uploaded by a
  // deployment that had them. The route answers 502 with a readable message
  // instead of crashing or serving an empty file.
  const module = await startModule({ storage: createSupabaseStorage({ env: {} }) });
  try {
    const student = account('student_researcher');
    const sub = await createStudentInitial(module, student);
    const row = module.store.rowsOf('research_submission_files')[0];
    assert.equal(row.storage_backend, 'disk', 'without Supabase, uploads stay on the disk');

    // Same row, but now claiming the bucket holds it.
    module.store.rowsOf('research_submission_files')[0].storage_backend = 'supabase';
    const res = await module.call(student, `/${sub.id}/files/${row.id}`);
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /could not be retrieved/i);
  } finally {
    await module.close();
    await module.cleanup();
  }
});

// Runs the boot DDL against a fake database and returns the ALTERs it issued.
async function bootDdlAlters(existingColumnsByTable) {
  const statements = [];
  await ensureResearchSubmissionsSchema({
    run: async (sql) => {
      statements.push(sql);
      const show = String(sql).match(/^SHOW COLUMNS FROM (\w+)$/);
      if (show) return (existingColumnsByTable[show[1]] || []).map(Field => ({ Field }));
      return [];
    }
  });
  return statements
    .filter(sql => /^ALTER TABLE/.test(sql))
    .map(sql => sql.match(/^ALTER TABLE (\w+)/)[1]);
}

test('the boot DDL adds a column only where it is missing', async () => {
  // A database that already has both storage_backend columns but not the
  // adviser-evaluation link: only research_submissions is touched.
  assert.deepEqual(
    await bootDdlAlters({
      research_submissions: ['id', 'title'],
      research_submission_files: ['id', 'stored_path', 'storage_backend'],
      research_ethics_clearances: ['id', 'file_path', 'storage_backend']
    }),
    ['research_submissions']
  );

  // Everything already present: nothing is altered, so every boot is safe.
  assert.deepEqual(
    await bootDdlAlters({
      research_submissions: ['id', 'adviser_eval_link'],
      research_submission_files: ['id', 'storage_backend'],
      research_ethics_clearances: ['id', 'storage_backend']
    }),
    []
  );

  // A table that is missing one of them is caught up.
  assert.deepEqual(
    await bootDdlAlters({
      research_submissions: ['id', 'adviser_eval_link'],
      research_submission_files: ['id', 'stored_path', 'storage_backend'],
      research_ethics_clearances: ['id', 'file_path']
    }),
    ['research_ethics_clearances']
  );
});

// ===========================================================================
//  The adviser-evaluation link field (a Google Form, not a document)
// ===========================================================================
test('the adviser-evaluation link is a student-only url field, required at end of semester', async () => {
  const module = await startModule();
  try {
    const student = account('student_researcher');
    const faculty = account('non_teaching_researcher');

    const studentCfg = await module.json(await module.call(student, '/form-config'));
    const link = studentCfg.body.stages
      .flatMap(s => s.fields)
      .find(f => f.key === 'adviser_eval_link');
    assert.ok(link, 'a student is offered the link field');
    assert.equal(link.type, 'url', 'it is a link, not a file slot');
    assert.equal(link.required, true);
    assert.equal(link.conditional, true, 'published as a boolean: functions cannot cross JSON');
    assert.equal(link.condition_key, 'end_of_semester');

    const facultyCfg = await module.json(await module.call(faculty, '/form-config'));
    for (const stage of facultyCfg.body.stages) {
      assert.ok(!stage.fields.some(f => f.key === 'adviser_eval_link'),
        'faculty has no adviser-evaluation link (it is a student form)');
    }
  } finally {
    await module.close();
    await module.cleanup();
  }
});

test('the link is enforced only when the end-of-semester flag is set', async () => {
  const module = await startModule();
  try {
    const student = account('student_researcher');

    // Flag off: not required, so the ordinary submission still goes through.
    const withoutFlag = await createStudentInitial(module, student);
    assert.ok(withoutFlag.id);
    assert.equal(withoutFlag.adviser_eval_link, '');

    const withFiles = (extra) => uploadForm(STUDENT_INITIAL_FILES, {
      ...STUDENT_INITIAL_FORM, end_of_semester: 'true', ...extra
    });

    // Flag on, no link → 400 naming the field.
    let res = await module.call(student, '/', { method: 'POST', body: withFiles({}) });
    let body = await res.json();
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(body.field, 'adviser_eval_link');

    // A value that is not a link is refused.
    for (const bad of ['forms.gle/abc123', 'javascript:alert(1)', 'not a url']) {
      res = await module.call(student, '/', {
        method: 'POST',
        body: withFiles({ adviser_eval_link: bad })
      });
      body = await res.json();
      assert.equal(res.status, 400, `${bad} must be refused: ${JSON.stringify(body)}`);
      assert.match(body.error, /http:\/\/ or https:\/\//);
    }

    // A real link satisfies the end-of-semester requirement on its own: no
    // adviser_eval PDF is needed, because the evaluation lives in the form.
    res = await module.call(student, '/', {
      method: 'POST',
      body: withFiles({ adviser_eval_link: 'https://forms.gle/abc123' })
    });
    body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.submission.adviser_eval_link, 'https://forms.gle/abc123');
    assert.ok(!Object.keys(body.files || {}).includes('adviser_eval'),
      'no adviser_eval document was required once the link is given');
  } finally {
    await module.close();
    await module.cleanup();
  }
});

test('a role without the link field cannot smuggle one in', async () => {
  const module = await startModule();
  try {
    const faculty = account('faculty_researcher');
    const res = await module.call(faculty, '/', {
      method: 'POST',
      body: uploadForm({ manuscript_docx: docx(), manuscript_pdf: pdf() }, {
        stage: 'initial', title: 'Faculty paper', authors: 'A. Author', program: 'CAS',
        category: 'Education', research_type: 'faculty_research',
        school_year: '2026-2027', semester: '1st',
        adviser_eval_link: 'https://forms.gle/sneaky'
      })
    });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.submission.adviser_eval_link, '',
      'the student-only value is dropped for a role whose form has no such field');
  } finally {
    await module.close();
    await module.cleanup();
  }
});

// ===========================================================================
//  Records whose owner_id is not the account id
//
//  The classic `submissions` module stored its owner in `submitterId`, and a
//  row imported from it (or written by a script) can carry the owner's EMAIL or
//  USERNAME in owner_id instead of the account id. Those rows used to be
//  invisible to their own owner — GET / answered with an empty list while the
//  record sat in the table, which is exactly the "You have no submissions yet"
//  bug on my-submissions.html.
// ===========================================================================
function importedRow(overrides = {}) {
  return {
    id: `imported-${randomUUID()}`,
    owner_id: '',
    owner_name: '',
    owner_role: 'student_researcher',
    stage: 'initial',
    title: 'Imported record',
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
    status: 'submitted',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    adviser_eval_link: '',
    ...overrides
  };
}

test("a record keyed by the owner's email or username still belongs to that owner", async () => {
  const module = await startModule();
  try {
    const student = account('student_researcher', { email: 'Ahron.Alcober@example.org' });
    const other = account('student_researcher', { email: 'someone.else@example.org' });

    module.store.rowsOf('research_submissions').push(
      importedRow({ id: 'imported-by-email', owner_id: 'ahron.alcober@example.org', owner_name: student.fullName }),
      importedRow({ id: 'imported-by-username', owner_id: student.username, owner_name: student.fullName }),
      importedRow({ id: 'imported-not-mine', owner_id: other.id, owner_name: other.fullName })
    );

    const list = await module.json(await module.call(student, '/'));
    assert.equal(list.status, 200);
    const ids = list.body.submissions.map(s => s.id);
    assert.ok(ids.includes('imported-by-email'), 'owner_id stored as an email is still this account\'s record');
    assert.ok(ids.includes('imported-by-username'), 'owner_id stored as a username is still this account\'s record');
    assert.ok(!ids.includes('imported-not-mine'), 'another account\'s record is never listed');
    assert.equal(list.body.submissions.find(s => s.id === 'imported-by-email').isOwner, true,
      'the list marks the email-keyed record as the caller\'s own');

    const mine = await module.json(await module.call(student, '/imported-by-email'));
    assert.equal(mine.status, 200, 'the owner may read the record itself');
    assert.equal(mine.body.submission.isOwner, true, 'and the detail view agrees it is theirs');

    assert.equal((await module.call(student, '/imported-not-mine')).status, 403,
      'widening the match never reaches another account');
  } finally {
    await module.close();
    await module.cleanup();
  }
});

test('an unexpected or blank status never hides a record', async () => {
  const module = await startModule();
  try {
    const student = account('student_researcher', { email: 'student@example.org' });
    module.store.rowsOf('research_submissions').push(
      importedRow({ id: 'imported-odd-status', owner_id: student.id, status: 'legacy_pending' }),
      importedRow({ id: 'imported-blank-status', owner_id: student.id, status: '' })
    );

    const list = await module.json(await module.call(student, '/'));
    const byId = new Map(list.body.submissions.map(s => [s.id, s]));
    assert.ok(byId.has('imported-odd-status'), 'an unknown status is not a reason to drop a record');
    assert.equal(byId.get('imported-odd-status').status, 'legacy_pending', 'the status is reported verbatim');
    assert.equal(byId.get('imported-odd-status').statusLabel, 'legacy_pending',
      'with no known label it falls back to the raw value');
    assert.ok(byId.has('imported-blank-status'), 'a blank status is not a reason to drop a record either');
  } finally {
    await module.close();
    await module.cleanup();
  }
});

test('the owner of an email-keyed record can still edit it and add a new version', async () => {
  const module = await startModule();
  try {
    const student = account('student_researcher', { email: 'ahron@example.org' });
    module.store.rowsOf('research_submissions').push(
      importedRow({ id: 'imported-editable', owner_id: 'AHRON@example.org', owner_name: student.fullName, status: 'for_revision' })
    );
    // The current version of the one slot, so the re-upload has to become v2.
    module.store.rowsOf('research_submission_files').push({
      id: 'imported-file-v1',
      submission_id: 'imported-editable',
      slot_key: 'manuscript_docx',
      original_name: 'manuscript-v1.docx',
      stored_path: 'submissions/classic/manuscript-v1.docx',
      mime: DOCX,
      size: 0,
      version: 1,
      uploaded_by: student.id,
      uploaded_by_name: student.fullName,
      uploaded_at: '2026-01-01T00:00:00.000Z',
      storage_backend: 'supabase'
    });

    const cfg = await module.json(await module.call(student, '/imported-editable/form-config'));
    assert.equal(cfg.status, 200);
    assert.equal(cfg.body.editable, true, 'the owner may change it while it is For revision');
    assert.equal(cfg.body.canUpload, true);

    const upload = await module.call(student, '/imported-editable/files', {
      method: 'POST',
      body: uploadForm({ manuscript_docx: docx('manuscript-v2.docx') })
    });
    const payload = await upload.json();
    assert.equal(upload.status, 201, JSON.stringify(payload));
    assert.equal(payload.file.version, 2, 'a re-upload is stored as the next version, keeping v1');

    const detail = await module.json(await module.call(student, '/imported-editable'));
    assert.equal(detail.body.submission.versions.length, 2, 'both versions are still listed');
  } finally {
    await module.close();
    await module.cleanup();
  }
});
