// ============================================================
//  CPRI — Research Submission Module (back end)
//  Router: /api/research-submissions/*
//
//  Storage: files land on disk under UPLOAD_DIR (random names),
//  served ONLY through the authorized download endpoint. Nothing is
//  stored in a public folder and nothing is served inline.
//
//  Auth: Express session. req.session.userId is the only identity the
//  server trusts. Client-supplied role / owner_id / status are ignored
//  everywhere. Role labels from the session are the only authority.
// ============================================================
'use strict';

import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { extname, basename, dirname } from 'path';
import { createReadStream } from 'fs';
// mkdir/readFile/rm/stat/writeFile are awaited, so they must come from the
// promise API — the callback versions throw without a callback.
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';

// The module now lives inside server/ alongside the rest of the site, so it
// shares the SAME database pool and the SAME session guard as every other
// router — no shim, no second connection, no invented identity.
import {
  get as defaultGet,
  all as defaultAll,
  insert as defaultInsert,
  update as defaultUpdate,
  remove as defaultRemove
} from './server/db/queries.js';
import {
  requireAuth as defaultRequireAuth,
  normalizePrefs,
  isValidClock
} from './auth.js';
import { notify as defaultNotify } from './notifications.js';
import { sendNotificationEmail as defaultSendEmail } from './lib/mail.js';

// The caller's own user row, resolved from the session only. The router never
// trusts a role / owner_id sent by the client, so this is the single place
// where "who is this?" is decided.
async function defaultCallerUser(req) {
  const id = req?.session?.userId;
  if (!id) return null;
  const user = await defaultGet(
    'SELECT id, username, email, fullName, role, status FROM users WHERE id = ?',
    [id]
  );
  if (!user || user.status === 'disabled') return null;
  return user;
}

import {
  RESEARCHER_ROLES,
  REVIEWER_ROLES,
  SUBMITTER_ROLES,
  ASSIGNED_ROLES,
  STAGES,
  HAS_INITIAL_STAGE,
  HAS_FINAL_STAGE,
  FORM_CONFIG,
  INITIAL_STATUSES,
  FINAL_STATUSES,
  INITIAL_TRANSITIONS,
  FACULTY_INITIAL_TRANSITIONS,
  FINAL_TRANSITIONS,
  validTransitionsFor,
  requiredSlotKeysFor,
  buildValidationContext,
  isTruthyFlag,
  missingRequirements,
  describeSlot,
  CONDITIONAL_FLAGS,
  WORD_EXTENSIONS,
  PDF_EXTENSIONS,
  OPEN_DOC_EXTENSIONS,
  isWordSlot,
  isPdfSlot,
  slotFileExtensions,
  ALL_SLOT_KEYS,
  STUDENT_ONLY_SLOTS,
  isFacultyRole,
  SEMESTERS
} from './lib/research-config.js';

// Files live on the same persistent disk the rest of the site already uses
// (server/data -> the Render disk), so they survive a restart and are never
// inside a public folder. A stored_path of
// `research-submissions/<id>/files/<uuid>.pdf` therefore lands in
// server/data/research-submissions/<id>/files/.
export const RESEARCH_SUBMISSIONS_UPLOAD_DIR = join(process.cwd(), 'server', 'data');

// ============================================================
//  Router factory
//
//  The data layer and the session guard are injected so the module can be
//  tested offline (no MySQL) — the same pattern the Research Gala router
//  uses. Production calls createResearchSubmissionsRouter() with no
//  arguments and gets the real pool + the real requireAuth.
// ============================================================
export function createResearchSubmissionsRouter(dependencies = {}) {
  const get = dependencies.get || defaultGet;
  const all = dependencies.all || defaultAll;
  const insert = dependencies.insert || defaultInsert;
  const update = dependencies.update || defaultUpdate;
  const remove = dependencies.remove || defaultRemove;
  const requireAuth = dependencies.requireAuth || defaultRequireAuth;
  const callerUser = dependencies.caller || defaultCallerUser;
  // Notification for a person: in-app (the site's own helper, which respects
  // the user's preferences) plus an email copy when they asked for one.
  // Both halves are injectable so tests can assert on them offline.
  const notifyInApp = dependencies.notify || defaultNotify;
  const sendEmail = dependencies.sendEmail || defaultSendEmail;

  // Is "now" inside the user's quiet hours? The window may cross midnight
  // (22:00 → 07:00), which is the default.
  function insideQuietHours(quietHours) {
    if (!quietHours || !quietHours.enabled) return false;
    if (!isValidClock(quietHours.start) || !isValidClock(quietHours.end)) return false;
    const minutes = (clock) => {
      const [h, m] = clock.split(':').map(Number);
      return h * 60 + m;
    };
    const now = new Date();
    const at = now.getHours() * 60 + now.getMinutes();
    const start = minutes(quietHours.start);
    const end = minutes(quietHours.end);
    return start <= end ? (at >= start && at < end) : (at >= start || at < end);
  }

  /**
   * In-app notification + optional email copy for one person.
   *
   * Email follows the account's own preferences (`user_prefs.email`, default
   * off, and quiet hours suppress the copy) — the same contract the Email
   * Notifications page writes. Nothing here may break the request it belongs
   * to, so every failure is logged and swallowed.
   */
  async function notifyPerson(userId, { action, title, message, link = '' }) {
    if (!userId) return;
    await notifyInApp(userId, action, title, message, link).catch(() => {});

    try {
      const account = await get(
        'SELECT email, fullName, user_prefs FROM users WHERE id = ?',
        [userId]
      );
      if (!account || !account.email) return;
      const prefs = normalizePrefs(account.user_prefs);
      if (!prefs.email) return;
      if (insideQuietHours(prefs.quietHours)) {
        console.log(`[research-submissions] quiet hours — email to ${userId} held back`);
        return;
      }
      await sendEmail(account.email, {
        title,
        message,
        link,
        linkLabel: 'Open the submission'
      });
    } catch (err) {
      console.error('[research-submissions] notification email failed:', err.message);
    }
  }
  const UPLOAD_DIR = dependencies.uploadDir || RESEARCH_SUBMISSIONS_UPLOAD_DIR;

  // Ensure the upload directory exists so the disk survives a restart.
  mkdir(UPLOAD_DIR, { recursive: true }).catch(() => {});


const FILE_MIME_LIMIT = 20 * 1024 * 1024; // 20 MB

// ---------------------------------------------------------------------------
//  Multer: memory for validation, then stream to disk with a random name.
//  Every upload creates a NEW file; old versions are never overwritten.
// ---------------------------------------------------------------------------
function createUploadMiddleware({ allowedSlots = new Set() } = {}) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: FILE_MIME_LIMIT, files: 50 }
  });

  return upload.fields(
    Array.from(allowedSlots).map(slot => ({ name: slot, maxCount: 1 })) // one per slot
  );
}

const ALLOWED_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/zip' // .docx / .odt containers may report zip
]);

function isAllowedSubmissionFile(file) {
  const ext = extname(file.originalname || '').toLowerCase();
  if (ext === '.pdf' && file.mimetype === 'application/pdf') return true;
  if (ext === '.doc' && file.mimetype === 'application/msword') return true;
  if (ext === '.docx') {
    const m = file.mimetype;
    return m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
           m === 'application/zip';
  }
  // Unknown extensions: reject.
  return false;
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------
function requireRoles(...roles) {
  return async (req, res, next) => {
    const user = await callerUser(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated.' });
    // Ignore any role the client may have sent; use only the session.
    if (!roles.includes(user.role)) return res.status(403).json({ error: 'Access denied.' });
    req._user = user;
    next();
  };
}

// Researchers see only their own submissions.
// Advisers/facilitators see submissions assigned to them (adviser_id / facilitator_id).
// cpri_staff / admin see all.
function canReadSubmission(user, sub) {
  if (!user) return false;
  if (RESEARCHER_ROLES.has(user.role)) return sub.owner_id === user.id;
  if (ASSIGNED_ROLES.has(user.role)) {
    if (user.role === 'adviser' && sub.adviser_id === user.id) return true;
    if (user.role === 'facilitator' && sub.facilitator_id === user.id) return true;
    // If not assigned to this submission, the reviewer sees nothing here; fall through.
  }
  if (user.role === 'cpri_staff' || user.role === 'admin') return true;
  return false;
}

function canWriteSubmission(user, sub) {
  // Editing is allowed while the submission is still with its owner: a draft
  // being filled in, or one that came back with a revision request.
  if (!['draft', 'submitted', 'for_revision'].includes(sub.status)) return false;
  return canReadSubmission(user, sub);
}

// ---------------------------------------------------------------------------
//  Upload error handler (multer failures -> 400 JSON, not 500)
// ---------------------------------------------------------------------------
function handleUploadErrors(uploadMiddleware) {
  return (req, res, next) => {
    uploadMiddleware(req, res, err => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: `File is too large (max ${FILE_MIME_LIMIT / 1024 / 1024} MB).` });
      }
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ error: `Upload rejected: ${err.message}` });
      }
      if (err.code === 'LIMIT_FILE_COUNT') {
        return res.status(400).json({ error: 'Too many files for this submission.' });
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ error: `Unexpected file field in the upload.` });
      }
      return res.status(400).json({ error: 'Upload could not be processed.' });
    });
  };
}

// ---------------------------------------------------------------------------
//  File persistence to disk (random name, keep every version)
// ---------------------------------------------------------------------------
async function storeFilesOnDisk(files, prefix, user, startingVersions = {}) {
  const stored = {};
  const paths = [];

  for (const [slotKey, fileList] of Object.entries(files)) {
    const file = fileList?.[0];
    if (!file) continue;

    // Validate extension + MIME for this slot.
    const allowedExts = slotFileExtensions(slotKey);
    if (!allowedExts) {
      const error = new Error(`File slot "${slotKey}" is not allowed for this submission.`);
      error.code = 'INVALID_SLOT';
      throw error;
    }
    const ext = extname(file.originalname || '').toLowerCase();
    if (!allowedExts.has(ext)) {
      const error = new Error(`"${file.originalname}" must be a ${Array.from(allowedExts).join(' or ')} file.`);
      error.code = 'INVALID_EXTENSION';
      throw error;
    }
    if (!isAllowedSubmissionFile(file)) {
      const error = new Error(`"${file.originalname}" is not a valid document file.`);
      error.code = 'INVALID_CONTENT';
      throw error;
    }

    // Version = the highest version this slot already has + 1. A slot keeps
    // every upload: an older version is never overwritten or removed.
    const version = (startingVersions[slotKey] || 0) + 1;
    const storedPath = `${prefix}/${randomUUID()}${ext}`;
    const absolutePath = join(UPLOAD_DIR, storedPath);
    await mkdir(dirname(absolutePath), { recursive: true }).catch(() => {});
    await writeFile(absolutePath, file.buffer);
    paths.push(absolutePath);

    stored[slotKey] = {
      id: randomUUID(),
      slot_key: slotKey,
      original_name: file.originalname || 'document',
      stored_path: storedPath,
      mime: file.mimetype || 'application/octet-stream',
      size: file.size,
      version,
      uploaded_by: user.id,
      uploaded_by_name: user.fullName || user.username,
      uploaded_at: new Date().toISOString()
    };
    startingVersions[slotKey] = version;
  }

  return { stored, paths };
}

async function clearFiles(paths) {
  for (const p of paths) {
    try { await rm(p, { force: true }); } catch {}
  }
}

// ---------------------------------------------------------------------------
//  Router
// ---------------------------------------------------------------------------
const router = Router();

// ---------------------------------------------------------------------------
//  GET /api/research-submissions/me
//  Shared "who am I" for the submission module. Returns { id, name, role }.
//  (This is the module's answer to the spec's /api/me for this feature.)
// ---------------------------------------------------------------------------
router.get('/me', requireAuth, async (req, res) => {
  const user = await callerUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });
  res.json({
    id: user.id,
    name: user.fullName || user.username,
    role: user.role
  });
});

// ---------------------------------------------------------------------------
//  GET /api/research-submissions/form-config
//  Returns fields + file slots for the caller's role and stage ONLY.
//  The front end renders the form from this — the user never picks their role.
// ---------------------------------------------------------------------------
router.get('/form-config', requireAuth, async (req, res) => {
  const user = await callerUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });

  const role = user.role;
  const config = FORM_CONFIG[role];
  if (!config) {
    return res.status(403).json({ error: 'Your account type cannot submit research through this module.' });
  }

  // Decide which stage(s) the caller can see. Presenters see no Initial tab.
  const result = {
    role,
    roleLabel: user.role,
    stages: []
  };

  if (HAS_INITIAL_STAGE.has(role)) {
    result.stages.push({
      stage: 'initial',
      stageLabel: 'Initial Submission',
      fields: config.initial.fields.map(f => ({ ...f })),
      slots: config.initial.slots.map(describeSlot)
    });
  }
  if (HAS_FINAL_STAGE.has(role)) {
    result.stages.push({
      stage: 'final',
      stageLabel: 'Final Submission',
      fields: config.final.fields.map(f => ({ ...f })),
      slots: config.final.slots.map(describeSlot)
    });
  }

  // The flags a conditional slot depends on, so the page can render the
  // controls instead of hard-coding them.
  result.conditionalFlags = CONDITIONAL_FLAGS.map(f => ({ ...f }));

  res.json(result);
});

// ---------------------------------------------------------------------------
//  POST /api/research-submissions
//  Create (draft or submitted). Validates required fields + required slots
//  for the caller's role+stage. Rejects slots not allowed for that role.
// ---------------------------------------------------------------------------
router.post(
  '/',
  requireRoles(...SUBMITTER_ROLES),
  handleUploadErrors(
    createUploadMiddleware({
      allowedSlots: new Set(
        Object.values(FORM_CONFIG)
          .flatMap(c => Object.values(c).flatMap(s => s.slots.map(sl => sl.slot_key)))
      )
    })
  ),
  async (req, res) => {
    const user = req._user;
    const role = user.role;
    const body = req.body || {};

    // Ignore any role/owner_id/status the client sent; use session only.
    const requestedStage = body.stage;
    if (!requestedStage) {
      return res.status(400).json({ error: 'A stage (initial or final) is required.' });
    }
    if (!STAGES.has(requestedStage)) {
      return res.status(400).json({ error: 'Invalid stage.' });
    }
    // Presenters cannot create initial submissions.
    if (requestedStage === 'initial' && role === 'presenter') {
      return res.status(403).json({ error: 'Presenters cannot create initial submissions.' });
    }
    // A role that doesn't have this stage cannot create it.
    if (!FORM_CONFIG[role] || !FORM_CONFIG[role][requestedStage]) {
      return res.status(403).json({ error: 'Your account type cannot create a submission at this stage.' });
    }

    const config = FORM_CONFIG[role][requestedStage];

    // "Save as draft" stores an incomplete record: the owner finishes it
    // later. Everything else (slots that exist, file types, size) still
    // applies, and the completeness rules are enforced when the draft is
    // submitted for review.
    const asDraft = isTruthyFlag(body.as_draft);

    // Reject any file slot not allowed for this role+stage.
    if (req.files) {
      const allowedKeys = new Set(config.slots.map(s => s.slot_key));
      for (const key of Object.keys(req.files)) {
        if (!allowedKeys.has(key)) {
          return res.status(400).json({ error: `File slot "${key}" is not allowed for this submission.` });
        }
      }
    }

    if (!asDraft) {
      // ONE completeness check, shared with "submit an existing draft".
      const haveFiles = new Set(
        Object.entries(req.files || {})
          .filter(([, list]) => list && list.length)
          .map(([key]) => key)
      );
      const problem = missingRequirements({
        role, stage: requestedStage, data: body, haveFiles
      })[0];
      if (problem) return res.status(400).json(problem);
    }

    // Build the submission record. Ignore client owner_id / status.
    const now = new Date().toISOString();
    const stageDefaults = {
      initial: { stage: 'initial', status: asDraft ? 'draft' : 'submitted' },
      final:   { stage: 'final',   status: asDraft ? 'draft' : 'submitted' }
    };

    const sub = {
      id: randomUUID(),
      owner_id: user.id,
      owner_name: user.fullName || user.username,
      owner_role: role,
      stage: requestedStage,
      title:            String(body.title || '').trim(),
      authors:          String(body.authors || '').trim(),
      program:          String(body.program || '').trim(),
      institution:      String(body.institution || '').trim(),
      nationality:      String(body.nationality || '').trim(),
      category:         String(body.category || '').trim(),
      research_type:    String(body.research_type || '').trim(),
      school_year:      String(body.school_year || '').trim(),
      semester:         String(body.semester || '').trim(),
      adviser_id:       body.adviser ? String(body.adviser).trim() : null,
      facilitator_id:   body.facilitator ? String(body.facilitator).trim() : null,
      abstract:         requestedStage === 'final' ? String(body.abstract || '').trim() : '',
      keywords:         requestedStage === 'final' ? String(body.keywords || '').trim() : '',
      status:           stageDefaults[requestedStage].status,
      created_at:       now,
      updated_at:       now
    };

  let storedFiles = {};
  let filePaths = [];
  try {
    ({ stored: storedFiles, paths: filePaths } = await storeFilesOnDisk(
      req.files || {},
      // Forward slashes on every platform: stored_path is persisted and read
      // back with join(UPLOAD_DIR, stored_path), which handles both.
      `research-submissions/${sub.id}/files`,
      user
    ));
  } catch (err) {
    if (err.code === 'INVALID_SLOT') {
      return res.status(400).json({ error: err.message });
    }
    if (err.code === 'INVALID_EXTENSION' || err.code === 'INVALID_CONTENT') {
      return res.status(400).json({ error: err.message });
    }
    console.error('[research-submissions] file storage failed:', err.message);
    return res.status(500).json({ error: 'Could not save uploaded files. Please try again.' });
  }

    try {
      await insert('research_submissions', sub);
      // Insert file rows.
      for (const file of Object.values(storedFiles)) {
        await insert('research_submission_files', { ...file, submission_id: sub.id });
      }
      // Initial status history entry.
      await insert('research_status_history', {
        id: randomUUID(),
        submission_id: sub.id,
        from_status: null,
        to_status: sub.status,
        changed_by: user.id,
        changed_at: now
      });
    } catch (err) {
      await clearFiles(filePaths);
      console.error('[research-submissions] could not persist submission:', err.message);
      return res.status(500).json({ error: 'Could not save your submission. Please try again.' });
    }

    // In-app notification (console-based since no mail/SMS wiring here yet).
    console.log(`[research-submissions] new submission ${sub.id} by ${user.fullName || user.username} (${role}) stage=${requestedStage} status=${sub.status}`);

  // Tell the people who now have to look at it: CPRI staff review every
  // submission, and a student's adviser/facilitator see what is assigned to
  // them (only when the submission actually names them).
  const reviewers = await all("SELECT id FROM users WHERE role IN ('cpri_staff','admin') AND status = 'active'").catch(() => []);
  const watchers = new Set(reviewers.map(r => r.id));
  // The adviser/facilitator fields are typed by the student, so they may hold a
  // user id, a username or a full name. Only an exact, single match becomes a
  // watcher — a guess would notify the wrong person.
  for (const [column, role] of [['adviser_id', 'adviser'], ['facilitator_id', 'facilitator']]) {
    const typed = String(sub[column] || '').trim();
    if (!typed) continue;
    const matches = await all(
      'SELECT id FROM users WHERE role = ? AND status = ? AND (id = ? OR username = ? OR fullName = ?)',
      [role, 'active', typed, typed, typed]
    ).catch(() => []);
    if (matches.length === 1) watchers.add(matches[0].id);
  }
  for (const watcherId of watchers) {
    if (watcherId === user.id) continue;
    await notifyPerson(watcherId, {
      action: 'research_submission_new',
      title: requestedStage === 'initial' ? 'New initial submission' : 'New final submission',
      message: `${sub.owner_name} submitted "${sub.title || 'a research record'}"`,
      link: `/research-submission-detail.html?id=${sub.id}`
    });
  }

    res.status(201).json({
      message: asDraft
        ? 'Draft saved. Complete it and submit when you are ready.'
        : `${requestedStage === 'initial' ? 'Initial' : 'Final'} submission created.`,
      submission: sub,
      files: storedFiles
    });
  }
);

// ---------------------------------------------------------------------------
//  GET /api/research-submissions
//  Caller's own (researcher) OR assigned (adviser/facilitator) OR all (staff/admin).
// ---------------------------------------------------------------------------
router.get('/', requireAuth, async (req, res) => {
  const user = await callerUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });

  let rows;
  if (RESEARCHER_ROLES.has(user.role)) {
    rows = await all(
      'SELECT * FROM research_submissions WHERE owner_id = ? ORDER BY created_at DESC',
      [user.id]
    );
  } else if (ASSIGNED_ROLES.has(user.role)) {
    const col = user.role === 'adviser' ? 'adviser_id' : 'facilitator_id';
    rows = await all(
      `SELECT * FROM research_submissions WHERE ${col} = ? ORDER BY created_at DESC`,
      [user.id]
    );
  } else if (user.role === 'cpri_staff' || user.role === 'admin') {
    rows = await all('SELECT * FROM research_submissions ORDER BY created_at DESC');
  } else {
    return res.status(403).json({ error: 'Access denied.' });
  }

  const payload = {
    submissions: rows.map(s => ({
      id: s.id,
      stage: s.stage,
      title: s.title,
      authors: s.authors,
      program: s.program,
      category: s.category,
      research_type: s.research_type,
      status: s.status,
      statusLabel: statusLabelFor(s.status, s.stage),
      created_at: s.created_at,
      updated_at: s.updated_at,
      isOwner: s.owner_id === user.id
    }))
  };

  res.json(payload);
});

// ---------------------------------------------------------------------------
//  GET /api/research-submissions/:id/form-config
//
//  The upload form for ONE submission: the slots its own stage + owner role
//  allow, each tagged Required / Conditional / Optional, plus whether the
//  caller may still change anything. The detail page renders its resubmission
//  control from this, so no page ever hard-codes a slot list and the shared
//  config stays the single source of truth.
// ---------------------------------------------------------------------------
router.get('/:id/form-config', requireAuth, async (req, res) => {
  const user = await callerUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });

  const sub = await get('SELECT * FROM research_submissions WHERE id = ?', [req.params.id]);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  if (!canReadSubmission(user, sub)) return res.status(403).json({ error: 'You don\'t have access to this submission.' });

  const config = FORM_CONFIG[sub.owner_role]?.[sub.stage];
  if (!config) return res.status(400).json({ error: 'This submission has no form configuration.' });

  // Only the owner can change a submission, and only while Submitted or For
  // revision. Reviewers and staff read, comment and move the status instead —
  // the same rule POST /:id/files enforces (they have no slot list of their
  // own, so every slot would be refused anyway).
  const editable = user.id === sub.owner_id && canWriteSubmission(user, sub);

  res.json({
    submissionId: sub.id,
    stage: sub.stage,
    ownerRole: sub.owner_role,
    editable,
    canUpload: editable,
    slots: config.slots.map(describeSlot)
  });
});

// ---------------------------------------------------------------------------
//  GET /api/research-submissions/:id
//  Authorized read with full detail.
// ---------------------------------------------------------------------------
router.get('/:id', requireAuth, async (req, res) => {
  const user = await callerUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });

  const sub = await get('SELECT * FROM research_submissions WHERE id = ?', [req.params.id]);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  if (!canReadSubmission(user, sub)) return res.status(403).json({ error: 'You don\'t have access to this submission.' });

  const files = await all(
    'SELECT * FROM research_submission_files WHERE submission_id = ? ORDER BY slot_key, version DESC',
    [sub.id]
  );

  const comments = await all(
    'SELECT * FROM research_comments WHERE submission_id = ? ORDER BY created_at ASC',
    [sub.id]
  );

  const versions = groupFilesByVersion(files);

  const statusHistory = await all(
    'SELECT * FROM research_status_history WHERE submission_id = ? ORDER BY changed_at ASC',
    [sub.id]
  );

  res.json({
    submission: {
      ...sub,
      statusLabel: statusLabelFor(sub.status, sub.stage),
      files,
      comments,
      versions,
      statusHistory
    }
  });
});

// ---------------------------------------------------------------------------
//  PUT /api/research-submissions/:id
//  Edit only while Submitted or For revision. Ignores client role/owner_id/status.
// ---------------------------------------------------------------------------
router.put('/:id', requireAuth, async (req, res) => {
  const user = await callerUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });

  const sub = await get('SELECT * FROM research_submissions WHERE id = ?', [req.params.id]);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  if (!canWriteSubmission(user, sub)) return res.status(403).json({ error: 'You don\'t have access to this submission.' });

  const body = req.body || {};

  // Build allowed updates from the stage's field list. Ignore client-supplied
  // role / owner_id / status.
  const config = FORM_CONFIG[user.role]?.[sub.stage];
  if (!config) return res.status(403).json({ error: 'Your account type cannot edit submissions at this stage.' });

  const allowedKeys = new Set(config.fields.map(f => f.key).map(k => toColumn(k)));
  const updates = {};

  for (const [key, value] of Object.entries(body)) {
    if (!allowedKeys.has(key)) continue; // ignore unsupported / client-injected fields
    updates[key] = value == null ? null : String(value).trim();
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid changes to save.' });
  }

  updates.updated_at = new Date().toISOString();

  try {
    await update('research_submissions', sub.id, updates);
  } catch (err) {
    console.error('[research-submissions] update failed:', err.message);
    return res.status(500).json({ error: 'Could not save your changes. Please try again.' });
  }

  const updated = await get('SELECT * FROM research_submissions WHERE id = ?', [sub.id]);
  res.json({
    message: 'Submission updated.',
    submission: updated
  });
});

// ---------------------------------------------------------------------------
//  POST /api/research-submissions/:id/files
//  Upload to a slot. Creates a new version. Validates slot + extension + MIME.
//  Faculty cannot upload student-only forms (A, B, D, E, F, G, I).
// ---------------------------------------------------------------------------
router.post(
  '/:id/files',
  requireAuth,
  handleUploadErrors(
    createUploadMiddleware({
      allowedSlots: new Set(
        Object.values(FORM_CONFIG)
          .flatMap(c => Object.values(c).flatMap(s => s.slots.map(sl => sl.slot_key)))
      )
    })
  ),
  async (req, res) => {
    const user = await callerUser(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated.' });

    const sub = await get('SELECT * FROM research_submissions WHERE id = ?', [req.params.id]);
    if (!sub) return res.status(404).json({ error: 'Submission not found.' });
    if (!canWriteSubmission(user, sub)) return res.status(403).json({ error: 'You don\'t have access to this submission.' });

    const role = user.role;
    const slotKey = Object.keys(req.files || {}).find(k => req.files[k]?.[0]);
    if (!slotKey) return res.status(400).json({ error: 'No file was uploaded.' });

    // The slot must be one the module knows at all.
    if (!ALL_SLOT_KEYS.has(slotKey)) {
      return res.status(400).json({ error: `File slot "${slotKey}" is not part of this module.` });
    }

    // ...and one this caller's role is allowed to fill at this stage. Faculty
    // (including non-teaching) can never upload the student-only forms.
    const stageConfig = FORM_CONFIG[role]?.[sub.stage];
    const slotAllowedForRole = Boolean(
      stageConfig && stageConfig.slots.some(s => s.slot_key === slotKey)
    );
    if (!slotAllowedForRole) {
      if (isFacultyRole(role) && STUDENT_ONLY_SLOTS.has(slotKey)) {
        return res.status(403).json({ error: 'Your account type cannot upload this form.' });
      }
      return res.status(403).json({ error: `The "${slotKey}" slot is not part of your submission form.` });
    }

    const file = req.files[slotKey][0];

    // Validate slot + extension + MIME.
    const allowedExts = slotFileExtensions(slotKey);
    if (!allowedExts) {
      return res.status(400).json({ error: `File slot "${slotKey}" is not allowed for this submission.` });
    }
    const ext = extname(file.originalname || '').toLowerCase();
    if (!allowedExts.has(ext)) {
      return res.status(400).json({ error: `"${file.originalname}" must be a ${Array.from(allowedExts).join(' or ')} file.` });
    }
    if (!isAllowedSubmissionFile(file)) {
      return res.status(400).json({ error: `"${file.originalname}" is not a valid document file.` });
    }

    // Version = the highest version this slot already has + 1. Computed from
    // the rows rather than from row order, so it cannot depend on how the
    // database happens to return them. Every older version is kept.
    const existingFiles = await all(
      'SELECT version FROM research_submission_files WHERE submission_id = ? AND slot_key = ?',
      [sub.id, slotKey]
    );
    const nextVersion = existingFiles.reduce((max, f) => Math.max(max, f.version || 0), 0) + 1;

    const storedPath = `research-submissions/${sub.id}/files/${randomUUID()}${ext}`;
    const absolutePath = join(UPLOAD_DIR, storedPath);
    await mkdir(dirname(absolutePath), { recursive: true }).catch(() => {});
    await writeFile(absolutePath, file.buffer);

    const fileRow = {
      id: randomUUID(),
      submission_id: sub.id,
      slot_key: slotKey,
      original_name: file.originalname || 'document',
      stored_path: storedPath,
      mime: file.mimetype || 'application/octet-stream',
      size: file.size,
      version: nextVersion,
      uploaded_by: user.id,
      uploaded_by_name: user.fullName || user.username,
      uploaded_at: new Date().toISOString()
    };

    try {
      await insert('research_submission_files', fileRow);
    } catch (err) {
      await rm(absolutePath, { force: true }).catch(() => {});
      console.error('[research-submissions] file insert failed:', err.message);
      return res.status(500).json({ error: 'Could not save the file. Please try again.' });
    }

    res.status(201).json({
      message: `File uploaded to ${slotKey} (version ${nextVersion}).`,
      file: fileRow
    });
  }
);

// ---------------------------------------------------------------------------
//  GET /api/research-submissions/:id/files/:fileId
//  Authorized download. Served from disk (application/octet-stream), never a
//  public folder, never inline.
// ---------------------------------------------------------------------------
router.get('/:id/files/:fileId', requireAuth, async (req, res) => {
  const user = await callerUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });

  const sub = await get('SELECT * FROM research_submissions WHERE id = ?', [req.params.id]);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  if (!canReadSubmission(user, sub)) return res.status(403).json({ error: 'You don\'t have access to this submission.' });

  const file = await get('SELECT * FROM research_submission_files WHERE id = ? AND submission_id = ?', [req.params.fileId, sub.id]);
  if (!file) return res.status(404).json({ error: 'File not found.' });

  // Stream from disk.
  const filePath = join(UPLOAD_DIR, file.stored_path);
  try {
    await stat(filePath);
  } catch (err) {
    return res.status(404).json({ error: 'File is no longer available.' });
  }

  res.setHeader('Content-Type', file.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURI(file.original_name || 'document')}"`);
  const stream = createReadStream(filePath);
  stream.pipe(res);
  stream.on('error', (err) => {
    if (!res.headersSent) res.status(500).json({ error: 'Could not stream the file.' });
    console.error('[research-submissions] file stream error:', err.message);
  });
});

// ---------------------------------------------------------------------------
//  GET /api/research-submissions/:id/versions
//  Version history: version, date, uploader, files per version.
// ---------------------------------------------------------------------------
router.get('/:id/versions', requireAuth, async (req, res) => {
  const user = await callerUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });

  const sub = await get('SELECT * FROM research_submissions WHERE id = ?', [req.params.id]);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  if (!canReadSubmission(user, sub)) return res.status(403).json({ error: 'You don\'t have access to this submission.' });

  const files = await all(
    'SELECT * FROM research_submission_files WHERE submission_id = ? ORDER BY version ASC, uploaded_at ASC',
    [sub.id]
  );

  const versions = groupFilesByVersion(files);
  res.json({ versions });
});

// ---------------------------------------------------------------------------
//  GET /api/research-submissions/:id/compare?a=&b=
//  Admin only. Returns two versions side by side for comparison.
// ---------------------------------------------------------------------------
router.get('/:id/compare', requireRoles('admin'), async (req, res) => {
  const versionA = String(req.query.a || '1');
  const versionB = String(req.query.b || '');

  const sub = await get('SELECT * FROM research_submissions WHERE id = ?', [req.params.id]);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });

  const files = await all(
    'SELECT * FROM research_submission_files WHERE submission_id = ? ORDER BY version ASC, uploaded_at ASC',
    [sub.id]
  );

  const versions = groupFilesByVersion(files);
  const vA = versions.find(v => String(v.version) === versionA);
  const vB = versionB ? versions.find(v => String(v.version) === versionB) : null;

  if (!vA) return res.status(404).json({ error: 'Version A not found.' });
  if (versionB && !vB) return res.status(404).json({ error: 'Version B not found.' });

  res.json({
    submissionId: sub.id,
    title: sub.title,
    comparing: { a: versionA, b: versionB },
    versionA: vA,
    versionB: vB
  });
});

// ---------------------------------------------------------------------------
//  POST /api/research-submissions/:id/comments
//  Comment/feedback thread. Staff, adviser, reviewer, and the researcher can
//  reply. Author role comes from the session, not the client.
// ---------------------------------------------------------------------------
router.post('/:id/comments', requireAuth, async (req, res) => {
  const user = await callerUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });

  const sub = await get('SELECT * FROM research_submissions WHERE id = ?', [req.params.id]);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  if (!canReadSubmission(user, sub)) return res.status(403).json({ error: 'You don\'t have access to this submission.' });

  const body = String(req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Comment text is required.' });

  // Anyone with read access + staff/reviewer/adviser OR the owner can comment.
  const mayComment =
    user.role === 'cpri_staff' || user.role === 'admin' ||
    user.role === 'ethics_reviewer' ||
    (user.role === 'adviser' && sub.adviser_id === user.id) ||
    (user.role === 'facilitator' && sub.facilitator_id === user.id) ||
    sub.owner_id === user.id;

  if (!mayComment) return res.status(403).json({ error: 'You are not allowed to comment on this submission.' });

  // Infer comment type from the commenter's role.
  let commentType = 'comment';
  if (user.role === 'adviser' || user.role === 'facilitator') commentType = 'feedback';
  else if (user.role === 'ethics_reviewer') commentType = 'revision_suggestion';
  else if (RESEARCHER_ROLES.has(user.role) && sub.owner_id === user.id) commentType = 'response';

  const comment = {
    id: randomUUID(),
    submission_id: sub.id,
    author_id: user.id,
    author_name: user.fullName || user.username,
    author_role: user.role,
    comment_type: commentType,
    body,
    parent_id: req.body?.parent_id || null,
    created_at: new Date().toISOString()
  };

  try {
    await insert('research_comments', comment);
  } catch (err) {
    console.error('[research-submissions] comment insert failed:', err.message);
    return res.status(500).json({ error: 'Could not post the comment. Please try again.' });
  }

  // Tell the owner about feedback, unless they wrote it.
  if (sub.owner_id !== user.id) {
    await notifyPerson(sub.owner_id, {
      action: 'research_submission_comment',
      title: 'New comment on your submission',
      message: `${comment.author_name} (${comment.comment_type}) commented on "${sub.title || 'your research submission'}".`,
      link: `/research-submission-detail.html?id=${sub.id}`
    });
  }

  res.status(201).json({ message: 'Comment posted.', comment });
});

// ---------------------------------------------------------------------------
//  PATCH /api/research-submissions/:id/status
//  Reviewers and staff only. Valid transitions only. Writes status_history.
//  Ignores client role / owner_id / status.
// ---------------------------------------------------------------------------
router.patch('/:id/status', requireAuth, async (req, res) => {
  const user = await callerUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });

  const sub = await get('SELECT * FROM research_submissions WHERE id = ?', [req.params.id]);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });

  const targetStatusEarly = String(req.body?.status || '').trim();

  // Two ways in: a reviewer/staff moves a submission along, or the owner hands
  // in their own draft. Nobody else may change a status at all.
  const ownerHandsInDraft = sub.owner_id === user.id
    && sub.status === 'draft'
    && targetStatusEarly === 'submitted';
  if (!ownerHandsInDraft && !REVIEWER_ROLES.has(user.role)) {
    return res.status(403).json({ error: 'Only the owner of a draft, a reviewer, or CPRI staff can change a status.' });
  }

  if (ownerHandsInDraft) {
    // The draft becomes a real submission, so it must now be complete.
    const storedFiles = await all(
      'SELECT slot_key FROM research_submission_files WHERE submission_id = ?', [sub.id]
    );
    const problem = missingRequirements({
      role: sub.owner_role,
      stage: sub.stage,
      data: sub,
      haveFiles: new Set(storedFiles.map(f => f.slot_key))
    })[0];
    if (problem) return res.status(400).json({ ...problem, draftIncomplete: true });
  }

  // Ethics reviewer can only act on "Under ethics review".
  if (user.role === 'ethics_reviewer' && sub.status !== 'under_ethics_review') {
    return res.status(403).json({ error: 'Only submissions under ethics review can be acted on by an ethics reviewer.' });
  }

  // Adviser/facilitator can only move submissions assigned to them.
  if (user.role === 'adviser' && sub.adviser_id !== user.id) {
    return res.status(403).json({ error: 'This submission is not assigned to you.' });
  }
  if (user.role === 'facilitator' && sub.facilitator_id !== user.id) {
    return res.status(403).json({ error: 'This submission is not assigned to you.' });
  }

  const targetStatus = targetStatusEarly;
  if (!targetStatus) return res.status(400).json({ error: 'A status is required.' });

  // Validate transition. Faculty initial work goes straight to ethics review,
  // so the allowed table depends on the researcher's role as well as the stage.
  const allowed = validTransitionsFor(sub.stage, sub.owner_role);
  // If it's not in allowed, reject.
  if (!allowed[targetStatus]) {
    return res.status(400).json({ error: `Cannot move to "${targetStatus}".` });
  }
  // "toStatus" must be achievable from current status.
  const targetTransitions = allowed[sub.status];
  if (!targetTransitions || !targetTransitions.includes(targetStatus)) {
    return res.status(400).json({ error: `Cannot move from "${sub.status}" to "${targetStatus}".` });
  }

  // An initial submission is only approved once the ethics decision has been
  // recorded. Approving it here would attach no Ethics Clearance, which is the
  // one thing the workflow guarantees. (The ethics route itself sets the
  // status after inserting the clearance, so it does not come through here.)
  if (sub.stage === 'initial' && targetStatus === 'approved') {
    const clearance = await get(
      'SELECT id FROM research_ethics_clearances WHERE submission_id = ? AND decision = ?',
      [sub.id, 'approved']
    );
    if (!clearance) {
      return res.status(400).json({
        error: 'An initial submission can only be approved after the ethics decision (POST /:id/ethics).'
      });
    }
  }

  const note = String(req.body?.note || '').trim();

  const now = new Date().toISOString();
  const fromStatus = sub.status;

  try {
    await update('research_submissions', sub.id, {
      status: targetStatus,
      updated_at: now
    });
    await insert('research_status_history', {
      id: randomUUID(),
      submission_id: sub.id,
      from_status: fromStatus,
      to_status: targetStatus,
      changed_by: user.id,
      changed_by_name: user.fullName || user.username,
      note,
      changed_at: now
    });
  } catch (err) {
    console.error('[research-submissions] status update failed:', err.message);
    return res.status(500).json({ error: 'Could not update the status. Please try again.' });
  }

  console.log(`[research-submissions] status ${sub.id}: ${fromStatus} -> ${targetStatus} by ${user.fullName || user.username}`);

  // Tell the owner, unless they made the change themselves (handing in a draft).
  if (sub.owner_id !== user.id) {
    await notifyPerson(sub.owner_id, {
      action: 'research_submission_status',
      title: 'Your submission was updated',
      message: `"${sub.title || 'Your research submission'}" is now ${statusLabelFor(targetStatus, sub.stage)}.`,
      link: `/research-submission-detail.html?id=${sub.id}`
    });
  }

  const updated = await get('SELECT * FROM research_submissions WHERE id = ?', [sub.id]);
  res.json({
    message: `Status updated to "${statusLabelFor(targetStatus, sub.stage)}".`,
    submission: updated
  });
});

// ---------------------------------------------------------------------------
//  Multer single-file upload for /:id/ethics (optional PDF).
// ---------------------------------------------------------------------------
const ethicsUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: FILE_MIME_LIMIT, files: 1 }
}).single('ethics_clearance');

// One route only: ethics_reviewer gate -> multer parse -> decision. Upload
// failures come back as 400 JSON instead of a 500 from the error middleware.
router.post(
  '/:id/ethics',
  requireRoles('ethics_reviewer'),
  handleUploadErrors(ethicsUpload),
  async (req, res) => {
  const user = await callerUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });

  const sub = await get('SELECT * FROM research_submissions WHERE id = ?', [req.params.id]);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  if (sub.status !== 'under_ethics_review') {
    return res.status(403).json({ error: 'Only submissions under ethics review can be acted on here.' });
  }

  const decision = String(req.body?.decision || '').trim();
  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: 'Decision must be "approved" or "rejected".' });
  }

  let clearancePath = null;
  let clearanceName = null;
  if (req.file) {
    const ext = extname(req.file.originalname || '').toLowerCase();
    if (!PDF_EXTENSIONS.has(ext)) {
      return res.status(400).json({ error: 'The ethics clearance file must be a PDF.' });
    }
    clearancePath = `research-submissions/${sub.id}/ethics-clearance-${randomUUID()}${ext}`;
    await mkdir(join(UPLOAD_DIR, `research-submissions/${sub.id}`), { recursive: true }).catch(() => {});
    await writeFile(join(UPLOAD_DIR, clearancePath), req.file.buffer);
    clearanceName = req.file.originalname || 'ethics-clearance.pdf';
  }

  const now = new Date().toISOString();
  try {
    await insert('research_ethics_clearances', {
      id: randomUUID(),
      submission_id: sub.id,
      reviewer_id: user.id,
      reviewer_name: user.fullName || user.username,
      decision,
      file_path: clearancePath,
      file_name: clearanceName,
      decided_at: now
    });
    const targetStatus = decision === 'approved' ? 'approved' : 'rejected';
    await update('research_submissions', sub.id, { status: targetStatus, updated_at: now });
    await insert('research_status_history', {
      id: randomUUID(),
      submission_id: sub.id,
      from_status: 'under_ethics_review',
      to_status: targetStatus,
      changed_by: user.id,
      changed_by_name: user.fullName || user.username,
      note: 'Ethics ' + (decision === 'approved' ? 'approved' : 'rejected') + (clearanceName ? ' (clearance attached)' : ''),
      changed_at: now
    });
  } catch (err) {
    if (clearancePath) {
      try { await rm(join(UPLOAD_DIR, clearancePath), { force: true }); } catch {}
    }
    console.error('[research-submissions] ethics decision failed:', err.message);
    return res.status(500).json({ error: 'Could not record the ethics decision. Please try again.' });
  }

  await notifyPerson(sub.owner_id, {
    action: 'research_submission_ethics',
    title: decision === 'approved' ? 'Your submission was approved' : 'Your submission was rejected',
    message: `The ethics reviewer ${decision} "${sub.title || 'your research submission'}"${clearanceName ? ' and attached the Ethics Clearance' : ''}.`,
    link: `/research-submission-detail.html?id=${sub.id}`
  });

  res.json({
    message: `Ethics ${decision === 'approved' ? 'approved' : 'rejected'}.`,
    submission: await get('SELECT * FROM research_submissions WHERE id = ?', [sub.id])
  });
});

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------
function statusLabelFor(status, stage) {
  if (stage === 'initial') {
    return INITIAL_STATUSES.find(s => s.value === status)?.label || status;
  }
  return FINAL_STATUSES.find(s => s.value === status)?.label || status;
}

function toColumn(fieldKey) {
  const map = {
    title: 'title',
    authors: 'authors',
    program: 'program',
    institution: 'institution',
    nationality: 'nationality',
    category: 'category',
    research_type: 'research_type',
    school_year: 'school_year',
    semester: 'semester',
    abstract: 'abstract',
    keywords: 'keywords'
  };
  return map[fieldKey] || fieldKey;
}

function groupFilesByVersion(files) {
  const groups = new Map();
  for (const f of files) {
    if (!groups.has(f.version)) groups.set(f.version, []);
    groups.get(f.version).push(f);
  }
  return Array.from(groups.entries())
    .map(([version, files]) => ({
      version,
      date: files[0].uploaded_at,
      uploader: files[0].uploaded_by_name || files[0].uploaded_by,
      files
    }))
    .sort((a, b) => a.version - b.version);
}

  return router;
}

// ---------------------------------------------------------------------------
//  The instance the app mounts at /api/research-submissions.
// ---------------------------------------------------------------------------
const router = createResearchSubmissionsRouter();

// ---------------------------------------------------------------------------
//  ensureResearchSubmissionsSchema()
//
//  Self-applying, additive DDL — the project's convention (see
//  db/migrations/README.md): every table is created with IF NOT EXISTS, so
//  running on every boot is safe and an older deployment catches up on its
//  own. The hand-written mirror of this DDL lives in
//  db/migrations/005_research_submissions.sql.
// ---------------------------------------------------------------------------
export async function ensureResearchSubmissionsSchema(dependencies = {}) {
  const runQuery = dependencies.run || (await import('./server/db/queries.js')).run;

  await runQuery(`
    CREATE TABLE IF NOT EXISTS research_submissions (
      id              VARCHAR(36) NOT NULL,
      owner_id        VARCHAR(36) NOT NULL,
      owner_name      VARCHAR(160) NOT NULL DEFAULT '',
      owner_role      VARCHAR(40) NOT NULL DEFAULT '',
      stage           VARCHAR(20) NOT NULL DEFAULT 'initial',
      title           VARCHAR(255) NOT NULL DEFAULT '',
      authors         VARCHAR(255) NOT NULL DEFAULT '',
      program         VARCHAR(180) NOT NULL DEFAULT '',
      institution     VARCHAR(180) NOT NULL DEFAULT '',
      nationality     VARCHAR(80) NOT NULL DEFAULT '',
      category        VARCHAR(120) NOT NULL DEFAULT '',
      research_type   VARCHAR(120) NOT NULL DEFAULT '',
      school_year     VARCHAR(40) NOT NULL DEFAULT '',
      semester        VARCHAR(40) NOT NULL DEFAULT '',
      adviser_id      VARCHAR(36) DEFAULT NULL,
      facilitator_id  VARCHAR(36) DEFAULT NULL,
      abstract        TEXT DEFAULT NULL,
      keywords        VARCHAR(255) DEFAULT NULL,
      status          VARCHAR(40) NOT NULL DEFAULT 'submitted',
      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_research_owner (owner_id),
      KEY idx_research_status (status),
      KEY idx_research_stage (stage)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS research_submission_files (
      id               VARCHAR(36) NOT NULL,
      submission_id    VARCHAR(36) NOT NULL,
      slot_key         VARCHAR(80) NOT NULL,
      original_name    VARCHAR(255) NOT NULL DEFAULT '',
      stored_path      VARCHAR(512) NOT NULL,
      mime             VARCHAR(120) NOT NULL DEFAULT 'application/octet-stream',
      size             BIGINT NOT NULL DEFAULT 0,
      version          INT NOT NULL DEFAULT 1,
      uploaded_by      VARCHAR(36) NOT NULL,
      uploaded_by_name VARCHAR(160) NOT NULL DEFAULT '',
      uploaded_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_research_file_submission (submission_id),
      KEY idx_research_file_slot (submission_id, slot_key, version)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS research_comments (
      id            VARCHAR(36) NOT NULL,
      submission_id VARCHAR(36) NOT NULL,
      author_id     VARCHAR(36) NOT NULL,
      author_name   VARCHAR(160) NOT NULL DEFAULT '',
      author_role   VARCHAR(40) NOT NULL DEFAULT '',
      comment_type  VARCHAR(40) NOT NULL DEFAULT 'comment',
      body          TEXT NOT NULL,
      parent_id     VARCHAR(36) DEFAULT NULL,
      created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_research_comment_submission (submission_id),
      KEY idx_research_comment_parent (parent_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS research_status_history (
      id              VARCHAR(36) NOT NULL,
      submission_id   VARCHAR(36) NOT NULL,
      from_status     VARCHAR(40) DEFAULT NULL,
      to_status       VARCHAR(40) NOT NULL,
      changed_by      VARCHAR(36) NOT NULL,
      changed_by_name VARCHAR(160) NOT NULL DEFAULT '',
      note            VARCHAR(500) DEFAULT NULL,
      changed_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_research_history_submission (submission_id),
      KEY idx_research_history_changed_by (changed_by)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS research_ethics_clearances (
      id            VARCHAR(36) NOT NULL,
      submission_id VARCHAR(36) NOT NULL,
      reviewer_id   VARCHAR(36) NOT NULL,
      reviewer_name VARCHAR(160) NOT NULL DEFAULT '',
      decision      VARCHAR(20) NOT NULL,
      file_path     VARCHAR(512) DEFAULT NULL,
      file_name     VARCHAR(255) DEFAULT NULL,
      decided_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_research_ethics_submission (submission_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

export { router as researchSubmissionsRouter };

