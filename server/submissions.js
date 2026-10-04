import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { requireAuth, requireRole, readUsers } from './auth.js';
import { all, get, run, insert, update, remove } from './server/db/queries.js';
import { addLog } from './audit.js';
import { notify } from './notifications.js';
import { supabaseStorage } from './storage/supabase-storage.js';
import {
  createSubmissionFileStore,
  MAX_SUBMISSION_FILE_BYTES,
  validateSubmissionUploadFile
} from './storage/submission-files.js';

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

// Roles allowed to create submissions (admin included per RBAC submit_research)
const SUBMIT_ROLES = ['admin', 'faculty_researcher', 'student_researcher', 'adviser', 'cpri_staff'];
// Roles allowed to review / change status
const REVIEW_ROLES = ['admin', 'cpri_staff', 'ethics_reviewer'];
// Roles that see the full submission list + stats (advisers supervise student
// work, so they see all; they still cannot change statuses — that's REVIEW_ROLES).
const VIEW_ALL_ROLES = ['admin', 'cpri_staff', 'ethics_reviewer', 'adviser'];
const { storeUploadedFiles, rollback: cleanupUploadedFiles } = createSubmissionFileStore();

function createUploadMiddleware() {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_SUBMISSION_FILE_BYTES, files: FILE_FIELDS.length + 10 },
    fileFilter(req, file, callback) {
      if (!validateSubmissionUploadFile(file)) {
        const error = new Error('Only PDF, DOC, and DOCX files are allowed.');
        error.code = 'INVALID_FILE_TYPE';
        return callback(error);
      }
      callback(null, true);
    }
  });
  return upload.fields([
    ...FILE_FIELDS.map(field => ({ name: field.key, maxCount: 1 })),
    { name: 'additional', maxCount: 10 }
  ]);
}

function handleUploadErrors(uploadMiddleware) {
  return (req, res, next) => {
    uploadMiddleware(req, res, error => {
      if (!error) return next();
      const message = error.code === 'LIMIT_FILE_SIZE'
        ? 'Each file must be 15 MB or smaller.'
        : error.code === 'INVALID_FILE_TYPE'
          ? error.message
          : error instanceof multer.MulterError
            ? 'The upload contains too many files or fields.'
            : 'The upload could not be processed.';
      return res.status(400).json({ ok: false, message });
    });
  };
}

async function caller(req) {
  const users = await readUsers();
  return users.find(u => u.id === req.session.userId);
}

function canAccess(me, sub) {
  return !me || me.id === sub.submitterId || REVIEW_ROLES.includes(me.role);
}

// ---------- Private file upload config ----------
const uploadFields = createUploadMiddleware();

// ---------- Create submission ----------
router.post('/', requireAuth, (req, res, next) => {
  req._subId = randomUUID();
  next();
}, handleUploadErrors(uploadFields), async (req, res) => {
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

  let storedFiles;
  try {
    storedFiles = await storeUploadedFiles(req.files, `submissions/${req._subId}`);
  } catch (error) {
    if (error.code === 'INVALID_FILE_CONTENT') {
      return res.status(400).json({ ok: false, message: error.message });
    }
    console.error('[storage] submission upload failed:', error.message);
    return res.status(500).json({ ok: false, message: 'Could not save uploaded files. Please try again.' });
  }
  const { files, additionalDocs, uploadedPaths } = storedFiles;

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

  try {
    await insert('submissions', sub);
  } catch (error) {
    await cleanupUploadedFiles(uploadedPaths, error);
    console.error('[submissions] could not save submission after file upload:', error.message);
    return res.status(500).json({ ok: false, message: 'Could not save your submission. Please try again.' });
  }
  res.status(201).json({ message: 'Research submitted successfully.', submission: sub });
});

// ---------- List submissions (role-aware) ----------
router.get('/', requireAuth, async (req, res) => {
  const me = await caller(req);
  const seesAll = VIEW_ALL_ROLES.includes(me.role);
  const subs = seesAll
    ? await all('SELECT * FROM submissions ORDER BY createdAt DESC')
    : await all('SELECT * FROM submissions WHERE submitterId = ? ORDER BY createdAt DESC', [me.id]);

  const payload = {
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
  };

  // ?stats=1 -> role-scoped stats computed over the same filtered set the
  // caller can actually see (own submissions for researchers, all for
  // reviewers). Used by the Student Researcher Portal so students see their
  // own counts instead of system-wide numbers.
  if (req.query.stats) {
    const window = Array.from({ length: 7 }, (_, i) => {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - 6 + i);
      return { key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, count: 0 };
    });
    const approvedStatuses = new Set(['approved', 'published']);
    let approvedCount = 0;
    let onTime = 0;
    let onTimeEligible = 0;

    subs.forEach(s => {
      if (approvedStatuses.has(s.status)) approvedCount += 1;
      const created = new Date(s.createdAt);
      if (!isNaN(created)) {
        const bucket = window.find(m => m.key === `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, '0')}`);
        if (bucket) bucket.count += 1;
      }
      // On-time delivery: first approved/published entry within 14 days of creation.
      if (Array.isArray(s.statusHistory)) {
        const approval = s.statusHistory.find(h => approvedStatuses.has(h.status) && h.at);
        if (approval) {
          const approvedAt = new Date(approval.at);
          onTimeEligible += 1;
          if (!isNaN(created) && !isNaN(approvedAt) && (approvedAt.getTime() - created.getTime()) <= 14 * 24 * 60 * 60 * 1000) {
            onTime += 1;
          }
        }
      }
    });

    payload.stats = {
      scope: seesAll ? 'all' : 'own',
      total: subs.length,
      approved: approvedCount,
      rejected: subs.filter(s => s.status === 'rejected').length,
      approvalRate: subs.length ? Math.round((approvedCount / subs.length) * 100) : 0,
      onTimeDelivery: onTimeEligible ? Math.round((onTime / onTimeEligible) * 100) : 0,
      monthlyOutput: window.map(m => m.count)
    };
  }

  res.json(payload);
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

  // Keep repository + publications in sync on EVERY status change: published
  // submissions surface on the Publications page, and any other status hides
  // the auto-added publication again.
  await syncRepository(sub, status, { role: me.role, at: now });

  await addLog(`submission_${status}`, `${STATUS_LABELS[status] || status} submission "${sub.title}"`, req);

  // In-app notification to the submitter on terminal/review decisions.
  const labels = {
    approved: 'approved', published: 'published', rejected: 'rejected',
    for_revision: 'sent back for revision'
  };
  await notify(sub.submitterId, `submission_${status}`,
    `Submission ${labels[status] || status}`, `Your submission "${sub.title}" was ${labels[status] || status}.`,
    `submission.html?id=${sub.id}`);

  const updated = await get('SELECT * FROM submissions WHERE id = ?', [sub.id]);
  res.json({ message: 'Status updated.', submission: updated });
});

// A submission marked "published" automatically appears on the Publications
// page as a publication record, linked back via sourceSubmissionId so staff
// can remove it from Publications without affecting the submission or its
// repository entry. Upserts so re-publishing never creates duplicates.
export async function syncPublication(sub, role, publishedAt) {
  const year = (sub.schoolYear && sub.schoolYear.match(/\d{4}/g))
    ? sub.schoolYear.match(/\d{4}/g).pop()
    : new Date(sub.createdAt).getFullYear();

  const authorType = (role === 'admin' || role === 'cpri_staff' || role === 'faculty_researcher')
    ? 'faculty'
    : (role === 'student_researcher' ? 'student' : 'other');

  const at = publishedAt || new Date().toISOString();
  const base = {
    title: sub.title,
    authors: sub.authors,
    journalOrConference: sub.program || 'CPRI',
    publicationDate: at.slice(0, 10),
    pubType: 'institutional_journal',
    status: 'published',
    authorType,
    department: sub.program || '',
    schoolYear: sub.schoolYear || '',
    proofDocuments: JSON.stringify([]),
    submitterId: sub.submitterId,
    submitterName: sub.submitterName,
    sourceSubmissionId: sub.id,
    updatedAt: at
  };

  const existing = await get('SELECT * FROM publications WHERE sourceSubmissionId = ?', [sub.id]);
  if (existing) {
    await update('publications', existing.id, base);
  } else {
    await insert('publications', { id: randomUUID(), ...base, createdAt: at });
  }
}

// Keep the institutional repository in sync with approved/published submissions
async function syncRepository(sub, newStatus, ctx = {}) {
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
    const citation = rec.citation && rec.citation.mla ? rec.citation : {
      apa: `${sub.authors} (${year}). ${sub.title}. ${sub.program}.`,
      mla: `${sub.authors}. "${sub.title}." ${sub.program}, ${year}.`,
      institutional: `CPRI (${year}). ${sub.title}. ${sub.authors}. ${sub.program}.`
    };
    await update('repository', rec.id, {
      ...base,
      citation: JSON.stringify(citation),
      updatedAt: new Date().toISOString()
    });
  } else if (newStatus === 'approved' || newStatus === 'published') {
    const citationObj = {
      apa: `${sub.authors} (${year}). ${sub.title}. ${sub.program}.`,
      mla: `${sub.authors}. "${sub.title}." ${sub.program}, ${year}.`,
      institutional: `CPRI (${year}). ${sub.title}. ${sub.authors}. ${sub.program}.`
    };
    const recData = {
      id: randomUUID(),
      sourceSubmissionId: sub.id,
      ...base,
      accessLevel: 'downloadable',
      citation: JSON.stringify(citationObj),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await insert('repository', recData);
  }

  // Published submissions surface on the Publications page automatically;
  // moving to any other status hides it again — the auto-added publication is
  // removed while the submission and its repository record stay untouched.
  if (newStatus === 'published') {
    await syncPublication(sub, ctx.role, ctx.at);
  } else {
    await run('DELETE FROM publications WHERE sourceSubmissionId = ?', [sub.id]);
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
  if (!meta || !meta.storage_path) {
    return res.status(404).json({
      ok: false,
      message: 'The file is no longer available. Please ask the author to upload it again.'
    });
  }

  try {
    if (!await supabaseStorage.objectExists(meta.storage_path)) {
      return res.status(404).json({
        ok: false,
        message: 'The file is no longer available. Please ask the author to upload it again.'
      });
    }
    const signedUrl = await supabaseStorage.createSignedDownloadUrl({
      path: meta.storage_path,
      downloadName: meta.original_name || 'download',
      expiresIn: 60
    });
    return res.redirect(302, signedUrl);
  } catch (error) {
    console.error('[storage] submission download failed:', error.message);
    return res.status(500).json({ ok: false, message: 'Could not prepare the file download. Please try again.' });
  }
});
// ---------- Revisions Side-by-Side Comparison ----------
router.get('/:id/revisions/compare', requireAuth, async (req, res) => {
  const me = await currentUser(req);
  const sub = await get('SELECT * FROM submissions WHERE id = ?', [req.params.id]);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  if (!canAccess(me, sub)) return res.status(403).json({ error: 'Access denied.' });

  const versions = sub.versions || [];
  const v1 = Number(req.query.v1) || 1;
  const v2 = Number(req.query.v2) || (versions.length > 0 ? versions[versions.length - 1].version : 1);

  const ver1 = versions.find(v => Number(v.version) === v1) || null;
  const ver2 = versions.find(v => Number(v.version) === v2) || null;

  if (!ver1 || !ver2) {
    return res.status(404).json({ error: 'One or both specified versions were not found.' });
  }

  res.json({
    submissionId: sub.id,
    title: sub.title,
    comparing: { v1, v2 },
    version1: ver1,
    version2: ver2
  });
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
const revisionFields = createUploadMiddleware();

router.post('/:id/revisions', requireAuth, async (req, res, next) => {
  const me = await caller(req);
  const sub = await get('SELECT * FROM submissions WHERE id = ?', [req.params.id]);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  if (sub.submitterId !== me.id) return res.status(403).json({ error: 'Only the researcher can upload revisions.' });
  req._subId = sub.id;
  req._version = (sub.versions || []).length + 1;
  req._sub = sub;
  next();
}, handleUploadErrors(revisionFields), async (req, res) => {
  if (!req.files || !req.files.manuscript) {
    return res.status(400).json({ error: 'A revised manuscript file is required.' });
  }
  let storedFiles;
  try {
    storedFiles = await storeUploadedFiles(
      req.files,
      `submissions/${req._subId}/revisions/${req._version}`
    );
  } catch (error) {
    if (error.code === 'INVALID_FILE_CONTENT') {
      return res.status(400).json({ ok: false, message: error.message });
    }
    console.error('[storage] revision upload failed:', error.message);
    return res.status(500).json({ ok: false, message: 'Could not save revised files. Please try again.' });
  }
  const { files, additionalDocs, uploadedPaths } = storedFiles;
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

  try {
    await update('submissions', sub.id, {
      files: JSON.stringify(files),
      additionalDocs: JSON.stringify(additionalDocs),
      versions: JSON.stringify(versions),
      status: 'under_initial_checking',
      statusHistory: JSON.stringify(statusHistory),
      updatedAt: now
    });
  } catch (error) {
    await cleanupUploadedFiles(uploadedPaths);
    console.error('[submissions] could not save revision after file upload:', error.message);
    return res.status(500).json({ ok: false, message: 'Could not save your revision. Please try again.' });
  }

  await addLog(
    'submission_revision',
    `Revision v${req._version} uploaded for submission "${sub.title}"`,
    req
  );

  const updated = await get('SELECT * FROM submissions WHERE id = ?', [sub.id]);
  res.status(201).json({ message: 'Revision uploaded.', version, submission: updated });
});

export { router as submissionsRouter, STATUS_LABELS, RESEARCH_TYPES, FILE_FIELDS, COMMENT_TYPE_LABELS };
