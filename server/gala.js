// ============================================================
//  CPRI — Research Gala submissions (Presenter role, FINAL paper only)
//
//    GET    /api/gala/config               form options: lists, slots, limits
//    GET    /api/gala                      own entries (reviewers: all, filterable)
//    GET    /api/gala/export               program of presenters: ?format=pdf|xlsx
//    POST   /api/gala                      start a draft
//    GET    /api/gala/:id                  one entry (owner or reviewer)
//    PATCH  /api/gala/:id                  save draft / edit while still editable
//    POST   /api/gala/:id/files/:slot      attach one document (multipart "file")
//    DELETE /api/gala/:id/files/:slot      remove one document
//    GET    /api/gala/:id/files/:slot      download one document (?inline=1 for PDFs)
//    POST   /api/gala/:id/submit           final submit (or resubmit after revision)
//    PATCH  /api/gala/:id/status           reviewer: status, remarks, schedule
//    GET    /api/gala/:id/file/:filename   download a pre-2026 abstract upload
//    DELETE /api/gala/:id                  withdraw (owner) or remove (admin)
//
//  Design notes:
//   • Only an active Presenter account can create, edit, upload to or submit
//     an entry, and only its own — the owner always comes from the session
//     (req.session.userId), never from the request. An entry that is not yours
//     answers 404, so ids cannot be probed. Reviewers (admin / CPRI staff) read
//     every submitted entry and decide on it; they never edit the paper.
//   • The presenter may edit while the entry is a draft, Submitted, or For
//     Revision. From Under Checking on it is frozen until an admin sends it back
//     For Revision.
//   • Documents are PDF or Word, up to 20 MB, validated on the SERVER by
//     extension AND magic bytes; empty files and the same file attached twice
//     are refused. Bytes live in the private research storage (Supabase when
//     configured, local disk otherwise) at
//     submissions/{user_id}/{submission_id}/final/ — never under /public.
//   • Every status change records who and when (statusHistory), notifies the
//     presenter in-app (and by email when their preferences ask for it) and
//     lands in the audit log.
//   • The data layer is a small `store`, so tests run the real router against
//     an in-memory one.
// ============================================================
import { Router } from 'express';
import multer from 'multer';
import { randomUUID, randomBytes, createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { requireAuth, requireRole, normalizePrefs } from './auth.js';
import { all, get, insert, update, remove } from './server/db/queries.js';
import { uploadErrorHandler } from './lib/upload-safety.js';
import { addLog } from './audit.js';
import { notify as defaultNotify } from './notifications.js';
import { sendNotificationEmail as defaultSendEmail } from './lib/mail.js';
import { createResearchStorage } from './lib/research-storage.js';
import { isHttpUrl } from './lib/research-config.js';
import { checkGrammar as defaultCheckGrammar, GRAMMAR_MAX_CHARS } from './lib/grammar.js';
import { loadSchoolYears, offeredSchoolYears, resolveListedFields } from './lib/school-years.js';
import {
  GALA_STATUS,
  GALA_TRANSITIONS,
  EDITABLE_STATUSES,
  WITHDRAWABLE_STATUSES,
  SCHEDULE_VISIBLE_STATUSES,
  REMARKS_REQUIRED_STATUSES,
  TRACKER_STATUSES,
  PRESENTATION_FORMATS,
  SCHEDULE_PREFERENCES,
  GALA_CATEGORIES,
  GALA_SEMESTERS,
  GALA_SLOTS,
  LIMITS,
  slotByKey,
  slotLabel,
  slotExtensions,
  slotAcceptText,
  checkUpload,
  normalizeEntry,
  checkTagLists,
  validateEntry,
  parseJsonColumn,
  isValidDate,
  isValidClock,
  formatClock,
  formatDay,
  categoryLabel,
  formatLabel
} from './lib/gala-config.js';
import { buildProgramPdf, buildProgramXlsx, programRows } from './lib/gala-export.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Pre-2026 abstract uploads were written here (public/, which is not private).
// New documents never go here; the folder is only read to serve old rows.
const LEGACY_GALA_UPLOAD_DIR = join(__dirname, '..', 'public', 'assets', 'uploads', 'gala');
// Local-disk root for the private document store (used when Supabase is not
// configured). Paths below it follow submissions/{user_id}/{submission_id}/final/.
const GALA_FILES_DIR = join(__dirname, 'data', 'gala-files');

export { GALA_STATUS };
export const PRESENTATION_TYPES = PRESENTATION_FORMATS;

// Only Presenter accounts submit; admins and CPRI staff review.
export const GALA_SUBMIT_ROLES = ['presenter'];
export const GALA_REVIEW_ROLES = ['admin', 'cpri_staff'];

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};

const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

export function makeRefNo(date = new Date()) {
  let suffix = '';
  for (const byte of randomBytes(6)) suffix += REF_ALPHABET[byte % REF_ALPHABET.length];
  return `RG-${date.getFullYear()}-${suffix}`;
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const likeEscape = (s) => String(s).replace(/[\\%_]/g, c => '\\' + c);
const nowIso = () => new Date().toISOString();

function dispositionHeader(name, inline) {
  const safe = String(name || 'document').replace(/[\r\n"\\]/g, '_');
  const ascii = safe.replace(/[^\x20-\x7E]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

// One writer per submission at a time: an upload and a save arriving together
// would otherwise both read the same `files` list and the last one would win.
const locks = new Map();
async function withLock(id, fn) {
  const previous = locks.get(id) || Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const chained = previous.then(() => gate);
  locks.set(id, chained);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(id) === chained) locks.delete(id);
  }
}

// ---------- Row <-> API shapes ----------
function entryOf(row) {
  const presenters = parseJsonColumn(row.presenters, null);
  const coAuthors = parseJsonColumn(row.coAuthors, []);
  return {
    title: row.title || '',
    presenters: Array.isArray(presenters) && presenters.length
      ? presenters
      : (row.submitterName ? [row.submitterName] : []),
    coAuthors: Array.isArray(coAuthors) ? coAuthors : [],
    program: row.program || '',
    category: row.category || '',
    presentationType: row.presentationType || '',
    adviser: row.adviser || '',
    abstract: row.abstractText || '',
    keywords: String(row.keywords || '').split(',').map(k => k.trim()).filter(Boolean),
    schoolYear: row.schoolYear || '',
    semester: row.semester || '',
    schedulePreference: row.schedulePreference || 'none',
    eventId: row.eventId || ''
  };
}

const filesOf = (row) => {
  const files = parseJsonColumn(row.files, []);
  return Array.isArray(files) ? files : [];
};

function recordChanges(norm, merged) {
  const out = {};
  const copy = ['title', 'program', 'category', 'presentationType', 'adviser', 'schoolYear', 'semester', 'schedulePreference', 'eventId'];
  for (const key of copy) if (norm[key] !== undefined) out[key] = norm[key];
  if (norm.abstract !== undefined) out.abstractText = norm.abstract;
  if (norm.keywords !== undefined) out.keywords = norm.keywords.join(', ');
  if (norm.presenters !== undefined) out.presenters = JSON.stringify(norm.presenters);
  if (norm.coAuthors !== undefined) out.coAuthors = JSON.stringify(norm.coAuthors);
  if (norm.presenters !== undefined || norm.coAuthors !== undefined) {
    // `authors` is the flat, 255-character display string older screens read;
    // the full lists live in the two JSON columns.
    out.authors = [...merged.presenters, ...merged.coAuthors].join(', ').slice(0, 255);
  }
  return out;
}

export function createGalaRouter(dependencies = {}) {
  const router = Router();

  const query = {
    all: dependencies.all || all,
    get: dependencies.get || get,
    insert: dependencies.insert || insert,
    update: dependencies.update || update,
    remove: dependencies.remove || remove
  };

  // ---- Data layer (replaceable as a whole in tests) ----
  const store = dependencies.store || {
    get: (id) => query.get('SELECT * FROM gala_submissions WHERE id = ?', [id]),
    insert: (record) => query.insert('gala_submissions', record),
    update: (id, changes) => query.update('gala_submissions', id, changes),
    remove: (id) => query.remove('gala_submissions', id),

    async list(f = {}) {
      let sql = 'SELECT * FROM gala_submissions WHERE 1=1';
      const params = [];
      if (f.userId) { sql += ' AND userId = ?'; params.push(f.userId); }
      if (f.excludeDrafts) sql += " AND status <> 'draft'";
      if (f.statuses?.length) {
        sql += ` AND status IN (${f.statuses.map(() => '?').join(',')})`;
        params.push(...f.statuses);
      }
      if (f.category) { sql += ' AND category = ?'; params.push(f.category); }
      if (f.presentationType) { sql += ' AND presentationType = ?'; params.push(f.presentationType); }
      if (f.schoolYear) { sql += ' AND schoolYear = ?'; params.push(f.schoolYear); }
      if (f.q) {
        const like = `%${likeEscape(f.q)}%`;
        sql += ' AND (title LIKE ? OR refNo LIKE ? OR submitterName LIKE ? OR authors LIKE ?)';
        params.push(like, like, like, like);
      }
      sql += f.userId
        ? ' ORDER BY updatedAt DESC LIMIT 200'
        : ' ORDER BY COALESCE(submittedAt, createdAt) DESC LIMIT 500';
      return query.all(sql, params);
    },

    async titleTaken(userId, title, exceptId) {
      const row = await query.get(
        "SELECT id FROM gala_submissions WHERE userId = ? AND LOWER(title) = LOWER(?) AND id <> ? AND status NOT IN ('draft', 'rejected') LIMIT 1",
        [userId, title, exceptId]
      );
      return Boolean(row);
    },

    async scheduleConflict({ date, time, room, exceptId }) {
      const row = await query.get(
        "SELECT id, title FROM gala_submissions WHERE scheduleDate = ? AND scheduleTime = ? AND LOWER(scheduleRoom) = LOWER(?) AND id <> ? AND status IN ('scheduled', 'presented') LIMIT 1",
        [date, time, room, exceptId]
      );
      return row || null;
    },

    async refNoTaken(refNo) {
      return Boolean(await query.get('SELECT id FROM gala_submissions WHERE refNo = ? LIMIT 1', [refNo]));
    },

    async eventExists(id) {
      return Boolean(await query.get('SELECT id FROM events_module WHERE id = ?', [id]));
    },

    async events() {
      return query.all('SELECT id, title, dateTime FROM events_module ORDER BY dateTime DESC').catch(() => []);
    },

    async schoolYearsInUse() {
      const rows = await query.all("SELECT DISTINCT schoolYear FROM gala_submissions WHERE schoolYear IS NOT NULL AND schoolYear <> '' ORDER BY schoolYear DESC");
      return rows.map(r => r.schoolYear);
    },

    async reviewerIds() {
      const rows = await query.all("SELECT id FROM users WHERE role IN ('admin', 'cpri_staff') AND status = 'active'");
      return rows.map(r => r.id);
    },

    async account(userId) {
      return query.get('SELECT email, fullName, user_prefs FROM users WHERE id = ?', [userId]);
    }
  };

  const authenticate = dependencies.requireAuth || requireAuth;
  const resolveCaller = dependencies.caller
    || (async (req) => query.get('SELECT * FROM users WHERE id = ?', [req.session?.userId]));
  const log = dependencies.addLog || addLog;
  // The review gate is injectable so tests can exercise the decision route
  // without a database (requireRole looks the account up on every request).
  const reviewGate = dependencies.reviewGate || requireRole(...GALA_REVIEW_ROLES);
  const notifyInApp = dependencies.notify || defaultNotify;
  const sendEmail = dependencies.sendEmail || defaultSendEmail;
  const grammarCheck = dependencies.checkGrammar || defaultCheckGrammar;
  // One grammar request per presenter every few seconds: LanguageTool's public
  // API is rate limited, and one noisy client must not use up everyone's turn.
  const GRAMMAR_GAP_MS = dependencies.grammarGapMs ?? 3000;
  const lastGrammarCall = new Map();
  const resolveListed = dependencies.resolveListed || ((args) => resolveListedFields({ ...args, all: query.all }));
  const loadSchoolYearList = dependencies.schoolYears || (async () => {
    const config = await loadSchoolYears({ all: query.all });
    return {
      current: config.current,
      years: offeredSchoolYears(config).map(y => ({ value: y.label, label: y.label, isCurrent: y.isCurrent }))
    };
  });
  const fileStore = dependencies.fileStore || createResearchStorage({
    uploadDir: dependencies.uploadDir || GALA_FILES_DIR,
    storage: dependencies.storage,
    logger: dependencies.logger
  });

  const isReviewer = (me) => Boolean(me) && GALA_REVIEW_ROLES.includes(me.role) && me.status === 'active';
  const isPresenter = (me) => Boolean(me) && GALA_SUBMIT_ROLES.includes(me.role) && me.status === 'active';
  const isOwner = (me, s) => isPresenter(me) && s.userId === me.id;

  // Async handlers: an exception becomes a 500 instead of a hung request.
  const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
    console.error('[gala] request failed:', err.message);
    if (res.headersSent) return next(err);
    return res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
  });

  // ---- Guards ----
  const withCaller = handle(async (req, res, next) => {
    const me = await resolveCaller(req);
    if (!me) return res.status(401).json({ error: 'Not authenticated.' });
    req._me = me;
    return next();
  });

  // Only an active Presenter account gets past this — the server-side rule
  // behind "only Presenter accounts can open this form".
  const presenterOnly = handle(async (req, res, next) => {
    const me = await resolveCaller(req);
    if (!me) return res.status(401).json({ error: 'Not authenticated.' });
    if (!isPresenter(me)) {
      return res.status(403).json({ error: 'Only Presenter accounts can use the Research Gala submission form.' });
    }
    req._me = me;
    return next();
  });

  // Loads the entry for an owner-only route. Someone else's entry looks exactly
  // like a missing one.
  const loadOwned = handle(async (req, res, next) => {
    const s = await store.get(req.params.id);
    if (!s || s.userId !== req._me.id) return res.status(404).json({ error: 'Submission not found.' });
    req._row = s;
    return next();
  });

  const requireEditable = (req, res, next) => {
    const s = req._row;
    if (!EDITABLE_STATUSES.has(s.status)) {
      return res.status(409).json({
        error: `This submission is ${GALA_STATUS[s.status] || s.status} and can no longer be edited. It can be edited again only if it is sent back For Revision.`
      });
    }
    return next();
  };

  // ---- Presentation ----
  function presentFile(s, f) {
    const slot = slotByKey(f.slot);
    return {
      slot: f.slot || null,
      label: slot ? slotLabel(slot, s.presentationType) : 'Abstract file (earlier upload)',
      originalName: f.originalName || f.filename || '',
      size: Number(f.size) || 0,
      uploadedAt: f.uploadedAt || null,
      legacyFilename: slot ? undefined : f.filename
    };
  }

  function present(s, viewer, { events = null } = {}) {
    const entry = entryOf(s);
    const files = filesOf(s);
    const attached = files.filter(f => slotByKey(f.slot));
    const owner = isOwner(viewer, s);
    const reviewer = isReviewer(viewer);
    const showSchedule = reviewer || (owner && SCHEDULE_VISIBLE_STATUSES.has(s.status));
    const hasSchedule = Boolean(s.scheduleDate && s.scheduleTime && s.scheduleRoom);
    const history = parseJsonColumn(s.statusHistory, []) || [];

    return {
      id: s.id,
      refNo: s.refNo || null,
      status: s.status,
      statusLabel: GALA_STATUS[s.status] || s.status,
      title: entry.title,
      presenters: entry.presenters,
      coAuthors: entry.coAuthors,
      authors: s.authors || '',
      program: entry.program,
      category: entry.category,
      categoryLabel: categoryLabel(entry.category),
      presentationType: entry.presentationType,
      presentationTypeLabel: formatLabel(entry.presentationType),
      adviser: entry.adviser,
      abstract: entry.abstract,
      keywords: entry.keywords,
      schoolYear: entry.schoolYear,
      semester: entry.semester,
      schedulePreference: entry.schedulePreference,
      schedulePreferenceLabel: SCHEDULE_PREFERENCES[entry.schedulePreference] || '',
      eventId: entry.eventId,
      eventTitle: events && entry.eventId ? (events.find(e => e.id === entry.eventId)?.title || '') : '',
      submitterName: s.submitterName || '',
      userId: reviewer ? s.userId : undefined,
      files: files.map(f => presentFile(s, f)),
      docsAttached: new Set(attached.map(f => f.slot)).size,
      docsRequired: GALA_SLOTS.length,
      draftStep: Number(s.draftStep) || 1,
      editable: owner && EDITABLE_STATUSES.has(s.status),
      withdrawable: owner && WITHDRAWABLE_STATUSES.has(s.status),
      remarks: s.reviewNote || '',
      reviewedBy: reviewer ? (s.reviewedBy || '') : undefined,
      // Turnitin result recorded by hand. Reviewers only: the presenter's
      // response does not even carry the keys.
      similarity: reviewer ? {
        score: s.similarityScore === null || s.similarityScore === undefined ? null : Number(s.similarityScore),
        reportUrl: s.similarityReportUrl || '',
        checkedAt: s.similarityCheckedAt || null,
        checkedBy: s.similarityCheckedBy || ''
      } : undefined,
      schedule: showSchedule && hasSchedule ? {
        date: s.scheduleDate,
        time: s.scheduleTime,
        room: s.scheduleRoom,
        dateLabel: formatDay(s.scheduleDate),
        timeLabel: formatClock(s.scheduleTime),
        announced: SCHEDULE_VISIBLE_STATUSES.has(s.status)
      } : null,
      statusHistory: history
        // An update that only touched an unannounced schedule has nothing the
        // presenter may read, so it is not part of their timeline.
        .filter(h => reviewer || h.kind !== 'update' || h.note)
        .map(h => ({
          kind: h.kind || 'status',
          status: h.status,
          label: GALA_STATUS[h.status] || h.status,
          at: h.at,
          by: reviewer ? (h.by || '') : (h.byId === s.userId || (!h.byId && h.by === s.submitterName) ? 'You' : 'CPRI team'),
          note: (reviewer ? (h.adminNote || h.note) : h.note) || ''
        })),
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      submittedAt: s.submittedAt || null
    };
  }

  // ---- Notifications ----
  // In-app always (the helper honours the account's own switch); an email copy
  // only when the account asked for one. Nothing here may fail the request.
  async function notifyPerson(userId, { action, title, message, link = '' }) {
    if (!userId) return;
    try {
      await notifyInApp(userId, action, title, message, link);
    } catch (err) {
      console.error('[gala] in-app notification failed:', err.message);
    }
    try {
      const account = await store.account(userId);
      if (!account?.email) return;
      if (!normalizePrefs(account.user_prefs).email) return;
      await sendEmail(account.email, {
        title: escapeHtml(title),
        message: escapeHtml(message),
        link,
        linkLabel: 'Open my submission'
      });
    } catch (err) {
      console.error('[gala] notification email failed:', err.message);
    }
  }

  async function notifyReviewers(payload) {
    try {
      for (const id of await store.reviewerIds()) {
        await notifyInApp(id, payload.action, payload.title, payload.message, payload.link).catch(() => {});
      }
    } catch (err) {
      console.error('[gala] reviewer notification failed:', err.message);
    }
  }

  const quote = (t) => `"${t}"`;
  function statusMessage(s, status, remarks, schedule) {
    const ref = s.refNo ? ` (${s.refNo})` : '';
    const base = `Your Research Gala submission ${quote(s.title)}${ref}`;
    const tail = remarks ? ` Remarks: ${remarks}` : '';
    switch (status) {
      case 'under_checking': return `${base} is now under checking.${tail}`;
      case 'for_revision': return `${base} was sent back for revision. Please update it and submit again.${tail}`;
      case 'scheduled': return `${base} is scheduled: ${schedule}.${tail}`;
      case 'presented': return `${base} is marked as presented. Thank you for presenting!${tail}`;
      case 'rejected': return `${base} was not accepted.${tail}`;
      default: return `${base} is now ${GALA_STATUS[status] || status}.${tail}`;
    }
  }

  // ---- Config ----
  router.get('/config', authenticate, withCaller, handle(async (req, res) => {
    const me = req._me;
    if (!isPresenter(me) && !isReviewer(me)) {
      return res.status(403).json({ error: 'Only Presenter accounts can use the Research Gala submission form.' });
    }
    const [years, events] = await Promise.all([
      loadSchoolYearList().catch(() => ({ current: '', years: [] })),
      store.events()
    ]);
    res.json({
      statuses: Object.entries(GALA_STATUS).map(([value, label]) => ({ value, label })),
      trackerStatuses: TRACKER_STATUSES,
      transitions: GALA_TRANSITIONS,
      editableStatuses: [...EDITABLE_STATUSES],
      remarksRequired: [...REMARKS_REQUIRED_STATUSES],
      categories: GALA_CATEGORIES,
      formats: Object.entries(PRESENTATION_FORMATS).map(([value, label]) => ({ value, label })),
      semesters: GALA_SEMESTERS,
      schedulePreferences: Object.entries(SCHEDULE_PREFERENCES).map(([value, label]) => ({ value, label })),
      slots: GALA_SLOTS.map(slot => ({
        key: slot.key,
        label: slot.label,
        labelOral: slotLabel(slot, 'oral'),
        labelPoster: slotLabel(slot, 'poster'),
        accept: slotAcceptText(slot),
        extensions: slotExtensions(slot)
      })),
      limits: LIMITS,
      schoolYears: years.years,
      currentSchoolYear: years.current,
      events: events.map(e => ({ id: e.id, title: e.title, dateTime: e.dateTime })),
      presenterName: isPresenter(me) ? (me.fullName || me.username) : '',
      // Only a colour hint in the admin table; it never blocks anything.
      similarityWarnPercent: isReviewer(me) ? (Number(process.env.SIMILARITY_WARN_PERCENT) || 25) : undefined
    });
  }));

  // ---- Grammar suggestions (advisory) ----
  // Never blocks anything: if the checker is down the answer is simply
  // { available: false } and the form carries on.
  router.post('/grammar', authenticate, presenterOnly, handle(async (req, res) => {
    const text = String((req.body || {}).text ?? '');
    if (text.length > Math.min(LIMITS.abstractCharsMax, GRAMMAR_MAX_CHARS)) {
      return res.status(400).json({ error: `Text is too long to check (max ${LIMITS.abstractCharsMax} characters).` });
    }
    const now = Date.now();
    const last = lastGrammarCall.get(req._me.id) || 0;
    if (now - last < GRAMMAR_GAP_MS) {
      return res.status(429).json({ error: 'Please wait a few seconds before checking again.' });
    }
    lastGrammarCall.set(req._me.id, now);
    if (lastGrammarCall.size > 2000) {
      for (const [id, at] of lastGrammarCall) if (now - at > 60000) lastGrammarCall.delete(id);
    }
    const result = await grammarCheck(text);
    return res.json({ available: result.available, reason: result.reason || null, issues: result.issues || [] });
  }));

  // ---- Create a draft ----
  router.post('/', authenticate, presenterOnly, handle(async (req, res) => {
    const me = req._me;
    const id = randomUUID();
    const now = nowIso();
    const name = me.fullName || me.username;

    const row = {
      id,
      userId: me.id,
      submitterName: name,
      eventId: '',
      title: '',
      authors: name,
      // Profile details carried over from the presenter's account, as before.
      institution: String(me.institution || '').trim(),
      nationality: String(me.nationality || '').trim(),
      contactNumber: String(me.contactNumber || '').trim(),
      researchInterests: String(me.researchInterests || '').trim(),
      presentationType: '',
      strand: '',
      keywords: '',
      abstractText: '',
      status: 'draft',
      reviewNote: '',
      reviewedBy: null,
      reviewedAt: null,
      statusHistory: JSON.stringify([]),
      files: JSON.stringify([]),
      presenters: JSON.stringify([name]),
      coAuthors: JSON.stringify([]),
      program: '',
      category: '',
      adviser: '',
      schoolYear: '',
      semester: '',
      schedulePreference: 'none',
      draftStep: 1,
      createdAt: now,
      updatedAt: now
    };
    await store.insert(row);

    // Anything sent with the request is applied through the normal save path.
    const body = req.body || {};
    let problems = [];
    let saved = await store.get(id);
    if (Object.keys(body).length) {
      const result = await withLock(id, () => applyEdits(saved, me, body, { strict: false }));
      if (result.error) {
        await store.remove(id);
        return res.status(result.status).json({ error: result.error, problems: result.problems });
      }
      saved = result.row;
      problems = result.problems;
    } else {
      problems = validateEntry(entryOf(saved), []);
    }

    await log('gala_draft_created', `Research Gala draft started by ${name}.`, req);
    return res.status(201).json({ message: 'Draft started.', submission: present(saved, me), problems });
  }));

  // Shared by create-with-body and PATCH. Returns { row, problems } or
  // { error, status, problems }. Must be called inside withLock(id).
  async function applyEdits(current, me, body, { strict }) {
    const tagErrors = checkTagLists(body);
    if (tagErrors.length) return { status: 400, error: tagErrors[0], problems: [] };
    const norm = normalizeEntry(body);

    // Closed lists: an unknown value is dropped (and reported as missing).
    if (norm.category && !GALA_CATEGORIES.some(c => c.value === norm.category)) norm.category = '';
    if (norm.presentationType && !PRESENTATION_FORMATS[norm.presentationType]) norm.presentationType = '';
    if (norm.semester && !GALA_SEMESTERS.some(s => s.value === norm.semester)) norm.semester = '';
    if (norm.schedulePreference && !SCHEDULE_PREFERENCES[norm.schedulePreference]) norm.schedulePreference = 'none';

    if (norm.eventId) {
      if (!(await store.eventExists(norm.eventId))) {
        return { status: 400, error: 'The selected Research Gala event does not exist.', problems: [] };
      }
    }

    // Program and School Year are validated against the shared lists, each on
    // its own: the shared validator stops at the first bad field, and a bad
    // School Year must not slip through just because Program was bad too.
    const notes = [];
    const listedKeys = [];
    if (norm.program !== undefined) listedKeys.push('program');
    if (norm.schoolYear !== undefined) listedKeys.push('school_year');
    for (const key of listedKeys) {
      const listed = await resolveListed({
        body: { program: norm.program, program_mode: body.programMode, school_year: norm.schoolYear },
        existing: { program: current.program, school_year: current.schoolYear },
        keys: [key]
      });
      if (listed.error) {
        notes.push({ step: 1, field: key === 'school_year' ? 'schoolYear' : key, message: listed.error });
        if (key === 'program') norm.program = '';
        else norm.schoolYear = '';
      } else if (key === 'program') {
        norm.program = listed.values.program;
      } else {
        norm.schoolYear = listed.values.school_year;
      }
    }

    // The signed-in presenter is always one of the presenters.
    const ownName = me.fullName || me.username;
    const merged = { ...entryOf(current), ...norm };
    if (norm.presenters !== undefined) {
      if (!merged.presenters.some(p => p.toLowerCase() === ownName.toLowerCase())) {
        merged.presenters = [ownName, ...merged.presenters].slice(0, LIMITS.presentersMax);
      }
      norm.presenters = merged.presenters;
    }

    const files = filesOf(current);
    // A specific complaint about a listed value ("choose from the list") replaces
    // the generic "required" one for the same field.
    const specific = new Map(notes.map(n => [n.field, n]));
    const problems = validateEntry(merged, files).map(p => specific.get(p.field) || p);

    // A Submitted entry is already in front of the admins, so an edit may not
    // break any field it touches. Fields it does not touch are left alone, which
    // keeps an older, incomplete row editable one field at a time.
    if (strict) {
      const touched = new Set(Object.keys(norm));
      const blocking = problems.filter(p => touched.has(p.field));
      if (blocking.length) {
        return {
          status: 422,
          error: `These changes would leave the submission incomplete: ${blocking[0].message}`,
          problems
        };
      }
    }

    const changes = recordChanges(norm, merged);
    const step = Number(body.step);
    if (Number.isInteger(step) && step >= 1 && step <= 3) changes.draftStep = step;
    changes.updatedAt = nowIso();
    await store.update(current.id, changes);
    return { row: await store.get(current.id), problems };
  }

  // ---- Save draft / edit ----
  router.patch('/:id', authenticate, presenterOnly, loadOwned, requireEditable, handle(async (req, res) => {
    const me = req._me;
    const id = req.params.id;
    const result = await withLock(id, async () => {
      // Re-read inside the lock: an upload may have landed since the guard ran.
      const current = await store.get(id);
      if (!current || !EDITABLE_STATUSES.has(current.status)) return { status: 409, error: 'This submission can no longer be edited.' };
      // A Submitted entry is already in front of the admins, so it must stay
      // complete. A draft or a For Revision entry may be saved half-finished.
      return applyEdits(current, me, req.body || {}, { strict: current.status === 'submitted' });
    });
    if (result.error) return res.status(result.status).json({ error: result.error, problems: result.problems || [] });

    await log('gala_draft_saved', `Research Gala entry ${result.row.refNo || result.row.id} saved by ${me.fullName || me.username}.`, req);
    return res.json({ message: 'Saved.', submission: present(result.row, me), problems: result.problems });
  }));

  // ---- Documents ----
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: LIMITS.maxFileBytes, files: 1 }
  });
  const uploadOne = upload.single('file');

  const slotGuard = (req, res, next) => {
    const slot = slotByKey(req.params.slot);
    if (!slot) return res.status(404).json({ error: 'Unknown document type.' });
    req._slot = slot;
    return next();
  };

  router.post('/:id/files/:slot', authenticate, presenterOnly, loadOwned, requireEditable, slotGuard, uploadOne, handle(async (req, res) => {
    const me = req._me;
    const slot = req._slot;
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file was received. Choose a PDF or Word document.' });

    const problem = checkUpload({ slot, originalName: file.originalname, buffer: file.buffer });
    if (problem) return res.status(400).json({ error: problem });

    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const ext = extname(file.originalname).toLowerCase();

    const result = await withLock(req.params.id, async () => {
      const current = await store.get(req.params.id);
      if (!current || !EDITABLE_STATUSES.has(current.status)) {
        return { status: 409, error: 'This submission can no longer be edited.' };
      }
      const format = current.presentationType;
      const files = filesOf(current);

      const sameElsewhere = files.find(f => f.sha256 === sha256 && f.slot !== slot.key && slotByKey(f.slot));
      if (sameElsewhere) {
        const other = slotLabel(slotByKey(sameElsewhere.slot), format);
        return { status: 409, error: `This exact file is already attached as "${other}". Each document must be a different file.` };
      }
      const sameHere = files.find(f => f.sha256 === sha256 && f.slot === slot.key);
      if (sameHere) {
        return { status: 409, error: `That exact file is already attached as "${slotLabel(slot, format)}".` };
      }

      const path = `submissions/${current.userId}/${current.id}/final/${slot.key}-${randomUUID()}${ext}`;
      const backend = await fileStore.save({ path, buffer: file.buffer, contentType: MIME_BY_EXT[ext] });

      const previous = files.find(f => f.slot === slot.key);
      const kept = files.filter(f => f.slot !== slot.key);
      const record = {
        slot: slot.key,
        originalName: file.originalname.slice(0, 200),
        size: file.size,
        sha256,
        storagePath: path,
        backend,
        uploadedAt: nowIso()
      };
      try {
        await store.update(current.id, { files: JSON.stringify([...kept, record]), updatedAt: nowIso() });
      } catch (err) {
        await fileStore.remove({ path, backend });
        throw err;
      }
      if (previous?.storagePath) await fileStore.remove({ path: previous.storagePath, backend: previous.backend });
      return { row: await store.get(current.id), replaced: Boolean(previous), record };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });

    await log(
      'gala_file_uploaded',
      `${result.replaced ? 'Replaced' : 'Attached'} "${slot.label}" (${result.record.originalName}, ${result.record.size} bytes) on Research Gala entry ${result.row.refNo || result.row.id}.`,
      req
    );
    return res.json({
      message: `${slotLabel(slot, result.row.presentationType)} ${result.replaced ? 'replaced' : 'attached'}.`,
      submission: present(result.row, me),
      problems: validateEntry(entryOf(result.row), filesOf(result.row))
    });
  }));

  router.delete('/:id/files/:slot', authenticate, presenterOnly, loadOwned, requireEditable, slotGuard, handle(async (req, res) => {
    const me = req._me;
    const slot = req._slot;
    const result = await withLock(req.params.id, async () => {
      const current = await store.get(req.params.id);
      if (!current || !EDITABLE_STATUSES.has(current.status)) return { status: 409, error: 'This submission can no longer be edited.' };
      // A Submitted entry must keep every required document; replace instead.
      if (current.status === 'submitted') {
        return { status: 409, error: 'A submitted entry must keep all of its required documents. Upload a replacement instead.' };
      }
      const files = filesOf(current);
      const target = files.find(f => f.slot === slot.key);
      if (!target) return { status: 404, error: 'That document is not attached.' };
      await store.update(current.id, { files: JSON.stringify(files.filter(f => f.slot !== slot.key)), updatedAt: nowIso() });
      if (target.storagePath) await fileStore.remove({ path: target.storagePath, backend: target.backend });
      return { row: await store.get(current.id), target };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });

    await log('gala_file_removed', `Removed "${slot.label}" (${result.target.originalName}) from Research Gala entry ${result.row.refNo || result.row.id}.`, req);
    return res.json({
      message: `${slot.label} removed.`,
      submission: present(result.row, me),
      problems: validateEntry(entryOf(result.row), filesOf(result.row))
    });
  }));

  // Owner or reviewer. Anyone else gets the same 404 as a missing entry.
  async function loadViewable(req, res) {
    const me = req._me;
    if (!isReviewer(me) && !isPresenter(me)) {
      res.status(403).json({ error: 'Only Presenter accounts can use the Research Gala submission form.' });
      return null;
    }
    const s = await store.get(req.params.id);
    if (!s || !(isReviewer(me) || isOwner(me, s))) {
      res.status(404).json({ error: 'Submission not found.' });
      return null;
    }
    // A reviewer has nothing to do with a draft the presenter has not submitted.
    if (s.status === 'draft' && !isOwner(me, s)) {
      res.status(404).json({ error: 'Submission not found.' });
      return null;
    }
    return s;
  }

  router.get('/:id/files/:slot', authenticate, withCaller, slotGuard, handle(async (req, res) => {
    const s = await loadViewable(req, res);
    if (!s) return undefined;
    const file = filesOf(s).find(f => f.slot === req._slot.key);
    if (!file?.storagePath) return res.status(404).json({ error: 'That document has not been attached.' });

    const stream = await fileStore.open({ path: file.storagePath, backend: file.backend }).catch((err) => {
      console.error('[gala] could not open a stored document:', err.message);
      return undefined;
    });
    if (stream === undefined) return res.status(503).json({ error: 'The document store is unavailable right now. Please try again shortly.' });
    if (!stream) return res.status(404).json({ error: 'The stored file could not be found.' });

    const ext = extname(file.storagePath).toLowerCase();
    const inline = req.query.inline === '1' && ext === '.pdf';
    res.setHeader('Content-Type', MIME_BY_EXT[ext] || 'application/octet-stream');
    res.setHeader('Content-Disposition', dispositionHeader(file.originalName, inline));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    stream.on('error', (err) => {
      console.error('[gala] document stream failed:', err.message);
      res.destroy(err);
    });
    return stream.pipe(res);
  }));

  // ---- Final submit ----
  router.post('/:id/submit', authenticate, presenterOnly, loadOwned, handle(async (req, res) => {
    const me = req._me;
    const id = req.params.id;
    if (!(req.body && (req.body.confirm === true || req.body.confirm === 'true'))) {
      return res.status(400).json({ error: 'Please tick the confirmation box before submitting.' });
    }

    const result = await withLock(id, async () => {
      const current = await store.get(id);
      if (!current || current.userId !== me.id) return { status: 404, error: 'Submission not found.' };
      if (!['draft', 'for_revision'].includes(current.status)) {
        return {
          status: 409,
          error: current.status === 'submitted'
            ? 'This submission has already been submitted.'
            : `This submission is ${GALA_STATUS[current.status] || current.status} and cannot be submitted.`
        };
      }

      const entry = entryOf(current);
      const files = filesOf(current);
      const problems = validateEntry(entry, files);
      if (problems.length) {
        return { status: 422, error: problems[0].message, problems };
      }
      if (await store.titleTaken(me.id, entry.title, current.id)) {
        return {
          status: 409,
          error: 'You already have another submission with this title. Change the title or open the existing entry.',
          problems: [{ step: 1, field: 'title', message: 'You already have another submission with this title.' }]
        };
      }

      const resubmission = current.status === 'for_revision';
      let refNo = current.refNo;
      if (!refNo) {
        do { refNo = makeRefNo(); } while (await store.refNoTaken(refNo));
      }
      const now = nowIso();
      const history = parseJsonColumn(current.statusHistory, []) || [];
      history.push({
        kind: 'status',
        status: 'submitted',
        at: now,
        by: me.fullName || me.username,
        byId: me.id,
        note: resubmission ? 'Resubmitted after revision.' : ''
      });
      await store.update(id, {
        status: 'submitted',
        refNo,
        statusHistory: JSON.stringify(history),
        submittedAt: now,
        draftStep: 3,
        updatedAt: now
      });
      return { row: await store.get(id), resubmission, refNo };
    });
    if (result.error) return res.status(result.status).json({ error: result.error, problems: result.problems || [] });

    const row = result.row;
    const name = me.fullName || me.username;
    await log(
      result.resubmission ? 'gala_resubmitted' : 'gala_submitted',
      `Research Gala entry ${result.refNo} "${row.title}" ${result.resubmission ? 'resubmitted after revision' : 'submitted'} by ${name}.`,
      req
    );
    await notifyPerson(me.id, {
      action: 'gala_submitted',
      title: 'Research Gala submission received',
      message: `Your final paper ${quote(row.title)} was submitted. Your reference number is ${result.refNo}.`,
      link: `gala-submission.html?id=${row.id}`
    });
    await notifyReviewers({
      action: 'gala_submitted',
      title: result.resubmission ? 'Research Gala resubmission' : 'New Research Gala submission',
      message: `${name} ${result.resubmission ? 'resubmitted' : 'submitted'} ${quote(row.title)} (${result.refNo}).`,
      link: 'admin-dashboard.html'
    });
    return res.json({
      message: 'Your final paper was submitted.',
      refNo: result.refNo,
      submission: present(row, me)
    });
  }));

  // ---- List ----
  router.get('/', authenticate, withCaller, handle(async (req, res) => {
    const me = req._me;
    const reviewer = isReviewer(me);
    if (!reviewer && !isPresenter(me)) {
      return res.status(403).json({ error: 'Only Presenter accounts can use the Research Gala submission form.' });
    }
    const q = req.query || {};
    const filters = {};

    if (!reviewer) {
      filters.userId = me.id;
    } else {
      filters.excludeDrafts = true;
    }
    if (q.status) {
      if (!GALA_STATUS[q.status]) return res.status(400).json({ error: 'Invalid status filter.' });
      filters.statuses = [q.status];
    }
    if (reviewer) {
      if (q.category) filters.category = String(q.category);
      if (q.presentationType) filters.presentationType = String(q.presentationType);
      if (q.schoolYear) filters.schoolYear = String(q.schoolYear);
      if (q.q) filters.q = String(q.q).trim().slice(0, 80);
    }

    const [rows, events] = await Promise.all([store.list(filters), store.events()]);
    const body = { submissions: rows.map(s => present(s, me, { events })) };
    if (reviewer) body.facets = { schoolYears: await store.schoolYearsInUse() };
    return res.json(body);
  }));

  // ---- Program export ----
  router.get('/export', authenticate, reviewGate, withCaller, handle(async (req, res) => {
    const q = req.query || {};
    const format = String(q.format || 'pdf').toLowerCase();
    if (!['pdf', 'xlsx'].includes(format)) return res.status(400).json({ error: 'Export format must be pdf or xlsx.' });

    const filters = { excludeDrafts: true };
    if (q.status) {
      if (!GALA_STATUS[q.status] || q.status === 'draft') return res.status(400).json({ error: 'Invalid status filter.' });
      filters.statuses = [q.status];
    } else if (q.include !== 'all') {
      // The program is who presents when: scheduled and already-presented entries.
      filters.statuses = ['scheduled', 'presented'];
    }
    if (q.category) filters.category = String(q.category);
    if (q.presentationType) filters.presentationType = String(q.presentationType);
    if (q.schoolYear) filters.schoolYear = String(q.schoolYear);

    const rows = await store.list(filters);
    const parts = [];
    if (filters.schoolYear) parts.push(`School Year ${filters.schoolYear}`);
    if (filters.category) parts.push(categoryLabel(filters.category));
    if (filters.presentationType) parts.push(formatLabel(filters.presentationType));
    parts.push(q.include === 'all' ? 'All submitted entries' : 'Scheduled presentations');
    const options = { heading: parts.join(' - '), generatedAt: new Date() };

    const flat = programRows(rows);
    const stamp = new Date().toISOString().slice(0, 10);
    const data = format === 'pdf' ? buildProgramPdf(flat, options) : buildProgramXlsx(flat, options);
    await log('gala_exported', `Research Gala program exported as ${format.toUpperCase()} (${flat.length} row${flat.length === 1 ? '' : 's'}; ${options.heading}).`, req);

    res.setHeader('Content-Type', format === 'pdf'
      ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', dispositionHeader(`cpri-research-gala-program-${stamp}.${format}`, false));
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(data);
  }));

  // ---- Read one ----
  router.get('/:id', authenticate, withCaller, handle(async (req, res) => {
    const me = req._me;
    const s = await loadViewable(req, res);
    if (!s) return undefined;
    const events = s.eventId ? await store.events() : null;
    return res.json({
      submission: present(s, me, { events }),
      canReview: isReviewer(me)
    });
  }));

  // ---- Reviewer: status, remarks, schedule ----
  router.patch('/:id/status', authenticate, reviewGate, withCaller, handle(async (req, res) => {
    const me = req._me;
    const b = req.body || {};
    const wantStatus = b.status === undefined || b.status === '' ? null : String(b.status);
    if (wantStatus && (!GALA_STATUS[wantStatus] || wantStatus === 'draft')) {
      return res.status(400).json({ error: 'Invalid status. Use submitted, under_checking, for_revision, scheduled, presented, or rejected.' });
    }
    const remarksIn = b.remarks !== undefined ? b.remarks : b.note;
    const remarks = remarksIn === undefined ? undefined : String(remarksIn).trim();
    if (remarks !== undefined && remarks.length > LIMITS.remarksMax) {
      return res.status(400).json({ error: `Remarks must be ${LIMITS.remarksMax} characters or fewer.` });
    }
    const scheduleTouched = ['scheduleDate', 'scheduleTime', 'scheduleRoom'].some(k => b[k] !== undefined);

    // Turnitin result, typed in by hand. Advisory: nothing reads it to allow or
    // refuse a status move. An empty value clears it.
    const similarityTouched = b.similarityScore !== undefined || b.similarityReportUrl !== undefined;
    let similarityScore;
    let similarityUrl;
    if (b.similarityScore !== undefined) {
      const raw = String(b.similarityScore).trim().replace(/%$/, '');
      if (raw === '') {
        similarityScore = null;
      } else {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0 || n > 100) {
          return res.status(400).json({ error: 'The similarity score must be a number from 0 to 100.' });
        }
        similarityScore = Math.round(n * 100) / 100;
      }
    }
    if (b.similarityReportUrl !== undefined) {
      const raw = String(b.similarityReportUrl).trim();
      if (raw === '') {
        similarityUrl = null;
      } else if (!isHttpUrl(raw) || raw.length > LIMITS.reportUrlMax) {
        return res.status(400).json({ error: 'The report link must start with http:// or https://.' });
      } else {
        similarityUrl = raw;
      }
    }

    const result = await withLock(req.params.id, async () => {
      const s = await store.get(req.params.id);
      if (!s) return { status: 404, error: 'Submission not found.' };
      if (s.status === 'draft') return { status: 409, error: 'This is still a draft. The presenter has not submitted it yet.' };

      const statusChanges = Boolean(wantStatus) && wantStatus !== s.status;
      if (statusChanges && !(GALA_TRANSITIONS[s.status] || []).includes(wantStatus)) {
        const allowed = (GALA_TRANSITIONS[s.status] || []).map(x => GALA_STATUS[x]).join(', ') || 'none';
        return { status: 409, error: `An entry that is ${GALA_STATUS[s.status]} cannot move to ${GALA_STATUS[wantStatus]}. Allowed next statuses: ${allowed}.` };
      }
      const nextStatus = statusChanges ? wantStatus : s.status;

      // Schedule: all three parts together, or none (which clears it).
      let date = s.scheduleDate || '';
      let time = s.scheduleTime || '';
      let room = s.scheduleRoom || '';
      if (scheduleTouched) {
        date = b.scheduleDate !== undefined ? String(b.scheduleDate).trim() : date;
        time = b.scheduleTime !== undefined ? String(b.scheduleTime).trim() : time;
        room = b.scheduleRoom !== undefined ? String(b.scheduleRoom).replace(/\s+/g, ' ').trim() : room;
        const any = date || time || room;
        if (any) {
          if (!isValidDate(date)) return { status: 400, error: 'Enter the presentation date.' };
          if (!isValidClock(time)) return { status: 400, error: 'Enter the presentation time.' };
          if (!room) return { status: 400, error: 'Enter the room.' };
          if (room.length > LIMITS.roomMax) return { status: 400, error: `Room must be ${LIMITS.roomMax} characters or fewer.` };
        }
        if (!any && nextStatus === 'scheduled') {
          return { status: 400, error: 'A Scheduled entry needs a date, time and room.' };
        }
      }
      if (statusChanges && nextStatus === 'scheduled' && !(isValidDate(date) && isValidClock(time) && room)) {
        return { status: 400, error: 'To mark an entry Scheduled, assign a date, time and room.' };
      }
      if (statusChanges && REMARKS_REQUIRED_STATUSES.has(nextStatus) && !remarks) {
        return { status: 400, error: `Add remarks explaining why this is ${GALA_STATUS[nextStatus]}, so the presenter knows what to do next.` };
      }

      const scheduleChanges = scheduleTouched
        && (date !== (s.scheduleDate || '') || time !== (s.scheduleTime || '') || room !== (s.scheduleRoom || ''));
      const remarksChange = remarks !== undefined && remarks !== (s.reviewNote || '');

      const nextScore = similarityScore !== undefined ? similarityScore : (s.similarityScore ?? null);
      const nextUrl = similarityUrl !== undefined ? similarityUrl : (s.similarityReportUrl ?? null);
      const similarityChanges = similarityTouched
        && (Number(nextScore ?? -1) !== Number(s.similarityScore ?? -1) || (nextUrl || '') !== (s.similarityReportUrl || ''));

      if (!statusChanges && !scheduleChanges && !remarksChange && !similarityChanges) {
        return { status: 400, error: 'Nothing to change.' };
      }

      if ((scheduleChanges || statusChanges) && date && ['scheduled', 'presented'].includes(nextStatus)) {
        const clash = await store.scheduleConflict({ date, time, room, exceptId: s.id });
        if (clash) {
          return { status: 409, error: `That slot is already taken by "${clash.title}" (${formatDay(date)}, ${formatClock(time)}, ${room}). Pick another time or room.` };
        }
      }

      const now = nowIso();
      const reviewerName = me.fullName || me.username || 'Reviewer';
      const history = parseJsonColumn(s.statusHistory, []) || [];
      const scheduleText = date ? `${formatDay(date)}, ${formatClock(time)}, ${room}` : '';
      if (statusChanges) {
        history.push({ kind: 'status', status: nextStatus, at: now, by: reviewerName, byId: me.id, note: remarks || '' });
      } else if (scheduleChanges || remarksChange) {
        // `note` is what the presenter may read; `adminNote` is the full record.
        // A schedule that is not announced yet stays out of the presenter's view.
        const scheduleBit = scheduleChanges ? (scheduleText ? `Schedule set to ${scheduleText}.` : 'Schedule cleared.') : '';
        const remarksBit = remarksChange ? (remarks ? `Remarks: ${remarks}` : 'Remarks cleared.') : '';
        const announced = SCHEDULE_VISIBLE_STATUSES.has(nextStatus);
        history.push({
          kind: 'update',
          status: s.status,
          at: now,
          by: reviewerName,
          byId: me.id,
          note: [announced ? scheduleBit : '', remarksBit].filter(Boolean).join(' '),
          adminNote: [scheduleBit, remarksBit].filter(Boolean).join(' ')
        });
      }

      const changes = {
        status: nextStatus,
        reviewedBy: reviewerName,
        reviewedAt: now,
        statusHistory: JSON.stringify(history),
        updatedAt: now
      };
      if (remarks !== undefined) changes.reviewNote = remarks;
      if (similarityChanges) {
        changes.similarityScore = nextScore;
        changes.similarityReportUrl = nextUrl;
        changes.similarityCheckedAt = now;
        changes.similarityCheckedBy = reviewerName;
      }
      if (scheduleTouched) {
        changes.scheduleDate = date || null;
        changes.scheduleTime = time || null;
        changes.scheduleRoom = room || null;
      }
      await store.update(s.id, changes);
      return {
        before: s,
        row: await store.get(s.id),
        statusChanges,
        scheduleChanges,
        remarksChange,
        similarityChanges,
        nextStatus,
        scheduleText,
        remarks: remarks === undefined ? (s.reviewNote || '') : remarks
      };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });

    const { before, row } = result;
    // One audit entry per change, with before -> after, so the trail is readable.
    const ref = row.refNo || row.id;
    const trail = [];
    if (result.statusChanges) trail.push(`status ${GALA_STATUS[before.status]} -> ${GALA_STATUS[row.status]}`);
    if (result.scheduleChanges) {
      const was = before.scheduleDate ? `${formatDay(before.scheduleDate)}, ${formatClock(before.scheduleTime)}, ${before.scheduleRoom}` : 'none';
      trail.push(`schedule ${was} -> ${result.scheduleText || 'none'}`);
    }
    if (result.remarksChange) trail.push(result.remarks ? `remarks "${result.remarks.slice(0, 120)}"` : 'remarks cleared');
    if (result.similarityChanges) {
      const show = (score, url) => (score === null || score === undefined ? 'none' : `${Number(score)}%`) + (url ? ` (${url})` : '');
      trail.push(`Turnitin similarity ${show(before.similarityScore, before.similarityReportUrl)} -> ${show(row.similarityScore, row.similarityReportUrl)}`);
    }
    await log('gala_reviewed', `Research Gala entry ${ref} "${row.title}": ${trail.join('; ')}.`, req);

    // Tell the presenter. A schedule they cannot see yet (entry not Scheduled)
    // stays private, so it triggers nothing.
    const link = `gala-submission.html?id=${row.id}`;
    if (result.statusChanges) {
      await notifyPerson(row.userId, {
        action: 'gala_status',
        title: `Research Gala: ${GALA_STATUS[row.status]}`,
        message: statusMessage(row, row.status, result.remarks, result.scheduleText),
        link
      });
    } else if (SCHEDULE_VISIBLE_STATUSES.has(row.status) && result.scheduleChanges) {
      await notifyPerson(row.userId, {
        action: 'gala_schedule',
        title: 'Research Gala schedule updated',
        message: `The schedule for ${quote(row.title)} (${ref}) is now ${result.scheduleText || 'to be announced'}.`,
        link
      });
    } else if (result.remarksChange && result.remarks) {
      await notifyPerson(row.userId, {
        action: 'gala_remarks',
        title: 'New remarks on your Research Gala submission',
        message: `${quote(row.title)} (${ref}): ${result.remarks}`,
        link
      });
    }

    return res.json({
      message: result.statusChanges ? `Marked ${GALA_STATUS[row.status]}.` : 'Saved.',
      submission: present(row, me),
      statusLabel: GALA_STATUS[row.status]
    });
  }));

  // ---- Legacy download (abstract uploaded before the final-paper form) ----
  router.get('/:id/file/:filename', authenticate, withCaller, handle(async (req, res) => {
    const s = await loadViewable(req, res);
    if (!s) return undefined;
    const file = filesOf(s).find(f => !f.slot && f.filename === req.params.filename);
    if (!file) return res.status(404).json({ error: 'File not found.' });
    return res.download(join(LEGACY_GALA_UPLOAD_DIR, s.id, file.filename), file.originalName);
  }));

  // ---- Withdraw / remove ----
  router.delete('/:id', authenticate, withCaller, handle(async (req, res) => {
    const me = req._me;
    const isAdmin = me.role === 'admin' && me.status === 'active';
    if (!isAdmin && !isPresenter(me)) {
      return res.status(403).json({ error: 'Only Presenter accounts can use the Research Gala submission form.' });
    }
    const s = await store.get(req.params.id);
    if (!s || (s.userId !== me.id && !isAdmin)) return res.status(404).json({ error: 'Submission not found.' });
    if (!isAdmin && !WITHDRAWABLE_STATUSES.has(s.status)) {
      return res.status(409).json({ error: `A submission that is ${GALA_STATUS[s.status] || s.status} cannot be withdrawn. Contact the organizers.` });
    }
    await withLock(s.id, async () => {
      for (const f of filesOf(s)) {
        if (f.storagePath) await fileStore.remove({ path: f.storagePath, backend: f.backend });
      }
      await store.remove(s.id);
    });
    await log('gala_removed', `Research Gala entry ${s.refNo || s.id} "${s.title}" ${isAdmin && s.userId !== me.id ? 'removed by an administrator' : 'withdrawn'}.`, req);
    return res.json({ message: 'Submission removed.' });
  }));

  // Friendly JSON for oversized or rejected uploads (400, not the global 500).
  router.use(uploadErrorHandler({ label: 'Document', maxMb: LIMITS.maxFileBytes / (1024 * 1024) }));

  return router;
}

// ---------- Schema (additive, safe on every existing deployment) ----------
// Mirrored by hand in db/migrations/002_gala_submissions.sql (the table) and
// db/migrations/008_gala_final_paper.sql (the final-paper columns below).
const GALA_ADDED_COLUMNS = [
  ['refNo', 'varchar(30) DEFAULT NULL'],
  ['presenters', 'JSON DEFAULT NULL'],
  ['coAuthors', 'JSON DEFAULT NULL'],
  ['program', 'varchar(180) DEFAULT NULL'],
  ['category', 'varchar(60) DEFAULT NULL'],
  ['adviser', 'varchar(160) DEFAULT NULL'],
  ['schoolYear', 'varchar(40) DEFAULT NULL'],
  ['semester', 'varchar(20) DEFAULT NULL'],
  ['schedulePreference', "varchar(20) DEFAULT 'none'"],
  ['scheduleDate', 'varchar(10) DEFAULT NULL'],
  ['scheduleTime', 'varchar(5) DEFAULT NULL'],
  ['scheduleRoom', 'varchar(120) DEFAULT NULL'],
  ['draftStep', 'tinyint DEFAULT 1'],
  ['submittedAt', 'datetime DEFAULT NULL'],
  // Turnitin result typed in by an admin (migration 009). Advisory only.
  ['similarityScore', 'decimal(5,2) DEFAULT NULL'],
  ['similarityReportUrl', 'varchar(500) DEFAULT NULL'],
  ['similarityCheckedAt', 'datetime DEFAULT NULL'],
  ['similarityCheckedBy', 'varchar(160) DEFAULT NULL']
];

export async function ensureGalaSchema(dependencies = {}) {
  const runQuery = dependencies.run || (await import('./server/db/queries.js')).run;
  const allQuery = dependencies.all || (await import('./server/db/queries.js')).all;
  await runQuery(`
    CREATE TABLE IF NOT EXISTS gala_submissions (
      id varchar(36) NOT NULL,
      userId varchar(36) DEFAULT NULL,
      submitterName varchar(160) DEFAULT NULL,
      eventId varchar(36) DEFAULT NULL,
      title varchar(255) DEFAULT NULL,
      authors varchar(255) DEFAULT NULL,
      institution varchar(180) DEFAULT NULL,
      nationality varchar(80) DEFAULT NULL,
      contactNumber varchar(60) DEFAULT NULL,
      researchInterests text DEFAULT NULL,
      presentationType varchar(40) DEFAULT 'oral',
      strand varchar(120) DEFAULT NULL,
      keywords varchar(255) DEFAULT NULL,
      abstractText text DEFAULT NULL,
      status varchar(40) DEFAULT 'submitted',
      reviewNote text DEFAULT NULL,
      reviewedBy varchar(160) DEFAULT NULL,
      reviewedAt datetime DEFAULT NULL,
      statusHistory JSON DEFAULT NULL,
      files JSON DEFAULT NULL,
      createdAt datetime DEFAULT NULL,
      updatedAt datetime DEFAULT NULL,
      PRIMARY KEY (id),
      KEY idx_gala_user (userId),
      KEY idx_gala_event (eventId),
      KEY idx_gala_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Final-paper columns: added only when missing, so a re-run changes nothing.
  const have = new Set((await allQuery('SHOW COLUMNS FROM gala_submissions')).map(c => c.Field));
  const added = [];
  for (const [name, ddl] of GALA_ADDED_COLUMNS) {
    if (have.has(name)) continue;
    await runQuery(`ALTER TABLE gala_submissions ADD COLUMN ${name} ${ddl}`);
    added.push(name);
  }
  if (added.length) console.log(`[schema] added missing gala_submissions columns: ${added.join(', ')}`);

  const indexes = new Set((await allQuery('SHOW INDEX FROM gala_submissions')).map(i => i.Key_name));
  if (!indexes.has('uq_gala_refno')) {
    await runQuery('ALTER TABLE gala_submissions ADD UNIQUE KEY uq_gala_refno (refNo)');
  }
  if (!indexes.has('idx_gala_schedule')) {
    await runQuery('ALTER TABLE gala_submissions ADD KEY idx_gala_schedule (scheduleDate, scheduleTime)');
  }

  // The status list changed with the final-paper form. Rows saved under the old
  // names move to their nearest new status once; afterwards these match nothing.
  await runQuery("UPDATE gala_submissions SET status = 'under_checking' WHERE status = 'under_review'");
  await runQuery("UPDATE gala_submissions SET status = 'scheduled' WHERE status = 'accepted'");
}

const router = createGalaRouter();

export { router as galaRouter, router as default };
