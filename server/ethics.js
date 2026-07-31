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
const ETHICS_UPLOAD_DIR = join(__dirname, '..', '..', 'public', 'assets', 'uploads', 'ethics');

const router = Router();

const ETHICS_STATUS = {
  submitted: 'Submitted',
  under_review: 'Under Review',
  for_revision: 'For Revision',
  approved: 'Approved',
  exempted_from_full_review: 'Exempted from Full Review',
  disapproved: 'Disapproved',
  certificate_issued: 'Certificate Issued'
};

const REVIEWER_ROLES = ['admin', 'cpri_staff', 'ethics_reviewer'];
const SUBMIT_ROLES = ['faculty_researcher', 'student_researcher', 'adviser', 'cpri_staff', 'ethics_reviewer'];

const FILE_FIELDS = [
  { key: 'ethics_application', label: 'Ethics Application Form', required: true },
  { key: 'informed_consent', label: 'Informed Consent Form', required: true },
  { key: 'research_instrument', label: 'Research Instrument', required: true },
  { key: 'proposal_manuscript', label: 'Proposal Manuscript', required: true },
  { key: 'revised_docs', label: 'Revised Documents', required: false }
];
const REQUIRED_KEYS = FILE_FIELDS.filter(f => f.required).map(f => f.key);

async function caller(req) {
  const users = await readUsers();
  return users.find(u => u.id === req.session.userId) || null;
}
function canAccess(me, app) {
  return !me || app.submitterId === me.id || REVIEWER_ROLES.includes(me.role);
}
function canReview(me) {
  return !!me && REVIEWER_ROLES.includes(me.role);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = join(ETHICS_UPLOAD_DIR, req._ethId);
    fs.mkdir(dir, { recursive: true }, () => cb(null, dir));
  },
  filename: (req, file, cb) => {
    const safe = file.fieldname.replace(/[^a-z0-9]/gi, '_');
    cb(null, `${safe}-${Date.now()}${extname(file.originalname)}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } });
const uploadFields = upload.fields([
  ...FILE_FIELDS.map(f => ({ name: f.key, maxCount: 1 })),
  { name: 'additional', maxCount: 10 }
]);
const uploadCertificate = upload.single('certificate_pdf');

router.get('/', requireAuth, async (req, res) => {
  const q = req.query;
  const me = await caller(req);
  let sql = 'SELECT * FROM ethics WHERE 1=1';
  const params = [];

  if (q.title) { sql += ' AND title LIKE ?'; params.push(`%${q.title}%`); }
  if (q.researchers) { sql += ' AND researchers LIKE ?'; params.push(`%${q.researchers}%`); }
  if (q.department) { sql += ' AND department LIKE ?'; params.push(`%${q.department}%`); }
  if (q.status) { sql += ' AND status = ?'; params.push(q.status); }
  if (q.year) { sql += ' AND LEFT(createdAt, 4) = ?'; params.push(q.year); }

  if (!canReview(me)) {
    sql += ' AND submitterId = ?';
    params.push(me.id);
  }

  sql += ' ORDER BY createdAt DESC';
  const list = await all(sql, params);

  res.json({
    applications: list.map(a => ({
      id: a.id,
      title: a.title,
      researchers: a.researchers,
      adviser: a.adviser,
      department: a.department,
      status: a.status,
      statusLabel: ETHICS_STATUS[a.status] || a.status,
      riskLevel: a.riskLevel,
      participantType: a.participantType,
      certificateNumber: a.certificate ? a.certificate.certificateNumber : null,
      createdAt: a.createdAt
    }))
  });
});

router.get('/:id', requireAuth, async (req, res) => {
  const me = await caller(req);
  const a = await get('SELECT * FROM ethics WHERE id = ?', [req.params.id]);
  if (!a) return res.status(404).json({ error: 'Ethics application not found.' });
  if (!canAccess(me, a)) return res.status(403).json({ error: 'Access denied.' });
  res.json({ application: a, statusLabel: ETHICS_STATUS[a.status] || a.status });
});

router.post('/', requireAuth, async (req, res, next) => {
  req._ethId = randomUUID();
  next();
}, uploadFields, async (req, res) => {
  const me = await caller(req);
  if (!me || !SUBMIT_ROLES.includes(me.role)) {
    return res.status(403).json({ error: 'Your role is not allowed to submit ethics applications.' });
  }

  const b = req.body || {};
  const requiredText = ['title', 'researchers', 'adviser', 'department', 'participantType', 'riskLevel'];
  for (const f of requiredText) {
    if (!b[f] || !String(b[f]).trim()) {
      return res.status(400).json({ error: `Field "${f}" is required.` });
    }
  }
  for (const key of REQUIRED_KEYS) {
    if (!req.files || !req.files[key]) {
      return res.status(400).json({ error: `Required file missing: ${key}.` });
    }
  }

  const files = {};
  for (const f of FILE_FIELDS) {
    if (req.files[f.key] && req.files[f.key][0]) {
      files[f.key] = {
        filename: req.files[f.key][0].filename,
        originalName: req.files[f.key][0].originalname
      };
    }
  }
  const additionalDocs = (req.files.additional || []).map(file => ({
    id: randomUUID(),
    filename: file.filename,
    originalName: file.originalname
  }));

  const now = new Date().toISOString();
  const app = {
    id: req._ethId,
    submitterId: me.id,
    submitterName: me.fullName || me.username,
    title: String(b.title).trim(),
    researchers: String(b.researchers).trim(),
    adviser: String(b.adviser).trim(),
    department: String(b.department).trim(),
    participantType: String(b.participantType).trim(),
    riskLevel: String(b.riskLevel).trim(),
    status: 'submitted',
    statusHistory: JSON.stringify([{ status: 'submitted', at: now, by: me.fullName || me.username, note: '' }]),
    files: JSON.stringify(files),
    additionalDocs: JSON.stringify(additionalDocs),
    comments: JSON.stringify([]),
    certificate: JSON.stringify(null),
    compliance: JSON.stringify(null),
    revisedDocuments: JSON.stringify([]),
    createdAt: now,
    updatedAt: now
  };

  await insert('ethics', app);
  res.status(201).json({ message: 'Ethics application submitted.', application: app });
});

router.patch('/:id/status', requireRole(...REVIEWER_ROLES), async (req, res) => {
  const { status, note } = req.body || {};
  if (!ETHICS_STATUS[status]) return res.status(400).json({ error: 'Invalid status.' });
  const me = await caller(req);
  const a = await get('SELECT * FROM ethics WHERE id = ?', [req.params.id]);
  if (!a) return res.status(404).json({ error: 'Application not found.' });

  const statusHistory = a.statusHistory || [];
  statusHistory.push({
    status,
    at: new Date().toISOString(),
    by: me.fullName || me.username,
    note: note ? String(note).trim() : ''
  });

  await update('ethics', a.id, { status, statusHistory: JSON.stringify(statusHistory), updatedAt: new Date().toISOString() });
  const updated = await get('SELECT * FROM ethics WHERE id = ?', [a.id]);
  res.json({ message: 'Status updated.', application: updated });
});

router.patch('/:id/compliance', requireRole(...REVIEWER_ROLES), async (req, res) => {
  const { compliant, note } = req.body || {};
  const me = await caller(req);
  const a = await get('SELECT * FROM ethics WHERE id = ?', [req.params.id]);
  if (!a) return res.status(404).json({ error: 'Application not found.' });

  const compliance = a.compliance || {};
  compliance.reviewerId = me.id;
  compliance.reviewerName = me.fullName || me.username;
  compliance.compliant = !!compliant;
  compliance.note = note ? String(note).trim() : '';
  compliance.updatedAt = new Date().toISOString();

  await update('ethics', a.id, { compliance: JSON.stringify(compliance), updatedAt: new Date().toISOString() });
  const updated = await get('SELECT * FROM ethics WHERE id = ?', [a.id]);
  res.json({ message: 'Compliance recorded.', application: updated });
});

router.post('/:id/comments', requireRole(...REVIEWER_ROLES), async (req, res) => {
  const { body } = req.body || {};
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'Comment text is required.' });
  const me = await caller(req);
  const a = await get('SELECT * FROM ethics WHERE id = ?', [req.params.id]);
  if (!a) return res.status(404).json({ error: 'Application not found.' });

  const comments = a.comments || [];
  comments.push({
    id: randomUUID(),
    authorId: me.id,
    authorName: me.fullName || me.username,
    authorRole: me.role,
    body: String(body).trim(),
    createdAt: new Date().toISOString()
  });
  await update('ethics', a.id, { comments: JSON.stringify(comments), updatedAt: new Date().toISOString() });
  const updated = await get('SELECT * FROM ethics WHERE id = ?', [a.id]);
  const newComment = (updated.comments || []).pop();
  res.status(201).json({ message: 'Comment added.', comment: newComment });
});

router.post('/:id/certificate', requireRole(...REVIEWER_ROLES), async (req, res) => {
  const { certificateNumber, dateIssued, validityPeriod, approvedTitle, principalInvestigator } = req.body || {};
  if (!certificateNumber || !dateIssued || !validityPeriod || !approvedTitle || !principalInvestigator) {
    return res.status(400).json({ error: 'All certificate fields are required.' });
  }
  const a = await get('SELECT * FROM ethics WHERE id = ?', [req.params.id]);
  if (!a) return res.status(404).json({ error: 'Application not found.' });

  const certificate = {
    certificateNumber: String(certificateNumber).trim(),
    dateIssued: String(dateIssued).trim(),
    validityPeriod: String(validityPeriod).trim(),
    approvedTitle: String(approvedTitle).trim(),
    principalInvestigator: String(principalInvestigator).trim(),
    issuedAt: new Date().toISOString()
  };

  const statusHistory = a.statusHistory || [];
  statusHistory.push({
    status: 'certificate_issued',
    at: new Date().toISOString(),
    by: (await caller(req))?.fullName || 'System',
    note: 'Certificate issued'
  });

  await update('ethics', a.id, {
    certificate: JSON.stringify(certificate),
    status: 'certificate_issued',
    statusHistory: JSON.stringify(statusHistory),
    updatedAt: new Date().toISOString()
  });
  const updated = await get('SELECT * FROM ethics WHERE id = ?', [a.id]);
  res.json({ message: 'Certificate recorded.', application: updated });
});

router.patch('/:id/certificate-upload', requireRole(...REVIEWER_ROLES), async (req, res, next) => {
  const a = await get('SELECT * FROM ethics WHERE id = ?', [req.params.id]);
  if (!a) return res.status(404).json({ error: 'Application not found.' });
  req._ethId = a.id;
  next();
}, uploadCertificate, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Certificate PDF is required.' });
  const a = await get('SELECT * FROM ethics WHERE id = ?', [req.params.id]);
  const certificate = a.certificate || {};
  certificate.file = {
    filename: req.file.filename,
    originalName: req.file.originalname,
    uploadedAt: new Date().toISOString()
  };
  await update('ethics', a.id, { certificate: JSON.stringify(certificate), updatedAt: new Date().toISOString() });
  const updated = await get('SELECT * FROM ethics WHERE id = ?', [a.id]);
  res.json({ message: 'Certificate PDF uploaded.', certificate: updated.certificate });
});

router.get('/:id/certificate', requireAuth, async (req, res) => {
  const me = await caller(req);
  const a = await get('SELECT * FROM ethics WHERE id = ?', [req.params.id]);
  if (!a) return res.status(404).json({ error: 'Application not found.' });
  if (!canAccess(me, a)) return res.status(403).json({ error: 'Access denied.' });
  if (!a.certificate) return res.status(404).json({ error: 'Certificate not issued yet.' });
  res.json({ certificate: a.certificate });
});

router.get('/:id/certificate.pdf', requireAuth, async (req, res) => {
  const me = await caller(req);
  const a = await get('SELECT * FROM ethics WHERE id = ?', [req.params.id]);
  if (!a) return res.status(404).json({ error: 'Application not found.' });
  if (!canAccess(me, a)) return res.status(403).json({ error: 'Access denied.' });
  if (!a.certificate || !a.certificate.file) return res.status(404).json({ error: 'Certificate PDF not available.' });
  const filePath = join(ETHICS_UPLOAD_DIR, a.id, a.certificate.file.filename);
  res.download(filePath, a.certificate.file.originalName);
});

router.post('/:id/revisions', requireAuth, async (req, res, next) => {
  const me = await caller(req);
  const a = await get('SELECT * FROM ethics WHERE id = ?', [req.params.id]);
  if (!a) return res.status(404).json({ error: 'Application not found.' });
  if (a.submitterId !== me.id) return res.status(403).json({ error: 'Only the researcher can upload revisions.' });
  req._ethId = a.id;
  next();
}, upload.single('revised_manuscript'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'A revised manuscript file is required.' });
  const fileEntry = {
    filename: req.file.filename,
    originalName: req.file.originalname,
    uploadedAt: new Date().toISOString(),
    note: req.body.note ? String(req.body.note).trim() : ''
  };
  const a = await get('SELECT * FROM ethics WHERE id = ?', [req.params.id]);
  const revisedDocuments = a.revisedDocuments || [];
  revisedDocuments.push(fileEntry);
  await update('ethics', a.id, { revisedDocuments: JSON.stringify(revisedDocuments), updatedAt: new Date().toISOString() });
  const updated = await get('SELECT * FROM ethics WHERE id = ?', [a.id]);
  res.status(201).json({ message: 'Revision uploaded.', document: fileEntry, application: updated });
});

router.get('/:id/file/:filename', requireAuth, async (req, res) => {
  const me = await caller(req);
  const a = await get('SELECT * FROM ethics WHERE id = ?', [req.params.id]);
  if (!a) return res.status(404).json({ error: 'Application not found.' });
  if (!canAccess(me, a)) return res.status(403).json({ error: 'Access denied.' });

  let meta = null;
  for (const key of Object.keys(a.files || {})) {
    if (a.files[key] && a.files[key].filename === req.params.filename) meta = a.files[key];
  }
  if (!meta && (a.additionalDocs || []).find(d => d.filename === req.params.filename)) {
    meta = (a.additionalDocs || []).find(d => d.filename === req.params.filename);
  }
  if (!meta && (a.revisedDocuments || []).find(d => d.filename === req.params.filename)) {
    meta = (a.revisedDocuments || []).find(d => d.filename === req.params.filename);
  }
  if (!meta) return res.status(404).json({ error: 'File not found.' });

  const filePath = join(ETHICS_UPLOAD_DIR, a.id, req.params.filename);
  res.download(filePath, meta.originalName);
});

router.patch('/:id', requireAuth, async (req, res) => {
  const me = await caller(req);
  const a = await get('SELECT * FROM ethics WHERE id = ?', [req.params.id]);
  if (!a) return res.status(404).json({ error: 'Application not found.' });
  if (!canAccess(me, a)) return res.status(403).json({ error: 'Access denied.' });

  const b = req.body || {};
  const changes = {};
  const editable = ['title', 'researchers', 'adviser', 'department', 'participantType', 'riskLevel'];
  for (const f of editable) {
    if (b[f] !== undefined) changes[f] = String(b[f]).trim();
  }
  changes.updatedAt = new Date().toISOString();
  await update('ethics', req.params.id, changes);
  const updated = await get('SELECT * FROM ethics WHERE id = ?', [req.params.id]);
  res.json({ message: 'Application updated.', application: updated });
});

router.delete('/:id', requireRole(...REVIEWER_ROLES), async (req, res) => {
  const a = await get('SELECT * FROM ethics WHERE id = ?', [req.params.id]);
  if (!a) return res.status(404).json({ error: 'Application not found.' });
  await remove('ethics', req.params.id);
  res.json({ message: 'Application removed.' });
});

export { router as ethicsRouter, ETHICS_STATUS, REVIEWER_ROLES, SUBMIT_ROLES, FILE_FIELDS };
