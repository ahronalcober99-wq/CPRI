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
const SUBMISSIONS_FILE = join(DATA_DIR, 'submissions.json');
const REPO_FILE = join(DATA_DIR, 'repository.json');
const SUB_UPLOAD_DIR = join(__dirname, '..', '..', 'public', 'assets', 'uploads', 'submissions');

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

// ---------- Store helpers ----------
async function readSubs() {
  try {
    return JSON.parse(await fs.readFile(SUBMISSIONS_FILE, 'utf8'));
  } catch {
    return [];
  }
}
async function writeSubs(subs) {
  await fs.writeFile(SUBMISSIONS_FILE, JSON.stringify(subs, null, 2));
}

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
    statusHistory: [{ status: 'submitted', at: now, by: me.fullName || me.username }],
    files,
    additionalDocs,
    versions: [{ version: 1, uploadedAt: now, by: me.fullName || me.username, note: 'Initial submission', files, additionalDocs }],
    comments: [],
    createdAt: now,
    updatedAt: now
  };

  const subs = await readSubs();
  subs.push(sub);
  await writeSubs(subs);
  res.status(201).json({ message: 'Research submitted successfully.', submission: sub });
});

// ---------- List submissions (role-aware) ----------
router.get('/', requireAuth, async (req, res) => {
  const me = await caller(req);
  const subs = await readSubs();
  const list = REVIEW_ROLES.includes(me.role)
    ? subs
    : subs.filter(s => s.submitterId === me.id);
  // Return a compact view
  res.json({
    submissions: list
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map(s => ({
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
  const subs = await readSubs();
  const sub = subs.find(s => s.id === req.params.id);
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
  const subs = await readSubs();
  const sub = subs.find(s => s.id === req.params.id);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  sub.status = status;
  sub.statusHistory.push({
    status,
    at: new Date().toISOString(),
    by: me.fullName || me.username,
    note: note ? String(note).trim() : ''
  });
  sub.updatedAt = new Date().toISOString();
  await writeSubs(subs);
  if (status === 'published' || status === 'approved') {
    await syncRepository(sub);
  }
  res.json({ message: 'Status updated.', submission: sub });
});

// Keep the institutional repository in sync with approved/published submissions
async function syncRepository(sub) {
  const year = (sub.schoolYear && sub.schoolYear.match(/\d{4}/g))
    ? sub.schoolYear.match(/\d{4}/g).pop()
    : new Date(sub.createdAt).getFullYear();
  let repo = [];
  try { repo = JSON.parse(await fs.readFile(REPO_FILE, 'utf8')); } catch { /* empty */ }
  let rec = repo.find(r => r.sourceSubmissionId === sub.id);
  const base = {
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
    fileAvailable: !!(sub.files && sub.files.manuscript)
  };
  if (rec) {
    Object.assign(rec, base);
    rec.updatedAt = new Date().toISOString();
  } else {
    rec = {
      id: randomUUID(),
      ...base,
      accessLevel: 'downloadable',
      citation: { apa: `${sub.authors} (${year}). ${sub.title}. ${sub.program}.` },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    repo.push(rec);
  }
  await fs.writeFile(REPO_FILE, JSON.stringify(repo, null, 2));
}

// ---------- Secure file download (supports versioned files) ----------
router.get('/:id/file', requireAuth, async (req, res) => {
  const me = await caller(req);
  const subs = await readSubs();
  const sub = subs.find(s => s.id === req.params.id);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  if (!canAccess(me, sub)) return res.status(403).json({ error: 'Access denied.' });

  const { key, docId, version } = req.query;
  // Choose the file set: a specific version, or the current/latest files
  let fileSet = sub;
  if (version) {
    const v = (sub.versions || []).find(x => String(x.version) === String(version));
    if (!v) return res.status(404).json({ error: 'Version not found.' });
    fileSet = v;
  }

  let meta = null;
  if (key === 'additional') {
    meta = (fileSet.additionalDocs || []).find(d => d.id === docId);
  } else if (key) {
    meta = fileSet.files[key];
  }
  if (!meta) return res.status(404).json({ error: 'File not found.' });

  // Version 1 files live directly under <id>/; later revisions under <id>/vN/
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
  const subs = await readSubs();
  const sub = subs.find(s => s.id === req.params.id);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  if (!canAccess(me, sub)) return res.status(403).json({ error: 'Access denied.' });
  res.json({ comments: sub.comments || [] });
});

router.post('/:id/comments', requireAuth, async (req, res) => {
  const me = await caller(req);
  const subs = await readSubs();
  const sub = subs.find(s => s.id === req.params.id);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  if (!canComment(me, sub)) return res.status(403).json({ error: 'You are not allowed to comment on this submission.' });
  const { body, type } = req.body || {};
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'Comment text is required.' });
  const comment = {
    id: randomUUID(),
    authorId: me.id,
    authorName: me.fullName || me.username,
    authorRole: me.role,
    type: COMMENT_TYPE_LABELS[type] ? type : inferCommentType(me.role),
    body: String(body).trim(),
    createdAt: new Date().toISOString()
  };
  sub.comments = sub.comments || [];
  sub.comments.push(comment);
  sub.updatedAt = new Date().toISOString();
  await writeSubs(subs);
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
  const subs = await readSubs();
  const sub = subs.find(s => s.id === req.params.id);
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
  const subs = await readSubs();
  const sub = subs.find(s => s.id === req.params.id);
  sub.versions = sub.versions || [];
  sub.versions.push(version);
  sub.files = files;            // latest files become current
  sub.additionalDocs = additionalDocs;
  sub.updatedAt = now;
  // Resubmission re-enters checking
  sub.status = 'under_initial_checking';
  sub.statusHistory.push({
    status: 'under_initial_checking',
    at: now,
    by: version.by,
    note: 'Revised manuscript resubmitted (v' + req._version + ')'
  });
  await writeSubs(subs);
  res.status(201).json({ message: 'Revision uploaded.', version, submission: sub });
});

export { router as submissionsRouter, STATUS_LABELS, RESEARCH_TYPES, FILE_FIELDS, COMMENT_TYPE_LABELS };
