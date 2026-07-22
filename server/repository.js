import { Router } from 'express';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { promises as fs } from 'fs';
import { readUsers } from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, 'data');
const REPO_FILE = join(DATA_DIR, 'repository.json');
const SUBMISSIONS_FILE = join(DATA_DIR, 'submissions.json');
const SUB_UPLOAD_DIR = join(__dirname, '..', 'public', 'assets', 'uploads', 'submissions');

const router = Router();

// ---------- Access levels ----------
const ACCESS_LEVELS = {
  public_abstract: 'Public (abstract only)',
  viewable: 'Full text viewable (logged-in users)',
  downloadable: 'Full text downloadable (logged-in users)',
  restricted_staff: 'Restricted to CPRI Staff',
  restricted_institutional: 'Restricted to Institutional Users'
};

const CATEGORY_TYPES = {
  institutional: 'Institutional Research',
  faculty: 'Faculty Research',
  student_thesis: 'Student Thesis',
  capstone: 'Capstone',
  feasibility: 'Feasibility Study',
  action_research: 'Action Research',
  extension: 'Extension-Related Research',
  innovation: 'Innovation Project'
};

// ---------- Store helpers ----------
async function readRepo() {
  try { return JSON.parse(await fs.readFile(REPO_FILE, 'utf8')); } catch { return []; }
}
async function writeRepo(list) {
  await fs.writeFile(REPO_FILE, JSON.stringify(list, null, 2));
}
async function readSubs() {
  try { return JSON.parse(await fs.readFile(SUBMISSIONS_FILE, 'utf8')); } catch { return []; }
}
async function optionalUser(req) {
  if (!req.session || !req.session.userId) return null;
  const users = await readUsers();
  return users.find(u => u.id === req.session.userId) || null;
}

// ---------- Citation generation ----------
function generateCitations(r) {
  const yr = r.yearCompleted || 'n.d.';
  return {
    apa: `${r.authors} (${yr}). ${r.title}. ${r.department}.`,
    mla: `${r.authors}. "${r.title}." ${r.department}, ${yr}.`,
    institutional: `CPRI (${yr}). ${r.title}. ${r.authors}. ${r.department}.`
  };
}

// Can the given user access the full text of a record?
function canAccessFile(level, user) {
  switch (level) {
    case 'public_abstract': return false;
    case 'viewable':
    case 'downloadable':
    case 'restricted_institutional': return !!user;
    case 'restricted_staff': return !!user && ['admin', 'cpri_staff'].includes(user.role);
    default: return false;
  }
}

// ---------- Public list with search & filter ----------
router.get('/', async (req, res) => {
  const q = req.query;
  let list = await readRepo();

  const match = (val, term) => !term || String(val || '').toLowerCase().includes(String(term).toLowerCase());
  list = list.filter(r => {
    if (q.title && !match(r.title, q.title)) return false;
    if (q.author && !match(r.authors, q.author)) return false;
    if (q.department && !match(r.department, q.department)) return false;
    if (q.program && !match(r.department, q.program)) return false;
    if (q.year && String(r.yearCompleted) !== String(q.year)) return false;
    if (q.keywords && !match(r.keywords, q.keywords)) return false;
    if (q.category && r.category !== q.category) return false;
    return true;
  });

  res.json({
    records: list
      .sort((a, b) => String(b.yearCompleted).localeCompare(String(a.yearCompleted)))
      .map(r => ({
        id: r.id,
        title: r.title,
        authors: r.authors,
        department: r.department,
        category: r.category,
        categoryLabel: CATEGORY_TYPES[r.category] || r.category,
        yearCompleted: r.yearCompleted,
        status: r.status,
        accessLevel: r.accessLevel,
        accessLabel: ACCESS_LEVELS[r.accessLevel] || r.accessLevel,
        fileAvailable: r.fileAvailable
      }))
  });
});

// ---------- Public detail ----------
router.get('/:id', async (req, res) => {
  const list = await readRepo();
  const r = list.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Record not found.' });
  const user = await optionalUser(req);
  const access = canAccessFile(r.accessLevel, user);
  res.json({
    record: r,
    categoryLabel: CATEGORY_TYPES[r.category] || r.category,
    accessLabel: ACCESS_LEVELS[r.accessLevel] || r.accessLevel,
    canView: access,
    canDownload: access && (r.accessLevel === 'downloadable' || r.accessLevel === 'viewable' || r.accessLevel === 'restricted_institutional' || r.accessLevel === 'restricted_staff')
  });
});

// ---------- Secure full-text file ----------
router.get('/:id/file', async (req, res) => {
  const user = await optionalUser(req);
  if (!user) return res.status(401).json({ error: 'Login required to access files.' });
  const list = await readRepo();
  const r = list.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Record not found.' });
  if (!canAccessFile(r.accessLevel, user)) return res.status(403).json({ error: 'You do not have access to this file.' });

  const subs = await readSubs();
  const sub = subs.find(s => s.id === r.sourceSubmissionId);
  const meta = sub && sub.files && sub.files.manuscript;
  if (!meta) return res.status(404).json({ error: 'File not available.' });

  const p = join(SUB_UPLOAD_DIR, sub.id, meta.filename);
  // "viewable" opens inline in the browser; other levels force download
  if (r.accessLevel === 'viewable') {
    const type = extname(meta.filename).toLowerCase() === '.pdf' ? 'application/pdf' : 'application/octet-stream';
    return res.sendFile(p, {
      headers: {
        'Content-Type': type,
        'Content-Disposition': `inline; filename="${meta.originalName}"`
      }
    });
  }
  res.download(p, meta.originalName);
});

// ---------- Admin: create (publish) ----------
router.post('/', async (req, res) => {
  const user = await optionalUser(req);
  if (!user || !['admin', 'cpri_staff'].includes(user.role)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });
  const b = req.body || {};
  let rec;
  if (b.submissionId) {
    const subs = await readSubs();
    const sub = subs.find(s => s.id === b.submissionId);
    if (!sub) return res.status(404).json({ error: 'Submission not found.' });
    const year = (sub.schoolYear && sub.schoolYear.match(/\d{4}/g)) ? sub.schoolYear.match(/\d{4}/g).pop() : new Date(sub.createdAt).getFullYear();
    rec = {
      id: randomUUID(),
      sourceSubmissionId: sub.id,
      title: sub.title,
      authors: sub.authors,
      adviser: sub.adviser || '',
      department: sub.program,
      abstract: sub.abstract,
      keywords: sub.keywords || '',
      category: sub.researchType,
      yearCompleted: String(year),
      status: sub.status,
      accessLevel: b.accessLevel && ACCESS_LEVELS[b.accessLevel] ? b.accessLevel : 'downloadable',
      fileAvailable: !!(sub.files && sub.files.manuscript)
    };
  } else {
    const required = ['title', 'authors', 'department', 'yearCompleted'];
    for (const f of required) if (!b[f]) return res.status(400).json({ error: `Field "${f}" is required.` });
    rec = {
      id: randomUUID(),
      sourceSubmissionId: null,
      title: String(b.title).trim(),
      authors: String(b.authors).trim(),
      adviser: b.adviser ? String(b.adviser).trim() : '',
      department: String(b.department).trim(),
      abstract: b.abstract ? String(b.abstract).trim() : '',
      keywords: b.keywords ? String(b.keywords).trim() : '',
      category: b.category || 'institutional',
      yearCompleted: String(b.yearCompleted).trim(),
      status: b.status || 'published',
      accessLevel: b.accessLevel && ACCESS_LEVELS[b.accessLevel] ? b.accessLevel : 'downloadable',
      fileAvailable: false
    };
  }
  rec.citation = b.citation && b.citation.apa ? b.citation : generateCitations(rec);
  rec.createdAt = new Date().toISOString();
  rec.updatedAt = rec.createdAt;

  const list = await readRepo();
  list.push(rec);
  await writeRepo(list);
  res.status(201).json({ message: 'Added to repository.', record: rec });
});

// ---------- Admin: update ----------
router.patch('/:id', async (req, res) => {
  const user = await optionalUser(req);
  if (!user || !['admin', 'cpri_staff'].includes(user.role)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });
  const b = req.body || {};
  const list = await readRepo();
  const r = list.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Record not found.' });
  const editable = ['adviser', 'department', 'abstract', 'keywords', 'category', 'yearCompleted', 'status', 'accessLevel', 'citation'];
  for (const f of editable) {
    if (b[f] !== undefined) r[f] = (typeof b[f] === 'string') ? b[f].trim() : b[f];
  }
  if (b.accessLevel && !ACCESS_LEVELS[b.accessLevel]) return res.status(400).json({ error: 'Invalid access level.' });
  r.updatedAt = new Date().toISOString();
  await writeRepo(list);
  res.json({ message: 'Record updated.', record: r });
});

// ---------- Admin: delete ----------
router.delete('/:id', async (req, res) => {
  const user = await optionalUser(req);
  if (!user || !['admin', 'cpri_staff'].includes(user.role)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });
  const list = await readRepo();
  const filtered = list.filter(x => x.id !== req.params.id);
  if (filtered.length === list.length) return res.status(404).json({ error: 'Record not found.' });
  await writeRepo(filtered);
  res.json({ message: 'Record removed from repository.' });
});

export { router as repositoryRouter, ACCESS_LEVELS, CATEGORY_TYPES };
