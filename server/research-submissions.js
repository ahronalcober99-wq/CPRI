// ============================================================
//  CPRI — Research Submission Module (back end)
//  Router: /api/research-submissions/*
//
//  Storage: bytes go to Supabase Storage when it is configured on the
//  deployment, and to the local disk under UPLOAD_DIR otherwise (random names
//  either way). They are served ONLY through the authorized download endpoint:
//  nothing sits in a public folder and nothing is ever served inline. Each file
//  row records the backend holding it, so switching a deployment between the two
//  keeps older uploads readable. See server/lib/research-storage.js.
//
//  Auth: Express session. req.session.userId is the only identity the
//  server trusts. Client-supplied role / owner_id / status are ignored
//  everywhere. Role labels from the session are the only authority.
// ============================================================
'use strict';

import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { extname, basename } from 'path';
import { join } from 'path';
// mkdir is awaited, so it must come from the promise API — the callback version
// throws without a callback. Every other byte-level operation (write/mkdir/stat/
// stream/rm) lives in the storage adapter, so this router never has to assume
// the files are on disk.
import { mkdir } from 'fs/promises';

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
  normalizePrefs
} from './auth.js';
import { notify as defaultNotify } from './notifications.js';
import { addLog } from './audit.js';
import { sendNotificationEmail as defaultSendEmail } from './lib/mail.js';
import { createResearchStorage } from './lib/research-storage.js';
import { fromModuleSubmission, syncSubmissionVisibility } from './lib/repository-publishing.js';
import { profileOf, recommendationsFor } from './lib/recommendations.js';
import { courseFields } from './lib/courses.js';
import { loadSchoolYears, offeredSchoolYears, resolveListedFields } from './lib/school-years.js';
import { CATEGORY_TYPES } from './repository.js';
// The record shape every reader of a submission shares, plus the status
// labels. A monitoring dashboard reads BOTH stores, so a classic row and a
// module row have to come back identical — see lib/submission-records.js.
import {
  statusLabelFor,
  slotLabelFor,
  STAGE_LABELS,
  listLegacySubmissions,
  mergeSubmissionRecords
} from './lib/submission-records.js';

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
  STATUS_CHANGE_ROLES,
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
  describeField,
  describeSlot,
  CONDITIONAL_FLAGS,
  isHttpUrl,
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

// The designated Google Form for the adviser evaluation, when the deployment
// has one. /form-config publishes it so the form page can offer a button that
// opens it; a student can always paste the link they were given instead, so an
// unconfigured deployment stays fully usable.
const ADVISER_EVAL_FORM_URL = String(process.env.ADVISER_EVAL_FORM_URL || '').trim();

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
  const log = dependencies.addLog || addLog;

  /**
   * In-app notification + optional email copy for one person.
   *
   * Email follows the account's own preference (`user_prefs.email`, default
   * off) — the same contract the Email
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

  // Where the bytes live: Supabase Storage when this deployment has it
  // configured, the local disk otherwise. Tests inject their own store.
  const fileStore = dependencies.fileStore || createResearchStorage({
    uploadDir: UPLOAD_DIR,
    storage: dependencies.storage,
    logger: dependencies.logger
  });

  // Ensure the local upload root exists, so the disk backend survives a
  // restart. Harmless and unused when Supabase is configured.
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
// A Research Adviser / Facilitator monitors STUDENT work: they can read every
// student_researcher submission (that is the whole point of the role —
// "Monitor student submissions and provide comments or recommendations"), plus
// anything explicitly assigned to them via adviser_id / facilitator_id, which
// is how they reach a faculty record they were asked to look at.
// cpri_staff / admin see all. Reading is not writing: status changes stay with
// STATUS_CHANGE_ROLES (see the status route).
// ---------------------------------------------------------------------------
//  Whose record is this?
//
//  research_submissions.owner_id is the account id this module writes from the
//  session. Records that arrived another way — imported from the classic
//  `submissions` module, restored from a backup, or written by a script — can
//  carry the owner's EMAIL or USERNAME instead. Those rows were invisible to
//  their own owner: the dashboard simply listed nothing while the record sat in
//  the table (the exact bug the migration script fixes for the classic rows).
//
//  ownerRefsFor() is every spelling of the CALLER's own identity, so matching
//  always widens a person's view only to records that are already theirs: an id
//  is unique, and so is an email and a username. It can never reach another
//  account's submission.
// ---------------------------------------------------------------------------
function ownerRefsFor(user) {
  const refs = [];
  for (const value of [user?.id, user?.email, user?.username]) {
    const text = String(value == null ? '' : value).trim();
    if (!text) continue;
    for (const variant of [text, text.toLowerCase()]) {
      if (!refs.includes(variant)) refs.push(variant);
    }
  }
  // Never leave the WHERE clause empty for a signed-in account.
  if (!refs.length && user && user.id != null) refs.push(String(user.id));
  return refs;
}

function isOwnerOf(user, ownerId) {
  const value = String(ownerId == null ? '' : ownerId).trim().toLowerCase();
  if (!value) return false;
  return ownerRefsFor(user).some(ref => ref.toLowerCase() === value);
}

// READING. A researcher reads their own record; every monitoring role reads
// every record. Monitoring used to be narrowed to student-owned records plus the
// ones naming the reviewer, which hid real submissions (a record owned by a
// staff account, or a legacy record whose owner role differs) from the very
// dashboard that is supposed to oversee them. Reading is not writing — see
// canWriteSubmission() below and STATUS_CHANGE_ROLES for those.
function canReadSubmission(user, sub) {
  if (!user) return false;
  if (RESEARCHER_ROLES.has(user.role)) return isOwnerOf(user, sub.owner_id);
  if (ASSIGNED_ROLES.has(user.role)) return true;
  if (user.role === 'cpri_staff' || user.role === 'admin') return true;
  // The ethics reviewer checks Initial papers (and issues the Ethics
  // Clearance), so it reads that stage — never someone's unfinished draft, and
  // never the Final papers that do not go through ethics review.
  if (user.role === 'ethics_reviewer') return sub.stage === 'initial' && sub.status !== 'draft';
  return false;
}

// WRITING. Deliberately NOT the read rule: widening monitoring reads must never
// let a reviewer upload into, or edit, somebody else's record. Editing is still
// only possible while the submission is with its owner (a draft, or one that
// came back for revision), and then only for the owner or the staff/admin who
// run the module (plus the narrow adviser/facilitator cases this module has
// always allowed: a student's own record, or one that names them).
function canWriteSubmission(user, sub) {
  if (!user) return false;
  if (!['draft', 'submitted', 'for_revision'].includes(sub.status)) return false;
  if (isOwnerOf(user, sub.owner_id)) return true;
  if (ASSIGNED_ROLES.has(user.role)) {
    if (sub.owner_role === 'student_researcher') return true;
    if (user.role === 'adviser' && sub.adviser_id === user.id) return true;
    if (user.role === 'facilitator' && sub.facilitator_id === user.id) return true;
    return false;
  }
  return user.role === 'cpri_staff' || user.role === 'admin';
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
//  File persistence (random name, keep every version). This decides the path
//  and the metadata; the bytes go wherever the storage adapter puts them.
// ---------------------------------------------------------------------------
async function storeFiles(files, prefix, user, startingVersions = {}) {
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
    const backend = await fileStore.save({
      path: storedPath,
      buffer: file.buffer,
      contentType: file.mimetype
    });
    paths.push({ path: storedPath, backend });

    stored[slotKey] = {
      id: randomUUID(),
      slot_key: slotKey,
      original_name: file.originalname || 'document',
      stored_path: storedPath,
      storage_backend: backend,
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

// Undo the bytes of a submission that could not be saved. The adapter swallows
// its own failures — the route is already reporting the problem.
async function clearFiles(paths) {
  for (const stored of paths) {
    await fileStore.remove(stored);
  }
}

// ---------------------------------------------------------------------------
//  Router
// ---------------------------------------------------------------------------
const router = Router();

// ---------------------------------------------------------------------------
//  Turnitin result (advisory, admin and CPRI staff only)
//
//  The school checks papers in Turnitin; a person types the score and the report
//  link in (PATCH /:id/similarity). Nothing here reads the score to allow or
//  refuse anything. Several routes hand back the raw database row, so every one
//  of them goes through forViewer(), which removes the four columns for anyone
//  who may not see them — the researcher never learns the score.
// ---------------------------------------------------------------------------
const SIMILARITY_ROLES = new Set(['admin', 'cpri_staff']);
const SIMILARITY_COLUMNS = ['similarity_score', 'similarity_report_url', 'similarity_checked_at', 'similarity_checked_by'];

function forViewer(user, row) {
  if (!row || (user && SIMILARITY_ROLES.has(user.role))) return row;
  const copy = { ...row };
  for (const column of SIMILARITY_COLUMNS) delete copy[column];
  return copy;
}

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

  // School Year is a dropdown of the admin-managed list (current year + the 4
  // before it, plus additions). The page renders `options` and pre-selects
  // `default`; POST re-validates whatever comes back.
  const schoolYears = await loadSchoolYears({ all });
  const schoolYearOptions = offeredSchoolYears(schoolYears).map(y => ({
    value: y.label,
    label: y.isCurrent ? `${y.label} (current)` : y.label,
    isCurrent: y.isCurrent
  }));
  const describeFormField = (field) => {
    const described = describeField(field);
    if (field.type === 'school_year') {
      described.options = schoolYearOptions;
      described.default = schoolYears.current;
    }
    return described;
  };

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
      fields: config.initial.fields.map(describeFormField),
      slots: config.initial.slots.map(describeSlot)
    });
  }
  if (HAS_FINAL_STAGE.has(role)) {
    result.stages.push({
      stage: 'final',
      stageLabel: 'Final Submission',
      fields: config.final.fields.map(describeFormField),
      slots: config.final.slots.map(describeSlot)
    });
  }

  // The flags a conditional slot depends on, so the page can render the
  // controls instead of hard-coding them.
  result.conditionalFlags = CONDITIONAL_FLAGS.map(f => ({ ...f }));

  // Links the page should offer as buttons. Null when the deployment has not
  // set one, in which case the field is still there to paste a link into.
  result.links = { adviserEvalForm: ADVISER_EVAL_FORM_URL || null };

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

    // Program or Department and School Year come from shared lists (courses /
    // school years), so the values are checked against them here — the form's
    // dropdowns are a convenience, not the rule. A draft may leave them empty.
    const listed = await resolveListedFields({ body, all });
    if (listed.error) return res.status(400).json({ error: listed.error, field: listed.field });

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
      program:          listed.values.program,
      institution:      String(body.institution || '').trim(),
      nationality:      String(body.nationality || '').trim(),
      category:         String(body.category || '').trim(),
      research_type:    String(body.research_type || '').trim(),
      school_year:      listed.values.school_year,
      semester:         String(body.semester || '').trim(),
      adviser_id:       body.adviser ? String(body.adviser).trim() : null,
      facilitator_id:   body.facilitator ? String(body.facilitator).trim() : null,
      abstract:         requestedStage === 'final' ? String(body.abstract || '').trim() : '',
      keywords:         requestedStage === 'final' ? String(body.keywords || '').trim() : '',
      // Display-only on the form ("To be announced by adviser"), so nothing a
      // client posts for it is stored.
      adviser_eval_link: '',
      status:           stageDefaults[requestedStage].status,
      created_at:       now,
      updated_at:       now
    };

  let storedFiles = {};
  let filePaths = [];
  try {
    ({ stored: storedFiles, paths: filePaths } = await storeFiles(
      req.files || {},
      // Forward slashes on every platform: stored_path is persisted as-is and
      // resolved by the storage adapter, as a disk path or a Supabase object path.
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
        changed_by_name: user.fullName || user.username || '',
        changed_at: now
      });
    } catch (err) {
      await clearFiles(filePaths);
      console.error('[research-submissions] could not persist submission:', err.message);
      return res.status(500).json({ error: 'Could not save your submission. Please try again.' });
    }

    // In-app notification (console-based since no mail/SMS wiring here yet).
    console.log(`[research-submissions] new submission ${sub.id} by ${user.fullName || user.username} (${role}) stage=${requestedStage} status=${sub.status}`);

  // Tell the people who now have to look at it. CPRI staff and admins review
  // everything, and the Adviser / Facilitator dashboard monitors EVERY
  // submission in the system — so every active adviser/facilitator is notified,
  // whether or not the form happened to name them. (A research record created by
  // staff or an admin is covered by the same rule: it is still work to monitor,
  // which is exactly the case the old "student submissions only" scope missed.)
  const watchers = new Set();
  const supervisors = await all(
    "SELECT id FROM users WHERE role IN ('cpri_staff','admin','adviser','facilitator') AND status = 'active'"
  ).catch(() => []);
  for (const row of supervisors) watchers.add(row.id);

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
//  The caller's own records (researcher), or EVERY submission in the system
//  (adviser / facilitator / cpri_staff / admin).
//
//  A monitoring role has no filter here on purpose. Earlier versions scoped the
//  adviser/facilitator view with
//  `owner_role = 'student_researcher' OR adviser_id = ? OR facilitator_id = ?`,
//  which silently hid every record whose owner is not a student account (a
//  record created by staff, or a legacy record whose owner role is different):
//  the admin dashboard counted 2 submissions while the facilitator saw 1.
//  Monitoring is read-only — the status routes enforce that separately — so the
//  list itself has nothing to narrow.
//
//  The same view also reads the CLASSIC `submissions` table and merges it in.
//  Both stores hold real submissions (public/submission.html still writes to the
//  classic one), a migrated record keeps its id in both, and the merge drops a
//  classic row whose id is already a module row — so nothing is ever listed
//  twice and nothing is ever missing.
// ---------------------------------------------------------------------------
function groupBySubmission(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = row.submission_id;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

// The statuses THIS caller may move a record to from where it is now — the
// same rules PATCH /:id/status enforces, so a list page can offer exactly the
// moves that will succeed. Approving an Initial Submission is left out: it
// goes through the ethics decision (POST /:id/ethics), which attaches the
// clearance.
function nextStatusesFor(user, row) {
  if (!user || !STATUS_CHANGE_ROLES.has(user.role)) return [];
  if (user.role === 'ethics_reviewer' && row.status !== 'under_ethics_review') return [];
  const stage = row.stage || 'initial';
  const next = validTransitionsFor(stage, row.owner_role)[row.status] || [];
  return next
    .filter(status => !(stage === 'initial' && status === 'approved'))
    .map(status => ({ value: status, label: statusLabelFor(status, stage) }));
}

// One module row -> the shared record shape (see lib/submission-records.js).
function moduleRecord(row, { user, files = [], comments = [] }) {
  const stage = row.stage || 'initial';
  return {
    id: row.id,
    title: row.title || 'Untitled submission',
    status: row.status || '',
    statusLabel: statusLabelFor(row.status, stage),
    stage,
    stageLabel: STAGE_LABELS[stage] || stage,

    // Who submitted it. `studentName` is the field name the monitoring
    // dashboards read; owner_name is written from the session at creation time,
    // so it is never blank for a record the module itself accepted.
    studentName: row.owner_name || row.owner_id || '—',
    studentId: row.owner_id,
    ownerRole: row.owner_role || '',

    authors: row.authors || '',
    program: row.program || '',
    category: row.category || '',
    research_type: row.research_type || '',
    // Shown under the title on the researcher's dashboard.
    abstract: row.abstract || '',
    school_year: row.school_year || '',
    semester: row.semester || '',
    adviser: row.adviser_id || '',
    facilitator: row.facilitator_id || '',

    fileCount: files.length,
    files: files.map(f => ({
      id: f.id,
      slot_key: f.slot_key,
      label: slotLabelFor(f.slot_key),
      original_name: f.original_name || 'document',
      version: f.version == null ? null : Number(f.version),
      uploaded_at: f.uploaded_at || null,
      url: `/api/research-submissions/${encodeURIComponent(row.id)}/files/${encodeURIComponent(f.id)}`,
      source: 'module'
    })),
    commentCount: comments.length,
    comments,

    created_at: row.created_at,
    updated_at: row.updated_at || row.created_at,
    source: 'module',
    sources: ['module'],
    detailUrl: `/research-submission-detail.html?id=${encodeURIComponent(row.id)}`,
    isOwner: isOwnerOf(user, row.owner_id),
    nextStatuses: nextStatusesFor(user, row),
    canDecideEthics: Boolean(user) && user.role === 'ethics_reviewer' && row.status === 'under_ethics_review'
  };
}

router.get('/', requireAuth, async (req, res) => {
  const user = await callerUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });

  const isResearcher = RESEARCHER_ROLES.has(user.role);
  // Every role that monitors work rather than owning it. Read-only: none of
  // these may change a status (see STATUS_CHANGE_ROLES).
  const isMonitor = !isResearcher && (
    ASSIGNED_ROLES.has(user.role) || user.role === 'cpri_staff' || user.role === 'admin'
  );
  const isEthicsReviewer = user.role === 'ethics_reviewer';

  let rows;
  if (isResearcher) {
    // Only ever the caller's own identifiers — see ownerRefsFor().
    const refs = ownerRefsFor(user);
    rows = await all(
      `SELECT * FROM research_submissions
        WHERE ${refs.map(() => 'owner_id = ?').join(' OR ')}
        ORDER BY created_at DESC`,
      refs
    );
  } else if (isMonitor) {
    rows = await all('SELECT * FROM research_submissions ORDER BY created_at DESC');
  } else if (isEthicsReviewer) {
    // Same rule as canReadSubmission(): the Initial papers ethics review covers.
    rows = (await all('SELECT * FROM research_submissions ORDER BY created_at DESC'))
      .filter(row => canReadSubmission(user, row));
  } else {
    return res.status(403).json({ error: 'Access denied.' });
  }

  // Files and comments for the listed records. Both tables are read whole and
  // grouped here rather than with a per-record query, so the list costs two
  // reads no matter how many records it returns — and so the offline test's
  // simple fake data layer sees the same shapes production does.
  const ids = new Set(rows.map(r => r.id));
  const filesBy = ids.size
    ? groupBySubmission(await all('SELECT * FROM research_submission_files ORDER BY slot_key, version DESC'))
    : new Map();
  const commentsBy = ids.size
    ? groupBySubmission(await all('SELECT * FROM research_comments ORDER BY created_at ASC'))
    : new Map();

  let submissions = rows.map(row => moduleRecord(row, {
    user,
    files: filesBy.get(row.id) || [],
    comments: commentsBy.get(row.id) || []
  }));

  // The classic store, for a monitoring role: this is what makes the dashboard's
  // count agree with the admin overview, which counts that table.
  // One card per record even when a migrated record lives in both stores (see
  // mergeSubmissionRecords) — the admin dashboard merges the same way.
  const legacy = isMonitor
    ? await listLegacySubmissions({ all, isOwner: ref => isOwnerOf(user, ref) })
    : [];
  submissions = mergeSubmissionRecords(submissions, legacy);

  res.json({
    count: submissions.length,
    submissions
  });
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
  const editable = isOwnerOf(user, sub.owner_id) && canWriteSubmission(user, sub);

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
  // The first history entry of older submissions was saved without a name,
  // so the page showed the raw account id. Fill those in from the account.
  const unnamed = [...new Set(statusHistory.filter(h => !h.changed_by_name && h.changed_by).map(h => h.changed_by))];
  if (unnamed.length) {
    const names = new Map();
    for (const userId of unnamed) {
      const account = await get('SELECT fullName, username FROM users WHERE id = ?', [userId]).catch(() => null);
      if (account) names.set(userId, account.fullName || account.username || '');
    }
    for (const h of statusHistory) {
      if (!h.changed_by_name && names.get(h.changed_by)) h.changed_by_name = names.get(h.changed_by);
    }
  }

  // Ethics decisions, without the storage path (the file is fetched through
  // the authorized clearance route).
  const ethicsClearances = (await all(
    'SELECT * FROM research_ethics_clearances WHERE submission_id = ? ORDER BY decided_at ASC',
    [sub.id]
  )).map(c => ({
    id: c.id,
    decision: c.decision,
    reviewer_name: c.reviewer_name,
    decided_at: c.decided_at,
    file_name: c.file_name || null,
    hasFile: Boolean(c.file_path)
  }));

  // The owner's current course (Student accounts only) — shown with the
  // submission details; read from the account so it is never stale or typed.
  let ownerCourse = '';
  if (sub.owner_role === 'student_researcher') {
    const owner = await get('SELECT role, course_id, course_other FROM users WHERE id = ?', [sub.owner_id]).catch(() => null);
    if (owner) ownerCourse = courseFields(owner).course || '';
  }

  res.json({
    submission: {
      ...forViewer(user, sub),
      ownerCourse,
      // The moves this caller may make from here (PATCH /:id/status), and
      // whether the ethics decision buttons apply (POST /:id/ethics).
      nextStatuses: nextStatusesFor(user, sub),
      canDecideEthics: user.role === 'ethics_reviewer' && sub.status === 'under_ethics_review',
      ethicsClearances,
      // The server decides ownership (see ownerRefsFor) — the detail page must
      // not re-decide it by comparing raw ids, or a record keyed by email would
      // look like somebody else's to its own owner.
      isOwner: isOwnerOf(user, sub.owner_id),
      statusLabel: statusLabelFor(sub.status, sub.stage),
      files,
      comments,
      versions,
      statusHistory
    }
  });
});

// ---------------------------------------------------------------------------
//  GET /api/research-submissions/:id/recommendations
//  Related research from the PUBLIC repository only (never other people's
//  submissions), ranked by shared keywords, then category, then department.
// ---------------------------------------------------------------------------
router.get('/:id/recommendations', requireAuth, async (req, res) => {
  const user = await callerUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });

  const sub = await get('SELECT * FROM research_submissions WHERE id = ?', [req.params.id]);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  if (!canReadSubmission(user, sub)) return res.status(403).json({ error: 'You don\'t have access to this submission.' });

  const recommendations = await recommendationsFor({
    all,
    profile: profileOf({
      keywords: sub.keywords,
      categories: [sub.research_type, sub.category],
      department: sub.program
    }),
    sourceId: sub.id,
    categoryLabel: c => CATEGORY_TYPES[c]
  });
  res.json({ recommendations });
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

  // The two listed fields get the same check as on create. A value already on
  // the record (an older free-text one) may be sent back unchanged.
  const listedKeys = ['program', 'school_year'].filter(k => k in updates);
  if (listedKeys.length) {
    const listed = await resolveListedFields({ body, existing: sub, keys: listedKeys, all });
    if (listed.error) return res.status(400).json({ error: listed.error, field: listed.field });
    // Both stay required once the record has left draft.
    const blank = listedKeys.find(k => !listed.values[k]);
    if (blank && sub.status !== 'draft') {
      const label = FORM_CONFIG[user.role][sub.stage].fields.find(f => f.key === blank).label;
      return res.status(400).json({ error: `Required field is missing: ${label}.`, field: blank });
    }
    Object.assign(updates, listed.values);
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
    submission: forViewer(user, updated)
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
    let backend;
    try {
      backend = await fileStore.save({
        path: storedPath,
        buffer: file.buffer,
        contentType: file.mimetype
      });
    } catch (err) {
      console.error('[research-submissions] file storage failed:', err.message);
      return res.status(502).json({ error: 'Could not store the file. Please try again.' });
    }

    const fileRow = {
      id: randomUUID(),
      submission_id: sub.id,
      slot_key: slotKey,
      original_name: file.originalname || 'document',
      stored_path: storedPath,
      storage_backend: backend,
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
      await fileStore.remove({ path: storedPath, backend });
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
//  Authorized download. Streamed straight from the storage backend (disk or
//  Supabase) as an attachment — never from a public folder, never inline, and
//  never as a public/signed URL the browser could keep using.
// ---------------------------------------------------------------------------
router.get('/:id/files/:fileId', requireAuth, async (req, res) => {
  const user = await callerUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });

  const sub = await get('SELECT * FROM research_submissions WHERE id = ?', [req.params.id]);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  if (!canReadSubmission(user, sub)) return res.status(403).json({ error: 'You don\'t have access to this submission.' });

  const file = await get('SELECT * FROM research_submission_files WHERE id = ? AND submission_id = ?', [req.params.fileId, sub.id]);
  if (!file) return res.status(404).json({ error: 'File not found.' });

  // Authorization happened above; only now do we reach for the bytes.
  let stream;
  try {
    stream = await fileStore.open({
      path: file.stored_path,
      backend: file.storage_backend
    });
  } catch (err) {
    console.error('[research-submissions] file could not be opened:', err.message);
    return res.status(502).json({ error: 'The stored file could not be retrieved. Please try again.' });
  }
  if (!stream) {
    return res.status(404).json({ error: 'File is no longer available.' });
  }

  res.setHeader('Content-Type', file.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURI(file.original_name || 'document')}"`);
  stream.pipe(res);
  stream.on('error', (err) => {
    if (!res.headersSent) res.status(500).json({ error: 'Could not stream the file.' });
    console.error('[research-submissions] file stream error:', err.message);
  });
});

// ---------------------------------------------------------------------------
//  GET /api/research-submissions/:id/ethics-clearance/:clearanceId
//  The Ethics Clearance PDF attached to an ethics decision. Same read rule as
//  every other document of the submission.
// ---------------------------------------------------------------------------
router.get('/:id/ethics-clearance/:clearanceId', requireAuth, async (req, res) => {
  const user = await callerUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });

  const sub = await get('SELECT * FROM research_submissions WHERE id = ?', [req.params.id]);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  if (!canReadSubmission(user, sub)) return res.status(403).json({ error: 'You don\'t have access to this submission.' });

  const clearance = await get(
    'SELECT * FROM research_ethics_clearances WHERE id = ? AND submission_id = ?',
    [req.params.clearanceId, sub.id]
  );
  if (!clearance || !clearance.file_path) return res.status(404).json({ error: 'No clearance file was attached.' });

  let stream;
  try {
    stream = await fileStore.open({ path: clearance.file_path, backend: clearance.storage_backend });
  } catch (err) {
    console.error('[research-submissions] clearance could not be opened:', err.message);
    return res.status(502).json({ error: 'The stored file could not be retrieved. Please try again.' });
  }
  if (!stream) return res.status(404).json({ error: 'File is no longer available.' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURI(clearance.file_name || 'ethics-clearance.pdf')}"`);
  stream.pipe(res);
  stream.on('error', (err) => {
    if (!res.headersSent) res.status(500).json({ error: 'Could not stream the file.' });
    console.error('[research-submissions] clearance stream error:', err.message);
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

  // Anyone who can READ the submission may leave a comment on it — the read
  // check above already scoped that. A Research Adviser / Facilitator therefore
  // comments on any student record they monitor, and on a faculty record only
  // when it names them. Commenting never implies the right to change a status.
  const mayComment =
    canReadSubmission(user, sub) || isOwnerOf(user, sub.owner_id);

  if (!mayComment) return res.status(403).json({ error: 'You are not allowed to comment on this submission.' });

  // Infer comment type from the commenter's role.
  let commentType = 'comment';
  if (user.role === 'adviser' || user.role === 'facilitator') commentType = 'feedback';
  else if (user.role === 'ethics_reviewer') commentType = 'revision_suggestion';
  else if (RESEARCHER_ROLES.has(user.role) && isOwnerOf(user, sub.owner_id)) commentType = 'response';

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
  const ownerHandsInDraft = isOwnerOf(user, sub.owner_id)
    && sub.status === 'draft'
    && targetStatusEarly === 'submitted';
  if (!ownerHandsInDraft && !STATUS_CHANGE_ROLES.has(user.role)) {
    // A Research Adviser / Facilitator reaches this line and is refused on
    // purpose: the role monitors and comments, it never approves or rejects.
    return res.status(403).json({
      error: 'Only the owner of a draft, a reviewer, or CPRI staff can change a status.'
    });
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


  const targetStatus = targetStatusEarly;
  if (!targetStatus) return res.status(400).json({ error: 'A status is required.' });

  // Validate transition. Faculty initial work goes straight to ethics review,
  // so the allowed table depends on the researcher's role as well as the stage.
  const allowed = validTransitionsFor(sub.stage, sub.owner_role);
  // The target must be a status of this workflow. (This used to test
  // `allowed[targetStatus]`, i.e. whether the target is a state you can move
  // ON from — and nothing moves on from "rejected", so no submission could
  // ever be rejected here.)
  const stageStatuses = sub.stage === 'initial' ? INITIAL_STATUSES : FINAL_STATUSES;
  if (!stageStatuses.some(s => s.value === targetStatus)) {
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

  const visibility = await syncPublicPages(sub, targetStatus, now);

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
    submission: forViewer(user, updated),
    repository: visibility
  });
});

// ---------------------------------------------------------------------------
//  PATCH /api/research-submissions/:id/similarity
//  Record the Turnitin score and report link. Admin and CPRI staff only.
//  Body: { score?: 0-100 | "", reportUrl?: "http(s)://…" | "" } — empty clears.
//  Advisory: no status move depends on it, and the owner is not notified.
// ---------------------------------------------------------------------------
router.patch('/:id/similarity', requireAuth, async (req, res) => {
  const user = await callerUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });
  if (!SIMILARITY_ROLES.has(user.role)) {
    return res.status(403).json({ error: 'Only an administrator or CPRI staff can record a similarity result.' });
  }
  const sub = await get('SELECT * FROM research_submissions WHERE id = ?', [req.params.id]);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  if (sub.status === 'draft') {
    return res.status(409).json({ error: 'This is still a draft. The researcher has not submitted it yet.' });
  }

  const body = req.body || {};
  if (body.score === undefined && body.reportUrl === undefined) {
    return res.status(400).json({ error: 'Send a score, a report link, or both.' });
  }
  let score = sub.similarity_score === null || sub.similarity_score === undefined ? null : Number(sub.similarity_score);
  let url = sub.similarity_report_url || '';
  if (body.score !== undefined) {
    const raw = String(body.score).trim().replace(/%$/, '');
    if (raw === '') {
      score = null;
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return res.status(400).json({ error: 'The similarity score must be a number from 0 to 100.' });
      }
      score = Math.round(n * 100) / 100;
    }
  }
  if (body.reportUrl !== undefined) {
    const raw = String(body.reportUrl).trim();
    if (raw && (!isHttpUrl(raw) || raw.length > 500)) {
      return res.status(400).json({ error: 'The report link must start with http:// or https://.' });
    }
    url = raw;
  }
  const beforeScore = sub.similarity_score === null || sub.similarity_score === undefined ? null : Number(sub.similarity_score);
  if (score === beforeScore && url === (sub.similarity_report_url || '')) {
    return res.status(400).json({ error: 'Nothing to change.' });
  }

  const now = new Date().toISOString();
  await update('research_submissions', sub.id, {
    similarity_score: score,
    similarity_report_url: url || null,
    similarity_checked_at: now,
    similarity_checked_by: user.fullName || user.username,
    updated_at: now
  });
  const show = (s, u) => (s === null ? 'none' : `${s}%`) + (u ? ` (${u})` : '');
  console.log(`[research-submissions] similarity ${sub.id}: ${show(beforeScore, sub.similarity_report_url)} -> ${show(score, url)} by ${user.fullName || user.username}`);
  try {
    await log('research_similarity',`Research submission ${sub.id} "${sub.title}": Turnitin similarity ${show(beforeScore, sub.similarity_report_url)} -> ${show(score, url)}.`, req);
  } catch { /* the audit helper logs its own failures */ }

  const updated = await get('SELECT * FROM research_submissions WHERE id = ?', [sub.id]);
  res.json({ message: 'Similarity result saved.', submission: forViewer(user, updated) });
});

// ---------------------------------------------------------------------------
//  The repository + Publications page follow a submission's status
//  (lib/repository-publishing.js). A Final Submission is finished research, so
//  approving it publishes it. An approved Initial Submission is only an
//  ethics-cleared proposal: it is published only if an admin already chose to
//  (the "Publish" button on the admin dashboard). Rejecting — or any other
//  non-public status — hides it again either way.
//
//  The status change has already been saved, so a failure here is logged and
//  reported in the response, never turned into a failed request.
// ---------------------------------------------------------------------------
async function syncPublicPages(sub, status, at) {
  try {
    return await syncSubmissionVisibility(
      { get, all, insert, update, remove },
      fromModuleSubmission(sub),
      status,
      { autoPublish: sub.stage === 'final', at }
    );
  } catch (err) {
    console.error(`[research-submissions] repository sync failed for ${sub.id}:`, err.message);
    return 'failed';
  }
}

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
  let clearanceBackend = null;
  if (req.file) {
    const ext = extname(req.file.originalname || '').toLowerCase();
    if (!PDF_EXTENSIONS.has(ext)) {
      return res.status(400).json({ error: 'The ethics clearance file must be a PDF.' });
    }
    clearancePath = `research-submissions/${sub.id}/ethics-clearance-${randomUUID()}${ext}`;
    try {
      clearanceBackend = await fileStore.save({
        path: clearancePath,
        buffer: req.file.buffer,
        contentType: req.file.mimetype || 'application/pdf'
      });
    } catch (err) {
      console.error('[research-submissions] could not store the ethics clearance file:', err.message);
      return res.status(502).json({ error: 'Could not store the clearance file. Please try again.' });
    }
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
      storage_backend: clearanceBackend,
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
      await fileStore.remove({ path: clearancePath, backend: clearanceBackend });
    }
    console.error('[research-submissions] ethics decision failed:', err.message);
    return res.status(500).json({ error: 'Could not record the ethics decision. Please try again.' });
  }

  await syncPublicPages(sub, decision === 'approved' ? 'approved' : 'rejected', now);

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
// statusLabelFor() now lives in lib/submission-records.js, next to the classic
// records that need the same labels (imported above).

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
      adviser_eval_link VARCHAR(1000) NOT NULL DEFAULT '',
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
      storage_backend  VARCHAR(20) NOT NULL DEFAULT 'disk',
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
      storage_backend VARCHAR(20) NOT NULL DEFAULT 'disk',
      decided_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_research_ethics_submission (submission_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Existing databases: the two file tables learnt a `storage_backend` column
  // when uploads started using Supabase Storage. New tables get it from the DDL
  // above; older ones — including any deployment that already ran an earlier
  // version of this module — are caught up here. SHOW COLUMNS comes first, so
  // running this on every boot is safe, exactly like ensureUsersSchema.
  const columnsToAdd = [
    {
      table: 'research_submissions',
      name: 'adviser_eval_link',
      sql: "ALTER TABLE research_submissions ADD COLUMN adviser_eval_link VARCHAR(1000) NOT NULL DEFAULT ''"
    },
    // Turnitin result typed in by admin / staff (migration 009). Advisory only.
    { table: 'research_submissions', name: 'similarity_score', sql: 'ALTER TABLE research_submissions ADD COLUMN similarity_score DECIMAL(5,2) DEFAULT NULL' },
    { table: 'research_submissions', name: 'similarity_report_url', sql: 'ALTER TABLE research_submissions ADD COLUMN similarity_report_url VARCHAR(500) DEFAULT NULL' },
    { table: 'research_submissions', name: 'similarity_checked_at', sql: 'ALTER TABLE research_submissions ADD COLUMN similarity_checked_at DATETIME DEFAULT NULL' },
    { table: 'research_submissions', name: 'similarity_checked_by', sql: 'ALTER TABLE research_submissions ADD COLUMN similarity_checked_by VARCHAR(160) DEFAULT NULL' },
    {
      table: 'research_submission_files',
      name: 'storage_backend',
      sql: "ALTER TABLE research_submission_files ADD COLUMN storage_backend VARCHAR(20) NOT NULL DEFAULT 'disk'"
    },
    {
      table: 'research_ethics_clearances',
      name: 'storage_backend',
      sql: "ALTER TABLE research_ethics_clearances ADD COLUMN storage_backend VARCHAR(20) NOT NULL DEFAULT 'disk'"
    }
  ];

  const added = [];
  for (const column of columnsToAdd) {
    const existing = await runQuery(`SHOW COLUMNS FROM ${column.table}`);
    const names = new Set(
      (existing || []).map(row => String(row.Field || row.field || '').toLowerCase())
    );
    if (names.has(column.name.toLowerCase())) continue;
    try {
      await runQuery(column.sql);
      added.push(`${column.table}.${column.name}`);
    } catch (err) {
      if (!String(err && err.message).includes('Duplicate column name')) {
        throw err;
      }
    }
  }
  if (added.length > 0) {
    console.log(`[schema] added missing research columns: ${added.join(', ')}`);
  }
}

export { router as researchSubmissionsRouter };

