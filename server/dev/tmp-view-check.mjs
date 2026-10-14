// TEMPORARY end-to-end check of GET /api/submissions/:id/file/view.
// Creates throwaway accounts and one submission, asserts the headers and the
// authorization gate, then deletes everything it made.
import '../load-env.js';

const BASE = process.env.CPRI_TEST_BASE || 'http://localhost:3001';
const PREFIX = 'tmpview';
const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures.push(label);
};

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n')]);
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4B, 0x03, 0x04]), Buffer.from('docx body')]);

async function login(identifier, password) {
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password })
  });
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  return { ok: res.status === 200 && !!cookie, cookie };
}

function part(buffer, filename, type) {
  // undici's FormData takes the filename as the third argument.
  return { blob: new Blob([buffer], { type }), filename };
}

async function main() {
  // ---- 1. throwaway accounts ------------------------------------------------
  const { insert, run } = await import('../server/db/queries.js');
  const bcrypt = (await import('bcryptjs')).default;
  const hash = await bcrypt.hash('sample12345', 10);
  const people = {
    owner: { id: `${PREFIX}-owner`, role: 'student_researcher', fullName: 'Tmp View Owner' },
    stranger: { id: `${PREFIX}-stranger`, role: 'student_researcher', fullName: 'Tmp View Stranger' },
    adviser: { id: `${PREFIX}-adviser`, role: 'adviser', fullName: 'Juan Dela Cruz' },
    otherAdviser: { id: `${PREFIX}-otheradv`, role: 'adviser', fullName: 'Somebody Else' },
    staff: { id: `${PREFIX}-staff`, role: 'cpri_staff', fullName: 'Tmp View Staff' }
  };
  for (const [key, p] of Object.entries(people)) {
    await run('DELETE FROM users WHERE id = ?', [p.id]);
    await insert('users', {
      id: p.id, username: `${PREFIX}.${key}`, email: `${PREFIX}.${key}@example.edu`,
      fullName: p.fullName, role: p.role, passwordHash: hash, status: 'active',
      department: '', program: '', contactNumber: '', researchInterests: '',
      researchArea: '', researchTitle: '', profilePhoto: null,
      researches: JSON.stringify([]), resetToken: null, resetTokenExpiry: null,
      setupPending: 0, createdAt: '2026-01-01 00:00:00'
    });
  }
  const sessions = {};
  for (const key of Object.keys(people)) {
    sessions[key] = await login(`${PREFIX}.${key}@example.edu`, 'sample12345');
  }
  check(Object.values(sessions).every(s => s.ok), 'all throwaway accounts can sign in');

  // ---- 2. one submission, six required PDFs + a .docx extra -----------------
  const form = new FormData();
  // `abstract` is BOTH a required text field and a required file slot, so it
  // has to be appended twice — set() would let the file replace the text.
  for (const [k, v] of Object.entries({
    title: 'Temp view check paper', authors: 'Tmp View Owner', program: 'BSED',
    category: 'Capstone', researchType: 'Quantitative',
    schoolYear: '2026-2027', semester: '1st Semester',
    adviser: 'Juan Dela Cruz'
  })) form.append(k, v);
  form.append('abstract', 'Temporary paper used to verify the inline file preview route.');
  for (const key of ['manuscript', 'abstract', 'approvalForm', 'similarityReport', 'adviserEndorsement', 'panelApproval']) {
    const p = part(PDF, `${key}.pdf`, 'application/pdf');
    // append, never set: set() wipes the abstract TEXT entry above
    form.append(key, p.blob, p.filename);
  }
  const appendix = part(DOCX, 'appendix.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  form.set('additional', appendix.blob, appendix.filename);

  const created = await fetch(BASE + '/api/submissions', {
    method: 'POST', headers: { cookie: sessions.owner.cookie }, body: form
  });
  const createdBody = await created.json().catch(() => null);
  check(created.status === 201, 'POST /api/submissions (owner)',
    `status ${created.status}${created.status === 201 ? '' : ' — ' + (createdBody?.message || createdBody?.error || 'no body')}`);
  const sub = createdBody?.submission;
  if (!sub) { console.log('cannot continue'); return; }
  // The POST response carries the row as written (JSON strings); the API
  // responses below come back parsed, so parse here too to get the doc id.
  const additional = (JSON.parse(sub.additionalDocs || '[]'))[0];
  check(Boolean(additional), 'additional .docx stored', additional?.original_name);

  const owner = sessions.owner.cookie;
  const stranger = sessions.stranger.cookie;
  const adviser = sessions.adviser.cookie;
  const otherAdviser = sessions.otherAdviser.cookie;
  const staff = sessions.staff.cookie;
  const get = async (path, cookie) => {
    const res = await fetch(BASE + path, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, buf };
  };

  // ---- 3. download is unchanged: a redirect that forces an attachment -------
  const dl = await get(`/api/submissions/${sub.id}/file?key=manuscript`, owner);
  const dlLocation = dl.headers.get('location') || '';
  check(dl.status === 302, 'download still redirects (attachment)', `status ${dl.status}`);
  check(dlLocation.includes('download='), 'download URL still carries download= (attachment)', dlLocation.slice(0, 60) + '…');

  // ---- 4. view streams the file inline --------------------------------------
  const view = await get(`/api/submissions/${sub.id}/file/view?key=manuscript`, owner);
  const disposition = view.headers.get('content-disposition') || '';
  check(view.status === 200, 'view returns 200 for the owner', `status ${view.status}`);
  check(disposition.startsWith('inline;'), 'Content-Disposition is inline', disposition);
  check(view.headers.get('content-type') === 'application/pdf', 'Content-Type is the stored type', view.headers.get('content-type'));
  check(view.buf.subarray(0, 5).toString() === '%PDF-', 'viewed bytes are the uploaded PDF', `${view.buf.length} bytes`);
  check(view.headers.get('x-content-type-options') === 'nosniff', 'nosniff set');

  // filename with quotes/CRLF must not break the header
  check(/filename="[^"\\]*"/.test(disposition) && !/[\r\n]/.test(disposition),
    'filename is header-safe', disposition);

  // ---- 5. authorization -----------------------------------------------------
  const anon = await get(`/api/submissions/${sub.id}/file/view?key=manuscript`);
  check(anon.status === 401, 'anonymous view returns 401', `status ${anon.status}`);

  const strangerView = await get(`/api/submissions/${sub.id}/file/view?key=manuscript`, stranger);
  check(strangerView.status === 403, 'another researcher is refused', `status ${strangerView.status}`);

  const strangerDl = await get(`/api/submissions/${sub.id}/file?key=manuscript`, stranger);
  check(strangerDl.status === 403, 'another researcher is refused on download too', `status ${strangerDl.status}`);

  const adviserView = await get(`/api/submissions/${sub.id}/file/view?key=manuscript`, adviser);
  check(adviserView.status === 200, 'the named adviser can view', `status ${adviserView.status}`);

  const otherAdviserView = await get(`/api/submissions/${sub.id}/file/view?key=manuscript`, otherAdviser);
  check(otherAdviserView.status === 403, 'a different adviser is refused', `status ${otherAdviserView.status}`);

  const staffView = await get(`/api/submissions/${sub.id}/file/view?key=manuscript`, staff);
  check(staffView.status === 200, 'CPRI staff can view', `status ${staffView.status}`);

  // ---- 6. parameters: version, additional docs, missing slot ----------------
  const versioned = await get(`/api/submissions/${sub.id}/file/view?key=manuscript&version=1`, owner);
  check(versioned.status === 200, 'view supports the version parameter', `status ${versioned.status}`);

  const badVersion = await get(`/api/submissions/${sub.id}/file/view?key=manuscript&version=99`, owner);
  check(badVersion.status === 404, 'unknown version is a 404', `status ${badVersion.status}`);

  const additionalView = await get(
    `/api/submissions/${sub.id}/file/view?key=additional&docId=${encodeURIComponent(additional.id)}`, owner);
  const additionalDisposition = additionalView.headers.get('content-disposition') || '';
  check(additionalView.status === 200, 'additional .docx is viewable', `status ${additionalView.status}`);
  check(additionalDisposition.includes('appendix.docx'), 'additional file keeps its name', additionalDisposition);

  const missing = await get(`/api/submissions/${sub.id}/file/view?key=ethicsCertificate`, owner);
  check(missing.status === 404, 'a slot with no upload is a 404', `status ${missing.status}`);

  // ---- 7. cleanup -----------------------------------------------------------
  await cleanup(sub.id);
}

async function cleanup(submissionId) {
  const { run } = await import('../server/db/queries.js');
  if (submissionId) await run('DELETE FROM submissions WHERE id = ?', [submissionId]);
  const swept = await run('DELETE FROM submissions WHERE submitterId LIKE ?', [`${PREFIX}-%`]);
  for (const suffix of ['owner', 'stranger', 'adviser', 'otheradv', 'staff']) {
    await run('DELETE FROM users WHERE id = ?', [`${PREFIX}-${suffix}`]);
  }
  console.log(`cleanup: submissions removed (extra rows swept: ${swept.affectedRows}), accounts removed`);
}

try {
  await main();
} catch (err) {
  console.log(' FAIL  unexpected error —', err.message);
  failures.push('unexpected error');
} finally {
  await cleanup();
}
console.log(failures.length ? `\n${failures.length} FAILURE(S)` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
