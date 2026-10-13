// ============================================================
//  CPRI — Research Gala submissions (Presenter role)
//
//    POST   /api/gala                    multipart, field "abstractFile"
//    GET    /api/gala                    own submissions (reviewers: all)
//    GET    /api/gala/:id                one submission (owner or reviewer)
//    PATCH  /api/gala/:id                edit own while not yet decided
//    PATCH  /api/gala/:id/status         reviewer decision
//    GET    /api/gala/:id/file/:name     download the uploaded abstract
//    DELETE /api/gala/:id                withdraw (owner) or remove (admin)
//
//  Design notes:
//   • A submission is always owned by the signed-in account
//     (req.session.userId) — never by an id taken from the request body.
//   • Reviewers (admin / CPRI staff) can read every submission and decide on
//     it; a presenter only ever sees their own.
//   • Every upload passes the shared extension + MIME allow-list in
//     server/lib/upload-safety.js, and multer's own 15 MB size cap, before a
//     single byte is written to disk.
//   • A submission may be linked to an event from the Events module; the id is
//     validated against events_module so a dangling link can never be stored.
//   • Statuses: submitted → under_review → accepted | rejected. Every change
//     records who made it and when (statusHistory) and lands in the audit log.
// ============================================================
import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { promises as fs } from 'fs';
import { requireAuth, requireRole, readUsers, ROLE_META } from './auth.js';
import { all, get, insert, update, remove } from './server/db/queries.js';
import { documentFileFilter, uploadErrorHandler } from './lib/upload-safety.js';
import { addLog } from './audit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const GALA_UPLOAD_DIR = join(__dirname, '..', 'public', 'assets', 'uploads', 'gala');

export const GALA_STATUS = {
  submitted: 'Submitted',
  under_review: 'Under Review',
  accepted: 'Accepted',
  rejected: 'Rejected'
};

export const PRESENTATION_TYPES = {
  oral: 'Oral Presentation',
  poster: 'Poster Presentation',
  both: 'Oral and Poster'
};

// A presenter registers for the Gala; students and faculty may also present,
// and an admin can file one on someone's behalf.
export const GALA_SUBMIT_ROLES = [
  'presenter',
  'student_researcher',
  'faculty_researcher',
  'non_teaching_researcher',
  'adviser',
  'admin'
];

// Who may move a submission through review.
export const GALA_REVIEW_ROLES = ['admin', 'cpri_staff'];

const MAX_ABSTRACT_BYTES = 15 * 1024 * 1024; // 15 MB, same as the other modules

const GALA_EDITABLE = [
  'eventId', 'title', 'authors', 'institution', 'nationality',
  'contactNumber', 'researchInterests', 'presentationType', 'strand',
  'keywords', 'abstractText'
];

async function caller(req) {
  const users = await readUsers();
  return users.find(u => u.id === req.session.userId) || null;
}

function isReviewer(me) {
  return !!me && GALA_REVIEW_ROLES.includes(me.role) && me.status === 'active';
}

function canView(me, s) {
  return isReviewer(me) || s.userId === me?.id;
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
  const authenticate = dependencies.requireAuth || requireAuth;
  const resolveCaller = dependencies.caller || caller;
  const log = dependencies.addLog || addLog;
  // The review gate is injectable so tests can exercise the decision route
  // without a database (requireRole looks the account up on every request).
  const reviewGate = dependencies.reviewGate || requireRole(...GALA_REVIEW_ROLES);

  const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
      const dir = join(GALA_UPLOAD_DIR, req._galaId);
      try { await fs.mkdir(dir, { recursive: true }); cb(null, dir); }
      catch (err) { cb(err); }
    },
    filename: (req, file, cb) => {
      const safe = file.fieldname.replace(/[^a-z0-9]/gi, '_');
      cb(null, `${safe}-${Date.now()}${extname(file.originalname)}`);
    }
  });
  const upload = multer({
    storage,
    limits: { fileSize: MAX_ABSTRACT_BYTES },
    fileFilter: documentFileFilter
  });
  const uploadAbstract = upload.fields([{ name: 'abstractFile', maxCount: 1 }]);

  // ---- Create ----
  router.post(
    '/',
    authenticate,
    (req, res, next) => { req._galaId = randomUUID(); next(); },
    uploadAbstract,
    async (req, res) => {
      const me = await resolveCaller(req);
      if (!me) return res.status(401).json({ error: 'Not authenticated.' });
      if (!GALA_SUBMIT_ROLES.includes(me.role)) {
        return res.status(403).json({ error: 'Your role is not allowed to submit a Research Gala entry.' });
      }

      const b = req.body || {};
      const required = ['title', 'authors', 'abstractText'];
      for (const field of required) {
        if (!b[field] || !String(b[field]).trim()) {
          return res.status(400).json({ error: `Field "${field}" is required.` });
        }
      }

      const presentationType = String(b.presentationType || 'oral').trim();
      if (!PRESENTATION_TYPES[presentationType]) {
        return res.status(400).json({ error: 'Please choose a valid presentation type: Oral, Poster, or both.' });
      }

      // Optional link to an event from the Events module — verified, never trusted.
      let eventId = b.eventId ? String(b.eventId).trim() : '';
      if (eventId) {
        const event = await query.get('SELECT id FROM events_module WHERE id = ?', [eventId]);
        if (!event) {
          return res.status(400).json({ error: 'The selected Research Gala event does not exist.' });
        }
      } else {
        eventId = '';
      }

      const file = req.files?.abstractFile?.[0];
      const now = new Date().toISOString();
      const submission = {
        id: req._galaId,
        userId: me.id,
        submitterName: me.fullName || me.username,
        eventId,
        title: String(b.title).trim(),
        authors: String(b.authors).trim(),
        institution: String(b.institution || me.institution || '').trim(),
        nationality: String(b.nationality || me.nationality || '').trim(),
        contactNumber: String(b.contactNumber || me.contactNumber || '').trim(),
        researchInterests: String(b.researchInterests || me.researchInterests || '').trim(),
        presentationType,
        strand: String(b.strand || '').trim(),
        keywords: String(b.keywords || '').trim(),
        abstractText: String(b.abstractText).trim(),
        status: 'submitted',
        reviewNote: '',
        reviewedBy: null,
        reviewedAt: null,
        statusHistory: JSON.stringify([{
          status: 'submitted',
          at: now,
          by: me.fullName || me.username,
          note: ''
        }]),
        files: JSON.stringify(file ? [{
          field: 'abstractFile',
          filename: file.filename,
          originalName: file.originalname,
          uploadedAt: now
        }] : []),
        createdAt: now,
        updatedAt: now
      };

      await query.insert('gala_submissions', submission);
      await log('gala_submitted', `Research Gala submission "${submission.title}" created.`, req);
      res.status(201).json({ message: 'Research Gala submission received.', submission });
    }
  );

  // ---- List ----
  router.get('/', authenticate, async (req, res) => {
    const me = await resolveCaller(req);
    if (!me) return res.status(401).json({ error: 'Not authenticated.' });

    const q = req.query || {};
    let sql = 'SELECT * FROM gala_submissions WHERE 1=1';
    const params = [];
    if (!isReviewer(me)) {
      sql += ' AND userId = ?';
      params.push(me.id);
    } else if (q.userId) {
      sql += ' AND userId = ?';
      params.push(q.userId);
    }
    if (q.status) {
      if (!GALA_STATUS[q.status]) return res.status(400).json({ error: 'Invalid status filter.' });
      sql += ' AND status = ?';
      params.push(q.status);
    }
    if (q.eventId) {
      sql += ' AND eventId = ?';
      params.push(q.eventId);
    }
    sql += ' ORDER BY createdAt DESC';

    const list = await query.all(sql, params);
    const events = await query.all('SELECT id, title, dateTime FROM events_module');
    const eventMap = new Map(events.map(e => [e.id, e]));

    res.json({
      submissions: list.map(s => ({
        ...s,
        statusLabel: GALA_STATUS[s.status] || s.status,
        presentationTypeLabel: PRESENTATION_TYPES[s.presentationType] || s.presentationType,
        eventTitle: s.eventId ? (eventMap.get(s.eventId)?.title || '') : '',
        eventDate: s.eventId ? (eventMap.get(s.eventId)?.dateTime || '') : ''
      }))
    });
  });

  // ---- Read one ----
  router.get('/:id', authenticate, async (req, res) => {
    const me = await resolveCaller(req);
    if (!me) return res.status(401).json({ error: 'Not authenticated.' });
    const s = await query.get('SELECT * FROM gala_submissions WHERE id = ?', [req.params.id]);
    if (!s) return res.status(404).json({ error: 'Submission not found.' });
    if (!canView(me, s)) return res.status(403).json({ error: 'Access denied.' });

    const event = s.eventId
      ? await query.get('SELECT id, title, dateTime, venue FROM events_module WHERE id = ?', [s.eventId])
      : null;

    res.json({
      submission: s,
      event,
      statusLabel: GALA_STATUS[s.status] || s.status,
      presentationTypeLabel: PRESENTATION_TYPES[s.presentationType] || s.presentationType,
      canReview: isReviewer(me)
    });
  });

  // ---- Edit own ----
  router.patch('/:id', authenticate, async (req, res) => {
    const me = await resolveCaller(req);
    if (!me) return res.status(401).json({ error: 'Not authenticated.' });
    const s = await query.get('SELECT * FROM gala_submissions WHERE id = ?', [req.params.id]);
    if (!s) return res.status(404).json({ error: 'Submission not found.' });
    if (s.userId !== me.id && !isReviewer(me)) {
      return res.status(403).json({ error: 'You can only edit your own submission.' });
    }
    // Once a decision is recorded the entry is closed to the applicant; an
    // admin can still correct it through the review screen.
    if (!isReviewer(me) && ['accepted', 'rejected'].includes(s.status)) {
      return res.status(409).json({ error: 'This submission has already been decided and can no longer be edited.' });
    }

    const b = req.body || {};
    const changes = {};
    for (const field of GALA_EDITABLE) {
      if (b[field] === undefined) continue;
      changes[field] = String(b[field]).trim();
    }
    if (changes.presentationType && !PRESENTATION_TYPES[changes.presentationType]) {
      return res.status(400).json({ error: 'Please choose a valid presentation type.' });
    }
    if (changes.eventId) {
      const event = await query.get('SELECT id FROM events_module WHERE id = ?', [changes.eventId]);
      if (!event) return res.status(400).json({ error: 'The selected Research Gala event does not exist.' });
    }
    if (!Object.keys(changes).length) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }
    changes.updatedAt = new Date().toISOString();
    await query.update('gala_submissions', s.id, changes);
    const updated = await query.get('SELECT * FROM gala_submissions WHERE id = ?', [s.id]);
    res.json({ message: 'Submission updated.', submission: updated });
  });

  // ---- Review decision ----
  router.patch('/:id/status', reviewGate, async (req, res) => {
    const { status, note } = req.body || {};
    if (!GALA_STATUS[status]) {
      return res.status(400).json({ error: 'Invalid status. Use submitted, under_review, accepted, or rejected.' });
    }
    const me = await resolveCaller(req);
    const s = await query.get('SELECT * FROM gala_submissions WHERE id = ?', [req.params.id]);
    if (!s) return res.status(404).json({ error: 'Submission not found.' });

    const statusHistory = s.statusHistory || [];
    statusHistory.push({
      status,
      at: new Date().toISOString(),
      by: me?.fullName || me?.username || 'Reviewer',
      note: note ? String(note).trim() : ''
    });

    await query.update('gala_submissions', s.id, {
      status,
      reviewNote: note ? String(note).trim() : (s.reviewNote || ''),
      reviewedBy: me?.fullName || me?.username || null,
      reviewedAt: new Date().toISOString(),
      statusHistory: JSON.stringify(statusHistory),
      updatedAt: new Date().toISOString()
    });

    await log('gala_reviewed', `Research Gala submission "${s.title}" set to ${GALA_STATUS[status]}.`, req);
    const updated = await query.get('SELECT * FROM gala_submissions WHERE id = ?', [s.id]);
    res.json({
      message: `Submission marked ${GALA_STATUS[status]}.`,
      submission: updated,
      statusLabel: GALA_STATUS[status]
    });
  });

  // ---- Download the uploaded abstract ----
  router.get('/:id/file/:filename', authenticate, async (req, res) => {
    const me = await resolveCaller(req);
    if (!me) return res.status(401).json({ error: 'Not authenticated.' });
    const s = await query.get('SELECT * FROM gala_submissions WHERE id = ?', [req.params.id]);
    if (!s) return res.status(404).json({ error: 'Submission not found.' });
    if (!canView(me, s)) return res.status(403).json({ error: 'Access denied.' });

    const file = (s.files || []).find(f => f.filename === req.params.filename);
    if (!file) return res.status(404).json({ error: 'File not found.' });
    res.download(join(GALA_UPLOAD_DIR, s.id, file.filename), file.originalName);
  });

  // ---- Withdraw / remove ----
  router.delete('/:id', authenticate, async (req, res) => {
    const me = await resolveCaller(req);
    if (!me) return res.status(401).json({ error: 'Not authenticated.' });
    const s = await query.get('SELECT * FROM gala_submissions WHERE id = ?', [req.params.id]);
    if (!s) return res.status(404).json({ error: 'Submission not found.' });
    const isAdmin = me.role === 'admin' && me.status === 'active';
    if (s.userId !== me.id && !isAdmin) {
      return res.status(403).json({ error: 'You can only withdraw your own submission.' });
    }
    if (s.userId === me.id && !isAdmin && ['accepted', 'rejected'].includes(s.status)) {
      return res.status(409).json({ error: 'A decided submission cannot be withdrawn. Contact the organizers.' });
    }
    await query.remove('gala_submissions', s.id);
    await log('gala_removed', `Research Gala submission "${s.title}" removed.`, req);
    res.json({ message: 'Submission removed.' });
  });

  // Friendly JSON for oversized or rejected uploads (400, not the global 500).
  router.use(uploadErrorHandler({ label: 'Abstract', maxMb: 15 }));

  return router;
}

// ---------- Schema (additive, safe on every existing deployment) ----------
export async function ensureGalaSchema(dependencies = {}) {
  const runQuery = dependencies.run || (await import('./server/db/queries.js')).run;
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
}

const router = createGalaRouter();

export { router as galaRouter, router as default };
