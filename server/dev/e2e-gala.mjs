// Live end-to-end check of the Research Gala final-paper flow.
//
//   node --env-file=.env.staging server/dev/e2e-gala.mjs http://127.0.0.1:3055
//
// Drives a RUNNING server over real HTTP with real sessions, so it covers what
// the offline tests cannot: the SQL, the page gating in server.js, the session
// cookie, the in-app notification rows and the audit log.
//
// It creates throwaway accounts (e2e-gala-*), runs the scenario, then deletes
// everything it created. For safety it refuses to run unless the database name
// contains "staging" — pass --allow-db to override on purpose.
import { randomUUID, randomBytes } from 'crypto';
import { rm } from 'fs/promises';
import { join } from 'path';
import bcrypt from 'bcryptjs';
import './../load-env.js';
import { all, get, run, insert } from '../server/db/queries.js';
import { zipStore } from '../lib/gala-export.js';

const base = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const allowAnyDb = process.argv.includes('--allow-db');

const dbName = (await get('SELECT DATABASE() AS d')).d;
if (!/staging/i.test(dbName) && !allowAnyDb) {
  console.error(`Refusing to run against database "${dbName}" (not a staging database). Use --allow-db to override.`);
  process.exit(2);
}
console.log(`Database: ${dbName}   Server: ${base}\n`);

// ---------- tiny HTTP client with a cookie jar ----------
function client() {
  let cookie = '';
  const call = async (method, path, body, { redirect = 'follow' } = {}) => {
    const isForm = body instanceof FormData;
    const res = await fetch(base + path, {
      method,
      redirect,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {})
      },
      body: body === undefined ? undefined : (isForm ? body : JSON.stringify(body))
    });
    const set = res.headers.getSetCookie?.() || [];
    if (set.length) cookie = set.map(c => c.split(';')[0]).join('; ');
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json().catch(() => ({})) : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  };
  return {
    get: (p, o) => call('GET', p, undefined, o),
    post: (p, b) => call('POST', p, b ?? {}),
    patch: (p, b) => call('PATCH', p, b ?? {}),
    del: (p) => call('DELETE', p),
    upload: (p, name, bytes) => {
      const fd = new FormData();
      fd.append('file', new Blob([bytes]), name);
      return call('POST', p, fd);
    }
  };
}

// ---------- results ----------
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : detail ? `  -> ${detail}` : ''}`);
}
const section = (title) => console.log(`\n${title}`);

// ---------- throwaway accounts ----------
const tag = randomBytes(3).toString('hex');
const password = 'E2e-' + randomBytes(6).toString('hex');
const hash = await bcrypt.hash(password, 8);
const accounts = {};
async function makeAccount(key, role, fullName) {
  const id = `e2e-gala-${key}-${tag}`;
  const username = `e2egala_${key}_${tag}`;
  await insert('users', {
    id, username, email: `${username}@example.test`, fullName, role, passwordHash: hash, status: 'active',
    createdAt: new Date().toISOString(), setupPending: 0
  });
  accounts[key] = { id, username, fullName };
  return accounts[key];
}
async function signIn(key) {
  const c = client();
  const res = await c.post('/api/auth/login', { identifier: accounts[key].username, password });
  if (res.status !== 200) throw new Error(`login failed for ${key}: ${res.status} ${JSON.stringify(res.data)}`);
  return c;
}

// ---------- fixtures ----------
let n = 0;
const pdf = () => Buffer.from(`%PDF-1.4\n% e2e ${++n} ${tag}\n1 0 obj\n<<>>\nendobj\n%%EOF\n`);
const docx = () => zipStore([
  { name: '[Content_Types].xml', data: '<Types/>' },
  { name: 'word/document.xml', data: `<doc>e2e ${++n} ${tag}</doc>` }
]);
const SLOTS = {
  manuscript_pdf: ['final.pdf', pdf],
  manuscript_docx: ['final.docx', docx],
  abstract: ['abstract.pdf', pdf],
  presentation: ['slides.pdf', pdf],
  endorsement: ['endorsement.pdf', pdf],
  ethics: ['ethics.docx', docx]
};

let createdSubmissionIds = [];

async function cleanup() {
  const ids = Object.values(accounts).map(a => a.id);
  if (!ids.length) return;
  const marks = ids.map(() => '?').join(',');
  try {
    await run(`DELETE FROM gala_submissions WHERE userId IN (${marks})`, ids);
    await run(`DELETE FROM notifications WHERE userId IN (${marks})`, ids);
    await run(`DELETE FROM system_logs WHERE userId IN (${marks})`, ids);
    await run(`DELETE FROM users WHERE id IN (${marks})`, ids);
    for (const a of Object.values(accounts)) {
      await rm(join(process.cwd(), 'server', 'data', 'gala-files', 'submissions', a.id), { recursive: true, force: true });
    }
    console.log('\nCleaned up the test accounts, submissions, notifications and log rows.');
  } catch (err) {
    console.error('\nCLEANUP FAILED — remove rows for ids like e2e-gala-*-' + tag + ' by hand:', err.message);
  }
}

try {
  await makeAccount('pat', 'presenter', 'Pat E2E Presenter');
  await makeAccount('sam', 'presenter', 'Sam E2E Speaker');
  await makeAccount('stu', 'student_researcher', 'Stu E2E Student');
  await makeAccount('adm', 'admin', 'Ada E2E Admin');

  const anon = client();
  const pat = await signIn('pat');
  const sam = await signIn('sam');
  const stu = await signIn('stu');
  const adm = await signIn('adm');

  // Real lists the form validates against.
  const courses = (await anon.get('/api/courses')).data.courses || [];
  const program = (courses.find(c => c.isActive !== false) || {}).name;
  const years = (await anon.get('/api/school-years')).data;
  const schoolYear = years.current;
  if (!program || !schoolYear) throw new Error('staging has no active course or school year to test with');

  const details = {
    title: `E2E ${tag}: Adaptive Learning in Rural Schools`,
    presenters: ['Lee E2E Partner'],
    coAuthors: ['M. Reyes'],
    program,
    category: 'capstone',
    presentationType: 'oral',
    adviser: 'Dr. Ana Adviser',
    schoolYear,
    semester: '1st',
    abstract: 'A study of adaptive learning platforms in rural secondary schools.',
    keywords: ['adaptive learning', 'rural education', 'blended'],
    schedulePreference: 'morning'
  };

  // ------------------------------------------------------------------
  section('1. Only Presenter accounts can open the form (pages and API)');
  for (const page of ['gala-form.html', 'gala-success.html', 'gala-submission.html', 'presenter-dashboard.html']) {
    const asPresenter = await pat.get('/' + page, { redirect: 'manual' });
    check(`presenter can open ${page}`, asPresenter.status === 200, `status ${asPresenter.status}`);
    const asStudent = await stu.get('/' + page, { redirect: 'manual' });
    check(`student is redirected away from ${page}`, asStudent.status === 302 && /account\.html/.test(asStudent.headers.get('location') || ''), `status ${asStudent.status} -> ${asStudent.headers.get('location')}`);
    const asAdmin = await adm.get('/' + page, { redirect: 'manual' });
    check(`admin is redirected away from ${page}`, asAdmin.status === 302, `status ${asAdmin.status}`);
    const asAnon = await anon.get('/' + page, { redirect: 'manual' });
    check(`signed-out visitor is sent to login for ${page}`, asAnon.status === 302 && /login\.html/.test(asAnon.headers.get('location') || ''), `status ${asAnon.status}`);
  }
  check('student cannot load the form settings (API 403)', (await stu.get('/api/gala/config')).status === 403);
  check('student cannot start an entry (API 403)', (await stu.post('/api/gala', details)).status === 403);
  check('admin cannot start an entry (API 403)', (await adm.post('/api/gala', details)).status === 403);
  check('signed-out visitor gets 401 from the API', (await anon.get('/api/gala')).status === 401);

  // ------------------------------------------------------------------
  section('2. A presenter saves a draft and resumes it');
  const cfg = (await pat.get('/api/gala/config')).data;
  check('config lists categories, school years and 6 document slots', cfg.categories?.length > 0 && cfg.schoolYears?.length > 0 && cfg.slots?.length === 6);
  check('config carries the signed-in presenter\'s name', cfg.presenterName === accounts.pat.fullName);

  const started = await pat.post('/api/gala', { title: details.title, presentationType: 'oral' });
  check('starting a draft returns 201 and status draft', started.status === 201 && started.data.submission.status === 'draft', JSON.stringify(started.data));
  const id = started.data.submission.id;
  createdSubmissionIds.push(id);
  check('the signed-in presenter is added by default', started.data.submission.presenters[0] === accounts.pat.fullName);

  const saved = await pat.patch(`/api/gala/${id}`, { ...details, step: 2 });
  check('saving the details works against the real database', saved.status === 200, JSON.stringify(saved.data));
  check('listed Program and School Year were accepted', saved.data.submission?.program === program && saved.data.submission?.schoolYear === schoolYear, `${saved.data.submission?.program} / ${saved.data.submission?.schoolYear}`);

  const list = await pat.get('/api/gala');
  check('the draft appears in the presenter\'s list (resume from My Account)', list.data.submissions?.some(s => s.id === id && s.status === 'draft'));
  const resumed = (await pat.get(`/api/gala/${id}`)).data.submission;
  check('resuming returns everything that was saved', resumed.title === details.title && resumed.coAuthors[0] === 'M. Reyes' && resumed.keywords.length === 3 && resumed.draftStep === 2 && resumed.schedulePreference === 'morning');
  check('JSON columns round-trip as arrays', Array.isArray(resumed.presenters) && Array.isArray(resumed.files) && resumed.presenters.includes('Lee E2E Partner'));

  const bad = await pat.patch(`/api/gala/${id}`, { program: 'Not A Real Course', schoolYear: '1999–2000' });
  check('an unlisted program and school year are both refused, not stored', bad.data.submission?.program === '' && bad.data.submission?.schoolYear === '', JSON.stringify([bad.data.submission?.program, bad.data.submission?.schoolYear]));
  await pat.patch(`/api/gala/${id}`, { program, schoolYear });

  check('another presenter cannot see the draft', (await sam.get(`/api/gala/${id}`)).status === 404);
  check('the admin cannot see a draft', (await adm.get(`/api/gala/${id}`)).status === 404);

  // ------------------------------------------------------------------
  section('3. Documents: validation and storage');
  const up = (who, slot, name, bytes) => who.upload(`/api/gala/${id}/files/${slot}`, name, bytes);
  check('0-byte file refused', (await up(pat, 'abstract', 'abstract.pdf', Buffer.alloc(0))).status === 400);
  check('wrong type (.png) refused', (await up(pat, 'abstract', 'abstract.png', pdf())).status === 400);
  check('spoofed content (.pdf that is HTML) refused', (await up(pat, 'abstract', 'abstract.pdf', Buffer.from('<html><script>1</script></html>'))).status === 400);
  check('Word file refused in the PDF-only slot', (await up(pat, 'manuscript_pdf', 'x.docx', docx())).status === 400);
  check('over 20 MB refused', (await up(pat, 'abstract', 'big.pdf', Buffer.concat([pdf(), Buffer.alloc(21 * 1024 * 1024)]))).status === 400);
  check('another presenter cannot upload to this draft', (await up(sam, 'abstract', 'a.pdf', pdf())).status === 404);

  for (const slot of ['manuscript_pdf', 'manuscript_docx', 'abstract', 'presentation', 'ethics']) {
    const [name, make] = SLOTS[slot];
    const res = await up(pat, slot, name, make());
    check(`attach ${slot}`, res.status === 200, JSON.stringify(res.data));
  }
  const dupe = pdf();
  await up(pat, 'endorsement', 'endorsement.pdf', dupe);
  const dup = await up(pat, 'abstract', 'copy.pdf', dupe);
  check('the same file cannot be attached to a second slot (409)', dup.status === 409, `status ${dup.status}`);
  await pat.del(`/api/gala/${id}/files/endorsement`);

  const stored = await get('SELECT files FROM gala_submissions WHERE id = ?', [id]);
  const fileRows = typeof stored.files === 'string' ? JSON.parse(stored.files) : stored.files;
  check('stored under submissions/{user_id}/{submission_id}/final/',
    fileRows.length === 5 && fileRows.every(f => f.storagePath.startsWith(`submissions/${accounts.pat.id}/${id}/final/`)),
    fileRows.map(f => f.storagePath).join(', '));
  const afterUploads = (await pat.get(`/api/gala/${id}`)).data.submission;
  check('"5 of 6 required documents attached"', afterUploads.docsAttached === 5 && afterUploads.docsRequired === 6);

  // ------------------------------------------------------------------
  section('4. Submitting');
  const blocked = await pat.post(`/api/gala/${id}/submit`, { confirm: true });
  check('submitting with a missing document is blocked (422)', blocked.status === 422 && blocked.data.problems?.some(p => p.field === 'doc_endorsement'), JSON.stringify(blocked.data));
  const stillDraft = await get('SELECT status, refNo FROM gala_submissions WHERE id = ?', [id]);
  check('it stays a draft with no reference number', stillDraft.status === 'draft' && !stillDraft.refNo);

  await up(pat, 'endorsement', 'endorsement.pdf', pdf());
  check('submitting without the confirmation is refused', (await pat.post(`/api/gala/${id}/submit`, {})).status === 400);
  const done = await pat.post(`/api/gala/${id}/submit`, { confirm: true });
  check('a complete entry submits (200)', done.status === 200, JSON.stringify(done.data));
  const refNo = done.data.refNo;
  check('a reference number is issued (RG-YYYY-XXXXXX)', /^RG-\d{4}-[A-Z0-9]{6}$/.test(refNo || ''), refNo);
  const row = await get('SELECT status, refNo, submittedAt FROM gala_submissions WHERE id = ?', [id]);
  check('the database row is Submitted with the same reference', row.status === 'submitted' && row.refNo === refNo && !!row.submittedAt);
  check('submitting twice is refused (409)', (await pat.post(`/api/gala/${id}/submit`, { confirm: true })).status === 409);

  const success = await pat.get(`/api/gala/${id}`);
  check('the success page can load the reference number', success.data.submission.refNo === refNo);

  // ------------------------------------------------------------------
  section('5. Admin: review, status, remarks, schedule');
  const adminList = await adm.get('/api/gala?status=submitted');
  const listed = adminList.data.submissions?.find(s => s.id === id);
  check('the admin console lists the entry', !!listed, JSON.stringify(adminList.data).slice(0, 200));
  check('filters work (category, format, school year)',
    (await adm.get(`/api/gala?category=capstone&presentationType=oral&schoolYear=${encodeURIComponent(schoolYear)}`)).data.submissions?.some(s => s.id === id)
    && !(await adm.get('/api/gala?presentationType=poster')).data.submissions?.some(s => s.id === id));
  const view = await adm.get(`/api/gala/${id}/files/manuscript_pdf?inline=1`);
  check('the admin can open a document inline (PDF)', view.status === 200 && /^inline/.test(view.headers.get('content-disposition')) && view.data.subarray(0, 5).toString() === '%PDF-');
  check('the admin can download a Word document', (await adm.get(`/api/gala/${id}/files/ethics`)).status === 200);
  check('another presenter cannot download it', (await sam.get(`/api/gala/${id}/files/abstract`)).status === 404);
  check('a presenter cannot change the status (403)', (await pat.patch(`/api/gala/${id}/status`, { status: 'scheduled' })).status === 403);

  check('Submitted -> Presented is refused', (await adm.patch(`/api/gala/${id}/status`, { status: 'presented' })).status === 409);
  const checking = await adm.patch(`/api/gala/${id}/status`, { status: 'under_checking', remarks: 'Looks good so far.' });
  check('admin sets Under Checking', checking.status === 200, JSON.stringify(checking.data));

  const locked = await pat.patch(`/api/gala/${id}`, { adviser: 'Sneaky Change' });
  check('the presenter can no longer edit (409)', locked.status === 409, `status ${locked.status}`);
  check('nor upload', (await up(pat, 'abstract', 'abstract2.pdf', pdf())).status === 409);

  const noSched = await adm.patch(`/api/gala/${id}/status`, { status: 'scheduled' });
  check('Scheduled needs a date, time and room (400)', noSched.status === 400);
  const sched = await adm.patch(`/api/gala/${id}/status`, { status: 'scheduled', scheduleDate: '2026-11-20', scheduleTime: '13:30', scheduleRoom: `Hall ${tag}`, remarks: 'See you there.' });
  check('admin assigns a date, time and room and marks it Scheduled', sched.status === 200, JSON.stringify(sched.data));

  const seen = (await pat.get(`/api/gala/${id}`)).data.submission;
  check('the presenter sees the new status', seen.status === 'scheduled' && seen.statusLabel === 'Scheduled');
  check('the presenter sees the schedule', seen.schedule?.dateLabel === 'Nov 20, 2026' && seen.schedule?.timeLabel === '1:30 PM' && seen.schedule?.room === `Hall ${tag}`, JSON.stringify(seen.schedule));
  check('the presenter sees the remarks', seen.remarks === 'See you there.');
  check('the history shows the steps without staff names', seen.statusHistory.map(h => h.label).join('>') === 'Submitted>Under Checking>Scheduled' && seen.statusHistory.slice(1).every(h => h.by === 'CPRI team'), JSON.stringify(seen.statusHistory.map(h => [h.label, h.by])));

  const notes = (await pat.get('/api/notifications')).data;
  const galaNotes = (notes.notifications || []).filter(x => /Gala/i.test(x.title));
  check('the presenter got in-app notifications for each change', galaNotes.length >= 3, galaNotes.map(x => x.title).join(' | '));
  check('the Scheduled notification carries the schedule', galaNotes.some(x => /Nov 20, 2026, 1:30 PM/.test(x.message)));
  check('each notification links to the submission', galaNotes.every(x => /gala-submission\.html\?id=/.test(x.link || '')));
  const adminNotes = ((await adm.get('/api/notifications')).data.notifications || []).filter(x => /Gala/i.test(x.title));
  check('admins were notified of the new submission', adminNotes.some(x => new RegExp(refNo).test(x.message)));

  // schedule conflict
  const other = await sam.post('/api/gala', { ...details, title: `E2E ${tag} second`, presenters: [] });
  const id2 = other.data.submission.id;
  createdSubmissionIds.push(id2);
  for (const slot of Object.keys(SLOTS)) await sam.upload(`/api/gala/${id2}/files/${slot}`, SLOTS[slot][0], SLOTS[slot][1]());
  check('a second presenter submits', (await sam.post(`/api/gala/${id2}/submit`, { confirm: true })).status === 200);
  await adm.patch(`/api/gala/${id2}/status`, { status: 'under_checking' });
  const clash = await adm.patch(`/api/gala/${id2}/status`, { status: 'scheduled', scheduleDate: '2026-11-20', scheduleTime: '13:30', scheduleRoom: `hall ${tag}` });
  check('the same date, time and room cannot be given twice (409)', clash.status === 409, `status ${clash.status}`);
  check('a different room works', (await adm.patch(`/api/gala/${id2}/status`, { status: 'scheduled', scheduleDate: '2026-11-20', scheduleTime: '13:30', scheduleRoom: `Room ${tag}` })).status === 200);

  // revision loop
  const third = await sam.post('/api/gala', { ...details, title: `E2E ${tag} third`, presenters: [] });
  const id3 = third.data.submission.id;
  createdSubmissionIds.push(id3);
  for (const slot of Object.keys(SLOTS)) await sam.upload(`/api/gala/${id3}/files/${slot}`, SLOTS[slot][0], SLOTS[slot][1]());
  await sam.post(`/api/gala/${id3}/submit`, { confirm: true });
  check('For Revision needs remarks (400)', (await adm.patch(`/api/gala/${id3}/status`, { status: 'for_revision' })).status === 400);
  await adm.patch(`/api/gala/${id3}/status`, { status: 'under_checking' });
  await adm.patch(`/api/gala/${id3}/status`, { status: 'for_revision', remarks: 'Shorten the abstract.' });
  check('For Revision unlocks editing', (await sam.patch(`/api/gala/${id3}`, { abstract: 'Shorter abstract text.' })).status === 200);
  const resub = await sam.post(`/api/gala/${id3}/submit`, { confirm: true });
  const ref3 = (await get('SELECT refNo FROM gala_submissions WHERE id = ?', [id3])).refNo;
  check('resubmitting returns to Submitted and keeps the reference number', resub.status === 200 && resub.data.submission.status === 'submitted' && resub.data.refNo === ref3);

  // presented
  check('Scheduled -> Presented', (await adm.patch(`/api/gala/${id}/status`, { status: 'presented' })).status === 200);

  // ------------------------------------------------------------------
  section('5b. Grammar suggestions and the Turnitin record');
  const g1 = await pat.post('/api/gala/grammar', { text: 'This are a testt of the grammer checker.' });
  check('grammar endpoint answers 200 with a clear shape (service up or down)', g1.status === 200 && typeof g1.data.available === 'boolean' && Array.isArray(g1.data.issues), JSON.stringify(g1.data));
  console.log(`        (LanguageTool ${g1.data.available ? `reachable, ${g1.data.issues.length} suggestion(s)` : `unavailable: ${g1.data.reason}`})`);
  check('a second request straight away is rate limited (429)', (await pat.post('/api/gala/grammar', { text: 'Again.' })).status === 429);
  check('a student cannot use the grammar endpoint (403)', (await stu.post('/api/gala/grammar', { text: 'Hello.' })).status === 403);

  const turn = await adm.patch(`/api/gala/${id}/status`, { similarityScore: '18.5', similarityReportUrl: 'https://school.example.test/turnitin/abc' });
  check('admin records the Turnitin score and report link', turn.status === 200 && turn.data.submission.similarity?.score === 18.5, JSON.stringify(turn.data));
  const afterTurn = await get('SELECT similarityScore, similarityReportUrl, similarityCheckedBy FROM gala_submissions WHERE id = ?', [id]);
  check('it is stored in the database with who recorded it', Number(afterTurn.similarityScore) === 18.5 && afterTurn.similarityCheckedBy === accounts.adm.fullName, JSON.stringify(afterTurn));
  const presenterView = JSON.stringify((await pat.get(`/api/gala/${id}`)).data) + JSON.stringify((await pat.get('/api/gala')).data);
  check('the presenter never sees the score or link', !/similarity|turnitin|18\.5/i.test(presenterView));
  check('a presenter cannot record a score (403)', (await pat.patch(`/api/gala/${id}/status`, { similarityScore: 1 })).status === 403);
  check('the score is in the Excel export', (await adm.get('/api/gala/export?format=xlsx')).data.includes('18.5%'));

  // Normal Research Submissions: same record, real SQL, no leak to the researcher.
  const rsId = `e2e-gala-rs-${tag}`;
  await insert('research_submissions', { id: rsId, owner_id: accounts.stu.id, owner_name: accounts.stu.fullName, owner_role: 'student_researcher', stage: 'final', title: `E2E ${tag} research`, status: 'submitted' });
  check('student cannot record a similarity result (403)', (await stu.patch(`/api/research-submissions/${rsId}/similarity`, { score: 5 })).status === 403);
  const rs = await adm.patch(`/api/research-submissions/${rsId}/similarity`, { score: 12, reportUrl: 'https://school.example.test/t/9' });
  check('admin records it on a research submission', rs.status === 200 && Number(rs.data.submission.similarity_score) === 12, JSON.stringify(rs.data));
  const studentDetail = JSON.stringify((await stu.get(`/api/research-submissions/${rsId}`)).data);
  check('the student\'s detail response has no similarity fields', !/similarity|turnitin/i.test(studentDetail));
  check('the student\'s list response has no similarity fields', !/similarity|turnitin/i.test(JSON.stringify((await stu.get('/api/research-submissions')).data)));
  const adminDetail = (await adm.get(`/api/research-submissions/${rsId}`)).data.submission;
  check('admin sees it on the detail response', Number(adminDetail.similarity_score) === 12 && adminDetail.similarity_report_url === 'https://school.example.test/t/9');
  await run('DELETE FROM research_submissions WHERE id = ?', [rsId]);

  // ------------------------------------------------------------------
  section('6. Export the program');
  const exportPdf = await adm.get(`/api/gala/export?format=pdf&schoolYear=${encodeURIComponent(schoolYear)}`);
  check('PDF export', exportPdf.status === 200 && exportPdf.data.subarray(0, 5).toString() === '%PDF-' && exportPdf.data.toString('latin1').includes(`E2E ${tag}`), `status ${exportPdf.status}`);
  const exportXlsx = await adm.get('/api/gala/export?format=xlsx');
  check('Excel export is a zip containing the sheet', exportXlsx.status === 200 && exportXlsx.data.readUInt32LE(0) === 0x04034b50 && exportXlsx.data.includes('xl/worksheets/sheet1.xml') && exportXlsx.data.includes(`E2E ${tag}`));
  check('a presenter cannot export (403)', (await pat.get('/api/gala/export?format=pdf')).status === 403);

  // ------------------------------------------------------------------
  section('7. Audit log');
  const ids = Object.values(accounts).map(a => a.id);
  const logs = await all(`SELECT action, details FROM system_logs WHERE userId IN (${ids.map(() => '?').join(',')}) AND action LIKE 'gala_%'`, ids);
  const actions = new Set(logs.map(l => l.action));
  for (const a of ['gala_draft_created', 'gala_draft_saved', 'gala_file_uploaded', 'gala_file_removed', 'gala_submitted', 'gala_resubmitted', 'gala_reviewed', 'gala_exported']) {
    check(`audit log has ${a}`, actions.has(a));
  }
  check('status change entries show before -> after', logs.some(l => l.action === 'gala_reviewed' && /Submitted -> Under Checking/.test(l.details)));
  check('schedule entries show the slot', logs.some(l => l.action === 'gala_reviewed' && new RegExp(`Hall ${tag}`).test(l.details)));

  // ------------------------------------------------------------------
  section('8. Presenter withdraws a draft');
  const tmp = (await pat.post('/api/gala', { title: `E2E ${tag} throwaway` })).data.submission.id;
  await pat.upload(`/api/gala/${tmp}/files/abstract`, 'a.pdf', pdf());
  check('deleting a draft works', (await pat.del(`/api/gala/${tmp}`)).status === 200);
  check('it is gone', (await get('SELECT id FROM gala_submissions WHERE id = ?', [tmp])) === null);
  check('a decided entry cannot be withdrawn (409)', (await pat.del(`/api/gala/${id}`)).status === 409);
} catch (err) {
  console.error('\nE2E aborted:', err);
  results.push({ name: 'script completed', ok: false });
} finally {
  await cleanup();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length) failed.forEach(f => console.log('  FAILED:', f.name));
  process.exit(failed.length ? 1 : 0);
}
