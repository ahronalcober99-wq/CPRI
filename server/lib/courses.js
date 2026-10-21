// ---------------------------------------------------------------------------
//  Courses — the ONE shared course list
//
//  Every page that offers or shows a student's course reads the `courses`
//  table through this module (directly, or through GET /api/courses in
//  server/courses.js). Nothing else keeps its own copy of the list: the seed
//  file is read once, only to fill an empty table on first boot.
//
//  A student's course lives on the users row:
//    course_id      the chosen courses.id (NULL = none, or "Other")
//    course_other   the text typed for "Other (please specify)"
//    course_review  1 while an "Other" entry waits for an admin to review it
//  Only student_researcher accounts may hold a course; the server enforces it
//  here (resolveCourseInput) for registration and for every admin edit.
//
//  This file holds no Express routes, so auth.js can import it without the
//  circular import auth.js -> courses router -> auth.js.
// ---------------------------------------------------------------------------
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { promises as fs } from 'fs';
import { all as defaultAll, get as defaultGet, run as defaultRun } from '../server/db/queries.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_FILE = join(__dirname, '..', 'data', 'courses-seed.json');

export const STUDENT_ROLE = 'student_researcher';
// The value the course picker sends for "Other (please specify)".
export const OTHER_COURSE_VALUE = 'other';
export const COURSE_NAME_MAX = 180;
export const COURSE_DEPARTMENT_MAX = 120;
// Change set that removes a course from an account (role moved off Student).
export const CLEARED_COURSE = Object.freeze({ course_id: null, course_other: null, course_review: 0 });

// ---------- In-memory copy of the table ----------
// publicUser() in auth.js is synchronous and is called from a dozen routes, so
// it reads course names from this cache instead of joining every query. The
// cache is filled on boot and refreshed after every change made through the
// courses API, and on every GET /api/courses.
let courseCache = new Map();

function toCourse(row) {
  return {
    id: Number(row.id),
    name: String(row.name || ''),
    department: String(row.department || ''),
    isActive: row.is_active === 1 || row.is_active === '1' || row.is_active === true,
    sortOrder: Number(row.sort_order) || 0
  };
}

function sortCourses(list) {
  return list.slice().sort((a, b) => (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name));
}

export async function refreshCourseCache(dependencies = {}) {
  const all = dependencies.all || defaultAll;
  const rows = await all('SELECT id, name, department, is_active, sort_order FROM courses');
  courseCache = new Map(rows.map(r => [Number(r.id), toCourse(r)]));
  return courseCache;
}

export function cachedCourse(id) {
  if (id === null || id === undefined || id === '') return null;
  return courseCache.get(Number(id)) || null;
}

// Every course, ordered the way the pickers list them.
export function cachedCourses({ includeInactive = false } = {}) {
  const list = [...courseCache.values()].filter(c => includeInactive || c.isActive);
  return sortCourses(list);
}

// [{ department, courses: [...] }] in list order: a department appears where
// its first course sits, so reordering courses also reorders the groups.
export function groupCourses(list) {
  const groups = new Map();
  for (const course of list) {
    const key = course.department || 'Other programs';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(course);
  }
  return [...groups.entries()].map(([department, courses]) => ({ department, courses }));
}

// ---------- The course fields every user payload carries ----------
export function courseFields(u) {
  if (!u) return {};
  const courseId = u.course_id === null || u.course_id === undefined || u.course_id === '' ? null : Number(u.course_id);
  const course = cachedCourse(courseId);
  const courseName = u.course_name || (course ? course.name : '');
  const courseOther = u.course_other ? String(u.course_other) : '';
  const isStudent = u.role === STUDENT_ROLE;
  return {
    courseId,
    courseName,
    courseOther,
    // An "Other" entry stays flagged until an admin assigns a listed course.
    courseNeedsReview: isStudent && (u.course_review === 1 || u.course_review === '1' || u.course_review === true),
    // A deactivated course stays on the record; the UI marks it.
    courseActive: course ? course.isActive : true,
    // One display string: the listed course, else the typed "Other" value.
    course: courseName || courseOther,
    // Existing students created before courses existed land here.
    courseMissing: isStudent && courseId === null && !courseOther
  };
}

// Human-readable value for audit log lines.
export function describeCourse(values) {
  if (!values) return '(none)';
  const id = values.course_id ?? values.courseId ?? null;
  const other = values.course_other ?? values.courseOther ?? '';
  if (id !== null && id !== undefined && id !== '') {
    const course = cachedCourse(id);
    return course ? `"${course.name}"` : `course #${id}`;
  }
  if (other) return `Other: "${other}"`;
  return '(none)';
}

export function sameCourse(a, b) {
  const norm = v => ({
    id: v && v.course_id !== null && v.course_id !== undefined && v.course_id !== '' ? Number(v.course_id) : null,
    other: (v && v.course_other) ? String(v.course_other) : ''
  });
  const x = norm(a);
  const y = norm(b);
  return x.id === y.id && x.other === y.other;
}

// True when a request body tries to set a course at all.
export function hasCourseInput(body) {
  if (!body) return false;
  const id = body.courseId;
  const other = body.courseOther;
  const idGiven = id !== undefined && id !== null && String(id).trim() !== '';
  const otherGiven = other !== undefined && other !== null && String(other).trim() !== '';
  return idGiven || otherGiven;
}

// ---------- The one validation rule, used by every write path ----------
// Returns one of:
//   { error, status }          the request must be refused
//   { changes: {...} }         columns to write on the users row
//   { changes: null }          nothing to change (no course in the request)
//
//   role              the account's role AFTER this request
//   body              { courseId, courseOther } — courseId is a courses.id or 'other'
//   required          a Student must end up with a course (registration, a new
//                     Student, or a role change to Student)
//   allowOther        registration offers "Other (please specify)"; admin
//                     screens pick from the list
//   currentCourseId   the course already on the record — it may stay even if
//                     it was deactivated since
export async function resolveCourseInput({
  role,
  body = {},
  required = false,
  allowOther = true,
  currentCourseId = null,
  get = defaultGet
} = {}) {
  const provided = hasCourseInput(body);

  if (role !== STUDENT_ROLE) {
    if (provided) {
      return { status: 400, error: 'A course can only be set for Student accounts.' };
    }
    return { changes: null };
  }

  if (!provided) {
    if (required) return { status: 400, error: 'Please select your course.' };
    return { changes: null };
  }

  const rawId = body.courseId === undefined || body.courseId === null ? '' : String(body.courseId).trim();
  const otherText = body.courseOther === undefined || body.courseOther === null ? '' : String(body.courseOther).trim();

  if (rawId === OTHER_COURSE_VALUE || (rawId === '' && otherText)) {
    if (!allowOther) {
      return { status: 400, error: 'Choose a course from the list. New courses are added under Content > Courses.' };
    }
    if (!otherText) return { status: 400, error: 'Please type your course.' };
    if (otherText.length < 2) return { status: 400, error: 'Please type the full name of your course.' };
    if (otherText.length > COURSE_NAME_MAX) {
      return { status: 400, error: `Course must be ${COURSE_NAME_MAX} characters or fewer.` };
    }
    // Someone typed a course that IS on the list: store the real course, no review.
    const match = await get('SELECT id, is_active FROM courses WHERE LOWER(name) = LOWER(?) LIMIT 1', [otherText]);
    if (match && (match.is_active === 1 || match.is_active === '1' || match.is_active === true)) {
      return { changes: { course_id: Number(match.id), course_other: null, course_review: 0 } };
    }
    return { changes: { course_id: null, course_other: otherText, course_review: 1 } };
  }

  if (!/^\d+$/.test(rawId)) return { status: 400, error: 'That course is not on the course list.' };
  const id = Number(rawId);
  const course = await get('SELECT id, name, is_active FROM courses WHERE id = ?', [id]);
  if (!course) return { status: 400, error: 'That course is not on the course list.' };
  const active = course.is_active === 1 || course.is_active === '1' || course.is_active === true;
  const keepingCurrent = currentCourseId !== null && currentCourseId !== undefined && Number(currentCourseId) === id;
  if (!active && !keepingCurrent) {
    return { status: 400, error: `"${course.name}" is no longer offered. Choose another course.` };
  }
  return { changes: { course_id: id, course_other: null, course_review: 0 } };
}

// ---------- Admin edits: role and course together ----------
// The rule for every admin write to an existing account:
//   * the account stays / becomes a Student  -> it must end up with a course;
//     becoming a Student without choosing one is refused
//   * the account is / becomes anything else -> a course in the request is
//     refused, and a course already on the record is cleared
// Returns { error, status } or { changes, before, after } where `changes` is
// null when the course columns stay as they are.
export async function planAdminCourseChange({ user, nextRole, body = {}, get = defaultGet }) {
  const role = nextRole || user.role;
  const before = { course_id: user.course_id ?? null, course_other: user.course_other ?? null };
  const hadCourse = !sameCourse(before, CLEARED_COURSE);

  if (role !== STUDENT_ROLE) {
    if (hasCourseInput(body)) {
      return { status: 400, error: 'A course can only be set for Student accounts.' };
    }
    return hadCourse
      ? { changes: { ...CLEARED_COURSE }, before, after: CLEARED_COURSE }
      : { changes: null, before, after: before };
  }

  const becomingStudent = user.role !== STUDENT_ROLE;
  // Sending an empty course for a Student is an attempt to remove it.
  const clearing = body && Object.prototype.hasOwnProperty.call(body, 'courseId') && !hasCourseInput(body);
  if (clearing) return { status: 400, error: 'Course is required for students.' };

  const result = await resolveCourseInput({
    role,
    body,
    // A role change to Student always needs a course, even if an old one is
    // still on the row from an earlier stint as a Student — it was cleared then.
    required: becomingStudent,
    allowOther: false,
    currentCourseId: user.course_id ?? null,
    get
  });
  if (result.error) {
    if (becomingStudent && result.error === 'Please select your course.') {
      return { status: 400, error: 'Choose a course to make this account a Student. Course is required for students.' };
    }
    return result;
  }
  if (!result.changes || sameCourse(before, result.changes)) {
    return { changes: null, before, after: before };
  }
  return { changes: result.changes, before, after: result.changes };
}

// ---------- Schema (additive, safe on every boot) ----------
// Mirrored by hand in db/migrations/006_courses.sql.
async function readSeed() {
  try {
    const parsed = JSON.parse(await fs.readFile(SEED_FILE, 'utf8'));
    const out = [];
    for (const group of parsed.departments || []) {
      for (const name of group.courses || []) {
        const clean = String(name || '').trim();
        if (clean) out.push({ name: clean.slice(0, COURSE_NAME_MAX), department: String(group.department || '').trim().slice(0, COURSE_DEPARTMENT_MAX) });
      }
    }
    return out;
  } catch (err) {
    console.error('[courses] could not read the seed list:', err.message);
    return [];
  }
}

export async function ensureCoursesSchema(dependencies = {}) {
  const all = dependencies.all || defaultAll;
  const run = dependencies.run || defaultRun;

  await run(`
    CREATE TABLE IF NOT EXISTS courses (
      id          INT NOT NULL AUTO_INCREMENT,
      name        VARCHAR(${COURSE_NAME_MAX}) NOT NULL,
      department  VARCHAR(${COURSE_DEPARTMENT_MAX}) NOT NULL DEFAULT '',
      is_active   TINYINT(1) NOT NULL DEFAULT 1,
      sort_order  INT NOT NULL DEFAULT 0,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_courses_name (name),
      KEY idx_courses_active_order (is_active, sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // users: nullable course columns. Existing rows get NULL / 0, so every
  // existing account is unchanged and existing students read as "no course yet".
  const columns = await all('SHOW COLUMNS FROM users');
  const existing = new Set(columns.map(c => String(c.Field || c.field || '').toLowerCase()));
  const userColumns = [
    { name: 'course_id', sql: 'ALTER TABLE users ADD COLUMN course_id INT NULL DEFAULT NULL' },
    { name: 'course_other', sql: `ALTER TABLE users ADD COLUMN course_other VARCHAR(${COURSE_NAME_MAX}) NULL DEFAULT NULL` },
    { name: 'course_review', sql: 'ALTER TABLE users ADD COLUMN course_review TINYINT(1) NOT NULL DEFAULT 0' }
  ];
  const added = [];
  for (const col of userColumns) {
    if (existing.has(col.name)) continue;
    try {
      await run(col.sql);
      added.push(col.name);
    } catch (err) {
      if (!String(err && err.message).includes('Duplicate column name')) throw err;
    }
  }
  if (added.includes('course_id')) {
    await run('CREATE INDEX idx_users_course ON users (course_id)').catch(() => {});
  }
  if (added.length) console.log(`[schema] added missing users columns: ${added.join(', ')}`);

  // Seed only an EMPTY table: once an admin has edited the list, the seed file
  // is never read again.
  const countRow = await all('SELECT COUNT(*) AS n FROM courses');
  if (Number(countRow[0]?.n ?? countRow[0]?.N ?? 0) === 0) {
    const seed = dependencies.seed || await readSeed();
    let order = 1;
    for (const course of seed) {
      await run(
        'INSERT INTO courses (name, department, is_active, sort_order) VALUES (?, ?, 1, ?)',
        [course.name, course.department, order++]
      ).catch(err => {
        if (!/Duplicate entry/i.test(String(err && err.message))) throw err;
      });
    }
    if (seed.length) console.log(`[courses] seeded ${seed.length} courses from server/data/courses-seed.json`);
  } else {
    console.log('[schema] courses table: ok');
  }

  await refreshCourseCache({ all });
}
