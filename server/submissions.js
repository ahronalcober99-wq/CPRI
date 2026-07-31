import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { promises as fs } from 'fs';
import { requireAuth, requireRole, readUsers } from './auth.js';
import { all, get, run, insert, update, remove } from './server/db/queries.js';
import { addLog } from './audit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SUB_UPLOAD_DIR = join(__dirname, '..', 'public', 'assets', 'uploads', 'submissions');

const router = Router();

// ---------- Constants ----------
const STATUS_LABELS = {
  submitted: 'Submitted',
  under_initial_checking: 'Under Initial Checking',
  for_revision: 'For Revision',
  under_ethics_review: 'Under Ethics Review',
  approved: 'Approved',
  published: 'Published',
  archived: 'Archived',
  rejected: 'Rejected'
};

const RESEARCH_TYPES = {
  institutional: 'Institutional Research',
  faculty: 'Faculty Research',
  student_thesis: 'Student Thesis',
  capstone: 'Capstone',
  feasibility: 'Feasibility Study',
  action_research: 'Action Research'
};

// Required upload document slots
const FILE_FIELDS = [
  { key: 'manuscript', label: 'Full Manuscript', required: true },
  { key: 'abstract', label: 'Abstract', required: true },
  { key: 'ethicsCertificate', label: 'Ethics Certificate (if applicable)', required: false },
  { key: 'approvalForm', label: 'Research Approval Form', required: true },
  { key: 'similarityReport', label: 'Similarity Report', required: true },
  { key: 'adviserEndorsement', label: 'Adviser Endorsement', required: true },
  { key: 'panelApproval', label: 'Panel Approval Sheet', required: true },
  { key: 'publicationProof', label: 'Publication Proof (if available)', required: false }
];
const REQUIRED_KEYS = FILE_FIELDS.filter(f => f.required).map(f => f.key);

// Roles allowed to create submissions
const SUBMIT_ROLES = ['faculty_researcher', 'student_researcher', 'adviser', 'cpri_staff'];
// Roles allowed to review / change status
const REVIEW_ROLES = ['admin', 'cpri_staff', 'ethics_reviewer'];

async function caller(req) {
  const users = await readUsers();
  return users.find(u => u.id === req.session.userId);
}

function canAccess(me, sub) {
  return !me || me.id === sub.submitterId || REVIEW_ROLES.includes(me.role);
}

// ---------- File upload config ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = join(SUB_UPLOAD_DIR, req._subId);
    fs.mkdir(dir, { recursive: true }, () => cb(null, dir));
  },
  filename: (req, file, cb) => {
    const safe = file.fieldname.replace(/[^a-z0-9]/gi, '_');
    cb(null, `${safe}-${Date.now()}${extname(file.originalname)}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } }); // 15 MB
const uploadFields = upload.fields([
  ...FILE_FIELDS.map(f => ({ name: f.key, maxCount: 1 })),
  { name: 'additional', maxCount: 10 }
]);

// ---------- Create submission ----------
router.post('/', requireAuth, (req, res, next) => {
  req._subId = randomUUID();
  next();
}, uploadFields, async (req, res) => {
  const me = await caller(req);
  if (!me || !SUBMIT_ROLES.includes(me.role)) {
    return res.status(403).json({ error: 'Your role is not allowed to submit research.' });
  }

  const b = req.body || {};
  const requiredText = ['title', 'authors', 'program', 'category', 'researchType', 'abstract', 'schoolYear', 'semester'];
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
  const sub = {
    id: req._subId,
    submitterId: me.id,
    submitterName: me.fullName || me.username,
    title: String(b.title).trim(),
    authors: String(b.authors).trim(),
    program: String(b.program).trim(),
    adviser: b.adviser ? String(b.adviser).trim() : '',
    category: String(b.category).trim(),
    researchType: String(b.researchType).trim(),
    abstract: String(b.abstract).trim(),
    keywords: b.keywords ? String(b.keywords).trim() : '',
    schoolYear: String(b.schoolYear).trim(),
    semester: String(b.semester).trim(),
    status: 'submitted',
    statusHistory: JSON.stringify([{ status: 'submitted', at: now, by: me.fullName || me.username }]),
    files: JSON.stringify(files),
    additionalDocs: JSON.stringify(additionalDocs),
    versions: JSON.stringify([{ version: 1, uploadedAt: now, by: me.fullName || me.username, note: 'Initial submission', files, additionalDocs }]),
    comments: JSON.stringify([]),
    createdAt: now,
    updatedAt: now
  };

  await insert('submissions', sub);
  res.status(201).json({ message: 'Research submitted successfully.', submission: sub });
});

// ---------- List submissions (role-aware) ----------
router.get('/', requireAuth, async (req, res) => {
  const me = await caller(req);
  const subs = REVIEW_ROLES.includes(me.role)
    ? await all('SELECT * FROM submissions ORDER BY createdAt DESC')
    : await all('SELECT * FROM submissions WHERE submitterId = ? ORDER BY createdAt DESC', [me.id]);

  res.json({
    submissions: subs.map(s => ({
      id: s.id,
      title: s.title,
      authors: s.authors,
      program: s.program,
      researchType: s.researchType,
      status: s.status,
      statusLabel: STATUS_LABELS[s.status] || s.status,
      createdAt: s.createdAt,
      isOwner: s.submitterId === me.id
    }))
  });
});

// ---------- Submission detail ----------
router.get('/:id', requireAuth, async (req, res) => {
  const me = await caller(req);
  const sub = await get('SELECT * FROM submissions WHERE id = ?', [req.params.id]);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  if (!canAccess(me, sub)) return res.status(403).json({ error: 'Access denied.' });
  res.json({ submission: sub, statusLabel: STATUS_LABELS[sub.status] || sub.status });
});

// ---------- Update status (reviewers/admins) ----------
router.patch('/:id/status', requireRole(...REVIEW_ROLES), async (req, res) => {
  const { status, note } = req.body || {};
  if (!STATUS_LABELS[status]) {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  const me = await caller(req);
  const sub = await get('SELECT * FROM submissions WHERE id = ?', [req.params.id]);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });

  const statusHistory = sub.statusHistory || [];
  statusHistory.push({
    status,
    at: new Date().toISOString(),
    by: me.fullName || me.username,
    note: note ? String(note).trim() : ''
  });

  const now = new Date().toISOString();
  await update('submissions', sub.id, { status, statusHistory: JSON.stringify(statusHistory), updatedAt: now });

  if (status === 'published' || status === 'approved') {
    await syncRepository(sub, status);
  }

  await addLog(`submission_${status}`, `${STATUS_LABELS[status] || status} submission "${sub.title}"`, req);

  const updated = await get('SELECT * FROM submissions WHERE id = ?', [sub.id]);
  res.json({ message: 'Status updated.', submission: updated });
});

// Keep the institutional repository in sync with approved/published submissions
async function syncRepository(sub, newStatus) {
  const year = (sub.schoolYear && sub.schoolYear.match(/\d{4}/g))
    ? sub.schoolYear.match(/\d{4}/g).pop()
    : new Date(sub.createdAt).getFullYear();

  let rec = await get('SELECT * FROM repository WHERE sourceSubmissionId = ?', [sub.id]);

  const base = {
    title: sub.title,
    authors: sub.authors,
    adviser: sub.adviser || '',
    department: sub.program,
    abstract: sub.abstract,
    keywords: sub.keywords || '',
    category: sub.researchType,
    yearCompleted: String(year),
    status: newStatus,
    fileAvailable: sub.files && sub.files.manuscript ? 1 : 0
  };

  if (rec) {
    const citation = rec.citation || { apa: `${sub.authors} (${year}). ${sub.title}. ${sub.program}.` };
    await update('repository', rec.id, {
      ...base,
      citation: JSON.stringify(citation),
      updatedAt: new Date().toISOString()
    });
  } else {
    const recData = {
      id: randomUUID(),
      sourceSubmissionId: sub.id,
      ...base,
      accessLevel: 'downloadable',
      citation: JSON.stringify({ apa: `${sub.authors} (${year}). ${sub.title}. ${sub.program}.` }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await insert('repository', recData);
  }
}

// ---------- Secure file download (supports versioned files) ----------
router.get('/:id/file', requireAuth, async (req, res) => {
  const me = await caller(req);
  const sub = await get('SELECT * FROM submissions WHERE id = ?', [req.params.id]);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  if (!canAccess(me, sub)) return res.status(403).json({ error: 'Access denied.' });

  const { key, docId, version } = req.query;
  let fileSet = sub;
  if (version) {
    const versions = sub.versions || [];
    const v = versions.find(x => String(x.version) === String(version));
    if (!v) return res.status(404).json({ error: 'Version not found.' });
    fileSet = v;
  }

  let meta = null;
  if (key === 'additional') {
    const additionalDocs = fileSet.additionalDocs || [];
    meta = additionalDocs.find(d => d.id === docId);
  } else if (key) {
    const files = fileSet.files || {};
    meta = files[key];
  }
  if (!meta) return res.status(404).json({ error: 'File not found.' });

  const folder = (version && Number(version) > 1) ? join(SUB_UPLOAD_DIR, sub.id, 'v' + version) : join(SUB_UPLOAD_DIR, sub.id);
  const p = join(folder, meta.filename);
  res.download(p, meta.originalName);
});

// ---------- Comments & Feedback ----------
function inferCommentType(role) {
  if (role === 'adviser') return 'feedback';
  if (role === 'ethics_reviewer') return 'revision_suggestion';
  if (role === 'faculty_researcher' || role === 'student_researcher') return 'response';
  return 'comment';
}
const COMMENT_TYPE_LABELS = {
  comment: 'Comment',
  feedback: 'Adviser Feedback',
  revision_suggestion: 'Reviewer Suggestion',
  response: 'Researcher Response'
};

// Participants allowed to comment: owner + staff + adviser + reviewer
function canComment(me, sub) {
  return me.id === sub.submitterId || ['admin', 'cpri_staff', 'ethics_reviewer', 'adviser'].includes(me.role);
}

router.get('/:id/comments', requireAuth, async (req, res) => {
  const me = await caller(req);
  const sub = await get('SELECT * FROM submissions WHERE id = ?', [req.params.id]);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  if (!canAccess(me, sub)) return res.status(403).json({ error: 'Access denied.' });
  res.json({ comments: sub.comments || [] });
});

router.post('/:id/comments', requireAuth, async (req, res) => {
  const me = await caller(req);
  const sub = await get('SELECT * FROM submissions WHERE id = ?', [req.params.id]);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  if (!canComment(me, sub)) return res.status(403).json({ error: 'You are not allowed to comment on this submission.' });
  const { body, type } = req.body || {};
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'Comment text is required.' });
  const comments = sub.comments || [];
  const comment = {
    id: randomUUID(),
    authorId: me.id,
    authorName: me.fullName || me.username,
    authorRole: me.role,
    type: COMMENT_TYPE_LABELS[type] ? type : inferCommentType(me.role),
    body: String(body).trim(),
    createdAt: new Date().toISOString()
  };
  comments.push(comment);
  await update('submissions', sub.id, { comments: JSON.stringify(comments), updatedAt: new Date().toISOString() });
  res.status(201).json({ message: 'Comment added.', comment });
});

// ---------- Revision upload (researcher only) ----------
const uploadRevision = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = join(SUB_UPLOAD_DIR, req._subId, 'v' + req._version);
      fs.mkdir(dir, { recursive: true }, () => cb(null, dir));
    },
    filename: (req, file, cb) => {
      const safe = file.fieldname.replace(/[^a-z0-9]/gi, '_');
      cb(null, `${safe}-${Date.now()}${extname(file.originalname)}`);
    }
  }),
  limits: { fileSize: 15 * 1024 * 1024 }
});
const revisionFields = uploadRevision.fields([
  ...FILE_FIELDS.map(f => ({ name: f.key, maxCount: 1 })),
  { name: 'additional', maxCount: 10 }
]);

router.post('/:id/revisions', requireAuth, async (req, res, next) => {
  const me = await caller(req);
  const sub = await get('SELECT * FROM submissions WHERE id = ?', [req.params.id]);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  if (sub.submitterId !== me.id) return res.status(403).json({ error: 'Only the researcher can upload revisions.' });
  req._subId = sub.id;
  req._version = (sub.versions || []).length + 1;
  req._sub = sub;
  next();
}, revisionFields, async (req, res) => {
  if (!req.files || !req.files.manuscript) {
    return res.status(400).json({ error: 'A revised manuscript file is required.' });
  }
  const files = {};
  for (const f of FILE_FIELDS) {
    if (req.files[f.key] && req.files[f.key][0]) {
      files[f.key] = { filename: req.files[f.key][0].filename, originalName: req.files[f.key][0].originalname };
    }
  }
  const additionalDocs = (req.files.additional || []).map(file => ({
    id: randomUUID(), filename: file.filename, originalName: file.originalname
  }));
  const me = await caller(req);
  const now = new Date().toISOString();
  const note = req.body.note ? String(req.body.note).trim() : '';
  const version = {
    version: req._version,
    uploadedAt: now,
    by: me.fullName || me.username,
    note,
    files,
    additionalDocs
  };

  const sub = await get('SELECT * FROM submissions WHERE id = ?', [req.params.id]);
  const versions = sub.versions || [];
  versions.push(version);
  const statusHistory = sub.statusHistory || [];
  statusHistory.push({
    status: 'under_initial_checking',
    at: now,
    by: version.by,
    note: 'Revised manuscript resubmitted (v' + req._version + ')'
  });

  await update('submissions', sub.id, {
    files: JSON.stringify(files),
    additionalDocs: JSON.stringify(additionalDocs),
    versions: JSON.stringify(versions),
    status: 'under_initial_checking',
    statusHistory: JSON.stringify(statusHistory),
    updatedAt: now
  });

  const updated = await get('SELECT * FROM submissions WHERE id = ?', [sub.id]);
  res.status(201).json({ message: 'Revision uploaded.', version, submission: updated });
});

export { router as submissionsRouter, STATUS_LABELS, RESEARCH_TYPES, FILE_FIELDS, COMMENT_TYPE_LABELS };

