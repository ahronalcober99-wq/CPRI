import { Router } from 'express';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { requireAuth, requireRole, readUsers } from './auth.js';
import { all, get, run, insert, update, remove } from './server/db/queries.js';
import { FACULTY_ROLES } from './lib/research-config.js';
import { cachedCourses, courseFields } from './lib/courses.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const router = Router();

const RESEARCHER_TYPES = {
  faculty: 'Faculty Researcher',
  student: 'Student Researcher'
};

const OUTPUT_STATUS = {
  ongoing: 'Ongoing',
  completed: 'Completed',
  published: 'Published',
  presented: 'Presented',
  under_review: 'Under Review',
  rejected: 'Rejected'
};

const STAFF_ROLES = ['admin', 'cpri_staff'];

// ---------------------------------------------------------------------------
//  Real-data model
// ---------------------------------------------------------------------------
// The cards and the profile list used to read the hand-maintained `researchers`
// profile table. That table is empty in production, so every card rendered 0
// and the list fell back to "No researcher profiles found" even though real
// researcher accounts and submissions exist. Everything below is now computed
// from the account table (`users`) joined to the Research Submission Module
// (`research_submissions`, `research_ethics_clearances`, `gala_submissions`).
//
// Role grouping (users.role -> the page's "type"):
//   faculty   = faculty_researcher | non_teaching_researcher
//   student   = student_researcher
//   presenter = presenter (Research Gala submitters)
const FACULTY_USER_ROLES = ['faculty_researcher', 'non_teaching_researcher'];
const STUDENT_USER_ROLES = ['student_researcher'];
const PRESENTER_USER_ROLES = ['presenter'];
const DIRECTORY_USER_ROLES = [...FACULTY_USER_ROLES, ...STUDENT_USER_ROLES, ...PRESENTER_USER_ROLES];

const ROLE_LABELS = {
  faculty_researcher: 'Faculty Researcher',
  non_teaching_researcher: 'Non-Teaching Researcher',
  student_researcher: 'Student Researcher',
  // Mirrors ROLE_META in auth.js, so the directory never disagrees with
  // account.html about what a role is called.
  presenter: 'Presenter'
};

// Only accounts the portal has approved are counted or listed publicly.
const ACTIVE_STATUS = 'active';

// Submission statuses, grouped the way the summary cards count them.
const ONGOING_STATUSES = ['draft', 'submitted', 'under_initial_checking', 'for_revision', 'under_ethics_review'];
const APPROVED_STATUSES = ['approved'];
const PUBLISHED_STATUSES = ['published'];

function placeholders(list) {
  return list.map(() => '?').join(', ');
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function typeForRole(role) {
  if (FACULTY_ROLES.has(role)) return 'faculty';
  if (STUDENT_USER_ROLES.includes(role)) return 'student';
  if (PRESENTER_USER_ROLES.includes(role)) return 'presenter';
  return '';
}

// A single-value COUNT that degrades to 0 on a deployment where the optional
// table has not been created yet, instead of breaking the whole dashboard.
async function countOrZero(sql, params = [], label = '') {
  try {
    const row = await get(sql, params);
    return num(row && row.n);
  } catch (err) {
    console.warn(`[researchers] ${label || 'count'} unavailable:`, err.message);
    return 0;
  }
}

// The `researchers` table predates the account-based directory: it stores who
// the person is (type/fullName/department/program).
function legacyWhere(q = {}) {
  const where = ['1=1'];
  if (q.fullName) where.push('(fullName LIKE ? OR researchTitle LIKE ?)');
  if (q.department) where.push('(department LIKE ? OR program LIKE ? OR researchInterests LIKE ?)');
  if (q.type === 'faculty' || q.type === 'student') where.push('type = ?');
  // A manual profile is never a Research Gala presenter, so it cannot match
  // the presenter filter.
  if (q.type === 'presenter' || q.type === 'non_teaching') where.push('1=0');
  return where;
}

function legacyParams(q = {}) {
  const params = [];
  if (q.fullName) params.push(`%${q.fullName}%`, `%${q.fullName}%`);
  if (q.department) params.push(`%${q.department}%`, `%${q.department}%`, `%${q.department}%`);
  if (q.type === 'faculty' || q.type === 'student') params.push(q.type);
  return params;
}

async function allOrEmpty(sql, params = [], label = '') {
  try {
    return await all(sql, params);
  } catch (err) {
    console.warn(`[researchers] ${label || 'query'} unavailable:`, err.message);
    return [];
  }
}

// Student course names for a set of account ids, read separately so the
// directory still loads on a database that has not gained the course columns.
async function studentCourses(rows) {
  const ids = rows.filter(r => r.role === 'student_researcher').map(r => r.id);
  if (!ids.length) return new Map();
  const found = await allOrEmpty(
    `SELECT id, role, course_id, course_other FROM users WHERE id IN (${placeholders(ids)})`,
    ids, 'student courses'
  );
  return new Map(found.map(u => [u.id, courseFields(u).course]));
}

// A registered researcher (users row) rather than a hand-entered profile row.
async function getResearcherUser(id) {
  return get(
    `SELECT id, fullName, role, status, department, program, researchInterests,
            researchTitle, researchArea, institution, nationality, adviser, createdAt
       FROM users
      WHERE id = ? AND role IN (${placeholders(DIRECTORY_USER_ROLES)})`,
    [id, ...DIRECTORY_USER_ROLES]
  );
}

// Maps the module's statuses onto the coarse output statuses the profile page
// already renders, so a real account's profile shows a meaningful state.
function outputStatusFor(submissions) {
  if (!submissions.length) return 'ongoing';
  const has = (status) => submissions.some(s => s.status === status);
  if (has('published')) return 'published';
  if (has('approved')) return 'completed';
  if (has('rejected')) return 'rejected';
  if (submissions.some(s => ONGOING_STATUSES.slice(1).includes(s.status))) return 'under_review';
  return 'ongoing';
}

// Builds the same payload shape the `researchers` profile table produces, so
// researcher-detail.html renders a registered account without any change.
async function buildUserBackedResearcher(u) {
  const submissions = await allOrEmpty(
    `SELECT id, title, status, stage, research_type, school_year, created_at
       FROM research_submissions WHERE owner_id = ? ORDER BY created_at DESC`,
    [u.id], 'researcher submissions'
  );
  const gala = await allOrEmpty(
    `SELECT id, title, presentationType, status FROM gala_submissions
      WHERE userId = ? ORDER BY createdAt DESC`,
    [u.id], 'researcher gala submissions'
  );

  const titlesFor = (statuses) => submissions
    .filter(s => statuses.includes(s.status))
    .map(s => s.title || 'Untitled research');

  const outputStatus = outputStatusFor(submissions);
  const course = u.role === 'student_researcher' ? ((await studentCourses([u])).get(u.id) || '') : '';

  return {
    id: u.id,
    accountBacked: true,
    type: typeForRole(u.role),
    role: u.role,
    roleLabel: ROLE_LABELS[u.role] || u.role,
    fullName: u.fullName || '',
    department: u.department || '',
    program: u.program || '',
    course,
    researchInterests: u.researchInterests || u.researchArea || '',
    researchTitle: u.researchTitle || (submissions[0] ? submissions[0].title : ''),
    adviser: u.adviser || '',
    yearCompleted: '',
    institution: u.institution || '',
    nationality: u.nationality || '',
    researchOutputStatus: outputStatus,
    outputStatusLabel: OUTPUT_STATUS[outputStatus] || outputStatus,
    orcid: '',
    googleScholar: '',
    researchGate: '',
    completedResearches: titlesFor([...APPROVED_STATUSES, ...PUBLISHED_STATUSES]),
    publishedWorks: titlesFor(PUBLISHED_STATUSES),
    presentedPapers: gala.filter(g => g.status === 'accepted').map(g => g.title || 'Untitled presentation'),
    innovationProjects: [],
    awards: [],
    citations: 0,
    counts: {
      submissions: submissions.length,
      completed: submissions.filter(s => [...APPROVED_STATUSES, ...PUBLISHED_STATUSES].includes(s.status)).length,
      published: submissions.filter(s => PUBLISHED_STATUSES.includes(s.status)).length,
      presentations: gala.filter(g => g.status === 'accepted').length
    },
    submissions: submissions.map(s => ({
      id: s.id, title: s.title, status: s.status, stage: s.stage, createdAt: s.created_at
    }))
  };
}

async function caller(req) {
  const users = await readUsers();
  return users.find(u => u.id === req.session.userId) || null;
}
function canEdit(me) {
  return !!me && STAFF_ROLES.includes(me.role);
}

router.get('/', async (req, res) => {
  const q = req.query;
  let sql = 'SELECT * FROM researchers WHERE 1=1';
  const params = [];

  if (q.fullName) { sql += ' AND fullName LIKE ?'; params.push(`%${q.fullName}%`); }
  if (q.department) { sql += ' AND department LIKE ?'; params.push(`%${q.department}%`); }
  if (q.program) { sql += ' AND program LIKE ?'; params.push(`%${q.program}%`); }
  if (q.type) { sql += ' AND type = ?'; params.push(q.type); }
  if (q.year) { sql += ' AND yearCompleted = ?'; params.push(q.year); }
  if (q.status) { sql += ' AND researchOutputStatus = ?'; params.push(q.status); }

  sql += ' ORDER BY fullName ASC';
  const list = await all(sql, params);

  res.json({
    researchers: list.map(r => ({
      id: r.id,
      type: r.type,
      fullName: r.fullName,
      department: r.department,
      program: r.program,
      researchTitle: r.researchTitle,
      adviser: r.adviser,
      yearCompleted: r.yearCompleted,
      researchOutputStatus: r.researchOutputStatus,
      outputStatusLabel: OUTPUT_STATUS[r.researchOutputStatus] || r.researchOutputStatus,
      researchInterests: r.researchInterests,
      publications: r.publishedWorks ? r.publishedWorks.length : 0,
      presentations: r.presentedPapers ? r.presentedPapers.length : 0,
      awards: r.awards ? r.awards.length : 0,
      orcid: r.orcid,
      googleScholar: r.googleScholar,
      researchGate: r.researchGate
    }))
  });
});

// ---- GET /api/researchers/stats ------------------------------------------
// Real, database-derived counts for the summary cards. Nothing here is
// hardcoded and nothing is estimated: researchers come from `users`, the
// research numbers come from the submission module, and the optional tables
// degrade to 0 with a logged warning instead of failing the request.
router.get('/stats', async (req, res) => {
  try {
    const people = await get(
      `SELECT
         COUNT(*) AS totalResearchers,
         COALESCE(SUM(role IN (${placeholders(FACULTY_USER_ROLES)})), 0) AS faculty,
         COALESCE(SUM(role IN (${placeholders(STUDENT_USER_ROLES)})), 0) AS students,
         COALESCE(SUM(role IN (${placeholders(PRESENTER_USER_ROLES)})), 0) AS presenters
       FROM users
       WHERE status = ? AND role IN (${placeholders(DIRECTORY_USER_ROLES)})`,
      [
        ...FACULTY_USER_ROLES, ...STUDENT_USER_ROLES, ...PRESENTER_USER_ROLES,
        ACTIVE_STATUS,
        ...DIRECTORY_USER_ROLES
      ]
    );

    const work = await get(
      `SELECT
         COUNT(*) AS totalSubmissions,
         COALESCE(SUM(status IN (${placeholders(ONGOING_STATUSES)})), 0) AS ongoing,
         COALESCE(SUM(status IN (${placeholders(APPROVED_STATUSES)})), 0) AS approved,
         COALESCE(SUM(status IN (${placeholders(PUBLISHED_STATUSES)})), 0) AS published
       FROM research_submissions`,
      [...ONGOING_STATUSES, ...APPROVED_STATUSES, ...PUBLISHED_STATUSES]
    );

    const ethicsClearances = await countOrZero(
      'SELECT COUNT(*) AS n FROM research_ethics_clearances', [], 'ethics clearances'
    );
    const galaSubmissions = await countOrZero(
      'SELECT COUNT(*) AS n FROM gala_submissions', [], 'gala submissions'
    );
    const galaPresentations = await countOrZero(
      "SELECT COUNT(*) AS n FROM gala_submissions WHERE status = 'accepted'", [], 'gala presentations'
    );

    res.json({
      stats: {
        totalResearchers: num(people.totalResearchers),
        faculty: num(people.faculty),
        students: num(people.students),
        presenters: num(people.presenters),
        totalSubmissions: num(work.totalSubmissions),
        ongoing: num(work.ongoing),
        approved: num(work.approved),
        published: num(work.published),
        ethicsClearances,
        galaPresentations,
        galaSubmissions,
        // Hand-entered profiles live in their own table; exposed so the page
        // can explain the difference between the two sources when both exist.
        profileRecords: await countOrZero('SELECT COUNT(*) AS n FROM researchers', [], 'researcher profiles')
      }
    });
  } catch (err) {
    console.error('[researchers] stats failed:', err.message);
    res.status(500).json({ error: 'Could not load researcher statistics.' });
  }
});

// ---- GET /api/researchers/directory --------------------------------------
// The researcher list: one row per real account (faculty, non-teaching,
// student, presenter) with its submission and publication counts, plus the
// search/filter options the page offers. Only directory-safe columns are
// published — never email, username, student id or contact number.
router.get('/directory', async (req, res) => {
  const q = req.query || {};
  const where = ['u.status = ?', `u.role IN (${placeholders(DIRECTORY_USER_ROLES)})`];
  const params = [ACTIVE_STATUS, ...DIRECTORY_USER_ROLES];

  if (q.fullName) {
    where.push('(u.fullName LIKE ? OR u.researchTitle LIKE ?)');
    params.push(`%${q.fullName}%`, `%${q.fullName}%`);
  }

  if (q.department) {
    // The "Department / Program" search also finds students by course name.
    const needle = String(q.department).toLowerCase();
    const courseIds = cachedCourses({ includeInactive: true })
      .filter(c => c.name.toLowerCase().includes(needle))
      .map(c => c.id);
    const byCourse = courseIds.length ? ` OR u.course_id IN (${placeholders(courseIds)})` : '';
    where.push(`(u.department LIKE ? OR u.program LIKE ? OR u.researchArea LIKE ?${byCourse})`);
    params.push(`%${q.department}%`, `%${q.department}%`, `%${q.department}%`, ...courseIds);
  }

  if (q.type === 'faculty') {
    where.push(`u.role IN (${placeholders(FACULTY_USER_ROLES)})`);
    params.push(...FACULTY_USER_ROLES);
  } else if (q.type === 'student') {
    where.push(`u.role IN (${placeholders(STUDENT_USER_ROLES)})`);
    params.push(...STUDENT_USER_ROLES);
  } else if (q.type === 'presenter') {
    where.push(`u.role IN (${placeholders(PRESENTER_USER_ROLES)})`);
    params.push(...PRESENTER_USER_ROLES);
  } else if (q.type === 'non_teaching') {
    where.push("u.role = 'non_teaching_researcher'");
  }

  try {
    const rows = await all(
      `SELECT u.id, u.fullName, u.role, u.department, u.program,
              u.researchArea, u.researchTitle, u.institution,
              COUNT(s.id) AS submissions,
              COALESCE(SUM(s.status IN (${placeholders(PUBLISHED_STATUSES)})), 0) AS published,
              COALESCE(SUM(s.status IN (${placeholders(APPROVED_STATUSES)})), 0) AS approved,
              MAX(s.updated_at) AS lastActivityAt
         FROM users u
         LEFT JOIN research_submissions s ON s.owner_id = u.id
        WHERE ${where.join(' AND ')}
        GROUP BY u.id, u.fullName, u.role, u.department, u.program,
                 u.researchArea, u.researchTitle, u.institution
        ORDER BY u.fullName ASC`,
      [...PUBLISHED_STATUSES, ...APPROVED_STATUSES, ...params]
    );

    // Hand-entered profiles (Admin -> + Add Researcher) are kept in the same
    // list, so adding one through the existing form still shows up here.
    const profiles = await allOrEmpty(
      `SELECT * FROM researchers WHERE ${legacyWhere(q).join(' AND ')} ORDER BY fullName ASC`,
      legacyParams(q), 'legacy researcher profiles'
    );

    const courses = await studentCourses(rows);
    const accounts = rows.map(r => ({
      id: r.id,
      source: 'account',
      type: typeForRole(r.role),
      role: r.role,
      roleLabel: ROLE_LABELS[r.role] || r.role,
      fullName: r.fullName || '',
      department: r.department || '',
      program: r.program || '',
      course: courses.get(r.id) || '',
      researchArea: r.researchArea || '',
      researchTitle: r.researchTitle || '',
      institution: r.institution || '',
      submissions: num(r.submissions),
      published: num(r.published),
      approved: num(r.approved),
      lastActivityAt: r.lastActivityAt || null
    }));

    const manual = profiles.map(r => ({
      id: r.id,
      source: 'profile',
      type: r.type,
      role: '',
      roleLabel: RESEARCHER_TYPES[r.type] || r.type,
      fullName: r.fullName || '',
      department: r.department || '',
      program: r.program || '',
      researchArea: r.researchInterests || '',
      researchTitle: r.researchTitle || '',
      institution: '',
      // A hand-entered profile documents works rather than module submissions.
      submissions: (r.completedResearches || []).length,
      published: (r.publishedWorks || []).length,
      approved: 0,
      publications: (r.publishedWorks || []).length,
      presentations: (r.presentedPapers || []).length,
      awards: (r.awards || []).length,
      outputStatusLabel: OUTPUT_STATUS[r.researchOutputStatus] || r.researchOutputStatus || '',
      lastActivityAt: r.updatedAt || null
    }));

    const researchers = [...accounts, ...manual]
      .sort((a, b) => String(a.fullName).localeCompare(String(b.fullName)));

    res.json({ total: researchers.length, accounts: accounts.length, profiles: manual.length, researchers });
  } catch (err) {
    console.error('[researchers] directory failed:', err.message);
    res.status(500).json({ error: 'Could not load researchers.' });
  }
});

// ---- GET /api/researchers/:id --------------------------------------------
// A hand-entered profile row wins; otherwise the id is resolved to a real
// researcher account and shaped into the same payload, so one URL works for
// both kinds of profile.
router.get('/:id', async (req, res) => {
  try {
    const r = await get('SELECT * FROM researchers WHERE id = ?', [req.params.id]);
    if (r) {
      return res.json({
        researcher: r,
        typeLabel: RESEARCHER_TYPES[r.type] || r.type,
        outputStatusLabel: OUTPUT_STATUS[r.researchOutputStatus] || r.researchOutputStatus
      });
    }

    const u = await getResearcherUser(req.params.id);
    if (!u) return res.status(404).json({ error: 'Researcher profile not found.' });

    const researcher = await buildUserBackedResearcher(u);
    res.json({
      researcher,
      typeLabel: RESEARCHER_TYPES[researcher.type] || researcher.roleLabel,
      outputStatusLabel: researcher.outputStatusLabel
    });
  } catch (err) {
    console.error('[researchers] profile failed:', err.message);
    res.status(500).json({ error: 'Could not load this researcher profile.' });
  }
});

router.post('/', requireAuth, async (req, res) => {
  const me = await caller(req);
  if (!me || !canEdit(me)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });

  const b = req.body || {};
  const required = ['fullName', 'type'];
  for (const f of required) {
    if (!b[f]) return res.status(400).json({ error: `Field "${f}" is required.` });
  }

  const rec = {
    id: randomUUID(),
    type: String(b.type).trim(),
    fullName: String(b.fullName).trim(),
    department: b.department ? String(b.department).trim() : '',
    program: b.program ? String(b.program).trim() : '',
    researchInterests: b.researchInterests ? String(b.researchInterests).trim() : '',
    completedResearches: JSON.stringify(Array.isArray(b.completedResearches) ? b.completedResearches : []),
    publishedWorks: JSON.stringify(Array.isArray(b.publishedWorks) ? b.publishedWorks : []),
    presentedPapers: JSON.stringify(Array.isArray(b.presentedPapers) ? b.presentedPapers : []),
    awards: JSON.stringify(Array.isArray(b.awards) ? b.awards : []),
    innovationProjects: JSON.stringify(Array.isArray(b.innovationProjects) ? b.innovationProjects : []),
    citations: typeof b.citations === 'number' ? b.citations : 0,
    orcid: b.orcid ? String(b.orcid).trim() : '',
    googleScholar: b.googleScholar ? String(b.googleScholar).trim() : '',
    researchGate: b.researchGate ? String(b.researchGate).trim() : '',
    researchTitle: b.researchTitle ? String(b.researchTitle).trim() : '',
    adviser: b.adviser ? String(b.adviser).trim() : '',
    yearCompleted: b.yearCompleted ? String(b.yearCompleted).trim() : '',
    researchOutputStatus: b.researchOutputStatus ? String(b.researchOutputStatus).trim() : '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await insert('researchers', rec);
  res.status(201).json({ message: 'Researcher profile added.', researcher: rec });
});

router.patch('/:id', requireAuth, async (req, res) => {
  const me = await caller(req);
  if (!me || !canEdit(me)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });

  const r = await get('SELECT * FROM researchers WHERE id = ?', [req.params.id]);

  // A directory entry belongs to a registered account. Only the profile
  // fields that live on the account are editable here; role, name and login
  // details stay under Admin -> Users.
  if (!r) {
    const u = await getResearcherUser(req.params.id);
    if (!u) return res.status(404).json({ error: 'Researcher profile not found.' });

    const b = req.body || {};
    const changes = {};
    for (const f of ['department', 'program', 'researchInterests', 'researchTitle']) {
      if (b[f] !== undefined) changes[f] = String(b[f]).trim();
    }
    if (Object.keys(changes).length === 0) {
      return res.status(400).json({
        error: 'No editable fields in this request. A registered researcher\'s name, role and account are managed in Admin -> Users.'
      });
    }

    await update('users', u.id, changes);
    const researcher = await buildUserBackedResearcher({ ...u, ...changes });
    // The form also sends type and output status, which cannot apply here: an
    // account's type is its role (changed only in Admin -> Users) and its
    // output status is derived from the submission module. Say so instead of
    // silently dropping them.
    const ignored = ['type', 'researchOutputStatus'].filter(k => b[k] !== undefined);
    const note = ignored.length
      ? ' Not applied to a registered account: ' + ignored.join(' and ') + ' (managed in Admin -> Users / derived from submissions).'
      : '';
    return res.json({ message: 'Researcher details updated.' + note, researcher });
  }

  const b = req.body || {};
  const changes = {};
  const editable = [
    'type', 'fullName', 'department', 'program', 'researchInterests',
    'completedResearches', 'publishedWorks', 'presentedPapers', 'awards',
    'innovationProjects', 'citations', 'orcid', 'googleScholar', 'researchGate',
    'researchTitle', 'adviser', 'yearCompleted', 'researchOutputStatus'
  ];
  for (const f of editable) {
    if (b[f] !== undefined) {
      if (Array.isArray(b[f])) changes[f] = JSON.stringify(b[f]);
      else if (typeof b[f] === 'number') changes[f] = b[f];
      else changes[f] = String(b[f]).trim();
    }
  }
  changes.updatedAt = new Date().toISOString();
  await update('researchers', req.params.id, changes);
  const updated = await get('SELECT * FROM researchers WHERE id = ?', [req.params.id]);
  res.json({ message: 'Researcher profile updated.', researcher: updated });
});

router.delete('/:id', requireAuth, async (req, res) => {
  const me = await caller(req);
  if (!me || !canEdit(me)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });

  const r = await get('SELECT * FROM researchers WHERE id = ?', [req.params.id]);
  if (!r) {
    // Never delete a real account through the researcher page: that would
    // remove the person's login and every submission tied to it.
    const u = await getResearcherUser(req.params.id);
    if (u) {
      return res.status(400).json({
        error: 'This researcher has a registered account and cannot be deleted here. Disable or remove the account in Admin -> Users.'
      });
    }
    return res.status(404).json({ error: 'Researcher profile not found.' });
  }
  await remove('researchers', req.params.id);
  res.json({ message: 'Researcher profile removed.' });
});

export { router as researchersRouter, RESEARCHER_TYPES, OUTPUT_STATUS, STAFF_ROLES };

