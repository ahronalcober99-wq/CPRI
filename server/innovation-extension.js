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
const UPLOAD_DIR = join(__dirname, '..', '..', 'public', 'assets', 'uploads', 'innovation-extension');

const router = Router();

const PROJECT_TYPES = {
  innovation_project: 'Innovation Project',
  extension_research: 'Extension-Based Research'
};

const STAFF_ROLES = ['admin', 'cpri_staff'];

async function caller(req) {
  const users = await readUsers();
  return users.find(u => u.id === req.session.userId) || null;
}
function canEdit(me) {
  return !!me && STAFF_ROLES.includes(me.role);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = join(UPLOAD_DIR, req._recordId);
    fs.mkdir(dir, { recursive: true }, () => cb(null, dir));
  },
  filename: (req, file, cb) => {
    const safe = file.fieldname.replace(/[^a-z0-9]/gi, '_');
    cb(null, `${safe}-${Date.now()}${extname(file.originalname)}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } });
const uploadDocs = upload.fields([
  { name: 'supporting_document', maxCount: 1 },
  { name: 'photo', maxCount: 1 },
  { name: 'report', maxCount: 1 }
]);

router.get('/', async (req, res) => {
  const q = req.query;
  let sql = 'SELECT * FROM innovation_extension WHERE 1=1';
  const params = [];

  if (q.title) { sql += ' AND title LIKE ?'; params.push(`%${q.title}%`); }
  if (q.proponents) { sql += ' AND proponents LIKE ?'; params.push(`%${q.proponents}%`); }
  if (q.department) { sql += ' AND department LIKE ?'; params.push(`%${q.department}%`); }
  if (q.projectType) { sql += ' AND projectType = ?'; params.push(q.projectType); }
  if (q.communityPartner) { sql += ' AND communityPartner LIKE ?'; params.push(`%${q.communityPartner}%`); }
  if (q.year) { sql += ' AND (LEFT(implementationDate, 4) = ? OR LEFT(createdAt, 4) = ?)'; params.push(q.year, q.year); }

  sql += ' ORDER BY createdAt DESC';
  const list = await all(sql, params);

  res.json({
    records: list.map(r => ({
      id: r.id,
      title: r.title,
      projectType: r.projectType,
      projectTypeLabel: PROJECT_TYPES[r.projectType] || r.projectType,
      proponents: r.proponents,
      department: r.department,
      implementationDate: r.implementationDate,
      beneficiaries: r.beneficiaries,
      communityOutcome: r.communityOutcome,
      communityPartner: r.communityPartner,
      createdAt: r.createdAt
    }))
  });
});

router.get('/stats', async (req, res) => {
  const list = await all('SELECT projectType, beneficiaries, impactDocuments FROM innovation_extension');
  const stats = {
    total: list.length,
    innovation: list.filter(r => r.projectType === 'innovation_project').length,
    extension: list.filter(r => r.projectType === 'extension_research').length,
    totalBeneficiaries: 0,
    withImpactDocs: list.filter(r => r.impactDocuments && r.impactDocuments.length > 0).length
  };

  list.forEach(r => {
    stats.totalBeneficiaries += (r.beneficiaries || 0);
  });

  res.json({ stats });
});

router.get('/:id', async (req, res) => {
  const r = await get('SELECT * FROM innovation_extension WHERE id = ?', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'Record not found.' });
  res.json({
    record: r,
    projectTypeLabel: PROJECT_TYPES[r.projectType] || r.projectType
  });
});

router.post('/', requireAuth, async (req, res, next) => {
  const me = await caller(req);
  if (!me || !canEdit(me)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });

  const b = req.body || {};
  const required = ['title', 'proponents', 'department', 'projectType'];
  for (const f of required) {
    if (!b[f]) return res.status(400).json({ error: `Field "${f}" is required.` });
  }

  req._recordId = randomUUID();
  next();
}, uploadDocs, async (req, res) => {
  const supportingDocs = [];
  for (const [type, files] of Object.entries(req.files || {})) {
    if (files && files[0]) {
      supportingDocs.push({
        type,
        filename: files[0].filename,
        originalName: files[0].originalname,
        uploadedAt: new Date().toISOString()
      });
    }
  }

  const b = req.body || {};
  const rec = {
    id: req._recordId,
    projectType: String(b.projectType).trim(),
    title: String(b.title).trim(),
    proponents: String(b.proponents).trim(),
    department: String(b.department).trim(),
    description: b.description ? String(b.description).trim() : '',
    beneficiaries: b.beneficiaries ? parseInt(b.beneficiaries, 10) || 0 : 0,
    implementationDate: b.implementationDate ? String(b.implementationDate).trim() : '',
    outputProduct: b.outputProduct ? String(b.outputProduct).trim() : '',
    communityPartner: b.communityPartner ? String(b.communityPartner).trim() : '',
    needsAssessment: b.needsAssessment ? String(b.needsAssessment).trim() : '',
    interventionConducted: b.interventionConducted ? String(b.interventionConducted).trim() : '',
    evaluationResult: b.evaluationResult ? String(b.evaluationResult).trim() : '',
    communityOutcome: b.communityOutcome ? String(b.communityOutcome).trim() : '',
    sustainabilityPlan: b.sustainabilityPlan ? String(b.sustainabilityPlan).trim() : '',
    supportingDocuments: JSON.stringify(supportingDocs),
    impactDocuments: JSON.stringify([]),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await insert('innovation_extension', rec);
  res.status(201).json({ message: 'Record added.', record: rec });
});

router.patch('/:id', requireAuth, async (req, res) => {
  const me = await caller(req);
  if (!me || !canEdit(me)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });

  const r = await get('SELECT * FROM innovation_extension WHERE id = ?', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'Record not found.' });

  const b = req.body || {};
  const changes = {};
  const editable = [
    'projectType', 'title', 'proponents', 'department', 'description',
    'beneficiaries', 'implementationDate', 'outputProduct', 'communityPartner',
    'needsAssessment', 'interventionConducted', 'evaluationResult',
    'communityOutcome', 'sustainabilityPlan'
  ];
  for (const f of editable) {
    if (b[f] !== undefined) {
      if (f === 'beneficiaries') changes[f] = parseInt(b[f], 10) || 0;
      else changes[f] = String(b[f]).trim();
    }
  }
  changes.updatedAt = new Date().toISOString();
  await update('innovation_extension', req.params.id, changes);
  const updated = await get('SELECT * FROM innovation_extension WHERE id = ?', [req.params.id]);
  res.json({ message: 'Record updated.', record: updated });
});

router.post('/:id/impact-docs', requireAuth, async (req, res, next) => {
  const me = await caller(req);
  if (!me || !canEdit(me)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });

  const r = await get('SELECT * FROM innovation_extension WHERE id = ?', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'Record not found.' });
  req._recordId = r.id;
  next();
}, uploadDocs, async (req, res) => {
  const items = [];
  for (const [type, files] of Object.entries(req.files || {})) {
    if (files && files[0]) {
      items.push({
        id: randomUUID(),
        type,
        filename: files[0].filename,
        originalName: files[0].originalname,
        uploadedAt: new Date().toISOString()
      });
    }
  }

  const r = await get('SELECT * FROM innovation_extension WHERE id = ?', [req.params.id]);
  const impactDocuments = r.impactDocuments || [];
  impactDocuments.push(...items);
  await update('innovation_extension', r.id, { impactDocuments: JSON.stringify(impactDocuments), updatedAt: new Date().toISOString() });
  res.status(201).json({ message: 'Impact documents uploaded.', impactDocuments: items });
});

router.get('/:id/file/:filename', async (req, res) => {
  const r = await get('SELECT * FROM innovation_extension WHERE id = ?', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'Record not found.' });

  const allDocs = [...(r.supportingDocuments || []), ...(r.impactDocuments || [])];
  const doc = allDocs.find(d => d.filename === req.params.filename);
  if (!doc) return res.status(404).json({ error: 'File not found.' });

  const filePath = join(UPLOAD_DIR, r.id, req.params.filename);
  res.download(filePath, doc.originalName);
});

router.delete('/:id', requireAuth, async (req, res) => {
  const me = await caller(req);
  if (!me || !canEdit(me)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });

  const r = await get('SELECT * FROM innovation_extension WHERE id = ?', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'Record not found.' });
  await remove('innovation_extension', req.params.id);
  res.json({ message: 'Record removed.' });
});

export { router as innovationExtensionRouter, PROJECT_TYPES, STAFF_ROLES };

