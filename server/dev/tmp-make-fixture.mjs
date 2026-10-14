// TEMPORARY fixture: one throwaway owner account and one submission with a
// PDF manuscript plus a .docx extra, left in place so the page can be driven in
// a browser. Delete with: node server/dev/tmp-make-fixture.mjs --clear
import '../load-env.js';
import bcrypt from 'bcryptjs';

const PREFIX = 'tmpview';
const OWNER_ID = `${PREFIX}-owner`;
const OWNER_EMAIL = 'tmpview.owner@example.edu';
const BASE = 'http://localhost:3001';
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n')]);
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4B, 0x03, 0x04]), Buffer.from('docx body')]);

const { insert, run, get } = await import('../server/db/queries.js');

if (process.argv.includes('--clear')) {
  await run('DELETE FROM submissions WHERE submitterId = ?', [OWNER_ID]);
  await run('DELETE FROM users WHERE id = ?', [OWNER_ID]);
  console.log('fixture cleared');
  process.exit(0);
}

await run('DELETE FROM submissions WHERE submitterId = ?', [OWNER_ID]);
await run('DELETE FROM users WHERE id = ?', [OWNER_ID]);
await insert('users', {
  id: OWNER_ID, username: `${PREFIX}.owner`, email: OWNER_EMAIL,
  fullName: 'Tmp View Owner', role: 'student_researcher',
  passwordHash: await bcrypt.hash('sample12345', 10), status: 'active',
  department: '', program: '', contactNumber: '', researchInterests: '',
  researchArea: '', researchTitle: '', profilePhoto: null,
  researches: JSON.stringify([]), resetToken: null, resetTokenExpiry: null,
  setupPending: 0, createdAt: '2026-01-01 00:00:00'
});

const raw = await fetch(BASE + '/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ identifier: OWNER_EMAIL, password: 'sample12345' })
});
const cookie = (raw.headers.get('set-cookie') || '').split(';')[0];
if (!cookie) { console.error('fixture login failed'); process.exit(1); }

const form = new FormData();
for (const [k, v] of Object.entries({
  title: 'Preview fixture paper', authors: 'Tmp View Owner', program: 'BSED',
  category: 'Capstone', researchType: 'Quantitative',
  schoolYear: '2026-2027', semester: '1st Semester', adviser: 'Juan Dela Cruz'
})) form.append(k, v);
form.append('abstract', 'Fixture used to check the document preview modal.');
for (const key of ['manuscript', 'abstract', 'approvalForm', 'similarityReport', 'adviserEndorsement', 'panelApproval']) {
  form.append(key, new Blob([PDF], { type: 'application/pdf' }), `${key}.pdf`);
}
form.append('additional',
  new Blob([DOCX], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
  'appendix.docx');

const res = await fetch(BASE + '/api/submissions', {
  method: 'POST', headers: { cookie }, body: form
});
const body = await res.json();
if (res.status !== 201) { console.error('fixture create failed', res.status, body); process.exit(1); }

const row = await get('SELECT additionalDocs FROM submissions WHERE id = ?', [body.submission.id]);
// queries.js already parses JSON columns, so only strings need parsing.
const rawDocs = typeof row.additionalDocs === 'string' ? row.additionalDocs : (row.additionalDocs || []);
const docs = Array.isArray(rawDocs) ? rawDocs : JSON.parse(rawDocs || '[]');
console.log(JSON.stringify({
  submissionId: body.submission.id,
  login: OWNER_EMAIL,
  password: 'sample12345',
  additionalId: docs[0]?.id,
  url: `${BASE}/submission.html?id=${body.submission.id}`
}, null, 2));
process.exit(0);
