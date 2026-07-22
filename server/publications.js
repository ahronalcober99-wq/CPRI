import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { promises as fs } from 'fs';
import { requireAuth, requireRole, readUsers } from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, 'data');
const PUB_FILE = join(DATA_DIR, 'publications.json');
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
const REVIEW_ROLES = ['admin', 'cpri_staff'];

async function readPubs() {
  try { return JSON.parse(await fs.readFile(PUB_FILE, 'utf8')); } catch { return []; }
}
async function writePubs(list) {
  await fs.writeFile(PUB_FILE, JSON.stringify(list, null, 2));
}
async function caller(req) {
  const users = await readUsers();
  return users.find(u => u.id === req.session.userId) || null;
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

function canEdit(me) {
  return !!me && STAFF_ROLES.includes(me.role);
}
function isOwner(me, pub) {
  return !!me && pub.submitterId === me.id;
}
function canManage(me, pub) {
  return canEdit(me) || isOwner(me, pub);
}

router.get('/', async (req, res) => {
  const q = req.query;
  let list = await readPubs();

  const match = (val, term) => !term || String(val || '').toLowerCase().includes(String(term).toLowerCase());
  list = list.filter(p => {
    if (q.title && !match(p.title, q.title)) return false;
    if (q.authors && !match(p.authors, q.authors)) return false;
    if (q.journalOrConference && !match(p.journalOrConference, q.journalOrConference)) return false;
    if (q.pubType && p.pubType !== q.pubType) return false;
    if (q.status && p.status !== q.status) return false;
    if (q.department && !match(p.department, q.department)) return false;
    if (q.schoolYear && p.schoolYear !== q.schoolYear) return false;
    if (q.authorType && p.authorType !== q.authorType) return false;
    if (q.year && String(p.publicationDate).slice(0, 4) !== String(q.year)) return false;
    return true;
  });

  res.json({
    publications: list
      .sort((a, b) => new Date(b.publicationDate || b.createdAt) - new Date(a.publicationDate || a.createdAt))
      .map(p => ({
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
  const list = await readPubs();
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
  const list = await readPubs();
  const p = list.find(x => x.id === req.params.id);
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
    proofDocuments: [],
    submitterId: me.id,
    submitterName: me.fullName || me.username,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const list = await readPubs();
  list.push(rec);
  await writePubs(list);
  res.status(201).json({ message: 'Publication added.', publication: rec });
});

router.post('/:id/proofs', requireAuth, uploadProofs, async (req, res) => {
  const me = await caller(req);
  const list = await readPubs();
  const p = list.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Publication not found.' });
  if (!canManage(me, p)) return res.status(403).json({ error: 'You are not allowed to edit this publication.' });

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

  p.proofDocuments = p.proofDocuments || [];
  p.proofDocuments.push(...proofs);
  p.updatedAt = new Date().toISOString();
  await writePubs(list);
  res.status(201).json({ message: 'Proof documents uploaded.', proofDocuments: proofs });
});

router.get('/:id/file/:filename', async (req, res) => {
  const list = await readPubs();
  const p = list.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Publication not found.' });

  const proof = (p.proofDocuments || []).find(d => d.filename === req.params.filename);
  if (!proof) return res.status(404).json({ error: 'File not found.' });

  const filePath = join(PUB_UPLOAD_DIR, p.id, proof.filename);
  res.download(filePath, proof.originalName);
});

router.patch('/:id', requireAuth, async (req, res) => {
  const me = await caller(req);
  const list = await readPubs();
  const p = list.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Publication not found.' });
  if (!canManage(me, p)) return res.status(403).json({ error: 'You are not allowed to edit this publication.' });

  const b = req.body || {};
  const editable = [
    'title', 'authors', 'journalOrConference', 'publicationDate',
    'volume', 'issue', 'pages', 'doi', 'publicationLink',
    'indexingStatus', 'pubType', 'status', 'authorType',
    'department', 'schoolYear'
  ];
  for (const f of editable) {
    if (b[f] !== undefined) p[f] = (typeof b[f] === 'string') ? b[f].trim() : b[f];
  }
  p.updatedAt = new Date().toISOString();
  await writePubs(list);
  res.json({ message: 'Publication updated.', publication: p });
});

router.delete('/:id', requireAuth, async (req, res) => {
  const me = await caller(req);
  const list = await readPubs();
  const p = list.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Publication not found.' });
  if (!canManage(me, p)) return res.status(403).json({ error: 'You are not allowed to delete this publication.' });

  const filtered = list.filter(x => x.id !== req.params.id);
  await writePubs(filtered);
  res.json({ message: 'Publication removed.' });
});

export { router as publicationsRouter, PUB_TYPES, PUB_STATUS, AUTHOR_TYPES, PROOF_TYPES, STAFF_ROLES };
