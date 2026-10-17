import { Router } from 'express';
import multer from 'multer';
import { documentFileFilter, uploadErrorHandler } from './lib/upload-safety.js';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { promises as fs } from 'fs';
import { requireAuth, requireRole, readUsers } from './auth.js';
import { all, get, run, insert, update, remove } from './server/db/queries.js';
import { addLog } from './audit.js';
import { notify } from './notifications.js';
import { createPdf } from './lib/pdf.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ETHICS_UPLOAD_DIR = join(__dirname, '..', 'public', 'assets', 'uploads', 'ethics');

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
const SUBMIT_ROLES = ['admin', 'faculty_researcher', 'non_teaching_researcher', 'student_researcher', 'adviser', 'cpri_staff', 'ethics_reviewer'];

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
// A session whose account no longer exists resolves to no caller, and must be
// refused (this used to read `!me || …`, which let exactly that through).
function canAccess(me, app) {
  return Boolean(me) && (app.submitterId === me.id || REVIEWER_ROLES.includes(me.role));
}
function canReview(me) {
  return !!me && REVIEWER_ROLES.includes(me.role);
}

// 'certificate_issued' is the only status that unlocks the printable
// certificate. When a reviewer moves an application into it without filling in
// the certificate form first, a certificate record is created on the spot from
// the application itself so the applicant always has something to download.
function buildCertificateDraft(application, issuerName) {
  const year = new Date().getFullYear();
  const unique = String(application.id || randomUUID()).replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase();
  return {
    certificateNumber: `CPRI-ERB-${year}-${unique}`,
    dateIssued: new Date().toISOString().slice(0, 10),
    validityPeriod: '1 year from date of issue',
    approvedTitle: application.title || '',
    principalInvestigator: application.researchers || application.submitterName || '',
    issuedBy: issuerName || 'CPRI Ethics Review Board',
    issuedAt: new Date().toISOString(),
    generated: true
  };
}

// The certificate as a printable PDF (one page, framed). Values come from the
// stored certificate record; nothing is read from the request.
function renderCertificatePdf(application, certificate) {
  const issued = certificate.dateIssued || new Date().toISOString().slice(0, 10);
  const lines = [
    { text: 'COLEGIO DE SAN GABRIEL ARCANGEL', y: 740, size: 13, bold: true, align: 'center' },
    { text: 'Center for Policy and Research Innovations', y: 720, size: 11, align: 'center' },
    { text: 'ETHICS REVIEW BOARD', y: 690, size: 16, bold: true, align: 'center' },
    { text: 'CERTIFICATE OF ETHICAL CLEARANCE', y: 650, size: 19, bold: true, align: 'center' },
    { text: 'This certifies that the research described below has been reviewed and', y: 600, size: 11, align: 'center' },
    { text: 'found to be in accordance with the ethical standards of the Board.', y: 584, size: 11, align: 'center' },

    { text: 'Research Title', y: 540, size: 9, bold: true },
    { text: certificate.approvedTitle || application.title || '-', y: 524, size: 12, bold: true },

    { text: 'Principal Investigator / Researcher(s)', y: 496, size: 9, bold: true },
    { text: certificate.principalInvestigator || application.researchers || '-', y: 480, size: 12 },

    { text: 'Department / Unit', y: 452, size: 9, bold: true },
    { text: application.department || '-', y: 436, size: 12 },

    { text: 'Clearance Number', y: 400, size: 9, bold: true },
    { text: certificate.certificateNumber || '-', y: 384, size: 12, bold: true },

    { text: 'Date Issued', y: 356, size: 9, bold: true },
    { text: issued, y: 340, size: 12 },

    { text: 'Validity', y: 312, size: 9, bold: true },
    { text: certificate.validityPeriod || '1 year from date of issue', y: 296, size: 12 },

    { text: `Issued by: ${certificate.issuedBy || 'CPRI Ethics Review Board'}`, y: 200, size: 11 },
    { text: 'This certificate is generated by the CPRI research management system.', y: 120, size: 8, align: 'center' }
  ];
  return createPdf({
    title: `Ethics Clearance ${certificate.certificateNumber || ''}`.trim(),
    border: { x: 40, y: 60, width: 515, height: 740 },
    lines
  });
}

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const dir = join(ETHICS_UPLOAD_DIR, req._ethId);
    try { await fs.mkdir(dir, { recursive: true }); cb(null, dir); }
    catch (err) { cb(err); }
  },
  filename: (req, file, cb) => {
    const safe = file.fieldname.replace(/[^a-z0-9]/gi, '_');
    cb(null, `${safe}-${Date.now()}${extname(file.originalname)}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 }, fileFilter: documentFileFilter });
const uploadFields = upload.fields([
  ...FILE_FIELDS.map(f => ({ name: f.key, maxCount: 1 })),
  { name: 'additional', maxCount: 10 }
]);
const uploadCertificate = upload.single('certificate_pdf');

router.get('/', requireAuth, async (req, res) => {
  const q = req.query;
  const me = await caller(req);
  if (!me) return res.status(401).json({ error: 'Not authenticated.' });
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
  // multer has already written this request's files by now. A refused
  // application must not leave them behind with no record pointing at them.
  const refuse = async (status, error) => {
    await fs.rm(join(ETHICS_UPLOAD_DIR, req._ethId), { recursive: true, force: true }).catch(() => {});
    return res.status(status).json({ error });
  };

  const me = await caller(req);
  if (!me || !SUBMIT_ROLES.includes(me.role)) {
    return refuse(403, 'Your role is not allowed to submit ethics applications.');
  }

  const b = req.body || {};
  const requiredText = ['title', 'researchers', 'adviser', 'department', 'participantType', 'riskLevel'];
  for (const f of requiredText) {
    if (!b[f] || !String(b[f]).trim()) {
      return refuse(400, `Field "${f}" is required.`);
    }
  }
  for (const key of REQUIRED_KEYS) {
    if (!req.files || !req.files[key]) {
      return refuse(400, `Required file missing: ${key}.`);
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

  const changes = { status, statusHistory: JSON.stringify(statusHistory), updatedAt: new Date().toISOString() };

  // Issuing the clearance without filling in the certificate form still has to
  // produce something the applicant can download, so mint a certificate record
  // from the application itself the first time it reaches this status.
  let certificateCreated = false;
  if (status === 'certificate_issued' && !a.certificate) {
    const certificate = buildCertificateDraft(a, me?.fullName || me?.username);
    changes.certificate = JSON.stringify(certificate);
    certificateCreated = true;
  }

  await update('ethics', a.id, changes);

  await addLog(`ethics_${status}`, `${ETHICS_STATUS[status] || status} ethics application "${a.title}"`, req);
  if (certificateCreated) {
    await addLog('ethics_certificate_generated',
      `Ethics clearance certificate generated for "${a.title}".`, req);
  }

  // In-app notification to the applicant on decisions.
  const labels = {
    approved: 'approved', disapproved: 'not approved',
    exempted_from_full_review: 'exempted from full review', for_revision: 'sent back for revision'
  };
  await notify(a.submitterId, `ethics_${status}`,
    `Ethics review ${labels[status] || status}`, `Your ethics application "${a.title}" was ${labels[status] || status}.`,
    `ethics-detail.html?id=${a.id}`);

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
  await addLog('ethics_certificate_issued',
    `Ethics clearance ${certificate.certificateNumber} issued for "${a.title}".`, req);
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

// The downloadable clearance certificate. Only the applicant, the reviewers
// (admin / CPRI staff / ethics reviewer) may fetch it, and each download is
// recorded in the audit trail. An uploaded PDF wins; otherwise the certificate
// is rendered on the fly so the button never dead-ends.
router.get('/:id/certificate.pdf', requireAuth, async (req, res) => {
  const me = await caller(req);
  const a = await get('SELECT * FROM ethics WHERE id = ?', [req.params.id]);
  if (!a) return res.status(404).json({ error: 'Application not found.' });
  if (!canAccess(me, a)) return res.status(403).json({ error: 'Access denied.' });
  if (!a.certificate) return res.status(404).json({ error: 'Certificate not issued yet.' });

  const certificate = a.certificate;
  const who = me?.fullName || me?.username || 'unknown';
  await addLog('ethics_certificate_downloaded',
    `Ethics certificate ${certificate.certificateNumber || ''} for "${a.title}" downloaded by ${who}.`, req);

  if (certificate.file) {
    const filePath = join(ETHICS_UPLOAD_DIR, a.id, certificate.file.filename);
    return res.download(filePath, certificate.file.originalName);
  }

  const pdf = renderCertificatePdf(a, certificate);
  const safeNumber = String(certificate.certificateNumber || 'certificate').replace(/[^A-Za-z0-9._-]/g, '_');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=ethics-clearance-${safeNumber}.pdf`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(pdf);
});

router.post('/:id/revisions', requireAuth, async (req, res, next) => {
  const me = await caller(req);
  const a = await get('SELECT * FROM ethics WHERE id = ?', [req.params.id]);
  if (!a) return res.status(404).json({ error: 'Application not found.' });
  if (!me || a.submitterId !== me.id) return res.status(403).json({ error: 'Only the researcher can upload revisions.' });
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

// Friendly JSON for oversized or rejected uploads (400, not the global 500).
// Registered after every route so it sees the upload errors from above.
router.use(uploadErrorHandler({ label: 'Document', maxMb: 15 }));

export { router as ethicsRouter, ETHICS_STATUS, REVIEWER_ROLES, SUBMIT_ROLES, FILE_FIELDS };
