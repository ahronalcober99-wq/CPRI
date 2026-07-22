import { Router } from 'express';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { promises as fs } from 'fs';
import { requireAuth, requireRole, readUsers } from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, 'data');
const RESEARCHERS_FILE = join(DATA_DIR, 'researchers.json');

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

async function readResearchers() {
  try { return JSON.parse(await fs.readFile(RESEARCHERS_FILE, 'utf8')); } catch { return []; }
}
async function writeResearchers(list) {
  await fs.writeFile(RESEARCHERS_FILE, JSON.stringify(list, null, 2));
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
  let list = await readResearchers();

  const match = (val, term) => !term || String(val || '').toLowerCase().includes(String(term).toLowerCase());
  list = list.filter(r => {
    if (q.fullName && !match(r.fullName, q.fullName)) return false;
    if (q.department && !match(r.department, q.department)) return false;
    if (q.program && !match(r.program, q.program)) return false;
    if (q.type && r.type !== q.type) return false;
    if (q.year && String(r.yearCompleted) !== String(q.year)) return false;
    if (q.status && r.researchOutputStatus !== q.status) return false;
    return true;
  });

  res.json({
    researchers: list
      .sort((a, b) => String(a.fullName).localeCompare(String(b.fullName)))
      .map(r => ({
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
  const list = await readResearchers();
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
  const list = await readResearchers();
  const r = list.find(x => x.id === req.params.id);
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
    completedResearches: Array.isArray(b.completedResearches) ? b.completedResearches : [],
    publishedWorks: Array.isArray(b.publishedWorks) ? b.publishedWorks : [],
    presentedPapers: Array.isArray(b.presentedPapers) ? b.presentedPapers : [],
    awards: Array.isArray(b.awards) ? b.awards : [],
    innovationProjects: Array.isArray(b.innovationProjects) ? b.innovationProjects : [],
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

  const list = await readResearchers();
  list.push(rec);
  await writeResearchers(list);
  res.status(201).json({ message: 'Researcher profile added.', researcher: rec });
});

router.patch('/:id', requireAuth, async (req, res) => {
  const me = await caller(req);
  if (!me || !canEdit(me)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });

  const list = await readResearchers();
  const r = list.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Researcher profile not found.' });

  const b = req.body || {};
  const editable = [
    'type', 'fullName', 'department', 'program', 'researchInterests',
    'completedResearches', 'publishedWorks', 'presentedPapers', 'awards',
    'innovationProjects', 'citations', 'orcid', 'googleScholar', 'researchGate',
    'researchTitle', 'adviser', 'yearCompleted', 'researchOutputStatus'
  ];
  for (const f of editable) {
    if (b[f] !== undefined) {
      if (Array.isArray(b[f])) r[f] = b[f];
      else if (typeof b[f] === 'number') r[f] = b[f];
      else r[f] = String(b[f]).trim();
    }
  }
  r.updatedAt = new Date().toISOString();
  await writeResearchers(list);
  res.json({ message: 'Researcher profile updated.', researcher: r });
});

router.delete('/:id', requireAuth, async (req, res) => {
  const me = await caller(req);
  if (!me || !canEdit(me)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });

  const list = await readResearchers();
  const filtered = list.filter(x => x.id !== req.params.id);
  if (filtered.length === list.length) return res.status(404).json({ error: 'Researcher profile not found.' });
  await writeResearchers(filtered);
  res.json({ message: 'Researcher profile removed.' });
});

export { router as researchersRouter, RESEARCHER_TYPES, OUTPUT_STATUS, STAFF_ROLES };
