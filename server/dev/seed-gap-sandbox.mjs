// Sandbox seed for the gap-analysis features. Creates the accounts and rows the
// screenshots need (Presenter, Non-Teaching Researcher, a pending CPRI Staff
// account, a certificate-issued ethics application, Research Gala entries, a
// Research Gala event, and publication-monitoring values).
//
// SAFETY: this refuses to run unless the target database name ends in `_demo`
// AND the host is loopback, so it can never write to the hosted TiDB database.
//
//   DB_HOST=127.0.0.1 DB_NAME=cpri_demo DB_SSL_MODE=disable \
//     node server/dev/seed-gap-sandbox.mjs
import '../load-env.js';
import bcrypt from 'bcryptjs';
import { all, get, run, insert } from '../server/db/queries.js';

const host = String(process.env.DB_HOST || '');
const database = String(process.env.DB_NAME || '');
const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
if (!/_demo$/.test(database) || !loopback) {
  console.error(`[gap-seed] REFUSING to run: host=${host || '(unset)'} database=${database || '(unset)'}.`);
  console.error('[gap-seed] This script only targets a local throwaway database whose name ends in "_demo".');
  process.exit(1);
}
console.log(`[gap-seed] seeding sandbox database "${database}" on ${host}`);

const iso = (y, m, d, h = 9) => new Date(Date.UTC(y, m - 1, d, h)).toISOString();
const passwordHash = await bcrypt.hash('demo12345', 10);

// ---------------------------------------------------------------- accounts
// The sandbox admin gets the same known development password as the demo users
// so screenshots never need the real ADMIN_PASSWORD from .env.
await run("UPDATE users SET passwordHash = ? WHERE role = 'admin'", [passwordHash]);

const account = (u) => ({
  id: u.id, username: u.username, email: u.email, fullName: u.fullName, role: u.role,
  passwordHash, status: u.status || 'active', department: u.department || '',
  contactNumber: u.contactNumber || '', researchInterests: u.researchInterests || '',
  profilePhoto: null, researches: JSON.stringify([]), user_prefs: null,
  officeUnit: u.officeUnit || '', position: u.position || '',
  institution: u.institution || '', nationality: u.nationality || '',
  resetToken: null, resetTokenExpiry: null, createdAt: u.createdAt || iso(2026, 8, 1)
});

const ACCOUNTS = [
  account({
    id: 'demo-user-lgarcia', username: 'lgarcia', email: 'liza.garcia@demo.cpri.edu',
    fullName: 'Liza Garcia', role: 'presenter', institution: 'State University',
    nationality: 'Filipino', contactNumber: '+639175550107',
    researchInterests: 'science education, STEM outreach, teacher training'
  }),
  account({
    id: 'demo-user-rnavarro', username: 'rnavarro', email: 'rex.navarro@demo.cpri.edu',
    fullName: 'Rex Navarro', role: 'non_teaching_researcher',
    department: 'Research & Innovation', officeUnit: 'Office of Research and Development',
    position: 'Research Assistant', researchInterests: 'institutional research, data management'
  }),
  account({
    id: 'demo-user-mfernandez', username: 'mfernandez', email: 'mia.fernandez@demo.cpri.edu',
    fullName: 'Mia Fernandez', role: 'cpri_staff', status: 'pending',
    department: 'Records & Compliance', createdAt: iso(2026, 9, 28)
  }),
  account({
    id: 'demo-user-jtan', username: 'jtan', email: 'jomar.tan@demo.cpri.edu',
    fullName: 'Jomar Tan', role: 'ethics_reviewer', status: 'pending',
    department: 'Research & Innovation', createdAt: iso(2026, 9, 30)
  })
];

for (const a of ACCOUNTS) {
  const existing = await get('SELECT id FROM users WHERE id = ?', [a.id]);
  if (existing) await run('DELETE FROM users WHERE id = ?', [a.id]);
  await insert('users', a);
}
console.log(`[gap-seed] accounts ready: presenter, non-teaching researcher, 2 pending approvals`);

// ---------------------------------------------------------------- events
await run('DELETE FROM events_module WHERE id IN (?, ?)', ['demo-ev-gala-2026', 'demo-ev-gala-2027']);
await insert('events_module', {
  id: 'demo-ev-gala-2026', title: '2026 CPRI Research Gala', theme: 'Research for Community Impact',
  dateTime: '2026-11-20 08:00:00', venue: 'Gabriel Arcangel Hall', description: 'Annual research gala.',
  speakers: 'Invited plenary panel', programFlow: '', imageUrl: null, imagePublicId: null,
  registrationLink: '', createdAt: iso(2026, 8, 20)
});
await insert('events_module', {
  id: 'demo-ev-gala-2027', title: '2027 CPRI Research Gala', theme: 'Evidence to Action',
  dateTime: '2027-03-12 08:00:00', venue: 'University Auditorium', description: 'Next-year gala.',
  speakers: '', programFlow: '', imageUrl: null, imagePublicId: null,
  registrationLink: '', createdAt: iso(2026, 9, 1)
});
console.log('[gap-seed] Research Gala events ready');

// ---------------------------------------------------------------- gala entries
await run('DELETE FROM gala_submissions WHERE userId = ?', ['demo-user-lgarcia']);
const galaEntry = (s) => ({
  id: s.id, userId: 'demo-user-lgarcia', submitterName: 'Liza Garcia',
  eventId: s.eventId, title: s.title, authors: s.authors,
  institution: 'State University', nationality: 'Filipino',
  contactNumber: '+639175550107', researchInterests: 'science education, STEM outreach',
  presentationType: s.presentationType, strand: s.strand, keywords: s.keywords,
  abstractText: s.abstractText, status: s.status, reviewNote: s.reviewNote || '',
  reviewedBy: s.reviewedBy || null, reviewedAt: s.reviewedAt || null,
  statusHistory: JSON.stringify(s.statusHistory), files: JSON.stringify([]),
  createdAt: s.createdAt, updatedAt: s.updatedAt
});

await insert('gala_submissions', galaEntry({
  id: 'demo-gala-1', eventId: 'demo-ev-gala-2026',
  title: 'Low-Cost Science Kits in Rural Junior High Schools',
  authors: 'Liza Garcia, Miguel Reyes',
  presentationType: 'oral', strand: 'Education',
  keywords: 'STEM, low-cost kits, rural schools',
  abstractText: 'This study evaluates the effect of locally sourced, low-cost science kits on Grade 8 performance in rural junior high schools.',
  status: 'accepted', reviewNote: 'Strong dataset and a clear policy hook. Accepted for oral presentation.',
  reviewedBy: 'Site Administrator', reviewedAt: iso(2026, 10, 2),
  statusHistory: [
    { status: 'submitted', at: iso(2026, 9, 15), by: 'Liza Garcia', note: '' },
    { status: 'under_review', at: iso(2026, 9, 25), by: 'Site Administrator', note: '' },
    { status: 'accepted', at: iso(2026, 10, 2), by: 'Site Administrator', note: 'Accepted for oral presentation.' }
  ],
  createdAt: iso(2026, 9, 15), updatedAt: iso(2026, 10, 2)
}));

await insert('gala_submissions', galaEntry({
  id: 'demo-gala-2', eventId: 'demo-ev-gala-2026',
  title: 'Teacher Assessment Literacy and Classroom Feedback',
  authors: 'Liza Garcia',
  presentationType: 'poster', strand: 'Education',
  keywords: 'assessment literacy, feedback',
  abstractText: 'A mixed-methods study of assessment literacy among secondary teachers and how it shapes the feedback students receive.',
  status: 'submitted',
  statusHistory: [{ status: 'submitted', at: iso(2026, 10, 5), by: 'Liza Garcia', note: '' }],
  createdAt: iso(2026, 10, 5), updatedAt: iso(2026, 10, 5)
}));
console.log('[gap-seed] 2 Research Gala submissions ready (one accepted, one submitted)');

// ---------------------------------------------------------- ethics certificate
await run('DELETE FROM ethics WHERE id = ?', ['demo-eth-cert-1']);
await insert('ethics', {
  id: 'demo-eth-cert-1',
  submitterId: 'demo-user-ramos',
  submitterName: 'Maria Teresa Ramos, PhD',
  title: 'Community-Based Monitoring of Local Budget Transparency',
  researchers: 'Maria Teresa Ramos, PhD; Karla Bautista',
  adviser: 'Carlos Tan, PhD',
  department: 'Governance & Public Policy',
  participantType: 'Adults (Local Government Staff)',
  riskLevel: 'Minimal Risk',
  status: 'certificate_issued',
  statusHistory: JSON.stringify([
    { status: 'submitted', at: iso(2026, 6, 10), by: 'Maria Teresa Ramos, PhD', note: '' },
    { status: 'under_review', at: iso(2026, 6, 18), by: 'Ethics Board', note: '' },
    { status: 'approved', at: iso(2026, 7, 2), by: 'Ethics Board', note: 'Approved with no conditions.' },
    { status: 'certificate_issued', at: iso(2026, 7, 8), by: 'Ethics Board', note: 'Certificate issued' }
  ]),
  files: JSON.stringify({}),
  additionalDocs: JSON.stringify([]),
  comments: JSON.stringify([
    { id: 'demo-comment-1', authorId: 'demo-user-admin', authorName: 'Site Administrator', authorRole: 'admin', body: 'Informed consent form is complete.', createdAt: iso(2026, 6, 20) }
  ]),
  certificate: JSON.stringify({
    certificateNumber: 'CPRI-ERB-2026-00412',
    dateIssued: '2026-07-08',
    validityPeriod: '1 year from date of issue',
    approvedTitle: 'Community-Based Monitoring of Local Budget Transparency',
    principalInvestigator: 'Maria Teresa Ramos, PhD',
    issuedBy: 'CPRI Ethics Review Board',
    issuedAt: iso(2026, 7, 8)
  }),
  compliance: JSON.stringify({ reviewerId: 'demo-user-admin', reviewerName: 'Site Administrator', compliant: true, note: 'All conditions met.', updatedAt: iso(2026, 7, 2) }),
  revisedDocuments: JSON.stringify([]),
  createdAt: iso(2026, 6, 10),
  updatedAt: iso(2026, 7, 8)
});
console.log('[gap-seed] certificate-issued ethics application ready');

// ------------------------------------------------- publication monitoring fields
// Graduated realism: an indexed journal article, a Scopus/DOAJ article and a
// book chapter (ISBN, no periodical numbering), so Report 9 shows every shape.
const monitoring = [
  { suffix: 'jpe202601', issn: '0118-7642', isbn: '', indexing: 'Scopus, Web of Science', impactFactor: '1.84', volume: '12', issue: '3', pages: '45-67' },
  { suffix: 'ajph202602', issn: '2094-2232', isbn: '', indexing: 'Scopus, DOAJ', impactFactor: '0.92', volume: '8', issue: '1', pages: '12-29' },
  { suffix: 'cpripb202607', issn: '', isbn: '978-971-1234-56-7', indexing: 'Google Scholar', impactFactor: '', volume: '', issue: '', pages: '110-128' }
];
let updated = 0;
for (const m of monitoring) {
  const row = await get('SELECT id FROM publications WHERE id = ?', [`demo-pub-101234${m.suffix}`]);
  if (!row) continue;
  await run(
    'UPDATE publications SET issn = ?, isbn = ?, indexing = ?, impactFactor = ?, volume = ?, issue = ?, pages = ? WHERE id = ?',
    [m.issn, m.isbn, m.indexing, m.impactFactor, m.volume, m.issue, m.pages, row.id]
  );
  updated += 1;
}
console.log(`[gap-seed] publication-monitoring fields set on ${updated} publication(s)`);

const totals = {
  users: (await all('SELECT COUNT(*) AS n FROM users'))[0].n,
  gala: (await all('SELECT COUNT(*) AS n FROM gala_submissions'))[0].n,
  ethics: (await all('SELECT COUNT(*) AS n FROM ethics'))[0].n
};
console.log('[gap-seed] done:', JSON.stringify(totals));
console.log('[gap-seed] sandbox logins (password demo12345): admin, lgarcia (Presenter), rnavarro (Non-Teaching), mramos (Faculty)');
process.exit(0);
