// Researcher seed — sample faculty / non-teaching / student / presenter
// accounts with Research Submission Module records, so the public Researchers
// page (summary cards + directory) can be tested end to end with real rows.
//
//   npm run seed:researchers          -> wipe previous seed rows, then seed fresh
//   npm run seed:researchers --clear  -> remove ONLY this seed data
//
// Safety rules:
//  - Every row uses an id prefixed with "rseed-" (users, submissions, ethics
//    clearances, gala submissions), so it can be identified and removed without
//    ever touching real accounts, real submissions or other demo data.
//  - Counts on the Researchers page are computed from the database, so any row
//    this script adds is a real row; nothing here is hardcoded into the page.
//  - Writes go through insert() in ./db/queries.js, which normalizes ISO
//    timestamps for MySQL/MariaDB DATETIME columns.

import '../load-env.js';
import bcrypt from 'bcryptjs';
import { insert, run, all } from './db/queries.js';

const PREFIX = 'rseed-';
const SAMPLE_PASSWORD = 'sample12345';
const CLEAR_ONLY = process.argv.includes('--clear');

const iso = (y, m, d, h = 9, min = 0) => new Date(Date.UTC(y, m - 1, d, h, min)).toISOString();
const uid = (name) => `${PREFIX}user-${name}`;
const subId = (n) => `${PREFIX}sub-${String(n).padStart(2, '0')}`;

// ---------------------------------------------------------------- sample people
// `role` is the real users.role the portal uses; `department` and `program`
// feed the directory's Department/Program filter.
const PEOPLE = [
  {
    key: 'fac-1', username: 'rseed.faculty1', email: 'sample.faculty1@example.edu',
    fullName: 'Sample Faculty Researcher', role: 'faculty_researcher',
    department: 'Governance & Public Policy', program: 'MPA - Public Administration',
    interests: 'local governance, public finance, policy evaluation'
  },
  {
    key: 'fac-2', username: 'rseed.faculty2', email: 'sample.faculty2@example.edu',
    fullName: 'Sample Faculty Researcher II', role: 'faculty_researcher',
    department: 'Environment & Climate', program: 'MS Environmental Science',
    interests: 'climate adaptation, disaster risk reduction'
  },
  {
    key: 'ntt-1', username: 'rseed.nonteaching1', email: 'sample.nonteaching1@example.edu',
    fullName: 'Sample Non-Teaching Researcher', role: 'non_teaching_researcher',
    department: 'Research & Innovation', program: 'Research Office',
    interests: 'research management, extension programs'
  },
  {
    key: 'stu-1', username: 'rseed.student1', email: 'sample.student1@example.edu',
    fullName: 'Sample Student Researcher', role: 'student_researcher',
    department: 'Education & Human Capital', program: 'BSED - Mathematics',
    interests: 'learning assessment, teacher quality'
  },
  {
    key: 'stu-2', username: 'rseed.student2', email: 'sample.student2@example.edu',
    fullName: 'Sample Student Researcher II', role: 'student_researcher',
    department: 'Health Systems & Well-being', program: 'BSN - Nursing',
    interests: 'primary care, community health'
  },
  {
    key: 'pres-1', username: 'rseed.presenter1', email: 'sample.presenter1@example.edu',
    fullName: 'Sample Gala Presenter', role: 'presenter',
    department: 'Governance & Public Policy', program: 'MPA - Public Administration',
    interests: 'e-governance, open data'
  }
];

function userRow(p, passwordHash) {
  return {
    id: uid(p.key),
    username: p.username,
    email: p.email,
    fullName: p.fullName,
    role: p.role,
    passwordHash,
    status: 'active',
    department: p.department,
    program: p.program,
    contactNumber: '',
    researchInterests: p.interests,
    researchArea: p.interests,
    researchTitle: '',
    profilePhoto: null,
    researches: JSON.stringify([]),
    resetToken: null,
    resetTokenExpiry: null,
    setupPending: 0,
    createdAt: iso(2026, 8, 1)
  };
}

// ---------------------------------------------------------------- sample work
// Every status below is a real status from server/lib/research-config.js, so
// the cards' Ongoing / Approved / Published buckets all light up.
const SUBMISSIONS = [
  { n: 1,  owner: 'fac-1', stage: 'final',   role: 'faculty_researcher',      status: 'published',            title: 'Decentralization and Local Fiscal Autonomy: A Policy Review', created: iso(2026, 1, 12), moved: iso(2026, 3, 2) },
  { n: 2,  owner: 'fac-1', stage: 'final',   role: 'faculty_researcher',      status: 'published',            title: 'Participatory Budgeting in Philippine Cities',                created: iso(2026, 2, 8),  moved: iso(2026, 4, 6) },
  { n: 3,  owner: 'fac-1', stage: 'initial', role: 'faculty_researcher',      status: 'under_ethics_review',  title: 'Transparency Portals and Public Trust',                      created: iso(2026, 7, 2),  moved: iso(2026, 7, 15) },
  { n: 4,  owner: 'fac-2', stage: 'final',   role: 'faculty_researcher',      status: 'approved',             title: 'Mangrove Restoration as Climate Adaptation',                  created: iso(2026, 5, 4),  moved: iso(2026, 6, 1) },
  { n: 5,  owner: 'fac-2', stage: 'initial', role: 'faculty_researcher',      status: 'rejected',             title: 'Heat Vulnerability Mapping: A Preliminary Scan',              created: iso(2026, 6, 3),  moved: iso(2026, 6, 20) },
  { n: 6,  owner: 'ntt-1', stage: 'initial', role: 'non_teaching_researcher', status: 'approved',             title: 'Research Management Practices in State Universities',        created: iso(2026, 4, 14), moved: iso(2026, 5, 20) },
  { n: 7,  owner: 'ntt-1', stage: 'final',   role: 'non_teaching_researcher', status: 'submitted',            title: 'Extension Program Impact on Partner Communities',            created: iso(2026, 8, 4),  moved: iso(2026, 8, 4) },
  { n: 8,  owner: 'stu-1', stage: 'final',   role: 'student_researcher',      status: 'published',            title: 'Early Grade Reading Assessment: A Baseline Study',           created: iso(2026, 3, 15), moved: iso(2026, 6, 9) },
  { n: 9,  owner: 'stu-1', stage: 'initial', role: 'student_researcher',      status: 'for_revision',         title: 'Mathematics Anxiety and Learner Performance',                 created: iso(2026, 7, 20), moved: iso(2026, 8, 2) },
  { n: 10, owner: 'stu-2', stage: 'initial', role: 'student_researcher',      status: 'under_initial_checking', title: 'Primary Care Access in Rural Health Units',                created: iso(2026, 8, 6),  moved: iso(2026, 8, 8) },
  { n: 11, owner: 'stu-2', stage: 'initial', role: 'student_researcher',      status: 'draft',                title: 'Community Health Volunteers: A Work in Progress',            created: iso(2026, 8, 20), moved: iso(2026, 8, 20) },
  { n: 12, owner: 'pres-1', stage: 'final',  role: 'presenter',               status: 'submitted',            title: 'Open Data Readiness of Municipal Governments',               created: iso(2026, 8, 18), moved: iso(2026, 8, 18) }
];

const byKey = Object.fromEntries(PEOPLE.map(p => [p.key, p]));

function submissionRow(s) {
  const person = byKey[s.owner];
  return {
    id: subId(s.n),
    owner_id: uid(s.owner),
    owner_name: person.fullName,
    owner_role: s.role,
    stage: s.stage,
    title: s.title,
    authors: person.fullName,
    program: person.program,
    institution: '',
    nationality: 'Filipino',
    category: 'Sample data',
    research_type: 'Quantitative',
    school_year: '2026-2027',
    semester: '1st Semester',
    adviser_id: null,
    facilitator_id: null,
    abstract: `${s.title}. Seeded sample record for testing the Researchers page and the Research Submission Module.`,
    keywords: 'sample, seed, research',
    adviser_eval_link: '',
    status: s.status,
    created_at: s.created,
    updated_at: s.moved
  };
}

// Ethics clearances for submissions that have already passed the panel, so the
// "Ethics Clearances" card is non-zero in a seeded database.
const CLEARANCES = [
  { n: '01', submission: 1, decision: 'approved', at: iso(2026, 2, 1) },
  { n: '02', submission: 6, decision: 'approved', at: iso(2026, 5, 10) }
];

const GALA = [
  { n: '01', owner: 'pres-1', title: 'Open Data Readiness of Municipal Governments', status: 'accepted', at: iso(2026, 7, 10) },
  { n: '02', owner: 'pres-1', title: 'Digital Transformation in Barangay Services', status: 'submitted', at: iso(2026, 8, 12) }
];

// ---------------------------------------------------------------- clearing
async function clearSeedRows() {
  const tables = [
    ['research_ethics_clearances', `DELETE FROM research_ethics_clearances WHERE id LIKE '${PREFIX}%'`],
    ['research_submission_files', `DELETE FROM research_submission_files WHERE submission_id LIKE '${PREFIX}%'`],
    ['research_comments', `DELETE FROM research_comments WHERE submission_id LIKE '${PREFIX}%'`],
    ['research_submissions', `DELETE FROM research_submissions WHERE owner_id LIKE '${PREFIX}%'`],
    ['gala_submissions', `DELETE FROM gala_submissions WHERE userId LIKE '${PREFIX}%'`],
    ['users', `DELETE FROM users WHERE id LIKE '${PREFIX}%'`]
  ];
  for (const [name, sql] of tables) {
    try {
      const res = await run(sql);
      console.log(`[seed:researchers] cleared ${name} (${res.affectedRows ?? 0} row(s))`);
    } catch (err) {
      console.warn(`[seed:researchers] could not clear ${name}:`, err.message);
    }
  }
}

// ---------------------------------------------------------------- seeding
async function seed() {
  const passwordHash = await bcrypt.hash(SAMPLE_PASSWORD, 10);

  for (const p of PEOPLE) {
    await insert('users', userRow(p, passwordHash));
  }
  console.log(`[seed:researchers] inserted ${PEOPLE.length} researcher accounts`);

  for (const s of SUBMISSIONS) {
    await insert('research_submissions', submissionRow(s));
  }
  console.log(`[seed:researchers] inserted ${SUBMISSIONS.length} research submissions`);

  for (const c of CLEARANCES) {
    const s = SUBMISSIONS.find(x => x.n === c.submission);
    await insert('research_ethics_clearances', {
      id: `${PREFIX}ethics-${c.n}`,
      submission_id: subId(c.submission),
      reviewer_id: uid('ntt-1'),
      reviewer_name: byKey['ntt-1'].fullName,
      decision: c.decision,
      file_path: null,
      file_name: null,
      storage_backend: 'disk',
      decided_at: c.at
    });
    if (!s) console.warn(`[seed:researchers] clearance ${c.n} has no submission`);
  }
  console.log(`[seed:researchers] inserted ${CLEARANCES.length} ethics clearances`);

  for (const g of GALA) {
    const person = byKey[g.owner];
    await insert('gala_submissions', {
      id: `${PREFIX}gala-${g.n}`,
      userId: uid(g.owner),
      submitterName: person.fullName,
      eventId: null,
      title: g.title,
      authors: person.fullName,
      institution: '',
      nationality: 'Filipino',
      contactNumber: '',
      researchInterests: person.interests,
      presentationType: 'oral',
      strand: person.department,
      keywords: 'sample, gala',
      abstractText: `${g.title}. Seeded sample Research Gala record.`,
      status: g.status,
      statusHistory: JSON.stringify([{ status: g.status, at: g.at, by: 'Seeder', note: '' }]),
      files: JSON.stringify([]),
      createdAt: g.at,
      updatedAt: g.at
    });
  }
  console.log(`[seed:researchers] inserted ${GALA.length} Research Gala submissions`);
}

async function report() {
  const rows = await all(
    `SELECT role, COUNT(*) AS n FROM users WHERE id LIKE '${PREFIX}%' GROUP BY role ORDER BY role`
  );
  console.log('[seed:researchers] seeded accounts by role:',
    rows.map(r => `${r.role}=${r.n}`).join(', ') || 'none');
}

(async () => {
  try {
    if (CLEAR_ONLY) {
      await clearSeedRows();
      console.log('[seed:researchers] done (clear only).');
      process.exit(0);
    }

    // Idempotent: re-running replaces the previous sample set instead of
    // duplicating it. Real accounts, submissions and other demo data are never
    // matched by the "rseed-" prefix.
    await clearSeedRows();
    await seed();
    await report();
    console.log(`[seed:researchers] done. Sample logins: sample.faculty1@example.edu / ${SAMPLE_PASSWORD}`);
    process.exit(0);
  } catch (err) {
    console.error('[seed:researchers] failed:', err.message);
    process.exit(1);
  }
})();
