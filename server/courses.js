// ---------------------------------------------------------------------------
//  /api/courses — the shared course list (read by register.html, the admin
//  console and every page that shows a course) and its admin management.
//
//    GET    /api/courses                 active courses, grouped by department (public)
//    GET    /api/courses?all=1           every course + student counts (admin)
//    POST   /api/courses                 add a course (admin)
//    PATCH  /api/courses/:id             rename / move / (de)activate (admin)
//    POST   /api/courses/reorder         save a new order { ids: [...] } (admin)
//    GET    /api/courses/report/submissions   submissions per course (admin, CPRI staff)
//
//  Courses are never deleted: a deactivated course stays on the students who
//  already hold it but is no longer offered to new registrations.
// ---------------------------------------------------------------------------
import { Router } from 'express';
import { requireAdmin, requireRole } from './auth.js';
import { all, get, run } from './server/db/queries.js';
import { addLog } from './audit.js';
import {
  COURSE_DEPARTMENT_MAX,
  COURSE_NAME_MAX,
  STUDENT_ROLE,
  cachedCourse,
  cachedCourses,
  groupCourses,
  refreshCourseCache
} from './lib/courses.js';

const router = Router();

function publicCourse(c, counts) {
  const out = { id: c.id, name: c.name, department: c.department, isActive: c.isActive, sortOrder: c.sortOrder };
  if (counts) out.students = counts.get(c.id) || 0;
  return out;
}

async function actorName(req) {
  const me = await get('SELECT username, fullName FROM users WHERE id = ?', [req.session?.userId]).catch(() => null);
  // Username, like the user-management audit lines in admin-dashboard.js.
  return me ? (me.username || me.fullName) : 'an administrator';
}

async function isAdminSession(req) {
  if (!req.session?.userId) return false;
  const me = await get('SELECT role, status FROM users WHERE id = ?', [req.session.userId]).catch(() => null);
  return Boolean(me && me.role === 'admin' && me.status === 'active');
}

function cleanName(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

router.get('/', async (req, res) => {
  try {
    await refreshCourseCache();
  } catch (err) {
    console.error('[courses] list failed:', err.message);
    return res.status(503).json({ error: 'The course list could not be loaded. Please try again.' });
  }
  if (req.query.all === '1') {
    if (!(await isAdminSession(req))) return res.status(403).json({ error: 'Admin access required.' });
    const rows = await all(
      'SELECT course_id, COUNT(*) AS n FROM users WHERE role = ? AND course_id IS NOT NULL GROUP BY course_id',
      [STUDENT_ROLE]
    ).catch(() => []);
    const counts = new Map(rows.map(r => [Number(r.course_id), Number(r.n) || 0]));
    const list = cachedCourses({ includeInactive: true });
    return res.json({
      courses: list.map(c => publicCourse(c, counts)),
      departments: [...new Set(list.map(c => c.department).filter(Boolean))]
    });
  }
  const list = cachedCourses();
  res.json({
    courses: list.map(c => publicCourse(c)),
    groups: groupCourses(list).map(g => ({ department: g.department, courses: g.courses.map(c => publicCourse(c)) }))
  });
});

router.post('/', requireAdmin, async (req, res) => {
  const name = cleanName(req.body?.name);
  const department = cleanName(req.body?.department);
  if (!name) return res.status(400).json({ error: 'Course name is required.' });
  if (name.length > COURSE_NAME_MAX) return res.status(400).json({ error: `Course name must be ${COURSE_NAME_MAX} characters or fewer.` });
  if (department.length > COURSE_DEPARTMENT_MAX) return res.status(400).json({ error: `Department must be ${COURSE_DEPARTMENT_MAX} characters or fewer.` });

  const clash = await get('SELECT id, is_active FROM courses WHERE LOWER(name) = LOWER(?)', [name]);
  if (clash) {
    return res.status(409).json({
      error: clash.is_active === 1 || clash.is_active === '1'
        ? 'That course is already on the list.'
        : 'That course already exists but is inactive. Reactivate it instead.'
    });
  }
  const maxRow = await get('SELECT MAX(sort_order) AS m FROM courses');
  const sortOrder = (Number(maxRow?.m) || 0) + 1;
  const result = await run(
    'INSERT INTO courses (name, department, is_active, sort_order) VALUES (?, ?, 1, ?)',
    [name, department, sortOrder]
  );
  await refreshCourseCache();
  const created = cachedCourse(result?.insertId) ||
    cachedCourses({ includeInactive: true }).find(c => c.name.toLowerCase() === name.toLowerCase());
  await addLog('course_create', `Course "${name}"${department ? ` (${department})` : ''} added by ${await actorName(req)}.`, req);
  res.status(201).json({ message: `Course "${name}" added.`, course: created ? publicCourse(created) : null });
});

router.post('/reorder', requireAdmin, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) return res.status(400).json({ error: 'Send the course ids in their new order.' });
  await refreshCourseCache();
  const known = cachedCourses({ includeInactive: true });
  if (ids.length !== known.length || new Set(ids).size !== ids.length || ids.some(id => !cachedCourse(id))) {
    return res.status(400).json({ error: 'The new order must list every course exactly once. Reload the page and try again.' });
  }
  for (let i = 0; i < ids.length; i++) {
    await run('UPDATE courses SET sort_order = ?, updated_at = ? WHERE id = ?', [i + 1, new Date().toISOString(), ids[i]]);
  }
  await refreshCourseCache();
  await addLog('course_reorder', `Course list reordered by ${await actorName(req)}.`, req);
  res.json({ message: 'Course order saved.', courses: cachedCourses({ includeInactive: true }).map(c => publicCourse(c)) });
});

router.patch('/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const current = Number.isInteger(id) ? await get('SELECT * FROM courses WHERE id = ?', [id]) : null;
  if (!current) return res.status(404).json({ error: 'Course not found.' });

  const body = req.body || {};
  const changes = {};
  const notes = [];
  if (body.name !== undefined) {
    const name = cleanName(body.name);
    if (!name) return res.status(400).json({ error: 'Course name is required.' });
    if (name.length > COURSE_NAME_MAX) return res.status(400).json({ error: `Course name must be ${COURSE_NAME_MAX} characters or fewer.` });
    if (name !== current.name) {
      const clash = await get('SELECT id FROM courses WHERE LOWER(name) = LOWER(?) AND id <> ?', [name, id]);
      if (clash) return res.status(409).json({ error: 'Another course already has that name.' });
      changes.name = name;
      notes.push(`renamed "${current.name}" to "${name}"`);
    }
  }
  if (body.department !== undefined) {
    const department = cleanName(body.department);
    if (department.length > COURSE_DEPARTMENT_MAX) return res.status(400).json({ error: `Department must be ${COURSE_DEPARTMENT_MAX} characters or fewer.` });
    if (department !== (current.department || '')) {
      changes.department = department;
      notes.push(`department "${current.department || '—'}" to "${department || '—'}"`);
    }
  }
  if (body.isActive !== undefined) {
    const isActive = body.isActive === true || body.isActive === 1 || body.isActive === '1' || body.isActive === 'true';
    const wasActive = current.is_active === 1 || current.is_active === '1' || current.is_active === true;
    if (isActive !== wasActive) {
      changes.is_active = isActive ? 1 : 0;
      notes.push(isActive ? 'reactivated' : 'deactivated');
    }
  }
  if (!Object.keys(changes).length) {
    return res.json({ message: 'Nothing to change.', course: publicCourse(cachedCourse(id) || { id, name: current.name, department: current.department, isActive: true, sortOrder: current.sort_order }) });
  }
  const cols = Object.keys(changes);
  await run(
    `UPDATE courses SET ${cols.map(c => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    [...cols.map(c => changes[c]), new Date().toISOString(), id]
  );
  await refreshCourseCache();
  await addLog('course_update', `Course #${id} "${current.name}": ${notes.join('; ')} by ${await actorName(req)}.`, req);
  const updated = cachedCourse(id);
  res.json({
    message: changes.is_active === 0
      ? `"${updated.name}" deactivated. Students who already have it keep it; new students can no longer choose it.`
      : `Course "${updated.name}" saved.`,
    course: publicCourse(updated)
  });
});

// Submissions per course, for the Analytics & Reports page. Counts Research
// Submission Module records (drafts excluded) owned by Student accounts, by the
// owner's course. Students without a course and "Other" entries get a bucket
// of their own so the totals add up.
router.get('/report/submissions', requireRole('admin', 'cpri_staff'), async (req, res) => {
  try {
    await refreshCourseCache();
    const rows = await all(
      `SELECT u.course_id AS course_id, u.course_other AS course_other, COUNT(s.id) AS n
         FROM research_submissions s
         JOIN users u ON u.id = s.owner_id
        WHERE s.status <> 'draft' AND u.role = ?
        GROUP BY u.course_id, u.course_other`,
      [STUDENT_ROLE]
    );
    const buckets = new Map();
    const add = (key, label, department, n) => {
      const entry = buckets.get(key) || { course: label, department, count: 0 };
      entry.count += n;
      buckets.set(key, entry);
    };
    for (const r of rows) {
      const n = Number(r.n) || 0;
      const course = cachedCourse(r.course_id);
      if (course) add('c' + course.id, course.name, course.department, n);
      else if (r.course_other) add('other', 'Other (pending review)', '', n);
      else add('none', 'No course yet', '', n);
    }
    const report = [...buckets.values()].sort((a, b) => b.count - a.count || a.course.localeCompare(b.course));
    res.json({ report, total: report.reduce((sum, r) => sum + r.count, 0) });
  } catch (err) {
    console.error('[courses] submissions report failed:', err.message);
    res.status(500).json({ error: 'Could not load submissions per course.' });
  }
});

export { router as coursesRouter };
