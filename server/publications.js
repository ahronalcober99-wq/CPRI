import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { promises as fs } from 'fs';
import { requireAuth, requireRole, readUsers } from './auth.js';
import { all, get, update, remove, withTransaction } from './server/db/queries.js';
import { createPublicationFeatureService } from './publication-feature-service.js';
import { invalidateFeaturedPublicationsCache } from './featured-publications.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUB_UPLOAD_DIR = join(__dirname, '..', 'public', 'assets', 'uploads', 'publications');

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

export function createPublicationsRouter(dependencies = {}) {
  const router = Router();
  const query = {
    all: dependencies.all || all,
    get: dependencies.get || get,
    update: dependencies.update || update,
    remove: dependencies.remove || remove
  };
  const authenticate = dependencies.requireAuth || requireAuth;
  const resolveCaller = dependencies.caller || caller;
  const featureService = dependencies.featureService ||
    createPublicationFeatureService({ withTransaction: dependencies.withTransaction || withTransaction });
  const invalidateCache = dependencies.invalidateCache || invalidateFeaturedPublicationsCache;

  const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
      const dir = join(PUB_UPLOAD_DIR, req._pubId);
      try { await fs.mkdir(dir, { recursive: true }); cb(null, dir); }
      catch (err) { cb(err); }
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
    const list = await query.all(sql, params);

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
        sourceSubmissionId: p.sourceSubmissionId || null,
        indexingStatus: p.indexingStatus,
        volume: p.volume,
        issue: p.issue,
        pages: p.pages,
        submitterName: p.submitterName
      }))
    });
  });

  router.get('/stats', async (req, res) => {
    const list = await query.all('SELECT authorType, status, pubType, department, schoolYear, publicationDate FROM publications');
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
    const p = await query.get('SELECT * FROM publications WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Publication not found.' });
    res.json({
      publication: p,
      pubTypeLabel: PUB_TYPES[p.pubType] || p.pubType,
      statusLabel: PUB_STATUS[p.status] || p.status,
      authorTypeLabel: AUTHOR_TYPES[p.authorType] || p.authorType
    });
  });

  router.post('/', authenticate, async (req, res) => {
    const me = await resolveCaller(req);
    if (!me) return res.status(401).json({ error: 'Not authenticated.' });

    const b = req.body || {};
    const hasFeatured = Object.prototype.hasOwnProperty.call(b, 'featured');
    if (hasFeatured && !canEdit(me)) {
      return res.status(403).json({ error: 'Only staff can feature publications.' });
    }
    if (hasFeatured && typeof b.featured !== 'boolean') {
      return res.status(400).json({ error: 'featured must be a boolean.' });
    }
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
      featured: hasFeatured ? (b.featured ? 1 : 0) : 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const result = await featureService.create(rec);
    if (!result.ok) return sendFeatureFailure(res, result);
    invalidateCache();
    res.status(201).json({ message: 'Publication added.', publication: result.publication });
  });

  router.post('/:id/proofs', authenticate, async (req, res, next) => {
    const me = await resolveCaller(req);
    const p = await query.get('SELECT * FROM publications WHERE id = ?', [req.params.id]);
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

    const p = await query.get('SELECT * FROM publications WHERE id = ?', [req.params.id]);
    const existingProofs = p.proofDocuments || [];
    existingProofs.push(...proofs);
    await query.update('publications', p.id, { proofDocuments: JSON.stringify(existingProofs), updatedAt: new Date().toISOString() });
    invalidateCache();
    res.status(201).json({ message: 'Proof documents uploaded.', proofDocuments: proofs });
  });

  router.get('/:id/file/:filename', async (req, res) => {
    const p = await query.get('SELECT * FROM publications WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Publication not found.' });

    const proof = (p.proofDocuments || []).find(d => d.filename === req.params.filename);
    if (!proof) return res.status(404).json({ error: 'File not found.' });

    const filePath = join(PUB_UPLOAD_DIR, p.id, proof.filename);
    res.download(filePath, proof.originalName);
  });

  router.patch('/:id', authenticate, async (req, res) => {
    const me = await resolveCaller(req);
    const p = await query.get('SELECT * FROM publications WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Publication not found.' });
    if (!canManage(me, p)) return res.status(403).json({ error: 'You are not allowed to edit this publication.' });

    const b = req.body || {};
    const hasFeatured = Object.prototype.hasOwnProperty.call(b, 'featured');
    if (hasFeatured && !canEdit(me)) {
      return res.status(403).json({ error: 'Only staff can feature publications.' });
    }
    if (hasFeatured && typeof b.featured !== 'boolean') {
      return res.status(400).json({ error: 'featured must be a boolean.' });
    }
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
    if (hasFeatured) changes.featured = b.featured ? 1 : 0;
    changes.updatedAt = new Date().toISOString();
    const result = await featureService.update(req.params.id, changes);
    if (!result.ok) return sendFeatureFailure(res, result);
    invalidateCache();
    res.json({ message: 'Publication updated.', publication: result.publication });
  });

  router.delete('/:id', authenticate, async (req, res) => {
    const me = await resolveCaller(req);
    const p = await query.get('SELECT * FROM publications WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Publication not found.' });
    if (!canManage(me, p)) return res.status(403).json({ error: 'You are not allowed to delete this publication.' });

    await query.remove('publications', req.params.id);
    invalidateCache();
    res.json({ message: 'Publication removed.' });
  });

  function sendFeatureFailure(res, result) {
    if (result.reason === 'limit') {
      return res.status(409).json({ error: 'Only six publications can be featured on the homepage.' });
    }
    if (result.reason === 'unpublished') {
      return res.status(400).json({ error: 'Only published publications can be featured.' });
    }
    return res.status(404).json({ error: 'Publication not found.' });
  }

  return router;
}

const router = createPublicationsRouter();
export { router as publicationsRouter, PUB_TYPES, PUB_STATUS, AUTHOR_TYPES, PROOF_TYPES, STAFF_ROLES };
