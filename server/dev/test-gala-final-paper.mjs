// Tests for the Research Gala final-paper submission (Presenter role).
//
//   node --test server/dev/test-gala-final-paper.mjs        (npm run test:gala)
//
// Runs the REAL router over HTTP (real Express + multer + validators) against an
// in-memory data store and an in-memory document store, so nothing touches MySQL
// or Supabase. Scenarios, in the order a presenter lives them:
//   • a non-presenter is turned away;
//   • a presenter saves a draft and resumes it;
//   • documents: type, size, 0-byte, spoofed content and duplicates are refused;
//   • submitting with a missing document is blocked, a complete one succeeds
//     and returns a reference number;
//   • an admin changes the status and assigns a schedule, and the presenter
//     sees the update (and is notified);
//   • editing is locked from Under Checking until the entry is sent For Revision;
//   • the program exports as PDF and Excel.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Readable } from 'stream';
import { createGalaRouter, makeRefNo } from '../gala.js';
import { checkGrammar } from '../lib/grammar.js';
import {
  wordCount, normalizeTags, detectDocumentKind, checkUpload, validateEntry, slotByKey,
  formatClock, formatDay, LIMITS, GALA_SLOTS
} from '../lib/gala-config.js';
import { zipStore, crc32, buildProgramPdf, buildProgramXlsx, programRows } from '../lib/gala-export.js';

// ---------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------
const USERS = {
  pat: { id: 'u-pat', role: 'presenter', status: 'active', fullName: 'Pat Presenter', username: 'pat', email: 'pat@example.test' },
  sam: { id: 'u-sam', role: 'presenter', status: 'active', fullName: 'Sam Speaker', username: 'sam', email: 'sam@example.test' },
  stu: { id: 'u-stu', role: 'student_researcher', status: 'active', fullName: 'Stu Student', username: 'stu' },
  fac: { id: 'u-fac', role: 'faculty_researcher', status: 'active', fullName: 'Fay Faculty', username: 'fac' },
  admin: { id: 'u-admin', role: 'admin', status: 'active', fullName: 'Site Admin', username: 'admin' },
  staff: { id: 'u-staff', role: 'cpri_staff', status: 'active', fullName: 'Staff Member', username: 'staff' }
};

const PROGRAMS = ['BS Information Technology', 'BS Nursing'];
const YEARS = ['2025–2026', '2026–2027'];
const JSON_COLUMNS = ['files', 'statusHistory', 'presenters', 'coAuthors'];

// What the MySQL driver does for JSON columns: hands them back parsed.
function hydrate(row) {
  if (!row) return null;
  const copy = { ...row };
  for (const key of JSON_COLUMNS) {
    if (typeof copy[key] === 'string') {
      try { copy[key] = JSON.parse(copy[key]); } catch { copy[key] = null; }
    }
  }
  return copy;
}

function memoryStore({ account = {} } = {}) {
  const rows = new Map();
  const store = {
    rows,
    get: async (id) => hydrate(rows.get(id)),
    insert: async (record) => { rows.set(record.id, { ...record }); },
    update: async (id, changes) => { Object.assign(rows.get(id), changes); },
    remove: async (id) => { rows.delete(id); },
    list: async (f = {}) => {
      let out = [...rows.values()].map(hydrate);
      if (f.userId) out = out.filter(r => r.userId === f.userId);
      if (f.excludeDrafts) out = out.filter(r => r.status !== 'draft');
      if (f.statuses) out = out.filter(r => f.statuses.includes(r.status));
      if (f.category) out = out.filter(r => r.category === f.category);
      if (f.presentationType) out = out.filter(r => r.presentationType === f.presentationType);
      if (f.schoolYear) out = out.filter(r => r.schoolYear === f.schoolYear);
      if (f.q) out = out.filter(r => `${r.title} ${r.refNo} ${r.submitterName}`.toLowerCase().includes(f.q.toLowerCase()));
      return out;
    },
    titleTaken: async (userId, title, exceptId) => [...rows.values()].some(r =>
      r.userId === userId && r.id !== exceptId && !['draft', 'rejected'].includes(r.status)
      && String(r.title).toLowerCase() === String(title).toLowerCase()),
    scheduleConflict: async ({ date, time, room, exceptId }) => [...rows.values()].find(r =>
      r.id !== exceptId && r.scheduleDate === date && r.scheduleTime === time
      && String(r.scheduleRoom).toLowerCase() === String(room).toLowerCase()
      && ['scheduled', 'presented'].includes(r.status)) || null,
    refNoTaken: async (ref) => [...rows.values()].some(r => r.refNo === ref),
    eventExists: async (id) => id === 'evt-1',
    events: async () => [{ id: 'evt-1', title: '2026 Research Gala', dateTime: '2026-11-20' }],
    schoolYearsInUse: async () => [...new Set([...rows.values()].map(r => r.schoolYear).filter(Boolean))],
    reviewerIds: async () => [USERS.admin.id, USERS.staff.id],
    account: async (userId) => account[userId] || { email: null, user_prefs: null }
  };
  return store;
}

function memoryFiles() {
  const blobs = new Map();
  return {
    blobs,
    save: async ({ path, buffer }) => { blobs.set(path, Buffer.from(buffer)); return 'memory'; },
    open: async ({ path }) => (blobs.has(path) ? Readable.from([blobs.get(path)]) : null),
    remove: async ({ path }) => { blobs.delete(path); }
  };
}

// A valid listed value passes; "other" is accepted as typed; anything else is refused.
async function fakeResolveListed({ body, keys }) {
  const values = {};
  if (keys.includes('program')) {
    const raw = String(body.program ?? '').trim();
    if (!raw) values.program = '';
    else if (PROGRAMS.includes(raw) || body.program_mode === 'other') values.program = raw;
    else return { field: 'program', error: 'Choose a program or department from the list, or pick "Other (please specify)".' };
  }
  if (keys.includes('school_year')) {
    const raw = String(body.school_year ?? '').trim();
    if (!raw) values.school_year = '';
    else if (YEARS.includes(raw)) values.school_year = raw;
    else return { field: 'school_year', error: 'Choose a school year from the list.' };
  }
  return { values };
}

async function startServer({ account = {}, store = memoryStore({ account }), files = memoryFiles(), grammar, grammarGapMs = 0 } = {}) {
  const logs = [];
  const notes = [];
  const emails = [];
  const app = express();
  app.use(express.json());
  const header = (req) => USERS[req.headers['x-user']];
  const router = createGalaRouter({
    store,
    fileStore: files,
    requireAuth: (req, res, next) => (header(req) ? next() : res.status(401).json({ error: 'Not authenticated.' })),
    caller: async (req) => header(req) || null,
    reviewGate: (req, res, next) => (['admin', 'cpri_staff'].includes(header(req)?.role)
      ? next() : res.status(403).json({ error: 'Access denied.' })),
    addLog: async (action, details) => { logs.push({ action, details }); },
    notify: async (userId, action, title, message, link) => { notes.push({ userId, action, title, message, link }); },
    sendEmail: async (to, payload) => { emails.push({ to, ...payload }); },
    resolveListed: fakeResolveListed,
    checkGrammar: grammar || (async () => ({ available: true, issues: [] })),
    grammarGapMs,
    schoolYears: async () => ({ current: '2026–2027', years: YEARS.map(y => ({ value: y, label: y, isCurrent: y === '2026–2027' })) })
  });
  app.use('/api/gala', router);

  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  server.unref();
  const base = `http://127.0.0.1:${server.address().port}/api/gala`;

  // One tiny client per user.
  const as = (who) => {
    const call = async (method, path, body) => {
      const res = await fetch(base + path, {
        method,
        headers: { ...(who ? { 'x-user': who } : {}), ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
        body: body === undefined ? undefined : (body instanceof FormData ? body : JSON.stringify(body))
      });
      const type = res.headers.get('content-type') || '';
      const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
      return { status: res.status, data, headers: res.headers };
    };
    return {
      get: (p) => call('GET', p),
      post: (p, b) => call('POST', p, b ?? {}),
      patch: (p, b) => call('PATCH', p, b ?? {}),
      del: (p) => call('DELETE', p),
      upload: (p, { name, body, type = 'application/octet-stream' }) => {
        const fd = new FormData();
        fd.append('file', new Blob([body], { type }), name);
        return call('POST', p, fd);
      }
    };
  };
  return { as, store, files, logs, notes, emails, close: () => new Promise(r => server.close(r)) };
}

// Documents. Each call returns different bytes so two slots never collide by accident.
let counter = 0;
const pdf = (label = '') => Buffer.from(`%PDF-1.4\n% ${label || ++counter}\n1 0 obj\n<<>>\nendobj\n%%EOF\n`);
const docx = (label = '') => zipStore([
  { name: '[Content_Types].xml', data: '<Types/>' },
  { name: 'word/document.xml', data: `<doc>${label || ++counter}</doc>` }
]);
const oleDoc = (label = '') => Buffer.concat([Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]), Buffer.from(`ole ${label || ++counter}`)]);

const SLOT_FILES = {
  manuscript_pdf: () => ({ name: 'final.pdf', body: pdf() }),
  manuscript_docx: () => ({ name: 'final.docx', body: docx() }),
  abstract: () => ({ name: 'abstract.pdf', body: pdf() }),
  presentation: () => ({ name: 'slides.pdf', body: pdf() }),
  endorsement: () => ({ name: 'endorsement.pdf', body: pdf() }),
  ethics: () => ({ name: 'ethics.docx', body: docx() })
};

const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const VALID = () => ({
  title: 'Adaptive Learning in Rural Schools',
  presenters: ['Pat Presenter', 'Lee Partner'],
  coAuthors: ['M. Reyes'],
  program: 'BS Information Technology',
  category: 'capstone',
  presentationType: 'oral',
  adviser: 'Dr. Ana Adviser',
  schoolYear: '2026–2027',
  semester: '1st',
  abstract: 'A study of adaptive learning platforms in rural secondary schools.',
  keywords: ['adaptive learning', 'rural education', 'blended']
});

// Creates a draft for `who` with the valid details, optionally with all six documents.
async function makeEntry(api, who, { details = {}, withFiles = false } = {}) {
  const client = api.as(who);
  const created = await client.post('/', { ...VALID(), ...details });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.submission.id;
  if (withFiles) {
    for (const slot of GALA_SLOTS) {
      const res = await client.upload(`/${id}/files/${slot.key}`, SLOT_FILES[slot.key]());
      assert.equal(res.status, 200, `${slot.key}: ${JSON.stringify(res.data)}`);
    }
  }
  return id;
}

// ---------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------
test('wordCount counts words, not characters or spaces', () => {
  assert.equal(wordCount(''), 0);
  assert.equal(wordCount('  one   two\nthree\t four '), 4);
  assert.equal(wordCount(words(250)), 250);
});

test('normalizeTags trims, de-duplicates case-insensitively and reports what it refused', () => {
  const r = normalizeTags(['  AI ', 'ai', '', 'Rural  Education'], { max: 5, maxLength: 40, label: 'keyword' });
  assert.deepEqual(r.tags, ['AI', 'Rural Education']);
  assert.deepEqual(r.errors, []);
  assert.equal(normalizeTags('a, b, c, d, e, f', { max: 5, maxLength: 40, label: 'keyword' }).errors.length, 1);
  assert.equal(normalizeTags(['x'.repeat(41)], { max: 5, maxLength: 40, label: 'keyword' }).errors.length, 1);
});

test('detectDocumentKind reads the content, not the name', () => {
  assert.equal(detectDocumentKind(pdf()), 'pdf');
  assert.equal(detectDocumentKind(docx()), 'word');
  assert.equal(detectDocumentKind(oleDoc()), 'word');
  assert.equal(detectDocumentKind(Buffer.from('plain text file, not a document')), null);
  assert.equal(detectDocumentKind(Buffer.from('MZ\x90\x00 this is an executable')), null);
  assert.equal(detectDocumentKind(Buffer.alloc(0)), null);
});

test('checkUpload enforces slot type, size, empty files and spoofed extensions', () => {
  const slotPdf = slotByKey('manuscript_pdf');
  const slotWord = slotByKey('manuscript_docx');
  const slotAny = slotByKey('abstract');
  assert.equal(checkUpload({ slot: slotPdf, originalName: 'a.pdf', buffer: pdf() }), null);
  assert.equal(checkUpload({ slot: slotWord, originalName: 'a.docx', buffer: docx() }), null);
  assert.equal(checkUpload({ slot: slotWord, originalName: 'a.doc', buffer: oleDoc() }), null);
  assert.equal(checkUpload({ slot: slotAny, originalName: 'a.PDF', buffer: pdf() }), null, 'extension case does not matter');
  assert.match(checkUpload({ slot: slotAny, originalName: 'a.pdf', buffer: Buffer.alloc(0) }), /0 bytes/);
  assert.match(checkUpload({ slot: slotPdf, originalName: 'a.docx', buffer: docx() }), /PDF only/);
  assert.match(checkUpload({ slot: slotWord, originalName: 'a.pdf', buffer: pdf() }), /Word only/);
  assert.match(checkUpload({ slot: slotAny, originalName: 'a.png', buffer: pdf() }), /PDF or Word/);
  assert.match(checkUpload({ slot: slotAny, originalName: 'a.pdf', buffer: Buffer.from('not really a pdf at all') }), /do not match/);
  assert.match(checkUpload({ slot: slotAny, originalName: 'a.docx', buffer: pdf() }), /do not match/);
  assert.match(checkUpload({ slot: slotAny, originalName: 'a.pdf', buffer: Buffer.concat([pdf(), Buffer.alloc(LIMITS.maxFileBytes)]) }), /larger than 20 MB/);
});

test('validateEntry lists every unmet requirement with its step', () => {
  const empty = validateEntry({ presenters: [], keywords: [] }, []);
  const fields = empty.filter(p => p.step === 1).map(p => p.field);
  for (const f of ['title', 'presenters', 'program', 'category', 'presentationType', 'adviser', 'schoolYear', 'semester', 'abstract', 'keywords']) {
    assert.ok(fields.includes(f), `${f} is required`);
  }
  assert.equal(empty.filter(p => p.step === 2).length, GALA_SLOTS.length);

  const ok = { ...VALID(), abstract: 'fine' };
  assert.equal(validateEntry(ok, GALA_SLOTS.map(s => ({ slot: s.key }))).length, 0);
  const step1Fields = (entry) => validateEntry(entry, []).filter(p => p.step === 1).map(p => p.field);
  assert.ok(step1Fields({ ...ok, abstract: words(251) }).includes('abstract'), '251 words is too many');
  assert.ok(!step1Fields({ ...ok, abstract: words(250) }).includes('abstract'), '250 words is allowed');
  assert.ok(validateEntry(ok, []).some(p => p.field === 'doc_abstract'), 'the Abstract document is its own requirement');
  assert.ok(validateEntry({ ...ok, keywords: ['a', 'b'] }, []).some(p => p.field === 'keywords'), 'fewer than 3 keywords');
  assert.ok(!validateEntry({ ...ok, keywords: ['a', 'b', 'c', 'd', 'e'] }, []).some(p => p.field === 'keywords'), '5 keywords is allowed');
  assert.ok(validateEntry({ ...ok, presentationType: 'both' }, []).some(p => p.field === 'presentationType'), 'only Oral or Poster');
});

test('the slides slot is named after the chosen format', () => {
  const [slot] = GALA_SLOTS.filter(s => s.key === 'presentation');
  assert.match(validateEntry({ ...VALID(), presentationType: 'poster' }, []).find(p => p.field === 'doc_presentation').message, /Poster/);
  assert.match(validateEntry({ ...VALID(), presentationType: 'oral' }, []).find(p => p.field === 'doc_presentation').message, /Presentation slides/);
  assert.equal(slot.label, 'Slides or poster');
});

test('clock and date helpers format without timezone shifts', () => {
  assert.equal(formatClock('00:05'), '12:05 AM');
  assert.equal(formatClock('13:30'), '1:30 PM');
  assert.equal(formatClock('25:00'), '');
  assert.equal(formatDay('2026-11-20'), 'Nov 20, 2026');
  assert.equal(formatDay('2026-02-30'), '');
});

test('reference numbers are readable and unambiguous', () => {
  for (let i = 0; i < 50; i++) assert.match(makeRefNo(new Date('2026-10-01')), /^RG-2026-[A-HJKMNP-Z2-9]{6}$/);
});

// ---------------------------------------------------------------
// Who may use it
// ---------------------------------------------------------------
test('an anonymous visitor gets 401 from every route', async () => {
  const api = await startServer();
  const anon = api.as(null);
  for (const [method, path] of [['get', '/config'], ['get', '/'], ['post', '/'], ['get', '/some-id']]) {
    assert.equal((await anon[method](path)).status, 401, `${method} ${path}`);
  }
  await api.close();
});

test('a non-presenter account is blocked from the form on the server', async () => {
  const api = await startServer();
  for (const who of ['stu', 'fac']) {
    const client = api.as(who);
    const create = await client.post('/', VALID());
    assert.equal(create.status, 403, `${who} cannot start an entry`);
    assert.match(create.data.error, /Presenter accounts/);
    assert.equal((await client.get('/config')).status, 403, `${who} cannot load the form settings`);
    assert.equal((await client.get('/')).status, 403, `${who} has no Gala list`);
  }
  assert.equal(api.store.rows.size, 0, 'nothing was stored');
  await api.close();
});

test('an admin reviews entries but cannot start one, upload, or submit', async () => {
  const api = await startServer();
  const id = await makeEntry(api, 'pat', { withFiles: true });
  const admin = api.as('admin');
  assert.equal((await admin.post('/', VALID())).status, 403);
  assert.equal((await admin.upload(`/${id}/files/abstract`, SLOT_FILES.abstract())).status, 403);
  assert.equal((await admin.post(`/${id}/submit`, { confirm: true })).status, 403);
  assert.equal((await admin.patch(`/${id}`, { title: 'Hijacked' })).status, 403);
  await api.close();
});

test('a presenter sees only their own entries, and another presenter\'s id looks missing', async () => {
  const api = await startServer();
  const mine = await makeEntry(api, 'pat');
  const theirs = await makeEntry(api, 'sam', { details: { title: 'Sam\'s study' } });

  const list = await api.as('pat').get('/');
  assert.deepEqual(list.data.submissions.map(s => s.id), [mine]);

  const pat = api.as('pat');
  assert.equal((await pat.get(`/${theirs}`)).status, 404);
  assert.equal((await pat.patch(`/${theirs}`, { title: 'Mine now' })).status, 404);
  assert.equal((await pat.upload(`/${theirs}/files/abstract`, SLOT_FILES.abstract())).status, 404);
  assert.equal((await pat.get(`/${theirs}/files/abstract`)).status, 404);
  assert.equal((await pat.post(`/${theirs}/submit`, { confirm: true })).status, 404);
  assert.equal((await pat.del(`/${theirs}`)).status, 404);
  assert.equal(api.store.rows.get(theirs).title, 'Sam\'s study', 'untouched');
  await api.close();
});

// ---------------------------------------------------------------
// Draft: save and resume
// ---------------------------------------------------------------
test('a presenter saves a draft in stages and resumes it intact', async () => {
  const api = await startServer();
  const pat = api.as('pat');

  const started = await pat.post('/', { title: 'Half-finished idea', presentationType: 'poster' });
  assert.equal(started.status, 201);
  const draft = started.data.submission;
  assert.equal(draft.status, 'draft');
  assert.deepEqual(draft.presenters, ['Pat Presenter'], 'the signed-in presenter is added by default');
  assert.ok(draft.editable);
  assert.equal(draft.refNo, null, 'no reference number until it is submitted');

  const saved = await pat.patch(`/${draft.id}`, { adviser: 'Dr. Ana Adviser', keywords: ['one', 'two'], coAuthors: ['M. Reyes'], step: 2 });
  assert.equal(saved.status, 200);
  assert.ok(saved.data.problems.length > 0, 'a draft saves with its gaps reported, not refused');

  // "Close the browser", then come back: list it and open it.
  const list = await pat.get('/');
  const row = list.data.submissions.find(s => s.id === draft.id);
  assert.equal(row.status, 'draft');
  const resumed = (await pat.get(`/${draft.id}`)).data.submission;
  assert.equal(resumed.title, 'Half-finished idea');
  assert.equal(resumed.presentationType, 'poster');
  assert.equal(resumed.adviser, 'Dr. Ana Adviser');
  assert.deepEqual(resumed.keywords, ['one', 'two']);
  assert.deepEqual(resumed.coAuthors, ['M. Reyes']);
  assert.equal(resumed.draftStep, 2, 'resumes at the step they reached');
  await api.close();
});

test('the signed-in presenter cannot be removed from the presenters', async () => {
  const api = await startServer();
  const pat = api.as('pat');
  const id = await makeEntry(api, 'pat');
  const res = await pat.patch(`/${id}`, { presenters: ['Someone Else'] });
  assert.deepEqual(res.data.submission.presenters, ['Pat Presenter', 'Someone Else']);
  assert.match(api.store.rows.get(id).authors, /Pat Presenter/);
  await api.close();
});

test('a draft is private: reviewers cannot list or open it', async () => {
  const api = await startServer();
  const id = await makeEntry(api, 'pat');
  const admin = api.as('admin');
  assert.deepEqual((await admin.get('/')).data.submissions, []);
  assert.equal((await admin.get(`/${id}`)).status, 404);
  assert.equal((await admin.patch(`/${id}/status`, { status: 'under_checking' })).status, 409);
  await api.close();
});

test('an unlisted program or school year is reported and not stored', async () => {
  const api = await startServer();
  const pat = api.as('pat');
  const id = await makeEntry(api, 'pat');
  const res = await pat.patch(`/${id}`, { program: 'Made Up Course', schoolYear: '1999–2000' });
  assert.equal(res.status, 200);
  assert.equal(res.data.submission.program, '');
  assert.equal(res.data.submission.schoolYear, '');
  assert.ok(res.data.problems.some(p => p.field === 'program' && /from the list/.test(p.message)));
  assert.ok(res.data.problems.some(p => p.field === 'schoolYear'));

  const other = await pat.patch(`/${id}`, { program: 'My Custom Dept', programMode: 'other' });
  assert.equal(other.data.submission.program, 'My Custom Dept', '"Other (please specify)" is accepted as typed');
  await api.close();
});

test('tag lists that would be cut short are refused, not silently truncated', async () => {
  const api = await startServer();
  const pat = api.as('pat');
  const id = await makeEntry(api, 'pat');
  const tooMany = await pat.patch(`/${id}`, { keywords: ['a', 'b', 'c', 'd', 'e', 'f'] });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.data.error, /at most 5/i);
  assert.deepEqual(api.store.rows.get(id).keywords.split(', '), VALID().keywords, 'the stored keywords are untouched');
  await api.close();
});

test('a closed list value is dropped and reported', async () => {
  const api = await startServer();
  const pat = api.as('pat');
  const id = await makeEntry(api, 'pat');
  const res = await pat.patch(`/${id}`, { category: 'astrology', presentationType: 'both', semester: 'fall' });
  assert.equal(res.data.submission.category, '');
  assert.equal(res.data.submission.presentationType, '');
  assert.equal(res.data.submission.semester, '');
  assert.ok(res.data.problems.some(p => p.field === 'presentationType'));
  await api.close();
});

test('the config tells the form everything it needs and nothing about other users', async () => {
  const api = await startServer();
  const cfg = (await api.as('pat').get('/config')).data;
  assert.equal(cfg.presenterName, 'Pat Presenter');
  assert.equal(cfg.slots.length, 6);
  assert.equal(cfg.limits.abstractWordsMax, 250);
  assert.deepEqual(cfg.formats.map(f => f.value), ['oral', 'poster']);
  assert.deepEqual(cfg.schedulePreferences.map(p => p.value), ['none', 'morning', 'afternoon']);
  assert.ok(cfg.schoolYears.length && cfg.categories.length && cfg.semesters.length);
  assert.equal(cfg.currentSchoolYear, '2026–2027');
  await api.close();
});

// ---------------------------------------------------------------
// Documents
// ---------------------------------------------------------------
test('documents are stored under submissions/{user_id}/{submission_id}/final/', async () => {
  const api = await startServer();
  const id = await makeEntry(api, 'pat');
  const res = await api.as('pat').upload(`/${id}/files/manuscript_pdf`, { name: 'My Paper.pdf', body: pdf('main') });
  assert.equal(res.status, 200);
  assert.equal(res.data.submission.docsAttached, 1);
  assert.equal(res.data.submission.files[0].originalName, 'My Paper.pdf');
  const [path] = [...api.files.blobs.keys()];
  assert.match(path, new RegExp(`^submissions/${USERS.pat.id}/${id}/final/manuscript_pdf-[0-9a-f-]{36}\\.pdf$`));
  await api.close();
});

test('the server refuses empty, mistyped, spoofed and oversized documents', async () => {
  const api = await startServer();
  const id = await makeEntry(api, 'pat');
  const pat = api.as('pat');
  const attempt = (slot, file) => pat.upload(`/${id}/files/${slot}`, file);

  const empty = await attempt('abstract', { name: 'abstract.pdf', body: Buffer.alloc(0) });
  assert.equal(empty.status, 400);
  assert.match(empty.data.error, /0 bytes/);

  const wrongType = await attempt('abstract', { name: 'abstract.png', body: pdf() });
  assert.equal(wrongType.status, 400);
  assert.match(wrongType.data.error, /PDF or Word/);

  const exe = await attempt('abstract', { name: 'setup.exe', body: Buffer.from('MZ binary') });
  assert.equal(exe.status, 400);

  const spoofed = await attempt('abstract', { name: 'abstract.pdf', body: Buffer.from('<html><script>alert(1)</script></html>') });
  assert.equal(spoofed.status, 400);
  assert.match(spoofed.data.error, /do not match/);

  const wrongSlot = await attempt('manuscript_pdf', { name: 'final.docx', body: docx() });
  assert.equal(wrongSlot.status, 400);
  assert.match(wrongSlot.data.error, /PDF only/);

  const huge = await attempt('abstract', { name: 'big.pdf', body: Buffer.concat([pdf(), Buffer.alloc(LIMITS.maxFileBytes + 1024)]) });
  assert.equal(huge.status, 400);
  assert.match(huge.data.error, /too large/i);

  const unknownSlot = await attempt('passport_scan', { name: 'a.pdf', body: pdf() });
  assert.equal(unknownSlot.status, 404);

  assert.equal(api.files.blobs.size, 0, 'nothing refused was stored');
  assert.equal((await api.store.get(id)).files.length, 0);
  await api.close();
});

test('the same file cannot be attached twice, and a different file replaces cleanly', async () => {
  const api = await startServer();
  const id = await makeEntry(api, 'pat');
  const pat = api.as('pat');
  const same = pdf('same bytes');

  assert.equal((await pat.upload(`/${id}/files/abstract`, { name: 'abstract.pdf', body: same })).status, 200);

  const elsewhere = await pat.upload(`/${id}/files/endorsement`, { name: 'copy.pdf', body: same });
  assert.equal(elsewhere.status, 409);
  assert.match(elsewhere.data.error, /already attached as "Abstract"/);

  const again = await pat.upload(`/${id}/files/abstract`, { name: 'abstract.pdf', body: same });
  assert.equal(again.status, 409);

  // A genuinely different file replaces the old one and the old object is deleted.
  const [oldPath] = [...api.files.blobs.keys()];
  const replaced = await pat.upload(`/${id}/files/abstract`, { name: 'abstract-v2.pdf', body: pdf('v2') });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.data.submission.docsAttached, 1, 'still one document in that slot');
  assert.equal(replaced.data.submission.files[0].originalName, 'abstract-v2.pdf');
  assert.ok(!api.files.blobs.has(oldPath), 'the replaced file was removed from storage');
  assert.equal(api.files.blobs.size, 1);
  await api.close();
});

test('a document can be removed from a draft, and counts follow', async () => {
  const api = await startServer();
  const id = await makeEntry(api, 'pat');
  const pat = api.as('pat');
  await pat.upload(`/${id}/files/abstract`, SLOT_FILES.abstract());
  await pat.upload(`/${id}/files/ethics`, SLOT_FILES.ethics());
  const removed = await pat.del(`/${id}/files/abstract`);
  assert.equal(removed.status, 200);
  assert.equal(removed.data.submission.docsAttached, 1);
  assert.equal(api.files.blobs.size, 1);
  assert.equal((await pat.del(`/${id}/files/abstract`)).status, 404, 'already gone');
  await api.close();
});

test('only the owner and reviewers can download a document', async () => {
  const api = await startServer();
  const id = await makeEntry(api, 'pat', { withFiles: true });
  const draftDownload = await api.as('admin').get(`/${id}/files/abstract`);
  assert.equal(draftDownload.status, 404, 'a reviewer cannot read a draft');

  assert.equal((await api.as('pat').post(`/${id}/submit`, { confirm: true })).status, 200);

  const owner = await api.as('pat').get(`/${id}/files/manuscript_pdf`);
  assert.equal(owner.status, 200);
  assert.match(owner.headers.get('content-disposition'), /^attachment; filename="final\.pdf"/);
  assert.equal(owner.headers.get('content-type'), 'application/pdf');
  assert.equal(owner.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(detectDocumentKind(owner.data), 'pdf');

  const inline = await api.as('admin').get(`/${id}/files/manuscript_pdf?inline=1`);
  assert.equal(inline.status, 200);
  assert.match(inline.headers.get('content-disposition'), /^inline;/);

  const word = await api.as('admin').get(`/${id}/files/manuscript_docx?inline=1`);
  assert.match(word.headers.get('content-disposition'), /^attachment;/, 'Word is never rendered inline');

  assert.equal((await api.as('sam').get(`/${id}/files/manuscript_pdf`)).status, 404, 'another presenter');
  assert.equal((await api.as('stu').get(`/${id}/files/manuscript_pdf`)).status, 403, 'a student');
  await api.close();
});

// ---------------------------------------------------------------
// Submitting
// ---------------------------------------------------------------
test('submitting with a missing document is blocked', async () => {
  const api = await startServer();
  const id = await makeEntry(api, 'pat');
  const pat = api.as('pat');
  for (const slot of GALA_SLOTS.filter(s => s.key !== 'endorsement')) {
    await pat.upload(`/${id}/files/${slot.key}`, SLOT_FILES[slot.key]());
  }
  const res = await pat.post(`/${id}/submit`, { confirm: true });
  assert.equal(res.status, 422);
  assert.match(res.data.error, /Adviser endorsement/);
  assert.deepEqual(res.data.problems.map(p => p.field), ['doc_endorsement']);
  assert.equal(res.data.problems[0].step, 2);
  assert.equal(api.store.rows.get(id).status, 'draft', 'still a draft');
  assert.equal(api.store.rows.get(id).refNo, undefined, 'no reference number was issued');
  assert.equal(api.notes.length, 0, 'nobody was notified');
  await api.close();
});

test('submitting incomplete details is blocked and says what is missing', async () => {
  const api = await startServer();
  const id = await makeEntry(api, 'pat', { details: { abstract: words(260), keywords: ['solo'] }, withFiles: true });
  const res = await api.as('pat').post(`/${id}/submit`, { confirm: true });
  assert.equal(res.status, 422);
  const fields = res.data.problems.map(p => p.field);
  assert.ok(fields.includes('abstract') && fields.includes('keywords'));
  assert.ok(res.data.problems.every(p => p.step === 1));
  await api.close();
});

test('submitting needs the confirmation', async () => {
  const api = await startServer();
  const id = await makeEntry(api, 'pat', { withFiles: true });
  const res = await api.as('pat').post(`/${id}/submit`, {});
  assert.equal(res.status, 400);
  assert.match(res.data.error, /confirm/i);
  assert.equal(api.store.rows.get(id).status, 'draft');
  await api.close();
});

test('a complete entry submits, returns a reference number and tells people', async () => {
  const api = await startServer({
    account: { [USERS.pat.id]: { email: 'pat@example.test', user_prefs: { inApp: true, email: true } } }
  });
  const id = await makeEntry(api, 'pat', { withFiles: true });
  const pat = api.as('pat');

  const res = await pat.post(`/${id}/submit`, { confirm: true });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.match(res.data.refNo, /^RG-\d{4}-[A-Z0-9]{6}$/);
  const s = res.data.submission;
  assert.equal(s.status, 'submitted');
  assert.equal(s.refNo, res.data.refNo);
  assert.equal(s.docsAttached, 6);
  assert.equal(s.statusHistory.at(-1).status, 'submitted');
  assert.ok(s.submittedAt);

  // Presenter: in-app + email. Reviewers: in-app.
  const mine = api.notes.filter(n => n.userId === USERS.pat.id);
  assert.equal(mine.length, 1);
  assert.match(mine[0].message, new RegExp(res.data.refNo));
  assert.equal(api.emails.length, 1);
  assert.equal(api.emails[0].to, 'pat@example.test');
  assert.deepEqual(api.notes.filter(n => n.userId !== USERS.pat.id).map(n => n.userId).sort(), [USERS.admin.id, USERS.staff.id]);
  assert.equal(api.logs.at(-1).action, 'gala_submitted');
  assert.match(api.logs.at(-1).details, new RegExp(res.data.refNo));

  assert.equal((await pat.post(`/${id}/submit`, { confirm: true })).status, 409, 'cannot submit twice');
  await api.close();
});

test('email is only sent to presenters who asked for it, and is escaped', async () => {
  const api = await startServer({
    account: { [USERS.pat.id]: { email: 'pat@example.test', user_prefs: { inApp: true, email: true } } }
  });
  const id = await makeEntry(api, 'pat', { details: { title: 'Cats <b>&</b> dogs' }, withFiles: true });
  await api.as('pat').post(`/${id}/submit`, { confirm: true });
  assert.ok(!api.emails[0].message.includes('<b>'), 'markup in a title cannot reach the email');
  assert.match(api.emails[0].message, /&lt;b&gt;/);

  const quiet = await startServer();
  const id2 = await makeEntry(quiet, 'pat', { withFiles: true });
  await quiet.as('pat').post(`/${id2}/submit`, { confirm: true });
  assert.equal(quiet.emails.length, 0, 'email is off by default');
  assert.equal(quiet.notes.filter(n => n.userId === USERS.pat.id).length, 1, 'in-app still arrives');
  await api.close();
  await quiet.close();
});

test('two entries cannot share a title', async () => {
  const api = await startServer();
  const first = await makeEntry(api, 'pat', { withFiles: true });
  assert.equal((await api.as('pat').post(`/${first}/submit`, { confirm: true })).status, 200);
  const second = await makeEntry(api, 'pat', { details: { title: first && VALID().title.toUpperCase() }, withFiles: true });
  const res = await api.as('pat').post(`/${second}/submit`, { confirm: true });
  assert.equal(res.status, 409);
  assert.match(res.data.error, /same title|this title/i);
  await api.close();
});

test('a Submitted entry stays editable, but never into an incomplete state', async () => {
  const api = await startServer();
  const id = await makeEntry(api, 'pat', { withFiles: true });
  const pat = api.as('pat');
  await pat.post(`/${id}/submit`, { confirm: true });

  const ok = await pat.patch(`/${id}`, { adviser: 'Dr. New Adviser' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.submission.adviser, 'Dr. New Adviser');

  const blank = await pat.patch(`/${id}`, { title: '   ' });
  assert.equal(blank.status, 422);
  assert.match(blank.data.error, /incomplete/);
  assert.equal(api.store.rows.get(id).title, VALID().title, 'unchanged');

  const rmFile = await pat.del(`/${id}/files/ethics`);
  assert.equal(rmFile.status, 409);
  assert.equal((await pat.upload(`/${id}/files/ethics`, { name: 'new-ethics.pdf', body: pdf('newer') })).status, 200, 'replacing is fine');
  await api.close();
});

// ---------------------------------------------------------------
// Admin: status, remarks, schedule
// ---------------------------------------------------------------
async function submitted(api, who = 'pat', details = {}) {
  const id = await makeEntry(api, who, { details, withFiles: true });
  const res = await api.as(who).post(`/${id}/submit`, { confirm: true });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return id;
}

test('the admin console lists submitted entries with filters', async () => {
  const api = await startServer();
  const a = await submitted(api, 'pat');
  await makeEntry(api, 'pat', { details: { title: 'Still a draft' } });
  await submitted(api, 'sam', { title: 'Poster on soil', presentationType: 'poster', category: 'action_research', schoolYear: '2025–2026' });
  const admin = api.as('admin');

  const all = (await admin.get('/')).data;
  assert.equal(all.submissions.length, 2, 'drafts are left out');
  assert.deepEqual(all.facets.schoolYears.sort(), ['2025–2026', '2026–2027']);
  assert.ok(all.submissions[0].userId, 'reviewers see the owner');

  assert.deepEqual((await admin.get('/?presentationType=poster')).data.submissions.map(s => s.title), ['Poster on soil']);
  assert.deepEqual((await admin.get('/?category=capstone')).data.submissions.map(s => s.id), [a]);
  assert.deepEqual((await admin.get('/?schoolYear=2025–2026')).data.submissions.length, 1);
  assert.equal((await admin.get('/?status=scheduled')).data.submissions.length, 0);
  assert.equal((await admin.get('/?status=nonsense')).status, 400);
  assert.equal((await admin.get('/?q=soil')).data.submissions.length, 1);
  await api.close();
});

test('the admin changes the status and assigns a schedule; the presenter sees the update', async () => {
  const api = await startServer({
    account: { [USERS.pat.id]: { email: 'pat@example.test', user_prefs: { inApp: true, email: true } } }
  });
  const id = await submitted(api);
  const admin = api.as('admin');
  const pat = api.as('pat');
  api.notes.length = 0; api.emails.length = 0;

  // Submitted -> Under Checking
  let res = await admin.patch(`/${id}/status`, { status: 'under_checking' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.submission.status, 'under_checking');
  assert.equal((await pat.get(`/${id}`)).data.submission.statusLabel, 'Under Checking', 'the presenter sees the new status');
  assert.match(api.notes.at(-1).title, /Under Checking/);
  assert.equal(api.notes.at(-1).userId, USERS.pat.id);
  assert.equal(api.emails.length, 1, 'and an email, because they asked for one');

  // Assign a date/time/room BEFORE announcing: the presenter must not see it yet.
  res = await admin.patch(`/${id}/status`, { scheduleDate: '2026-11-20', scheduleTime: '13:30', scheduleRoom: 'Hall A' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.submission.schedule.room, 'Hall A', 'the admin sees it');
  let seen = (await pat.get(`/${id}`)).data.submission;
  assert.equal(seen.schedule, null, 'an unannounced schedule stays private');
  assert.ok(!JSON.stringify(seen.statusHistory).includes('Hall A'), 'and so does the history');
  const quiet = api.notes.length;

  // Under Checking -> Scheduled announces it.
  res = await admin.patch(`/${id}/status`, { status: 'scheduled', remarks: 'See you there.' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  seen = (await pat.get(`/${id}`)).data.submission;
  assert.equal(seen.status, 'scheduled');
  assert.deepEqual(
    { date: seen.schedule.dateLabel, time: seen.schedule.timeLabel, room: seen.schedule.room },
    { date: 'Nov 20, 2026', time: '1:30 PM', room: 'Hall A' }
  );
  assert.equal(seen.remarks, 'See you there.');
  assert.ok(api.notes.length > quiet);
  assert.match(api.notes.at(-1).message, /Nov 20, 2026, 1:30 PM, Hall A/);
  assert.equal(seen.statusHistory.at(-1).by, 'CPRI team', 'presenters see "CPRI team", not staff names');

  // Scheduled -> Presented
  res = await admin.patch(`/${id}/status`, { status: 'presented' });
  assert.equal(res.data.submission.status, 'presented');
  assert.equal((await pat.get(`/${id}`)).data.submission.schedule.room, 'Hall A', 'the schedule stays after presenting');

  // Every change is in the audit log with before -> after.
  const reviews = api.logs.filter(l => l.action === 'gala_reviewed').map(l => l.details);
  assert.equal(reviews.length, 4);
  assert.match(reviews[0], /Submitted -> Under Checking/);
  assert.match(reviews[1], /schedule none -> Nov 20, 2026, 1:30 PM, Hall A/);
  assert.match(reviews[2], /Under Checking -> Scheduled/);
  assert.match(reviews[3], /Scheduled -> Presented/);
  await api.close();
});

test('only allowed status moves are accepted, and some need remarks or a schedule', async () => {
  const api = await startServer();
  const id = await submitted(api);
  const admin = api.as('admin');

  assert.equal((await admin.patch(`/${id}/status`, { status: 'presented' })).status, 409, 'cannot jump to Presented');
  assert.equal((await admin.patch(`/${id}/status`, { status: 'scheduled' })).status, 409, 'must be checked first');
  assert.equal((await admin.patch(`/${id}/status`, { status: 'maybe' })).status, 400);
  assert.equal((await admin.patch(`/${id}/status`, { status: 'draft' })).status, 400);

  const noRemarks = await admin.patch(`/${id}/status`, { status: 'for_revision' });
  assert.equal(noRemarks.status, 400);
  assert.match(noRemarks.data.error, /remarks/i);
  assert.equal((await admin.patch(`/${id}/status`, { status: 'rejected', remarks: '  ' })).status, 400);

  await admin.patch(`/${id}/status`, { status: 'under_checking' });
  const noSchedule = await admin.patch(`/${id}/status`, { status: 'scheduled' });
  assert.equal(noSchedule.status, 400);
  assert.match(noSchedule.data.error, /date, time and room/);
  assert.equal((await admin.patch(`/${id}/status`, { status: 'scheduled', scheduleDate: '2026-13-40', scheduleTime: '10:00', scheduleRoom: 'A' })).status, 400);
  assert.equal((await admin.patch(`/${id}/status`, { status: 'scheduled', scheduleDate: '2026-11-20', scheduleTime: '25:00', scheduleRoom: 'A' })).status, 400);
  assert.equal((await admin.patch(`/${id}/status`, { status: 'scheduled', scheduleDate: '2026-11-20', scheduleTime: '10:00' })).status, 400);
  assert.equal((await admin.patch(`/${id}/status`, {})).status, 400, 'nothing to change');
  assert.equal(api.store.rows.get(id).status, 'under_checking', 'none of the refused moves took effect');
  await api.close();
});

test('two presentations cannot be given the same date, time and room', async () => {
  const api = await startServer();
  const a = await submitted(api, 'pat');
  const b = await submitted(api, 'sam', { title: 'Another study' });
  const admin = api.as('admin');
  const slot = { scheduleDate: '2026-11-20', scheduleTime: '09:00', scheduleRoom: 'Hall A' };
  for (const id of [a, b]) await admin.patch(`/${id}/status`, { status: 'under_checking' });

  assert.equal((await admin.patch(`/${a}/status`, { status: 'scheduled', ...slot })).status, 200);
  const clash = await admin.patch(`/${b}/status`, { status: 'scheduled', ...slot, scheduleRoom: 'hall a' });
  assert.equal(clash.status, 409);
  assert.match(clash.data.error, /already taken/);
  assert.equal((await admin.patch(`/${b}/status`, { status: 'scheduled', ...slot, scheduleTime: '10:00' })).status, 200);
  await api.close();
});

test('a presenter cannot change the status or the schedule', async () => {
  const api = await startServer();
  const id = await submitted(api);
  const pat = api.as('pat');
  assert.equal((await pat.patch(`/${id}/status`, { status: 'scheduled', scheduleDate: '2026-11-20', scheduleTime: '09:00', scheduleRoom: 'X' })).status, 403);
  // Sending status fields through the edit route changes nothing either.
  await pat.patch(`/${id}`, { status: 'presented', scheduleRoom: 'X', refNo: 'RG-FAKE', userId: 'u-sam' });
  const row = api.store.rows.get(id);
  assert.equal(row.status, 'submitted');
  assert.equal(row.scheduleRoom, undefined);
  assert.equal(row.userId, USERS.pat.id, 'ownership cannot be reassigned');
  assert.notEqual(row.refNo, 'RG-FAKE');
  await api.close();
});

test('editing is locked from Under Checking until the entry is sent For Revision', async () => {
  const api = await startServer();
  const id = await submitted(api);
  const pat = api.as('pat');
  const admin = api.as('admin');

  await admin.patch(`/${id}/status`, { status: 'under_checking' });
  const locked = await pat.patch(`/${id}`, { title: 'Sneaky change' });
  assert.equal(locked.status, 409);
  assert.match(locked.data.error, /Under Checking/);
  assert.equal((await pat.upload(`/${id}/files/abstract`, SLOT_FILES.abstract())).status, 409);
  assert.equal((await pat.del(`/${id}/files/abstract`)).status, 409);
  assert.equal((await pat.del(`/${id}`)).status, 409, 'cannot withdraw once checking has started');
  assert.equal(api.store.rows.get(id).title, VALID().title);
  assert.equal((await pat.get(`/${id}`)).data.submission.editable, false);

  // Sent back: editable again, and the remarks explain why.
  const back = await admin.patch(`/${id}/status`, { status: 'for_revision', remarks: 'Abstract is too long.' });
  assert.equal(back.status, 200);
  const view = (await pat.get(`/${id}`)).data.submission;
  assert.equal(view.editable, true);
  assert.equal(view.remarks, 'Abstract is too long.');
  assert.match(api.notes.at(-1).message, /Abstract is too long\./);

  assert.equal((await pat.patch(`/${id}`, { abstract: 'A much shorter abstract.' })).status, 200);
  // For Revision may be saved half-finished...
  assert.equal((await pat.patch(`/${id}`, { adviser: '' })).status, 200);
  // ...but cannot be resubmitted until it is complete again.
  const incomplete = await pat.post(`/${id}/submit`, { confirm: true });
  assert.equal(incomplete.status, 422);
  await pat.patch(`/${id}`, { adviser: 'Dr. Ana Adviser' });

  const refBefore = api.store.rows.get(id).refNo;
  const again = await pat.post(`/${id}/submit`, { confirm: true });
  assert.equal(again.status, 200);
  assert.equal(again.data.submission.status, 'submitted');
  assert.equal(again.data.refNo, refBefore, 'the reference number never changes');
  assert.match(again.data.submission.statusHistory.at(-1).note, /Resubmitted after revision/);
  assert.equal(api.logs.at(-1).action, 'gala_resubmitted');
  await api.close();
});

test('withdrawing: drafts and early entries yes, decided ones no, files go with it', async () => {
  const api = await startServer();
  const draft = await makeEntry(api, 'pat', { details: { title: 'Draft to delete' }, withFiles: true });
  const pat = api.as('pat');
  assert.equal(api.files.blobs.size, 6);
  assert.equal((await pat.del(`/${draft}`)).status, 200);
  assert.equal(api.files.blobs.size, 0, 'the stored documents were deleted too');
  assert.equal(api.store.rows.has(draft), false);
  assert.equal(api.logs.at(-1).action, 'gala_removed');

  const sent = await submitted(api);
  await api.as('admin').patch(`/${sent}/status`, { status: 'under_checking' });
  await api.as('admin').patch(`/${sent}/status`, { status: 'scheduled', scheduleDate: '2026-11-20', scheduleTime: '09:00', scheduleRoom: 'A' });
  assert.equal((await pat.del(`/${sent}`)).status, 409);
  assert.equal((await api.as('admin').del(`/${sent}`)).status, 200, 'an admin can still remove it');
  await api.close();
});

test('remarks alone can be added and clear, and the presenter is told', async () => {
  const api = await startServer();
  const id = await submitted(api);
  const admin = api.as('admin');
  api.notes.length = 0;
  const res = await admin.patch(`/${id}/status`, { remarks: 'Please bring a printed copy.' });
  assert.equal(res.status, 200);
  assert.equal(res.data.submission.status, 'submitted', 'status untouched');
  assert.equal((await api.as('pat').get(`/${id}`)).data.submission.remarks, 'Please bring a printed copy.');
  assert.match(api.notes.at(-1).title, /remarks/i);
  const cleared = await admin.patch(`/${id}/status`, { remarks: '' });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.data.submission.remarks, '');
  await api.close();
});

// ---------------------------------------------------------------
// Export
// ---------------------------------------------------------------
async function scheduledFixture(api) {
  const a = await submitted(api, 'pat', { title: 'Zebra study' });
  const b = await submitted(api, 'sam', { title: 'Alpha study =cmd|calc', presentationType: 'poster', category: 'action_research' });
  await submitted(api, 'pat', { title: 'Not scheduled yet' });
  const admin = api.as('admin');
  for (const [id, time] of [[a, '14:00'], [b, '09:00']]) {
    await admin.patch(`/${id}/status`, { status: 'under_checking' });
    await admin.patch(`/${id}/status`, { status: 'scheduled', scheduleDate: '2026-11-20', scheduleTime: time, scheduleRoom: 'Hall A' });
  }
  return { a, b };
}

test('the program exports as a valid PDF in date/time order, reviewers only', async () => {
  const api = await startServer();
  await scheduledFixture(api);
  const res = await api.as('admin').get('/export?format=pdf');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.match(res.headers.get('content-disposition'), /cpri-research-gala-program-\d{4}-\d{2}-\d{2}\.pdf/);
  const text = res.data.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4') && text.trimEnd().endsWith('%%EOF'));
  const size = Number(text.match(/\/Size (\d+)/)[1]);
  assert.equal(text.match(/xref\n0 \d+\n([\s\S]*?)trailer/)[1].trim().split('\n').length, size, 'xref matches the object count');
  assert.ok(text.indexOf('Alpha study') < text.indexOf('Zebra study'), '9:00 is listed before 2:00 PM');
  assert.ok(!text.includes('Not scheduled yet'), 'only scheduled entries by default');
  assert.equal(api.logs.at(-1).action, 'gala_exported');

  const everything = await api.as('admin').get('/export?format=pdf&include=all');
  assert.ok(everything.data.toString('latin1').includes('Not scheduled yet'));

  const poster = await api.as('admin').get('/export?format=pdf&presentationType=poster');
  const posterText = poster.data.toString('latin1');
  assert.ok(posterText.includes('Alpha study') && !posterText.includes('Zebra study'), 'filters apply');

  assert.equal((await api.as('pat').get('/export?format=pdf')).status, 403);
  assert.equal((await api.as('stu').get('/export?format=pdf')).status, 403);
  assert.equal((await api.as('admin').get('/export?format=docx')).status, 400);
  await api.close();
});

test('the program exports as an Excel workbook that is a well-formed zip', async () => {
  const api = await startServer();
  await scheduledFixture(api);
  const res = await api.as('admin').get('/export?format=xlsx');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const buf = res.data;

  // Walk the central directory and check each entry's CRC against its bytes.
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'starts with a local file header');
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4B, 0x05, 0x06]));
  assert.ok(end > 0, 'has an end-of-central-directory record');
  const count = buf.readUInt16LE(end + 10);
  let offset = buf.readUInt32LE(end + 16);
  const entries = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(offset), 0x02014b50);
    const crc = buf.readUInt32LE(offset + 16);
    const size = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const local = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    assert.equal(crc32(data), crc, `${name} has a valid CRC`);
    entries[name] = data.toString('utf8');
    offset += 46 + nameLen;
  }
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) {
    assert.ok(part in entries, `${part} is present`);
  }
  const sheet = entries['xl/worksheets/sheet1.xml'];
  assert.ok(sheet.includes('Program of Presenters'));
  assert.ok(sheet.indexOf('Alpha study') < sheet.indexOf('Zebra study'));
  assert.ok(!sheet.includes('Not scheduled yet'));
  assert.ok(sheet.includes('t="inlineStr"') && !sheet.includes('<f>'), 'text is never a formula');
  assert.ok(sheet.includes('=cmd|calc'), 'a title starting like a formula is kept as plain text');
  await api.close();
});

test('exports handle an empty program and awkward characters', () => {
  const none = buildProgramPdf([], { heading: 'Nothing yet' });
  assert.ok(none.toString('latin1').includes('No presenters match'));
  assert.ok(buildProgramXlsx([], {}).length > 500);

  const rows = programRows([{
    title: 'Ünïcode — "quotes" & <tags> (parens) \\ back', presenters: ['Ana'], presentationType: 'oral',
    scheduleDate: '2026-11-20', scheduleTime: '08:00', scheduleRoom: 'R1', status: 'scheduled'
  }]);
  const pdfText = buildProgramPdf(rows, {}).toString('latin1');
  assert.ok(pdfText.includes('quotes'));
  assert.ok(buildProgramXlsx(rows, {}).toString('utf8').length > 0);

  // Long rows paginate instead of running off the page.
  const many = programRows(Array.from({ length: 80 }, (_, i) => ({
    title: `Study number ${i} with a reasonably long descriptive title that wraps`, presenters: ['Ana Cruz', 'Ben Diaz'],
    scheduleDate: '2026-11-20', scheduleTime: '08:00', scheduleRoom: `R${i}`, status: 'scheduled'
  })));
  const pages = Number(buildProgramPdf(many, {}).toString('latin1').match(/\/Count (\d+)/)[1]);
  assert.ok(pages > 1, `80 rows span ${pages} pages`);
});

// ---------------------------------------------------------------
// Grammar suggestions (advisory) and the hand-entered Turnitin result
// ---------------------------------------------------------------
const jsonResponse = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('checkGrammar shapes LanguageTool matches and caps suggestions', async () => {
  let sent;
  const result = await checkGrammar('This are wrong.', {
    url: 'http://lt.test',
    fetchImpl: async (url, init) => {
      sent = { url, body: init.body };
      return jsonResponse({ matches: [
        { offset: 5, length: 3, message: 'Use "is".', rule: { id: 'AGREEMENT', category: { name: 'Grammar' } }, replacements: [{ value: 'is' }, { value: 'was' }, { value: 'be' }, { value: 'x' }] },
        { offset: -1, length: 0, message: 'junk' }
      ] });
    }
  });
  assert.equal(sent.url, 'http://lt.test/v2/check');
  assert.match(sent.body, /text=This\+are\+wrong/);
  assert.equal(result.available, true);
  assert.equal(result.issues.length, 1, 'malformed matches are dropped');
  assert.deepEqual(result.issues[0].replacements, ['is', 'was', 'be'], 'at most three suggestions');
  assert.equal(result.issues[0].ruleId, 'AGREEMENT');
});

test('checkGrammar never throws: outages become { available: false }', async () => {
  const down = await checkGrammar('hello', { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.deepEqual([down.available, down.reason], [false, 'unreachable']);
  assert.equal((await checkGrammar('hello', { fetchImpl: async () => jsonResponse({}, 429) })).reason, 'rate_limited');
  assert.equal((await checkGrammar('hello', { fetchImpl: async () => jsonResponse({}, 500) })).reason, 'service_error');
  const slow = await checkGrammar('hello', {
    timeoutMs: 20,
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })
  });
  assert.equal(slow.reason, 'timeout');
  assert.deepEqual((await checkGrammar('   ')).issues, [], 'blank text needs no request');
  assert.equal((await checkGrammar('x'.repeat(20001))).reason, 'too_long');
});

test('POST /grammar is presenter-only, bounded and rate limited', async () => {
  let calls = 0;
  const api = await startServer({
    grammarGapMs: 60000,
    grammar: async () => { calls++; return { available: true, issues: [{ offset: 0, length: 4, message: 'm', replacements: ['r'] }] }; }
  });
  assert.equal((await api.as('stu').post('/grammar', { text: 'hello there' })).status, 403);
  assert.equal((await api.as('admin').post('/grammar', { text: 'hello there' })).status, 403);
  assert.equal((await api.as(null).post('/grammar', { text: 'hello' })).status, 401);
  assert.equal(calls, 0, 'nobody else reached the checker');

  const ok = await api.as('pat').post('/grammar', { text: 'This are a test.' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.available, true);
  assert.equal(ok.data.issues[0].replacements[0], 'r');

  assert.equal((await api.as('pat').post('/grammar', { text: 'This are a test.' })).status, 429, 'a second request inside the gap waits');
  assert.equal((await api.as('sam').post('/grammar', { text: 'Another presenter is not held up.' })).status, 200, 'the limit is per presenter');
  const huge = await api.as('sam').post('/grammar', { text: 'x'.repeat(LIMITS.abstractCharsMax + 1) });
  assert.equal(huge.status, 400);
  assert.equal(calls, 2);
  await api.close();
});

test('an unavailable grammar service is reported, never an error', async () => {
  const api = await startServer({ grammar: async () => ({ available: false, issues: [], reason: 'timeout' }) });
  const res = await api.as('pat').post('/grammar', { text: 'Some text.' });
  assert.equal(res.status, 200);
  assert.deepEqual([res.data.available, res.data.reason, res.data.issues], [false, 'timeout', []]);
  await api.close();
});

test('the Turnitin result is recorded by reviewers, validated, audited and hidden from the presenter', async () => {
  const api = await startServer();
  const id = await submitted(api);
  const admin = api.as('admin');
  const pat = api.as('pat');

  assert.equal((await pat.patch(`/${id}/status`, { similarityScore: 5 })).status, 403, 'presenters cannot record it');
  assert.equal((await admin.patch(`/${id}/status`, { similarityScore: 140 })).status, 400);
  assert.equal((await admin.patch(`/${id}/status`, { similarityScore: 'abc' })).status, 400);
  assert.equal((await admin.patch(`/${id}/status`, { similarityScore: -1 })).status, 400);
  assert.equal((await admin.patch(`/${id}/status`, { similarityReportUrl: 'javascript:alert(1)' })).status, 400);
  assert.equal((await admin.patch(`/${id}/status`, { similarityReportUrl: 'ftp://x.test/r' })).status, 400);

  const notesBefore = api.notes.length;
  const url = 'https://school.turnitin.test/report/42';
  const res = await admin.patch(`/${id}/status`, { similarityScore: '17.456%', similarityReportUrl: url });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.submission.status, 'submitted', 'recording a score changes no status');
  const sim = res.data.submission.similarity;
  assert.deepEqual([sim.score, sim.reportUrl, sim.checkedBy], [17.46, url, 'Site Admin']);
  assert.ok(sim.checkedAt);
  assert.equal(api.notes.length, notesBefore, 'the presenter is not notified about it');
  assert.ok(api.logs.at(-1).details.includes(`Turnitin similarity none -> 17.46% (${url})`));

  // The presenter's view carries no trace of it, anywhere in the payload.
  const seen = (await pat.get(`/${id}`)).data;
  assert.equal(seen.submission.similarity, undefined);
  assert.ok(!JSON.stringify(seen).includes('17.46') && !JSON.stringify(seen).includes('turnitin'));
  assert.ok(!JSON.stringify((await pat.get('/')).data).includes('turnitin'));
  assert.ok(!JSON.stringify(seen.submission.statusHistory).includes('imilar'), 'and not in their history');

  // Advisory: a very high score never stops the entry moving on.
  await admin.patch(`/${id}/status`, { similarityScore: 99 });
  assert.equal((await admin.patch(`/${id}/status`, { status: 'under_checking' })).status, 200);
  assert.equal((await admin.get('/')).data.submissions[0].similarity.score, 99);

  // The same value again is "nothing to change"; empty values clear it.
  assert.equal((await admin.patch(`/${id}/status`, { similarityScore: 99 })).status, 400);
  const cleared = await admin.patch(`/${id}/status`, { similarityScore: '', similarityReportUrl: '' });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.data.submission.similarity.score, null);
  assert.equal(cleared.data.submission.similarity.reportUrl, '');
  await api.close();
});

test('the Excel program carries the similarity score but the PDF program does not', async () => {
  const api = await startServer();
  const { a } = await scheduledFixture(api);
  await api.as('admin').patch(`/${a}/status`, { similarityScore: 31 });
  const text = (await api.as('admin').get('/export?format=xlsx')).data.toString('utf8');
  assert.ok(text.includes('Turnitin similarity') && text.includes('31%'));
  const pdfText = (await api.as('admin').get('/export?format=pdf')).data.toString('latin1');
  assert.ok(!pdfText.includes('Turnitin') && !pdfText.includes('31%'), 'the printed program stays free of it');
  await api.close();
});
