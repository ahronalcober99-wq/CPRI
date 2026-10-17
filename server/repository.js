import { Router } from 'express';
import { Readable } from 'stream';
import { randomUUID } from 'crypto';
import { readUsers, requireAuth, requireAdmin } from './auth.js';
import { all, get, run, insert, update, withTransaction } from './server/db/queries.js';
import { addLog } from './audit.js';
import { supabaseStorage } from './storage/supabase-storage.js';
import { profileOf, recommendationsFor } from './lib/recommendations.js';

// ---------- Access levels ----------
const ACCESS_LEVELS = {
  public_abstract: 'Public (abstract only)',
  viewable: 'Full text viewable (logged-in users)',
  downloadable: 'Full text downloadable (logged-in users)',
  restricted_staff: 'Restricted to CPRI Staff',
  restricted_institutional: 'Restricted to Institutional Users'
};

const CATEGORY_TYPES = {
  institutional: 'Institutional Research',
  faculty: 'Faculty Research',
  student_thesis: 'Student Thesis',
  capstone: 'Capstone',
  feasibility: 'Feasibility Study',
  action_research: 'Action Research',
  extension: 'Extension-Related Research',
  innovation: 'Innovation Project'
};

// ---------- Citation generation ----------
function generateCitations(r) {
  const yr = r.yearCompleted || 'n.d.';
  return {
    apa: `${r.authors} (${yr}). ${r.title}. ${r.department}.`,
    mla: `${r.authors}. "${r.title}." ${r.department}, ${yr}.`,
    institutional: `CPRI (${yr}). ${r.title}. ${r.authors}. ${r.department}.`
  };
}

// Can the given user access the full text of a record?
function canAccessFile(level, user) {
  switch (level) {
    case 'public_abstract': return false;
    case 'viewable':
    case 'downloadable':
    case 'restricted_institutional': return !!user;
    case 'restricted_staff': return !!user && ['admin', 'cpri_staff'].includes(user.role);
    default: return false;
  }
}

const PRIVILEGED_ROLES = new Set(['admin', 'cpri_staff']);
const PUBLIC_STATUSES = new Set(['approved', 'published']);
const MISSING_FILE_RESPONSE = {
  ok: false,
  message: 'The file is no longer available. Please ask the author to upload it again.'
};

function isPrivileged(user) {
  return Boolean(user && PRIVILEGED_ROLES.has(user.role));
}

function isPublicStatus(status) {
  return PUBLIC_STATUSES.has(String(status || '').toLowerCase());
}

// Who may DOWNLOAD a full text, as opposed to reading it on the page. The
// features document limits downloads to CPRI staff, the student who uploaded
// it, and advisers/facilitators; any other student researcher reads it in the
// browser only (GET /:id/file/view) and the download route refuses them.
const VIEW_ONLY_ROLES = new Set(['student_researcher']);

function mayDownloadFile(user, owner) {
  if (!user) return false;
  if (owner || isPrivileged(user)) return true;
  return !VIEW_ONLY_ROLES.has(user.role);
}

// Only a PDF can be shown in the browser's own viewer.
function isPdfFile(meta) {
  return Boolean(meta) && (meta.mime_type === 'application/pdf' ||
    /\.pdf$/i.test(String(meta.original_name || meta.storage_path || '')));
}

function manuscriptMetadata(files) {
  let decoded = files;
  if (typeof decoded === 'string') {
    try { decoded = JSON.parse(decoded); }
    catch { return null; }
  }
  const meta = decoded?.manuscript;
  return meta && typeof meta.storage_path === 'string' && meta.storage_path
    ? meta
    : null;
}

// Repository ids are UUIDs from randomUUID(), but older/demo rows may use short
// slugs — accept anything URL-safe and bounded before it reaches a query.
const REPOSITORY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// submissions.files is a JSON column that arrives already parsed through
// queryRow() or as raw text, depending on the driver path.
function parsedFiles(value) {
  if (value && typeof value === 'object') return { ...value };
  if (typeof value === 'string' && value) {
    try {
      const decoded = JSON.parse(value);
      return decoded && typeof decoded === 'object' ? { ...decoded } : null;
    } catch { return null; }
  }
  return null;
}

async function defaultOptionalUser(req) {
  if (!req.session || !req.session.userId) return null;
  const users = await readUsers();
  return users.find(u => u.id === req.session.userId) || null;
}

export function createRepositoryRouter(dependencies = {}) {
  const router = Router();
  const queries = {
    all: dependencies.all || all,
    get: dependencies.get || get,
    run: dependencies.run || run,
    insert: dependencies.insert || insert,
    update: dependencies.update || update
  };
  const resolveUser = dependencies.optionalUser || defaultOptionalUser;
  const storage = dependencies.storage || supabaseStorage;
  // Deleting touches two tables (the repository row and the linked
  // submission's file pointer), so it runs in one transaction. Tests inject
  // their own implementation.
  const transaction = dependencies.withTransaction || withTransaction;
  // Audit trail (system_logs): records who deleted what and when.
  const log = dependencies.log || addLog;
  // The app's real auth middleware gives exactly the required contract:
  // 401 when not signed in, 403 when the session is not an active admin.
  // Tests inject a pass-through because requireAdmin reads the real DB, while
  // the handler keeps an equivalent check of its own (defense in depth).
  const adminGuard = dependencies.adminGuard !== undefined
    ? dependencies.adminGuard
    : [requireAuth, requireAdmin];

// ---------- Public list with search & filter ----------
router.get('/', async (req, res) => {
  const user = await resolveUser(req);
  const privileged = isPrivileged(user);
  const q = req.query;
  let sql = `SELECT r.*, s.files AS files
             FROM repository r
             LEFT JOIN submissions s ON s.id = r.sourceSubmissionId
             WHERE 1=1`;
  const params = [];

  if (!privileged) {
    if (user?.id) {
      sql += ` AND (
        LOWER(COALESCE(r.status, '')) IN ('approved', 'published')
        OR EXISTS (
          SELECT 1 FROM submissions owner_sub
          WHERE owner_sub.id = r.sourceSubmissionId AND owner_sub.submitterId = ?
        )
      )`;
      params.push(user.id);
    } else {
      sql += ` AND LOWER(COALESCE(r.status, '')) IN ('approved', 'published')`;
    }
  }
  if (q.title) { sql += ' AND r.title LIKE ?'; params.push(`%${q.title}%`); }
  if (q.author) { sql += ' AND r.authors LIKE ?'; params.push(`%${q.author}%`); }
  if (q.department) { sql += ' AND r.department LIKE ?'; params.push(`%${q.department}%`); }
  if (q.program) { sql += ' AND r.department LIKE ?'; params.push(`%${q.program}%`); }
  if (q.year) { sql += ' AND r.yearCompleted = ?'; params.push(q.year); }
  if (q.keywords) { sql += ' AND r.keywords LIKE ?'; params.push(`%${q.keywords}%`); }
  if (q.category) { sql += ' AND r.category = ?'; params.push(q.category); }
  // The researcher's own category ("Life Sciences"), as typed on the form.
  if (q.researchCategory) { sql += ' AND r.researchCategory LIKE ?'; params.push(`%${q.researchCategory}%`); }
  if (q.facilitator) { sql += ' AND r.facilitator LIKE ?'; params.push(`%${q.facilitator}%`); }

  sql += ' ORDER BY r.yearCompleted DESC';
  const list = await queries.all(sql, params);

  res.json({
    records: list.map(r => ({
      id: r.id,
      title: r.title,
      authors: r.authors,
      department: r.department,
      category: r.category,
      categoryLabel: CATEGORY_TYPES[r.category] || r.category,
      researchCategory: r.researchCategory || '',
      adviser: r.adviser || '',
      facilitator: r.facilitator || '',
      yearCompleted: r.yearCompleted,
      status: r.status,
      accessLevel: r.accessLevel,
      accessLabel: ACCESS_LEVELS[r.accessLevel] || r.accessLevel,
      fileAvailable: Boolean(manuscriptMetadata(r.files))
    }))
  });
});

// ---------- Public detail ----------
router.get('/:id', async (req, res) => {
  const user = await resolveUser(req);
  const privileged = isPrivileged(user);
  const r = await queries.get('SELECT * FROM repository WHERE id = ?', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'Record not found.' });
  const sub = r.sourceSubmissionId
    ? await queries.get('SELECT id, submitterId, files FROM submissions WHERE id = ?', [r.sourceSubmissionId])
    : null;
  const owner = Boolean(user && sub && sub.submitterId === user.id);
  if (!isPublicStatus(r.status) && !owner && !privileged) {
    return res.status(404).json({ error: 'Record not found.' });
  }
  const access = canAccessFile(r.accessLevel, user);
  const meta = manuscriptMetadata(sub?.files);
  const fileAvailable = Boolean(meta);
  const record = { ...r, fileAvailable };
  delete record.sourceSubmissionId;
  const downloadLevel = ['downloadable', 'viewable', 'restricted_institutional', 'restricted_staff'].includes(r.accessLevel);
  res.json({
    record,
    categoryLabel: CATEGORY_TYPES[r.category] || r.category,
    accessLabel: ACCESS_LEVELS[r.accessLevel] || r.accessLevel,
    canView: access,
    canDownload: fileAvailable && access && downloadLevel && mayDownloadFile(user, owner),
    // Read on the page (a PDF in the browser's viewer), for everyone who may
    // open the full text — including those who may not download it.
    canViewInline: fileAvailable && access && downloadLevel && isPdfFile(meta),
    viewOnly: fileAvailable && access && downloadLevel && !mayDownloadFile(user, owner)
  });
});

// ---------- Recommended research ----------
// Related public entries, ranked by shared keywords, then category, then
// department (lib/recommendations.js). Readable by whoever may read the entry.
router.get('/:id/recommendations', async (req, res) => {
  const user = await resolveUser(req);
  const r = await queries.get('SELECT * FROM repository WHERE id = ?', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'Record not found.' });
  if (!isPublicStatus(r.status) && !isPrivileged(user)) {
    const sub = r.sourceSubmissionId
      ? await queries.get('SELECT id, submitterId FROM submissions WHERE id = ?', [r.sourceSubmissionId])
      : null;
    if (!(user && sub && sub.submitterId === user.id)) return res.status(404).json({ error: 'Record not found.' });
  }
  const recommendations = await recommendationsFor({
    all: queries.all,
    profile: profileOf({ keywords: r.keywords, categories: [r.category], department: r.department }),
    repositoryId: r.id,
    sourceId: r.sourceSubmissionId,
    categoryLabel: c => CATEGORY_TYPES[c]
  });
  res.json({ recommendations });
});

// ---------- Secure full-text file ----------
router.get('/:id/file', async (req, res) => {
  const user = await resolveUser(req);
  if (!user) return res.status(401).json({ error: 'Login required to access files.' });
  const r = await queries.get('SELECT * FROM repository WHERE id = ?', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'Record not found.' });
  const sub = r.sourceSubmissionId
    ? await queries.get('SELECT id, submitterId, files FROM submissions WHERE id = ?', [r.sourceSubmissionId])
    : null;
  const owner = Boolean(sub && sub.submitterId === user.id);
  const privileged = isPrivileged(user);
  if (!isPublicStatus(r.status) && !owner && !privileged) {
    return res.status(403).json({ error: 'This research item is not available for download.' });
  }
  if (!canAccessFile(r.accessLevel, user)) return res.status(403).json({ error: 'You do not have access to this file.' });
  if (!mayDownloadFile(user, owner)) {
    return res.status(403).json({ error: 'Your account can read this file on the page but not download it.', viewOnly: true });
  }

  const meta = manuscriptMetadata(sub?.files);
  if (!meta) return res.status(404).json(MISSING_FILE_RESPONSE);

  try {
    if (!await storage.objectExists(meta.storage_path)) {
      return res.status(404).json(MISSING_FILE_RESPONSE);
    }
    const url = await storage.createSignedDownloadUrl({
      path: meta.storage_path,
      downloadName: meta.original_name || 'download',
      expiresIn: 60
    });
    return res.json({ ok: true, url });
  } catch (error) {
    console.error('[repository] signed file download failed:', error.message);
    return res.status(502).json({ ok: false, message: 'Could not prepare the file download. Please try again.' });
  }
});

// ---------- Read the full text on the page ----------
// Streams the PDF through this server (never a signed link that could be
// shared) with `inline` disposition, so the browser shows it instead of
// saving it. Same access rules as the download, minus the download right.
router.get('/:id/file/view', async (req, res) => {
  const user = await resolveUser(req);
  if (!user) return res.status(401).json({ error: 'Login required to access files.' });
  const r = await queries.get('SELECT * FROM repository WHERE id = ?', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'Record not found.' });
  const sub = r.sourceSubmissionId
    ? await queries.get('SELECT id, submitterId, files FROM submissions WHERE id = ?', [r.sourceSubmissionId])
    : null;
  const owner = Boolean(sub && sub.submitterId === user.id);
  if (!isPublicStatus(r.status) && !owner && !isPrivileged(user)) {
    return res.status(403).json({ error: 'This research item is not available.' });
  }
  if (!canAccessFile(r.accessLevel, user)) return res.status(403).json({ error: 'You do not have access to this file.' });

  const meta = manuscriptMetadata(sub?.files);
  if (!meta) return res.status(404).json(MISSING_FILE_RESPONSE);
  if (!isPdfFile(meta)) {
    return res.status(415).json({ error: 'Only PDF files can be read in the browser.' });
  }

  try {
    const response = await storage.downloadObject({ path: meta.storage_path });
    if (!response || !response.body) return res.status(404).json(MISSING_FILE_RESPONSE);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    Readable.fromWeb(response.body).on('error', (err) => {
      console.error('[repository] file view stream failed:', err.message);
      if (!res.headersSent) res.status(502).end(); else res.end();
    }).pipe(res);
  } catch (error) {
    console.error('[repository] file view failed:', error.message);
    return res.status(502).json({ ok: false, message: 'Could not open the file. Please try again.' });
  }
});

// ---------- Admin: create (publish) ----------
router.post('/', async (req, res) => {
  const user = await resolveUser(req);
  if (!user || !['admin', 'cpri_staff'].includes(user.role)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });
  const b = req.body || {};
  let rec;
  if (b.submissionId) {
    const sub = await queries.get('SELECT * FROM submissions WHERE id = ?', [b.submissionId]);
    if (!sub) return res.status(404).json({ error: 'Submission not found.' });
    const year = (sub.schoolYear && sub.schoolYear.match(/\d{4}/g)) ? sub.schoolYear.match(/\d{4}/g).pop() : new Date(sub.createdAt).getFullYear();
    rec = {
      id: randomUUID(),
      sourceSubmissionId: sub.id,
      title: sub.title,
      authors: sub.authors,
      adviser: sub.adviser || '',
      facilitator: b.facilitator ? String(b.facilitator).trim() : null,
      department: sub.program,
      abstract: sub.abstract,
      keywords: sub.keywords || '',
      category: sub.researchType,
      researchCategory: sub.category || null,
      yearCompleted: String(year),
      status: sub.status,
      accessLevel: b.accessLevel && ACCESS_LEVELS[b.accessLevel] ? b.accessLevel : 'downloadable',
      fileAvailable: sub.files && sub.files.manuscript ? 1 : 0
    };
  } else {
    const required = ['title', 'authors', 'department', 'yearCompleted'];
    for (const f of required) if (!b[f]) return res.status(400).json({ error: `Field "${f}" is required.` });
    rec = {
      id: randomUUID(),
      sourceSubmissionId: null,
      title: String(b.title).trim(),
      authors: String(b.authors).trim(),
      adviser: b.adviser ? String(b.adviser).trim() : '',
      facilitator: b.facilitator ? String(b.facilitator).trim() : null,
      department: String(b.department).trim(),
      abstract: b.abstract ? String(b.abstract).trim() : '',
      keywords: b.keywords ? String(b.keywords).trim() : '',
      category: b.category || 'institutional',
      researchCategory: b.researchCategory ? String(b.researchCategory).trim() : null,
      yearCompleted: String(b.yearCompleted).trim(),
      status: b.status || 'published',
      accessLevel: b.accessLevel && ACCESS_LEVELS[b.accessLevel] ? b.accessLevel : 'downloadable',
      fileAvailable: false
    };
  }
  rec.citation = b.citation && b.citation.apa ? JSON.stringify(b.citation) : JSON.stringify(generateCitations(rec));
  rec.createdAt = new Date().toISOString();
  rec.updatedAt = rec.createdAt;

  await queries.insert('repository', rec);
  res.status(201).json({ message: 'Added to repository.', record: rec });
});

// ---------- Admin: update ----------
router.patch('/:id', async (req, res) => {
  const user = await resolveUser(req);
  if (!user || !['admin', 'cpri_staff'].includes(user.role)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });
  const b = req.body || {};
  const r = await queries.get('SELECT * FROM repository WHERE id = ?', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'Record not found.' });

  const changes = {};
  const editable = ['adviser', 'facilitator', 'department', 'abstract', 'keywords', 'category', 'researchCategory', 'yearCompleted', 'status', 'accessLevel', 'citation'];
  for (const f of editable) {
    if (b[f] !== undefined) {
      if (f === 'citation') {
        changes[f] = JSON.stringify(typeof b[f] === 'string' ? b[f] : b[f]);
      } else {
        changes[f] = (typeof b[f] === 'string') ? b[f].trim() : b[f];
      }
    }
  }
  if (b.accessLevel && !ACCESS_LEVELS[b.accessLevel]) return res.status(400).json({ error: 'Invalid access level.' });
  changes.updatedAt = new Date().toISOString();
  await queries.update('repository', req.params.id, changes);
  const updated = await queries.get('SELECT * FROM repository WHERE id = ?', [req.params.id]);
  res.json({ message: 'Record updated.', record: updated });
});

// ---------- Admin: delete ----------
// Admin-only (role === 'admin'): CPRI staff may add/update records but not
// destroy them. Anonymous callers get 401, non-admins 403, unknown ids 404.
//
// Hard delete, not soft: neither db/schema.sql nor server/init-db.sql has a
// deleted_at / is_deleted column, so the project has no soft-delete pattern to
// follow. Because the row is physically removed, every public listing, search,
// report and export query stops returning it with no extra filter.
//
// What else is removed: the uploaded manuscript. Repository rows only store a
// fileAvailable flag; the object path lives in the linked submission's files
// JSON, so the pointer is unlinked in the same transaction and the object is
// deleted from storage afterwards. A storage failure must not undo a deletion
// the admin already confirmed, so it is logged instead of thrown. The
// submission itself is kept — lib/repository-publishing.js already treats
// submissions and repository entries as separate records the owner still sees.
// The check for other repository rows pointing at the same submission avoids
// unlinking a file another record still uses.
// The deletion is written to system_logs (admin id, entry id, title, time).
router.delete('/:id', adminGuard, async (req, res) => {
  const user = await resolveUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });
  if (user.role !== 'admin' || user.status !== 'active') {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const id = String(req.params.id || '');
  if (!REPOSITORY_ID_PATTERN.test(id)) return res.status(404).json({ error: 'Record not found.' });
  const record = await queries.get('SELECT * FROM repository WHERE id = ?', [id]);
  if (!record) return res.status(404).json({ error: 'Record not found.' });

  const submission = record.sourceSubmissionId
    ? await queries.get('SELECT id, files FROM submissions WHERE id = ?', [record.sourceSubmissionId]).catch(() => null)
    : null;
  const manuscript = manuscriptMetadata(submission?.files);

  const removeStoredFile = await transaction(async (tx) => {
    await tx.run('DELETE FROM repository WHERE id = ?', [id]);
    if (!submission || !manuscript) return false;

    const siblings = await tx.all(
      'SELECT id FROM repository WHERE sourceSubmissionId = ? AND id <> ?',
      [submission.id, id]
    );
    if (siblings.length) return false;

    const files = parsedFiles(submission.files);
    if (!files) return false;
    delete files.manuscript;
    await tx.run(
      'UPDATE submissions SET files = ?, updatedAt = ? WHERE id = ?',
      [JSON.stringify(files), new Date().toISOString(), submission.id]
    );
    return true;
  });

  if (removeStoredFile) {
    try {
      await storage.deleteObjects([manuscript.storage_path]);
    } catch (error) {
      console.error(`[repository] deleted ${id} but could not remove its stored file:`, error.message);
    }
  }

  await log(
    'repository_delete',
    `Deleted repository entry "${record.title}" (${id})` + (manuscript ? ' including its uploaded file' : ''),
    req
  );

  res.json({ success: true, message: 'Repository entry deleted' });
});

  return router;
}

// ---------- Schema (additive, safe on existing databases) ----------
// `facilitator` and `researchCategory` (the researcher's own free-text
// category, e.g. "Life Sciences" — `category` holds the research TYPE key) were
// added later, so a database created before them gets them on boot. Nullable,
// so every existing row stays valid.
export async function ensureRepositorySchema(dependencies = {}) {
  const queries = { all: dependencies.all || all, run: dependencies.run || run };
  const columns = await queries.all('SHOW COLUMNS FROM repository');
  const existing = new Set(columns.map(c => String(c.Field || c.field || '').toLowerCase()));
  const columnsToAdd = [
    { name: 'facilitator', sql: 'ALTER TABLE repository ADD COLUMN facilitator VARCHAR(160) DEFAULT NULL' },
    { name: 'researchCategory', sql: 'ALTER TABLE repository ADD COLUMN researchCategory VARCHAR(160) DEFAULT NULL' }
  ];
  const added = [];
  for (const col of columnsToAdd) {
    if (existing.has(col.name.toLowerCase())) continue;
    try {
      await queries.run(col.sql);
      added.push(col.name);
    } catch (err) {
      if (!String(err && err.message).includes('Duplicate column name')) throw err;
    }
  }
  console.log(added.length
    ? `[schema] added missing repository columns: ${added.join(', ')}`
    : '[schema] repository columns: ok');
  return added;
}

const router = createRepositoryRouter();
export { router as repositoryRouter, ACCESS_LEVELS, CATEGORY_TYPES };
