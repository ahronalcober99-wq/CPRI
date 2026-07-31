import { Router } from 'express';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { requireAuth, requireRole, readUsers } from './auth.js';
import { all, get, run, insert, update, remove } from './server/db/queries.js';

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

router.get('/stats', async (req, res) => {
  const list = await all('SELECT type, completedResearches, publishedWorks, presentedPapers, innovationProjects, citations FROM researchers');
  const stats = {
    totalResearchers: list.length,
    faculty: list.filter(r => r.type === 'faculty').length,
    students: list.filter(r => r.type === 'student').length,
    completedResearches: 0,
    publications: 0,
    presentations: 0,
    innovationProjects: 0,
    citations: 0
  };

  list.forEach(r => {
    stats.completedResearches += (r.completedResearches || []).length;
    stats.publications += (r.publishedWorks || []).length;
    stats.presentations += (r.presentedPapers || []).length;
    stats.innovationProjects += (r.innovationProjects || []).length;
    stats.citations += (r.citations || 0);
  });

  res.json({ stats });
});

router.get('/:id', async (req, res) => {
  const r = await get('SELECT * FROM researchers WHERE id = ?', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'Researcher profile not found.' });
  res.json({
    researcher: r,
    typeLabel: RESEARCHER_TYPES[r.type] || r.type,
    outputStatusLabel: OUTPUT_STATUS[r.researchOutputStatus] || r.researchOutputStatus
  });
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
  if (!r) return res.status(404).json({ error: 'Researcher profile not found.' });

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
  if (!r) return res.status(404).json({ error: 'Researcher profile not found.' });
  await remove('researchers', req.params.id);
  res.json({ message: 'Researcher profile removed.' });
});

export { router as researchersRouter, RESEARCHER_TYPES, OUTPUT_STATUS, STAFF_ROLES };

