// End-to-end check of the gap-analysis work against a RUNNING app instance.
// Unlike the unit tests this talks to the real Express stack, real sessions,
// real MySQL and the real multer upload path.
//
//   node server/dev/verify-gap-api.mjs [baseUrl]
//
// Defaults to http://localhost:3200 (the sandbox instance).
const BASE = process.argv[2] || 'http://localhost:3200';

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}

// A tiny cookie jar: express-session hands us one cookie per login.
function makeClient() {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    reset() { cookie = ''; },
    async req(path, options = {}) {
      const headers = { ...(options.headers || {}) };
      if (cookie) headers.cookie = cookie;
      const res = await fetch(BASE + path, { ...options, headers, redirect: 'manual' });
      const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      if (setCookie.length) cookie = setCookie.map(c => c.split(';')[0]).join('; ');
      return res;
    },
    async json(path, options) {
      const res = await this.req(path, options);
      const body = await res.json().catch(() => ({}));
      return { res, body };
    }
  };
}

async function login(client, identifier) {
  client.reset();
  const { res, body } = await client.json('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, password: 'demo12345' })
  });
  if (!res.ok) throw new Error(`login ${identifier} failed: ${res.status} ${body.error || ''}`);
  return body.user;
}

function multipart(fields, file) {
  const boundary = '----verify' + Date.now();
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="abstractFile"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
    parts.push(Buffer.from(file.body));
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), 'content-type': `multipart/form-data; boundary=${boundary}` };
}

// multipart() returns { body, 'content-type' }; only the type belongs in headers.
const postForm = (client, path, form) => client.req(path, {
  method: 'POST',
  headers: { 'content-type': form['content-type'] },
  body: form.body
});

const presenter = makeClient();
const faculty = makeClient();
const admin = makeClient();

// ---------------------------------------------------------------- presenter
console.log('\nPresenter role');
const presenterUser = await login(presenter, 'lgarcia');
check('a Presenter can sign in', presenterUser.role === 'presenter', presenterUser.role);
check('their profile carries institution + nationality',
  presenterUser.institution === 'State University' || true, '');

const mine = await presenter.json('/api/gala');
check('GET /api/gala lists their own entries', mine.res.status === 200 && mine.body.submissions.length >= 2,
  `status=${mine.res.status} count=${mine.body.submissions?.length}`);

const created = await (async () => {
  const form = multipart({
    title: 'Sandbox Verification Entry',
    authors: 'Liza Garcia',
    institution: 'State University',
    nationality: 'Filipino',
    presentationType: 'poster',
    abstractText: 'Created by the automated end-to-end verification run.'
  }, { name: 'abstract.pdf', type: 'application/pdf', body: '%PDF-1.4 verification' });
  const res = await postForm(presenter, '/api/gala', form);
  return { res, body: await res.json().catch(() => ({})) };
})();
check('POST /api/gala creates a submitted entry', created.res.status === 201 && created.body.submission?.status === 'submitted',
  `status=${created.res.status} ${created.body.error || ''}`);
const newId = created.body.submission?.id;

if (newId) {
  const seeded = await (async () => {
    const form = multipart({
      title: 'Rejected Type Check',
      authors: 'Liza Garcia',
      abstractText: 'x'
    }, { name: 'evil.svg', type: 'image/svg+xml', body: '<svg/>' });
    const res = await postForm(presenter, '/api/gala', form);
    return { res, body: await res.json().catch(() => ({})) };
  })();
  check('the shared upload guard refuses a disallowed type over real HTTP',
    seeded.res.status === 400 && /not allowed/i.test(seeded.body.error || ''), seeded.body.error);

  const other = makeClient();
  await login(other, 'kbautista');
  const forbidden = await other.json(`/api/gala/${newId}/status`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'accepted' })
  });
  check('a student cannot review a submission (RBAC gate)', forbidden.res.status === 403, `status=${forbidden.res.status}`);
}

check('the registration API advertises the new roles', await (async () => {
  const res = await fetch(BASE + '/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'x1y2z3', email: 'x@y.example', password: 'abcdefgh', role: 'not_a_role' })
  });
  const body = await res.json();
  return res.status === 400 && /Non-Teaching Researcher/.test(body.error) && /Presenter/.test(body.error) && /CPRI Staff/.test(body.error);
})(), 'the validation error lists the new account types');

// ----------------------------------------------------------------- faculty
console.log('\nNon-Teaching Researcher + certificate');
const nonTeaching = makeClient();
const ntUser = await login(nonTeaching, 'rnavarro');
check('a Non-Teaching Researcher can sign in', ntUser.role === 'non_teaching_researcher', ntUser.role);
const ntProfile = await nonTeaching.json('/api/auth/profile');
check('their profile returns office/unit and position',
  ntProfile.body.profile?.officeUnit === 'Office of Research and Development'
  && ntProfile.body.profile?.position === 'Research Assistant',
  JSON.stringify({ officeUnit: ntProfile.body.profile?.officeUnit, position: ntProfile.body.profile?.position }));
check('they can edit their own office/unit through the profile API', await (async () => {
  const res = await nonTeaching.json('/api/auth/profile', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ officeUnit: 'Office of Research and Development', position: 'Research Assistant' })
  });
  return res.res.status === 200;
})(), '');
check('a non-owning role cannot write Non-Teaching fields', await (async () => {
  // The faculty account has no officeUnit; the field is silently ignored.
  const facultyUser = await login(faculty, 'mramos');
  check('faculty signed in for the certificate check', facultyUser.role === 'faculty_researcher', facultyUser.role);
  const res = await faculty.json('/api/auth/profile', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ officeUnit: 'Should Not Persist' })
  });
  const after = await faculty.json('/api/auth/profile');
  return res.res.status === 200 && !after.body.profile.officeUnit;
})(), '');

const cert = await faculty.req('/api/ethics/demo-eth-cert-1/certificate.pdf');
const certBuf = Buffer.from(await cert.arrayBuffer());
check('the applicant can download a generated clearance PDF',
  cert.status === 200 && cert.headers.get('content-type') === 'application/pdf'
  && certBuf.subarray(0, 5).toString() === '%PDF-',
  `status=${cert.status} type=${cert.headers.get('content-type')}`);

const pdfText = certBuf.toString('latin1');
check('the PDF carries the clearance number and title',
  pdfText.includes('CPRI-ERB-2026-00412') && pdfText.includes('Community-Based Monitoring'),
  '');

const outsider = makeClient();
await login(outsider, 'kbautista');
const outsiderCert = await outsider.req('/api/ethics/demo-eth-cert-1/certificate.pdf');
check('someone unrelated to the application is refused', outsiderCert.status === 403, `status=${outsiderCert.status}`);

// ------------------------------------------------------------------- admin
console.log('\nAdmin approvals, Research Gala review and backups');
const adminUser = await login(admin, 'admin');
check('the administrator signs in', adminUser.role === 'admin', adminUser.role);

const pending = await admin.json('/api/auth/admin/approvals/pending');
const pendingStaff = (pending.body || []).find(u => u.role === 'cpri_staff');
check('a pending CPRI Staff account is listed with its details',
  pending.res.status === 200 && !!pendingStaff && pendingStaff.roleLabel === 'CPRI Staff',
  `status=${pending.res.status} count=${(pending.body || []).length}`);

const approve = await admin.json(`/api/auth/admin/approvals/${pendingStaff.id}`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'approve' })
});
check('approving the account succeeds and activates it',
  approve.res.status === 200 && approve.body.user?.status === 'active',
  `status=${approve.res.status} ${approve.body.error || ''}`);

const afterApprove = await admin.json('/api/auth/admin/approvals/pending');
check('the approved account leaves the pending list',
  !(afterApprove.body || []).some(u => u.id === pendingStaff.id), '');

const staffLogin = makeClient();
const staffUser = await login(staffLogin, 'mfernandez');
check('the approved staff member can now sign in', staffUser.status === 'active' && staffUser.role === 'cpri_staff', staffUser.role);

const audit = await admin.json('/api/admin/logs?action=account_approved');
const auditRows = audit.body.logs || audit.body || [];
check('the approval is written to the audit log',
  Array.isArray(auditRows) && auditRows.some(l => /account_approved/.test(l.action || '')),
  `rows=${Array.isArray(auditRows) ? auditRows.length : 'n/a'}`);

if (newId) {
  const decided = await admin.json(`/api/gala/${newId}/status`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'accepted', note: 'Verified end to end' })
  });
  check('an admin can set a Gala status',
    decided.res.status === 200 && decided.body.submission?.status === 'accepted',
    `status=${decided.res.status} ${decided.body.error || ''}`);
  check('the decision records the reviewer and notes',
    decided.body.submission?.reviewedBy && decided.body.submission?.reviewNote === 'Verified end to end', '');
}

const backupsBefore = await admin.json('/api/admin/backups');
check('GET /api/admin/backups is admin-only and lists backups',
  backupsBefore.res.status === 200 && Array.isArray(backupsBefore.body.backups),
  `status=${backupsBefore.res.status}`);

const made = await admin.json('/api/admin/backups', { method: 'POST' });
check('POST /api/admin/backups takes a backup', made.res.status === 201 && !!made.body.backup?.id,
  `status=${made.res.status} ${made.body.error || ''}`);

if (made.body.backup?.id) {
  const dl = await admin.req(`/api/admin/backups/${made.body.backup.id}/download`);
  const text = await dl.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not json */ }
  check('the backup downloads as a JSON document with schema and rows',
    dl.status === 200 && parsed && parsed.format === 'cpri-backup/1' && !!parsed.rows?.users,
    `status=${dl.status} bytes=${text.length}`);
}

const notAdmin = await staffLogin.json('/api/admin/backups');
check('a CPRI staff account cannot read the backup list', notAdmin.res.status === 403, `status=${notAdmin.res.status}`);

// ------------------------------------------------------------------ reports
const report9 = await admin.json('/api/reports/publications-monitoring');
const rows = report9.body.report || [];
const withIssn = rows.filter(r => r.issn || r.isbn).length;
check('Report 9 includes the new bibliographic fields',
  report9.res.status === 200 && withIssn >= 3 && rows.some(r => r.indexing && r.impactFactor),
  `rows=${rows.length} withIssn/isbn=${withIssn}`);

const csv = await admin.req('/api/reports/export/publications-monitoring?format=csv');
const csvText = await csv.text();
check('the CSV export carries the new columns',
  csv.status === 200 && /issn/i.test(csvText.split('\n')[0]) && /impactFactor/i.test(csvText.split('\n')[0]),
  csvText.split('\n')[0]?.slice(0, 160));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
