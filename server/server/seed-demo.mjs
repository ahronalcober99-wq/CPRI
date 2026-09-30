// Demo data seeder — populates the MySQL database and JSON content files with
// realistic sample records so the public site and admin dashboards show real
// numbers instead of all-zero stats.
//
//   npm run seed:demo          -> wipe existing demo data, then seed fresh
//   npm run seed:demo --clear  -> remove ONLY demo data (real rows untouched)
//
// Safety rules:
//  - Every demo row uses an id prefixed with "demo-" so it can be identified
//    and removed without ever touching real records (admin user, real
//    submissions, existing announcements, etc.).
//  - JSON content files are read, demo entries filtered out, new demo entries
//    appended — real entries (e.g. a user-created announcement) are preserved.
//  - All MySQL writes go through insert() in ./db/queries.js, which normalizes
//    ISO timestamps for MariaDB's STRICT_TRANS_TABLES (the datetime gotcha).

import bcrypt from 'bcryptjs';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { insert, run } from './db/queries.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '..', 'data');

const DEMO_PASSWORD = 'demo12345';
const CLEAR_ONLY = process.argv.includes('--clear');

// ---------------------------------------------------------------- helpers

const DEMO_TABLES = [
  'users', 'submissions', 'repository', 'publications', 'ethics',
  'researchers', 'events_module', 'event_registrations', 'event_abstracts',
  'innovation_extension', 'system_logs', 'inquiries'
];

async function clearDemoRows() {
  for (const table of DEMO_TABLES) {
    try {
      await run(`DELETE FROM ${table} WHERE id LIKE 'demo-%'`);
    } catch (err) {
      console.warn(`[demo] Skipping clear of ${table}:`, err.message);
    }
  }
  // inquiries.id is BIGINT AUTO_INCREMENT — string ids are coerced to auto
  // values, so it can't be matched with `id LIKE 'demo-%'`. Clean it by the
  // demo email domain instead.
  try {
    await run("DELETE FROM inquiries WHERE email LIKE '%@demo.cpri.edu'");
  } catch (err) {
    console.warn('[demo] Skipping clear of inquiries:', err.message);
  }
  console.log('[demo] Removed demo rows from MySQL.');
}

async function clearDemoJson(name) {
  const file = join(DATA_DIR, `${name}.json`);
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    const kept = Array.isArray(raw) ? raw.filter(x => !String(x.id || '').startsWith('demo-')) : raw;
    await fs.writeFile(file, JSON.stringify(kept, null, 2));
    console.log(`[demo] Removed demo entries from ${name}.json (kept ${Array.isArray(kept) ? kept.length : 'file'}).`);
  } catch { /* file missing/empty — nothing to clear */ }
}

async function appendJson(name, entries) {
  const file = join(DATA_DIR, `${name}.json`);
  let list = [];
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    if (Array.isArray(raw)) list = raw.filter(x => !String(x.id || '').startsWith('demo-'));
  } catch { /* start fresh */ }
  list.push(...entries);
  await fs.writeFile(file, JSON.stringify(list, null, 2));
  console.log(`[demo] Seeded ${entries.length} entries into ${name}.json (total ${list.length}).`);
}

const iso = (y, m, d, h = 9, min = 0) => new Date(Date.UTC(y, m - 1, d, h, min)).toISOString();

// Shared ID helpers so child rows (repository, registrations, abstracts)
// reference exactly the same ids the parent seeders generate.
const submissionId = (s) => `demo-sub-${s.created.slice(0, 10)}-${s.submitterId.slice(-6)}`;
const eventModuleId = (e) => `demo-evmod-${e.dateTime.slice(0, 7).replace('-', '')}-${e.title.slice(0, 4).toLowerCase()}`;
const registrationId = (e, userId) => `demo-reg-${e.dateTime.slice(0, 7).replace('-', '')}-${userId.slice(-6)}`;

// ---------------------------------------------------------------- MySQL data

const USER_IDS = {
  ramos: 'demo-user-ramos', delaCruz: 'demo-user-delacruz', villanueva: 'demo-user-villanueva',
  bautista: 'demo-user-bautista', reyes: 'demo-user-reyes', tan: 'demo-user-tan'
};

function user(u, passwordHash) {
  return { id: u.id, username: u.username, email: u.email, fullName: u.fullName,
    role: u.role, passwordHash, status: 'active',
    department: u.department, contactNumber: u.contact, researchInterests: u.interests,
    profilePhoto: null, researches: JSON.stringify([]),
    resetToken: null, resetTokenExpiry: null, createdAt: iso(2025, 11, 15) };
}

async function seedUsers() {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const users = [
    user({ id: USER_IDS.ramos, username: 'mramos', email: 'maria.ramos@demo.cpri.edu', fullName: 'Maria Teresa Ramos, PhD', role: 'faculty_researcher', department: 'Governance & Public Policy', contact: '0917 555 0101', interests: 'local governance, decentralization, public accountability' }, passwordHash),
    user({ id: USER_IDS.delaCruz, username: 'jdelacruz', email: 'juan.delacruz@demo.cpri.edu', fullName: 'Juan Miguel dela Cruz, PhD', role: 'faculty_researcher', department: 'Health Systems & Well-being', contact: '0917 555 0102', interests: 'health systems, primary care, health financing' }, passwordHash),
    user({ id: USER_IDS.villanueva, username: 'avillanueva', email: 'angela.villanueva@demo.cpri.edu', fullName: 'Angela Villanueva, MA', role: 'faculty_researcher', department: 'Education & Human Capital', contact: '0917 555 0103', interests: 'education policy, learning assessment, teacher quality' }, passwordHash),
    user({ id: USER_IDS.bautista, username: 'kbautista', email: 'karla.bautista@demo.cpri.edu', fullName: 'Karla Bautista', role: 'student_researcher', department: 'Governance & Public Policy', contact: '0917 555 0104', interests: 'e-governance, digital transformation, open data' }, passwordHash),
    user({ id: USER_IDS.reyes, username: 'mreyes', email: 'miguel.reyes@demo.cpri.edu', fullName: 'Miguel Reyes', role: 'student_researcher', department: 'Environment & Climate', contact: '0917 555 0105', interests: 'climate adaptation, disaster risk reduction, urban resilience' }, passwordHash),
    user({ id: USER_IDS.tan, username: 'ctan', email: 'carlos.tan@demo.cpri.edu', fullName: 'Carlos Tan, PhD', role: 'adviser', department: 'Research & Innovation', contact: '0917 555 0106', interests: 'impact evaluation, research methodology, statistics' }, passwordHash)
  ];
  for (const u of users) await insert('users', u);
  console.log(`[demo] Seeded ${users.length} researcher users (password: ${DEMO_PASSWORD}).`);
}

// Submission/status helpers -------------------------------------------------
// statusHistory mirrors what real submissions carry; the dashboard derives
// on-time delivery from the first approved/published entry's "at" field.

function history(steps) {
  return steps.map(([status, at, by = 'System Administrator', note = '']) => ({ status, at, by, note }));
}

const SUBMISSIONS = [
  { submitterId: USER_IDS.ramos, submitterName: 'Maria Teresa Ramos, PhD', title: 'Decentralization and Fiscal Autonomy of Philippine LGUs: A Mixed-Methods Study', program: 'Governance & Public Policy', adviser: 'Carlos Tan, PhD', category: 'Policy Research', researchType: 'Quantitative', schoolYear: '2025-2026', semester: '1st Semester', status: 'published', created: iso(2026, 2, 12), approved: iso(2026, 2, 19), publishedAt: iso(2026, 3, 2), reject: null },
  { submitterId: USER_IDS.delaCruz, submitterName: 'Juan Miguel dela Cruz, PhD', title: 'Barriers to Primary Care Utilization in Rural Health Units', program: 'Health Systems & Well-being', adviser: 'Carlos Tan, PhD', category: 'Applied Research', researchType: 'Qualitative', schoolYear: '2025-2026', semester: '1st Semester', status: 'published', created: iso(2026, 2, 26), approved: iso(2026, 3, 5), publishedAt: iso(2026, 3, 18), reject: null },
  { submitterId: USER_IDS.bautista, submitterName: 'Karla Bautista', title: 'Open Data Adoption in Local Government Units: A Capability Assessment', program: 'Governance & Public Policy', adviser: 'Maria Teresa Ramos, PhD', category: 'Capstone', researchType: 'Mixed Methods', schoolYear: '2025-2026', semester: '2nd Semester', status: 'rejected', created: iso(2026, 3, 6), approved: null, publishedAt: null, reject: iso(2026, 3, 12) },
  { submitterId: USER_IDS.villanueva, submitterName: 'Angela Villanueva, MA', title: 'Teacher Professional Development and Student Learning Outcomes', program: 'Education & Human Capital', adviser: 'Carlos Tan, PhD', category: 'Policy Research', researchType: 'Quantitative', schoolYear: '2025-2026', semester: '2nd Semester', status: 'published', created: iso(2026, 3, 15), approved: iso(2026, 3, 23), publishedAt: iso(2026, 4, 6), reject: null },
  { submitterId: USER_IDS.reyes, submitterName: 'Miguel Reyes', title: 'Nature-Based Solutions for Urban Flood Resilience in Metro Manila', program: 'Environment & Climate', adviser: 'Juan Miguel dela Cruz, PhD', category: 'Capstone', researchType: 'Mixed Methods', schoolYear: '2025-2026', semester: '2nd Semester', status: 'approved', created: iso(2026, 4, 2), approved: iso(2026, 4, 11), publishedAt: null, reject: null },
  { submitterId: USER_IDS.ramos, submitterName: 'Maria Teresa Ramos, PhD', title: 'Citizen Participation Mechanisms in Participatory Budgeting', program: 'Governance & Public Policy', adviser: 'Carlos Tan, PhD', category: 'Policy Research', researchType: 'Qualitative', schoolYear: '2025-2026', semester: '2nd Semester', status: 'published', created: iso(2026, 4, 16), approved: iso(2026, 4, 25), publishedAt: iso(2026, 5, 9), reject: null },
  { submitterId: USER_IDS.delaCruz, submitterName: 'Juan Miguel dela Cruz, PhD', title: 'Health Insurance Coverage and Out-of-Pocket Spending of Informal Workers', program: 'Health Systems & Well-being', adviser: 'Carlos Tan, PhD', category: 'Applied Research', researchType: 'Quantitative', schoolYear: '2025-2026', semester: '2nd Semester', status: 'archived', created: iso(2026, 5, 4), approved: null, publishedAt: null, reject: null },
  { submitterId: USER_IDS.bautista, submitterName: 'Karla Bautista', title: 'Digital Literacy and E-Service Delivery in Provincial Governments', program: 'Governance & Public Policy', adviser: 'Maria Teresa Ramos, PhD', category: 'Capstone', researchType: 'Quantitative', schoolYear: '2025-2026', semester: '2nd Semester', status: 'approved', created: iso(2026, 5, 18), approved: iso(2026, 5, 28), publishedAt: null, reject: null },
  { submitterId: USER_IDS.villanueva, submitterName: 'Angela Villanueva, MA', title: 'Early Grade Reading Assessment: A Multi-Region Baseline', program: 'Education & Human Capital', adviser: 'Carlos Tan, PhD', category: 'Policy Research', researchType: 'Quantitative', schoolYear: '2025-2026', semester: '2nd Semester', status: 'rejected', created: iso(2026, 6, 3), approved: null, publishedAt: null, reject: iso(2026, 6, 10) },
  { submitterId: USER_IDS.reyes, submitterName: 'Miguel Reyes', title: 'Heat Vulnerability Mapping for Urban Communities', program: 'Environment & Climate', adviser: 'Juan Miguel dela Cruz, PhD', category: 'Capstone', researchType: 'Spatial Analysis', schoolYear: '2025-2026', semester: '2nd Semester', status: 'for_revision', created: iso(2026, 6, 15), approved: null, publishedAt: null, reject: null },
  { submitterId: USER_IDS.ramos, submitterName: 'Maria Teresa Ramos, PhD', title: 'Transparency Portals and Public Trust: Evidence from Philippine Cities', program: 'Governance & Public Policy', adviser: 'Carlos Tan, PhD', category: 'Policy Research', researchType: 'Quantitative', schoolYear: '2026-2027', semester: '1st Semester', status: 'under_ethics_review', created: iso(2026, 7, 2), approved: null, publishedAt: null, reject: null },
  { submitterId: USER_IDS.delaCruz, submitterName: 'Juan Miguel dela Cruz, PhD', title: 'Telemedicine Adoption in Rural Health Facilities', program: 'Health Systems & Well-being', adviser: 'Carlos Tan, PhD', category: 'Applied Research', researchType: 'Mixed Methods', schoolYear: '2026-2027', semester: '1st Semester', status: 'published', created: iso(2026, 7, 9), approved: iso(2026, 7, 17), publishedAt: iso(2026, 7, 28), reject: null },
  { submitterId: USER_IDS.villanueva, submitterName: 'Angela Villanueva, MA', title: 'Senior High School Tracks and Labor Market Outcomes', program: 'Education & Human Capital', adviser: 'Carlos Tan, PhD', category: 'Policy Research', researchType: 'Longitudinal', schoolYear: '2026-2027', semester: '1st Semester', status: 'approved', created: iso(2026, 7, 20), approved: iso(2026, 7, 30), publishedAt: null, reject: null },
  { submitterId: USER_IDS.reyes, submitterName: 'Miguel Reyes', title: 'Community-Based Mangrove Restoration: A Cost-Benefit Analysis', program: 'Environment & Climate', adviser: 'Juan Miguel dela Cruz, PhD', category: 'Capstone', researchType: 'Mixed Methods', schoolYear: '2026-2027', semester: '1st Semester', status: 'submitted', created: iso(2026, 8, 3), approved: null, publishedAt: null, reject: null },
  { submitterId: USER_IDS.bautista, submitterName: 'Karla Bautista', title: 'Barangay e-Governance: Readiness of Rural Communities', program: 'Governance & Public Policy', adviser: 'Maria Teresa Ramos, PhD', category: 'Capstone', researchType: 'Qualitative', schoolYear: '2026-2027', semester: '1st Semester', status: 'under_initial_checking', created: iso(2026, 8, 6), approved: null, publishedAt: null, reject: null },
  { submitterId: USER_IDS.delaCruz, submitterName: 'Juan Miguel dela Cruz, PhD', title: 'Mental Health Services in Public Tertiary Hospitals', program: 'Health Systems & Well-being', adviser: 'Carlos Tan, PhD', category: 'Applied Research', researchType: 'Quantitative', schoolYear: '2026-2027', semester: '1st Semester', status: 'published', created: iso(2026, 8, 10), approved: iso(2026, 8, 17), publishedAt: iso(2026, 8, 24), reject: null }
];

function submissionRow(s) {
  const steps = [['submitted', s.created, s.submitterName, 'Initial submission']];
  if (s.approved) steps.push(['approved', s.approved, undefined, 'Meets CPRI quality standards']);
  if (s.publishedAt) steps.push(['published', s.publishedAt, undefined, 'Published to repository']);
  if (s.reject) steps.push(['rejected', s.reject, undefined, 'Does not meet scope requirements']);
  if (s.status === 'for_revision') steps.push(['for_revision', iso(2026, 6, 22), undefined, 'Minor revisions requested']);
  if (s.status === 'under_ethics_review') steps.push(['under_ethics_review', iso(2026, 7, 8), undefined, 'With Ethics Review Board']);
  return {
    id: submissionId(s),
    submitterId: s.submitterId, submitterName: s.submitterName, title: s.title,
    authors: s.submitterName, program: s.program, adviser: s.adviser, category: s.category,
    researchType: s.researchType,
    abstract: `${s.title}. This study contributes to CPRI's ${s.program} research agenda with evidence for policy and practice.`,
    keywords: 'policy, research, evidence', schoolYear: s.schoolYear, semester: s.semester,
    status: s.status, statusHistory: JSON.stringify(history(steps)),
    files: JSON.stringify({}), additionalDocs: JSON.stringify([]),
    versions: JSON.stringify([]), comments: JSON.stringify([]),
    createdAt: s.created, updatedAt: s.publishedAt || s.approved || s.reject || iso(2026, 8, 12)
  };
}

async function seedSubmissions() {
  for (const s of SUBMISSIONS) {
    const row = submissionRow(s);
    // Demo feedback threads so the portal shows reviewer feedback inline.
    if (s.status === 'for_revision') {
      row.comments = JSON.stringify([
        { id: 'demo-cmt-rev-1', authorId: USER_IDS.tan, authorName: 'Carlos Tan, PhD', authorRole: 'adviser', type: 'feedback', body: 'Strengthen the methodology section — please justify the sample size and sampling frame more explicitly.', createdAt: iso(2026, 6, 18) },
        { id: 'demo-cmt-rev-2', authorId: 'demo-admin-1', authorName: 'Ethics Review Board', authorRole: 'ethics_reviewer', type: 'revision_suggestion', body: 'Add a risk-mitigation paragraph for the participant recruitment process.', createdAt: iso(2026, 6, 20) },
        { id: 'demo-cmt-rev-3', authorId: USER_IDS.reyes, authorName: 'Miguel Reyes', authorRole: 'student_researcher', type: 'response', body: 'Noted — I will add the sampling justification and the mitigation paragraph in the next revision.', createdAt: iso(2026, 6, 21) }
      ]);
    }
    if (s.status === 'under_ethics_review') {
      row.comments = JSON.stringify([
        { id: 'demo-cmt-eth-1', authorId: 'demo-admin-1', authorName: 'Ethics Review Board', authorRole: 'ethics_reviewer', type: 'comment', body: 'Your ethics application is now under review. Expect a decision within 2 weeks.', createdAt: iso(2026, 7, 9) }
      ]);
    }
    if (s.status === 'approved') {
      row.comments = JSON.stringify([
        { id: 'demo-cmt-ap-1', authorId: USER_IDS.tan, authorName: 'Carlos Tan, PhD', authorRole: 'adviser', type: 'feedback', body: 'Great work on the revisions — the analysis is now much clearer. Approval granted.', createdAt: iso(2026, 5, 28) }
      ]);
    }
    await insert('submissions', row);
  }
  console.log(`[demo] Seeded ${SUBMISSIONS.length} submissions.`);
}

const REPOSITORY = [
  { src: SUBMISSIONS[0], year: '2026', status: 'approved' },
  { src: SUBMISSIONS[1], year: '2026', status: 'approved' },
  { src: SUBMISSIONS[3], year: '2026', status: 'approved' },
  { src: SUBMISSIONS[5], year: '2026', status: 'approved' },
  { src: SUBMISSIONS[11], year: '2026', status: 'approved' },
  { src: SUBMISSIONS[15], year: '2026', status: 'approved' }
];

async function seedRepository() {
  for (const r of REPOSITORY) {
    await insert('repository', {
      id: `demo-repo-${r.src.created.slice(0, 10)}-${r.src.submitterId.slice(-6)}`,
      sourceSubmissionId: submissionId(r.src),
      title: r.src.title, authors: r.src.submitterName, adviser: r.src.adviser,
      department: r.src.program, abstract: r.src.abstract, keywords: 'policy, research, evidence',
      category: r.src.category, yearCompleted: r.year, status: r.status,
      fileAvailable: 1, accessLevel: 'public',
      citation: JSON.stringify({ apa: `${r.src.submitterName}. (${r.year}). ${r.src.title}. CPRI Repository.` }),
      createdAt: r.src.approved, updatedAt: r.src.publishedAt || r.src.approved
    });
  }
  // Standalone repository records (no source submission) — these count toward
  // the approved total independently.
  await insert('repository', {
    id: 'demo-repo-standalone-1', sourceSubmissionId: null,
    title: 'CPRI Policy Brief Series: Digital Governance 2026', authors: 'CPRI Research Unit',
    adviser: 'Carlos Tan, PhD', department: 'Governance & Public Policy',
    abstract: 'Synthesis of policy recommendations on inclusive, accountable digital public services.',
    keywords: 'digital governance', category: 'Policy Brief', yearCompleted: '2026',
    status: 'approved', fileAvailable: 1, accessLevel: 'public',
    citation: JSON.stringify({ apa: 'CPRI Research Unit. (2026). CPRI Policy Brief Series: Digital Governance 2026. CPRI Repository.' }),
    createdAt: iso(2026, 3, 20), updatedAt: iso(2026, 3, 20)
  });
  await insert('repository', {
    id: 'demo-repo-standalone-2', sourceSubmissionId: null,
    title: 'Health Systems Review: Universal Health Coverage Progress Report', authors: 'CPRI Health Cluster',
    adviser: 'Carlos Tan, PhD', department: 'Health Systems & Well-being',
    abstract: 'An annual synthesis of UHC implementation progress across partner provinces.',
    keywords: 'universal health coverage', category: 'Review', yearCompleted: '2026',
    status: 'approved', fileAvailable: 1, accessLevel: 'public',
    citation: JSON.stringify({ apa: 'CPRI Health Cluster. (2026). Health Systems Review: UHC Progress Report. CPRI Repository.' }),
    createdAt: iso(2026, 6, 12), updatedAt: iso(2026, 6, 12)
  });
  console.log(`[demo] Seeded ${REPOSITORY.length + 2} repository records.`);
}

const PUBLICATIONS = [
  { title: 'Decentralization and Fiscal Autonomy of Philippine LGUs', authors: 'Ramos, M. T.; Tan, C.', journal: 'Philippine Journal of Public Administration', date: '2026-03-15', volume: '70', issue: '1', pages: '12-28', doi: '10.1234/pjpa.2026.01', pubType: 'national_journal', authorType: 'faculty', department: 'Governance & Public Policy', status: 'published' },
  { title: 'Barriers to Primary Care Utilization in Rural Health Units', authors: 'dela Cruz, J. M.; Tan, C.', journal: 'Asian Journal of Public Health', date: '2026-04-02', volume: '18', issue: '2', pages: '45-61', doi: '10.1234/ajph.2026.02', pubType: 'international_journal', authorType: 'faculty', department: 'Health Systems & Well-being', status: 'published' },
  { title: 'Teacher Professional Development and Student Learning Outcomes', authors: 'Villanueva, A.; Tan, C.', journal: 'Journal of Philippine Education', date: '2026-05-10', volume: '14', issue: '1', pages: '88-104', doi: '10.1234/jpe.2026.01', pubType: 'national_journal', authorType: 'faculty', department: 'Education & Human Capital', status: 'published' },
  { title: 'Citizen Participation in Participatory Budgeting', authors: 'Ramos, M. T.', journal: 'Public Governance Review', date: '2026-05-22', volume: '9', issue: '2', pages: '33-49', doi: '10.1234/pgr.2026.02', pubType: 'national_journal', authorType: 'faculty', department: 'Governance & Public Policy', status: 'published' },
  { title: 'Open Data Adoption in Local Government Units', authors: 'Bautista, K.; Ramos, M. T.', journal: 'CPRI Research Symposium 2026', date: '2026-06-05', volume: '', issue: '', pages: '1-9', doi: '10.1234/cpri-sym.2026.03', pubType: 'conference_paper', authorType: 'student', department: 'Governance & Public Policy', status: 'published' },
  { title: 'Nature-Based Solutions for Urban Flood Resilience', authors: 'Reyes, M.; dela Cruz, J. M.', journal: 'Journal of Urban Climate', date: '2026-06-18', volume: '31', issue: '3', pages: '210-226', doi: '10.1234/juc.2026.03', pubType: 'international_journal', authorType: 'student', department: 'Environment & Climate', status: 'published' },
  { title: 'Digital Literacy and E-Service Delivery in Provincial Governments', authors: 'Bautista, K.', journal: 'E-Government Studies', date: '2026-07-02', volume: '11', issue: '1', pages: '77-93', doi: '10.1234/egov.2026.01', pubType: 'local_journal', authorType: 'student', department: 'Governance & Public Policy', status: 'published' },
  { title: 'Telemedicine Adoption in Rural Health Facilities', authors: 'dela Cruz, J. M.', journal: 'Philippine Journal of Health Systems', date: '2026-07-15', volume: '22', issue: '2', pages: '55-70', doi: '10.1234/pjhs.2026.02', pubType: 'national_journal', authorType: 'faculty', department: 'Health Systems & Well-being', status: 'published' },
  { title: 'Senior High School Tracks and Labor Market Outcomes', authors: 'Villanueva, A.', journal: 'CPRI Policy Brief', date: '2026-07-28', volume: '', issue: '', pages: '4', doi: '10.1234/cpri-pb.2026.07', pubType: 'proceedings_paper', authorType: 'faculty', department: 'Education & Human Capital', status: 'published' },
  { title: 'Mental Health Services in Public Tertiary Hospitals', authors: 'dela Cruz, J. M.; Tan, C.', journal: 'Journal of Mental Health Policy', date: '2026-08-08', volume: '12', issue: '1', pages: '19-35', doi: '10.1234/jmhp.2026.01', pubType: 'international_journal', authorType: 'faculty', department: 'Health Systems & Well-being', status: 'published' },
  { title: 'Heat Vulnerability Mapping for Urban Communities', authors: 'Reyes, M.', journal: 'CPRI Working Paper', date: '2026-08-15', volume: '', issue: '', pages: '1-12', doi: '10.1234/cpri-wp.2026.04', pubType: 'research_poster', authorType: 'student', department: 'Environment & Climate', status: 'published' },
  { title: 'Barangay e-Governance Readiness of Rural Communities', authors: 'Bautista, K.', journal: 'CPRI Research Symposium 2026', date: '2026-08-20', volume: '', issue: '', pages: '1-8', doi: '10.1234/cpri-sym.2026.05', pubType: 'conference_paper', authorType: 'student', department: 'Governance & Public Policy', status: 'published' }
];

async function seedPublications() {
  for (const p of PUBLICATIONS) {
    await insert('publications', {
      id: `demo-pub-${p.doi.replace(/[^a-z0-9]/gi, '')}`,
      title: p.title, authors: p.authors, journalOrConference: p.journal,
      publicationDate: p.date, volume: p.volume, issue: p.issue, pages: p.pages,
      doi: p.doi, publicationLink: '', indexingStatus: 'Scopus', pubType: p.pubType,
      status: p.status, authorType: p.authorType, department: p.department,
      schoolYear: '2025-2026', proofDocuments: JSON.stringify([]),
      submitterId: USER_IDS.ramos, submitterName: p.authors,
      createdAt: `${p.date} 09:00:00`, updatedAt: `${p.date} 09:00:00`
    });
  }
  console.log(`[demo] Seeded ${PUBLICATIONS.length} publications.`);
}

const ETHICS = [
  { submitterId: USER_IDS.ramos, title: 'Transparency Portals and Public Trust', researchers: 'Maria Teresa Ramos', participantType: 'Key Informants', riskLevel: 'Minimal Risk', status: 'approved' },
  { submitterId: USER_IDS.reyes, title: 'Community-Based Mangrove Restoration', researchers: 'Miguel Reyes', participantType: 'Community Members', riskLevel: 'Minimal Risk', status: 'approved' },
  { submitterId: USER_IDS.bautista, title: 'Barangay e-Governance Readiness', researchers: 'Karla Bautista', participantType: 'Local Government Staff', riskLevel: 'Minimal Risk', status: 'under_review' },
  { submitterId: USER_IDS.delaCruz, title: 'Mental Health Services Study', researchers: 'Juan Miguel dela Cruz', participantType: 'Patients', riskLevel: 'Moderate Risk', status: 'under_review' },
  { submitterId: USER_IDS.villanueva, title: 'Early Grade Reading Assessment', researchers: 'Angela Villanueva', participantType: 'Children (Minors)', riskLevel: 'Moderate Risk', status: 'returned_for_revision' }
];

async function seedEthics() {
  for (const e of ETHICS) {
    await insert('ethics', {
      id: `demo-eth-${e.status}-${e.submitterId.slice(-6)}`,
      submitterId: e.submitterId, submitterName: e.researchers, title: e.title,
      researchers: e.researchers, adviser: 'Carlos Tan, PhD', department: 'Research & Innovation',
      participantType: e.participantType, riskLevel: e.riskLevel, status: e.status,
      statusHistory: JSON.stringify([{ status: 'submitted', at: iso(2026, 7, 6), by: e.researchers }, { status: e.status, at: iso(2026, 7, 12), by: 'Ethics Board' }]),
      files: JSON.stringify({}), additionalDocs: JSON.stringify([]), comments: JSON.stringify([]),
      certificate: JSON.stringify(null), compliance: JSON.stringify(null), revisedDocuments: JSON.stringify([]),
      createdAt: iso(2026, 7, 6), updatedAt: iso(2026, 7, 12)
    });
  }
  console.log(`[demo] Seeded ${ETHICS.length} ethics applications.`);
}

const RESEARCHERS = [
  { id: 'demo-dir-1', type: 'Faculty', fullName: 'Maria Teresa Ramos, PhD', department: 'Governance & Public Policy', program: 'Governance & Public Policy', interests: 'local governance, decentralization', citations: 312, orcid: '0000-0001-1111-1111' },
  { id: 'demo-dir-2', type: 'Faculty', fullName: 'Juan Miguel dela Cruz, PhD', department: 'Health Systems & Well-being', program: 'Health Systems & Well-being', interests: 'health systems, health financing', citations: 428, orcid: '0000-0002-2222-2222' },
  { id: 'demo-dir-3', type: 'Faculty', fullName: 'Angela Villanueva, MA', department: 'Education & Human Capital', program: 'Education & Human Capital', interests: 'education policy, assessment', citations: 156, orcid: '0000-0003-3333-3333' },
  { id: 'demo-dir-4', type: 'Student', fullName: 'Karla Bautista', department: 'Governance & Public Policy', program: 'BS Public Administration', interests: 'e-governance, open data', citations: 12, orcid: '0000-0004-4444-4444' },
  { id: 'demo-dir-5', type: 'Student', fullName: 'Miguel Reyes', department: 'Environment & Climate', program: 'BS Environmental Science', interests: 'climate adaptation, urban resilience', citations: 8, orcid: '0000-0005-5555-5555' },
  { id: 'demo-dir-6', type: 'Faculty', fullName: 'Carlos Tan, PhD', department: 'Research & Innovation', program: 'Research & Innovation', interests: 'impact evaluation, methodology', citations: 275, orcid: '0000-0006-6666-6666' }
];

async function seedResearcherDirectory() {
  for (const r of RESEARCHERS) {
    await insert('researchers', {
      id: r.id, type: r.type, fullName: r.fullName, department: r.department, program: r.program,
      researchInterests: r.interests, completedResearches: JSON.stringify(['2026-03']),
      publishedWorks: JSON.stringify(['Decentralization and Fiscal Autonomy', 'Telemedicine Adoption']),
      presentedPapers: JSON.stringify(['CPRI Research Symposium 2026']),
      awards: JSON.stringify(['CPRI Outstanding Researcher 2025']),
      innovationProjects: JSON.stringify(['Digital Governance Toolkit']),
      citations: r.citations, orcid: r.orcid, googleScholar: '', researchGate: '',
      researchTitle: '', adviser: '', yearCompleted: '', researchOutputStatus: 'active',
      createdAt: iso(2025, 11, 20), updatedAt: iso(2026, 8, 1)
    });
  }
  console.log(`[demo] Seeded ${RESEARCHERS.length} researcher directory entries.`);
}

const EVENTS_MODULE = [
  { title: 'Annual Research Symposium 2026', theme: 'Evidence for a Resilient Philippines', dateTime: '2026-09-18 08:30', venue: 'CPRI Convention Hall, Quezon City', desc: 'A full-day symposium featuring paper presentations, panel discussions, and policy dialogues across CPRI priority themes.', link: '/events.html' },
  { title: 'Policy Forum: Digital Governance', theme: 'Inclusive digital public services', dateTime: '2026-10-09 09:00', venue: 'University Boardroom', desc: 'Public forum on accountable and inclusive e-government with national and local experts.', link: '/events.html' },
  { title: 'Capability Building: Impact Evaluation', theme: 'Methods for policy research', dateTime: '2026-11-12 09:00', venue: 'CPRI Training Room 2', desc: 'Two-day workshop on impact evaluation design for faculty and student researchers.', link: '/events.html' },
  { title: 'Research Ethics Training 2026', theme: 'Responsible conduct of research', dateTime: '2027-01-15 08:30', venue: 'CPRI Training Room 1', desc: 'Required ethics certification for researchers working with human participants.', link: '/events.html' },
  { title: 'Innovation & Extension Showcase', theme: 'Research to community', dateTime: '2027-03-05 09:00', venue: 'University Quadrangle', desc: 'Showcase of extension projects and community innovations from the past year.', link: '/events.html' }
];

async function seedEventsModule() {
  for (const e of EVENTS_MODULE) {
    await insert('events_module', {
      id: eventModuleId(e),
      title: e.title, theme: e.theme, dateTime: e.dateTime, venue: e.venue,
      description: e.desc, registrationLink: e.link, programFlow: '',
      speakers: JSON.stringify(['Carlos Tan, PhD', 'Maria Teresa Ramos, PhD']),
      gallery: JSON.stringify([]), createdAt: iso(2026, 8, 1), updatedAt: iso(2026, 8, 1)
    });
  }
  console.log(`[demo] Seeded ${EVENTS_MODULE.length} events-module records.`);
}

async function seedRegistrations() {
  const regs = [
    { event: EVENTS_MODULE[0], user: USER_IDS.ramos, name: 'Maria Teresa Ramos', inst: 'CPRI', email: 'maria.ramos@demo.cpri.edu', type: 'Faculty', role: 'speaker', status: 'attended' },
    { event: EVENTS_MODULE[0], user: USER_IDS.bautista, name: 'Karla Bautista', inst: 'State University', email: 'karla.bautista@demo.cpri.edu', type: 'Student', role: 'presenter', status: 'attended' },
    { event: EVENTS_MODULE[0], user: USER_IDS.reyes, name: 'Miguel Reyes', inst: 'State University', email: 'miguel.reyes@demo.cpri.edu', type: 'Student', role: 'presenter', status: 'attended' },
    { event: EVENTS_MODULE[1], user: USER_IDS.ramos, name: 'Maria Teresa Ramos', inst: 'CPRI', email: 'maria.ramos@demo.cpri.edu', type: 'Faculty', role: 'speaker', status: 'registered' },
    { event: EVENTS_MODULE[1], user: USER_IDS.delaCruz, name: 'Juan Miguel dela Cruz', inst: 'CPRI', email: 'juan.delacruz@demo.cpri.edu', type: 'Faculty', role: 'panelist', status: 'registered' },
    { event: EVENTS_MODULE[2], user: USER_IDS.villanueva, name: 'Angela Villanueva', inst: 'CPRI', email: 'angela.villanueva@demo.cpri.edu', type: 'Faculty', role: 'facilitator', status: 'registered' },
    { event: EVENTS_MODULE[2], user: USER_IDS.bautista, name: 'Karla Bautista', inst: 'State University', email: 'karla.bautista@demo.cpri.edu', type: 'Student', role: 'attendee', status: 'registered' },
    { event: EVENTS_MODULE[3], user: USER_IDS.reyes, name: 'Miguel Reyes', inst: 'State University', email: 'miguel.reyes@demo.cpri.edu', type: 'Student', role: 'attendee', status: 'registered' }
  ];
  for (const r of regs) {
    await insert('event_registrations', {
      id: registrationId(r.event, r.user),
      eventId: eventModuleId(r.event), userId: r.user, participantName: r.name, institution: r.inst,
      email: r.email, participantType: r.type, role: r.role, abstractFile: null,
      attendanceStatus: r.status, certificateIssued: r.status === 'attended' ? 1 : 0,
      certificateData: JSON.stringify(null), createdAt: iso(2026, 8, 2)
    });
  }
  console.log(`[demo] Seeded ${regs.length} event registrations.`);
}

async function seedAbstracts() {
  const abs = [
    { event: EVENTS_MODULE[0], user: USER_IDS.bautista, title: 'Open Data Adoption in LGUs', authors: 'Karla Bautista; Maria Teresa Ramos', strand: 'Digital Governance' },
    { event: EVENTS_MODULE[0], user: USER_IDS.reyes, title: 'Nature-Based Solutions for Urban Flooding', authors: 'Miguel Reyes; Juan Miguel dela Cruz', strand: 'Climate & Environment' },
    { event: EVENTS_MODULE[0], user: USER_IDS.villanueva, title: 'Teacher PD and Learning Outcomes', authors: 'Angela Villanueva', strand: 'Education' },
    { event: EVENTS_MODULE[0], user: USER_IDS.delaCruz, title: 'Telemedicine in Rural Health', authors: 'Juan Miguel dela Cruz', strand: 'Health Systems' }
  ];
  for (const a of abs) {
    await insert('event_abstracts', {
      id: `demo-abs-${a.user.slice(-6)}`,
      eventId: eventModuleId(a.event), userId: a.user, title: a.title, authors: a.authors,
      abstract: `${a.title}. Abstract accepted for the Annual Research Symposium 2026.`,
      keywords: 'research, policy', strand: a.strand, status: 'accepted',
      createdAt: iso(2026, 8, 3)
    });
  }
  console.log(`[demo] Seeded ${abs.length} event abstracts.`);
}

const INNOVATION = [
  { projectType: 'Extension', title: 'Digital Governance Toolkit for LGUs', proponents: 'CPRI Governance Cluster', department: 'Governance & Public Policy', beneficiaries: 120, date: '2026-05-20', partner: 'Quezon City Government' },
  { projectType: 'Innovation', title: 'Community Health Information System', proponents: 'CPRI Health Cluster', department: 'Health Systems & Well-being', beneficiaries: 850, date: '2026-06-15', partner: 'Provincial Health Office' },
  { projectType: 'Extension', title: 'Climate-Resilient Barangay Program', proponents: 'CPRI Environment Cluster', department: 'Environment & Climate', beneficiaries: 640, date: '2026-07-10', partner: 'Coastal Barangay Federation' },
  { projectType: 'Innovation', title: 'Reading Assessment Dashboard', proponents: 'CPRI Education Cluster', department: 'Education & Human Capital', beneficiaries: 210, date: '2026-08-05', partner: 'Department of Education Region IV-A' }
];

async function seedInnovation() {
  for (const i of INNOVATION) {
    await insert('innovation_extension', {
      id: `demo-inno-${i.date}-${i.department.slice(0, 3).toLowerCase()}`,
      projectType: i.projectType, title: i.title, proponents: i.proponents, department: i.department,
      description: `${i.title}. Delivered with partner ${i.partner} as part of CPRI's applied research mandate.`,
      beneficiaries: i.beneficiaries, implementationDate: i.date, outputProduct: 'Training modules, dashboard, toolkit',
      communityPartner: i.partner, needsAssessment: 'Conducted stakeholder consultations in 2025.',
      interventionConducted: 'Capacity building and technology transfer conducted.', evaluationResult: 'Positive uptake among beneficiaries.',
      communityOutcome: 'Improved local capacity and adoption.', sustainabilityPlan: 'Joint maintenance with partner agency.',
      supportingDocuments: JSON.stringify([]), impactDocuments: JSON.stringify([]),
      createdAt: iso(2026, 5, 1), updatedAt: iso(2026, 8, 1)
    });
  }
  console.log(`[demo] Seeded ${INNOVATION.length} innovation & extension projects.`);
}

async function seedLogs() {
  const logs = [
    { id: 'demo-log-1', action: 'auth_login', details: 'Admin logged in', userId: null, at: iso(2026, 8, 12, 8, 30) },
    { id: 'demo-log-2', action: 'submission_status', details: 'Status changed to published', userId: USER_IDS.ramos, at: iso(2026, 8, 12, 9, 15) },
    { id: 'demo-log-3', action: 'content_create', details: 'Created event Annual Research Symposium', userId: null, at: iso(2026, 8, 11, 14, 0) },
    { id: 'demo-log-4', action: 'content_create', details: 'Created announcement Call for Papers', userId: null, at: iso(2026, 8, 10, 11, 45) },
    { id: 'demo-log-5', action: 'content_update', details: 'Updated featured research', userId: null, at: iso(2026, 8, 9, 16, 20) }
  ];
  for (const l of logs) {
    await insert('system_logs', { id: l.id, action: l.action, details: l.details, userId: l.userId, ip: '127.0.0.1', userAgent: 'CPRI demo seed', timestamp: l.at });
  }
  console.log(`[demo] Seeded ${logs.length} system log entries.`);
}

async function seedInquiries() {
  const inqs = [
    { name: 'Partner Agency', email: 'partner@demo.cpri.edu', subject: 'Research collaboration', message: 'We would like to explore a joint research collaboration for 2027.', at: iso(2026, 7, 25) },
    { name: 'External Researcher', email: 'researcher@demo.cpri.edu', subject: 'Publication inquiry', message: 'Requesting information about submission guidelines for the policy brief series.', at: iso(2026, 8, 5) }
  ];
  // No explicit id — inquiries.id is BIGINT AUTO_INCREMENT. Demo rows are
  // identified by the @demo.cpri.edu email domain for cleanup.
  for (const q of inqs) {
    await insert('inquiries', { name: q.name, email: q.email, subject: q.subject, message: q.message, receivedAt: q.at });
  }
  console.log(`[demo] Seeded ${inqs.length} inquiries.`);
}

// ---------------------------------------------------------------- JSON content

async function seedJsonContent() {
  // Events — homepage "Upcoming Events" + events page + admin Events tab.
  await appendJson('events', [
    { id: 'demo-ev-1', title: 'Annual Research Symposium 2026', type: 'Conference', date: '2026-09-18', location: 'CPRI Convention Hall, Quezon City', description: 'A full-day symposium featuring paper presentations, panel discussions, and policy dialogues across CPRI priority themes.', photo: '', createdAt: iso(2026, 8, 1) },
    { id: 'demo-ev-2', title: 'Policy Forum: Digital Governance', type: 'Forum', date: '2026-10-09', location: 'University Boardroom', description: 'Public forum on inclusive, accountable e-government with national and local experts.', photo: '', createdAt: iso(2026, 8, 1) },
    { id: 'demo-ev-3', title: 'Capability Building: Impact Evaluation', type: 'Workshop', date: '2026-11-12', location: 'CPRI Training Room 2', description: 'Two-day workshop on impact evaluation design for faculty and student researchers.', photo: '', createdAt: iso(2026, 8, 1) },
    { id: 'demo-ev-4', title: 'Research Ethics Training 2026', type: 'Training', date: '2027-01-15', location: 'CPRI Training Room 1', description: 'Required ethics certification for researchers working with human participants.', photo: '', createdAt: iso(2026, 8, 1) },
    { id: 'demo-ev-5', title: 'Past Webinar: UHC Progress in the Regions', type: 'Webinar', date: '2026-05-22', location: 'Online', description: 'Webinar on Universal Health Coverage implementation progress across partner provinces.', photo: '', createdAt: iso(2026, 8, 1) }
  ]);

  // Announcements — public announcements page. Keeps any real entries.
  await appendJson('announcements', [
    { id: 'demo-an-1', title: 'Call for Papers: Annual Research Symposium 2026', content: 'Submit abstracts for the Annual Research Symposium by August 30, 2026.', category: 'Call for Papers', date: '2026-08-14', excerpt: 'Abstracts due August 30, 2026 for the Annual Research Symposium.', body: 'Submit abstracts for the Annual Research Symposium by August 30, 2026. All CPRI priority themes are welcome.', createdAt: iso(2026, 8, 14) },
    { id: 'demo-an-2', title: 'Research Ethics Training — January 2027 Batch', content: 'Registration is now open for the January 15, 2027 ethics training.', category: 'Training', date: '2026-08-12', excerpt: 'Registration open for the January 2027 ethics certification.', body: 'Registration is now open for the January 15, 2027 research ethics training. Required for researchers working with human participants.', createdAt: iso(2026, 8, 12) },
    { id: 'demo-an-3', title: 'Call for Student Researchers — 2026 Cohort', content: 'Applications are open for the next cohort of student researchers.', category: 'General', date: '2026-08-08', excerpt: 'Applications open for the 2026 student researcher cohort.', body: 'Applications are open for the next cohort of student researchers across all CPRI priority themes.', createdAt: iso(2026, 8, 8) },
    { id: 'demo-an-4', title: 'Public Policy Brief Released: Digital Governance', content: 'The new policy brief series on digital governance is now available.', category: 'Publication', date: '2026-07-30', excerpt: 'New policy brief on digital governance now available.', body: 'The new policy brief series on digital governance is now available in the repository.', createdAt: iso(2026, 7, 30) },
    { id: 'demo-an-5', title: 'Symposium Paper Defense Schedule', content: 'Final defense schedules for student researchers are posted.', category: 'Defense Schedule', date: '2026-07-20', excerpt: 'Final defense schedules are now posted.', body: 'Final defense schedules for student researchers are posted on the submissions portal.', createdAt: iso(2026, 7, 20) }
  ]);

  // Featured research — homepage "Explore our research" section.
  await appendJson('research', [
    { id: 'demo-r-1', title: 'Decentralization and Fiscal Autonomy of Philippine LGUs', summary: 'Mixed-methods evidence on how fiscal decentralization shapes local service delivery and accountability.', author: 'Maria Teresa Ramos, PhD', date: '2026-03-15', read: 12, year: 2026, createdAt: iso(2026, 3, 16) },
    { id: 'demo-r-2', title: 'Barriers to Primary Care Utilization in Rural Health Units', summary: 'A qualitative study identifying systemic barriers to primary care access in underserved rural communities.', author: 'Juan Miguel dela Cruz, PhD', date: '2026-04-02', read: 9, year: 2026, createdAt: iso(2026, 4, 3) },
    { id: 'demo-r-3', title: 'Teacher Professional Development and Student Learning Outcomes', summary: 'Quantitative analysis linking teacher training investments to measurable gains in student achievement.', author: 'Angela Villanueva, MA', date: '2026-05-10', read: 8, year: 2026, createdAt: iso(2026, 5, 11) },
    { id: 'demo-r-4', title: 'Open Data Adoption in Local Government Units', summary: 'A capability assessment of LGU readiness for open data and e-service delivery.', author: 'Karla Bautista', date: '2026-06-05', read: 6, year: 2026, createdAt: iso(2026, 6, 6) },
    { id: 'demo-r-5', title: 'Nature-Based Solutions for Urban Flood Resilience', summary: 'Assessing the cost-effectiveness of green infrastructure for flood risk reduction in Metro Manila.', author: 'Miguel Reyes', date: '2026-06-18', read: 10, year: 2026, createdAt: iso(2026, 6, 19) },
    { id: 'demo-r-6', title: 'Telemedicine Adoption in Rural Health Facilities', summary: 'Mixed-methods findings on the drivers and barriers of telemedicine uptake in rural health facilities.', author: 'Juan Miguel dela Cruz, PhD', date: '2026-07-15', read: 11, year: 2026, createdAt: iso(2026, 7, 16) }
  ]);
}

// ---------------------------------------------------------------- main

async function main() {
  console.log('[demo] Starting demo seed...');
  await clearDemoRows();
  await clearDemoJson('events');
  await clearDemoJson('announcements');
  await clearDemoJson('research');

  if (CLEAR_ONLY) {
    console.log('[demo] Done — demo data removed. Real data untouched.');
    process.exit(0);
  }

  await seedUsers();
  await seedSubmissions();
  await seedRepository();
  await seedPublications();
  await seedEthics();
  await seedResearcherDirectory();
  await seedEventsModule();
  await seedRegistrations();
  await seedAbstracts();
  await seedInnovation();
  await seedLogs();
  await seedInquiries();
  await seedJsonContent();

  console.log('[demo] Done. Use `npm run seed:demo --clear` to remove demo data.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[demo] Seed failed:', err);
  process.exit(1);
});
