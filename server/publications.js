import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { promises as fs } from 'fs';
import { requireAuth, requireRole, readUsers } from './auth.js';
import { all, get, run, insert, update, remove } from './server/db/queries.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUB_UPLOAD_DIR = join(__dirname, '..', '..', 'public', 'assets', 'uploads', 'publications');

const router = Router();

const PUB_TYPES = {
  institutional_journal: 'Institutional Journal',
  local_journal: 'Local Journal',
  national_journal: 'National Journal',
  international_journal: 'International Journal',
  conference_paper: 'Conference Paper',
  book_chapter: 'Book Chapter',
  research_poster: 'Research Poster',
  proceedings_paper: 'Proceedings Paper'
};

const PUB_STATUS = {
  submitted: 'Submitted',
  under_review: 'Under Review',
  accepted: 'Accepted',
  published: 'Published',
  presented: 'Presented',
  rejected: 'Rejected'
};

const AUTHOR_TYPES = {
  faculty: 'Faculty',
  student: 'Student',
  other: 'Other'
};

const PROOF_TYPES = {
  acceptance_letter: 'Acceptance Letter',
  certificate_presentation: 'Certificate of Presentation',
  published_pdf: 'Published Article PDF',
  doi_link: 'DOI Link / Journal Link',
  conference_certificate: 'Conference Certificate'
};

const STAFF_ROLES = ['admin', 'cpri_staff'];

async function caller(req) {
  const users = await readUsers();
  return users.find(u => u.id === req.session.userId) || null;
}
function canEdit(me) {
  return !!me && STAFF_ROLES.includes(me.role);
}
function isOwner(me, pub) {
  return !!me && pub.submitterId === me.id;
}
function canManage(me, pub) {
  return canEdit(me) || isOwner(me, pub);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = join(PUB_UPLOAD_DIR, req._pubId);
    fs.mkdir(dir, { recursive: true }, () => cb(null, dir));
  },
  filename: (req, file, cb) => {
    const safe = file.fieldname.replace(/[^a-z0-9]/gi, '_');
    cb(null, `${safe}-${Date.now()}${extname(file.originalname)}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } });
const uploadProofs = upload.fields([
  { name: 'acceptance_letter', maxCount: 1 },
  { name: 'certificate_presentation', maxCount: 1 },
  { name: 'published_pdf', maxCount: 1 },
  { name: 'doi_link', maxCount: 1 },
  { name: 'conference_certificate', maxCount: 1 }
]);

router.get('/', async (req, res) => {
  const q = req.query;
  let sql = 'SELECT * FROM publications WHERE 1=1';
  const params = [];

  if (q.title) { sql += ' AND title LIKE ?'; params.push(`%${q.title}%`); }
  if (q.authors) { sql += ' AND authors LIKE ?'; params.push(`%${q.authors}%`); }
  if (q.journalOrConference) { sql += ' AND journalOrConference LIKE ?'; params.push(`%${q.journalOrConference}%`); }
  if (q.pubType) { sql += ' AND pubType = ?'; params.push(q.pubType); }
  if (q.status) { sql += ' AND status = ?'; params.push(q.status); }
  if (q.department) { sql += ' AND department LIKE ?'; params.push(`%${q.department}%`); }
  if (q.schoolYear) { sql += ' AND schoolYear = ?'; params.push(q.schoolYear); }
  if (q.authorType) { sql += ' AND authorType = ?'; params.push(q.authorType); }
  if (q.year) { sql += ' AND LEFT(publicationDate, 4) = ?'; params.push(q.year); }

  sql += ' ORDER BY createdAt DESC';
  const list = await all(sql, params);

  res.json({
    publications: list.map(p => ({
      id: p.id,
      title: p.title,
      authors: p.authors,
      journalOrConference: p.journalOrConference,
      publicationDate: p.publicationDate,
      pubType: p.pubType,
      pubTypeLabel: PUB_TYPES[p.pubType] || p.pubType,
      status: p.status,
      statusLabel: PUB_STATUS[p.status] || p.status,
      DOI: p.doi,
      department: p.department,
      schoolYear: p.schoolYear,
      authorType: p.authorType,
      authorTypeLabel: AUTHOR_TYPES[p.authorType] || p.authorType,
      indexingStatus: p.indexingStatus,
      volume: p.volume,
      issue: p.issue,
      pages: p.pages,
      submitterName: p.submitterName
    }))
  });
});

router.get('/stats', async (req, res) => {
  const list = await all('SELECT authorType, status, pubType, department, schoolYear, publicationDate FROM publications');
  const stats = {
    total: list.length,
    faculty: list.filter(p => p.authorType === 'faculty').length,
    student: list.filter(p => p.authorType === 'student').length,
    published: list.filter(p => p.status === 'published').length,
    byDepartment: {},
    bySchoolYear: {},
    byPubType: {},
    local: 0,
    national: 0,
    international: 0
  };

  list.forEach(p => {
    stats.byDepartment[p.department || 'Unknown'] = (stats.byDepartment[p.department || 'Unknown'] || 0) + 1;
    stats.bySchoolYear[p.schoolYear || 'Unknown'] = (stats.bySchoolYear[p.schoolYear || 'Unknown'] || 0) + 1;
    stats.byPubType[p.pubType] = (stats.byPubType[p.pubType] || 0) + 1;

    if (p.pubType === 'local_journal') stats.local++;
    else if (p.pubType === 'national_journal') stats.national++;
    else if (p.pubType === 'international_journal') stats.international++;
  });

  res.json({ stats });
});

router.get('/:id', async (req, res) => {
  const p = await get('SELECT * FROM publications WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Publication not found.' });
  res.json({
    publication: p,
    pubTypeLabel: PUB_TYPES[p.pubType] || p.pubType,
    statusLabel: PUB_STATUS[p.status] || p.status,
    authorTypeLabel: AUTHOR_TYPES[p.authorType] || p.authorType
  });
});

router.post('/', requireAuth, async (req, res) => {
  const me = await caller(req);
  if (!me) return res.status(401).json({ error: 'Not authenticated.' });

  const b = req.body || {};
  const required = ['title', 'authors', 'journalOrConference', 'publicationDate', 'pubType', 'status'];
  for (const f of required) {
    if (!b[f]) return res.status(400).json({ error: `Field "${f}" is required.` });
  }

  const rec = {
    id: randomUUID(),
    title: String(b.title).trim(),
    authors: String(b.authors).trim(),
    journalOrConference: String(b.journalOrConference).trim(),
    publicationDate: String(b.publicationDate).trim(),
    volume: b.volume ? String(b.volume).trim() : '',
    issue: b.issue ? String(b.issue).trim() : '',
    pages: b.pages ? String(b.pages).trim() : '',
    doi: b.doi ? String(b.doi).trim() : '',
    publicationLink: b.publicationLink ? String(b.publicationLink).trim() : '',
    indexingStatus: b.indexingStatus ? String(b.indexingStatus).trim() : '',
    pubType: String(b.pubType).trim(),
    status: String(b.status).trim(),
    authorType: b.authorType || (STAFF_ROLES.includes(me.role) ? 'faculty' : (['student_researcher'].includes(me.role) ? 'student' : 'other')),
    department: b.department ? String(b.department).trim() : '',
    schoolYear: b.schoolYear ? String(b.schoolYear).trim() : '',
    proofDocuments: JSON.stringify([]),
    submitterId: me.id,
    submitterName: me.fullName || me.username,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await insert('publications', rec);
  res.status(201).json({ message: 'Publication added.', publication: rec });
});

router.post('/:id/proofs', requireAuth, async (req, res, next) => {
  const me = await caller(req);
  const p = await get('SELECT * FROM publications WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Publication not found.' });
  if (!canManage(me, p)) return res.status(403).json({ error: 'You are not allowed to edit this publication.' });
  req._pubId = p.id;
  next();
}, uploadProofs, async (req, res) => {
  const proofs = [];
  for (const [type, files] of Object.entries(req.files || {})) {
    if (files && files[0]) {
      proofs.push({
        type,
        filename: files[0].filename,
        originalName: files[0].originalname,
        uploadedAt: new Date().toISOString()
      });
    }
  }

  const p = await get('SELECT * FROM publications WHERE id = ?', [req.params.id]);
  const existingProofs = p.proofDocuments || [];
  existingProofs.push(...proofs);
  await update('publications', p.id, { proofDocuments: JSON.stringify(existingProofs), updatedAt: new Date().toISOString() });
  res.status(201).json({ message: 'Proof documents uploaded.', proofDocuments: proofs });
});

router.get('/:id/file/:filename', async (req, res) => {
  const p = await get('SELECT * FROM publications WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Publication not found.' });

  const proof = (p.proofDocuments || []).find(d => d.filename === req.params.filename);
  if (!proof) return res.status(404).json({ error: 'File not found.' });

  const filePath = join(PUB_UPLOAD_DIR, p.id, proof.filename);
  res.download(filePath, proof.originalName);
});

router.patch('/:id', requireAuth, async (req, res) => {
  const me = await caller(req);
  const p = await get('SELECT * FROM publications WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Publication not found.' });
  if (!canManage(me, p)) return res.status(403).json({ error: 'You are not allowed to edit this publication.' });

  const b = req.body || {};
  const changes = {};
  const editable = [
    'title', 'authors', 'journalOrConference', 'publicationDate',
    'volume', 'issue', 'pages', 'doi', 'publicationLink',
    'indexingStatus', 'pubType', 'status', 'authorType',
    'department', 'schoolYear'
  ];
  for (const f of editable) {
    if (b[f] !== undefined) changes[f] = (typeof b[f] === 'string') ? b[f].trim() : b[f];
  }
  changes.updatedAt = new Date().toISOString();
  await update('publications', req.params.id, changes);
  const updated = await get('SELECT * FROM publications WHERE id = ?', [req.params.id]);
  res.json({ message: 'Publication updated.', publication: updated });
});

router.delete('/:id', requireAuth, async (req, res) => {
  const me = await caller(req);
  const p = await get('SELECT * FROM publications WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Publication not found.' });
  if (!canManage(me, p)) return res.status(403).json({ error: 'You are not allowed to delete this publication.' });

  await remove('publications', req.params.id);
  res.json({ message: 'Publication removed.' });
});

export { router as publicationsRouter, PUB_TYPES, PUB_STATUS, AUTHOR_TYPES, PROOF_TYPES, STAFF_ROLES };

