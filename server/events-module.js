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
const UPLOAD_DIR = join(__dirname, '..', '..', 'public', 'assets', 'uploads', 'events-module');

const router = Router();

const PARTICIPANT_TYPES = {
  presenter: 'Research Presenter',
  attendee: 'Attendee'
};

const ABSTRACT_STATUS = {
  submitted: 'Submitted',
  under_review: 'Under Review',
  accepted: 'Accepted',
  rejected: 'Rejected'
};

const STAFF_ROLES = ['admin', 'cpri_staff'];

async function caller(req) {
  const users = await readUsers();
  return users.find(u => u.id === req.session.userId) || null;
}
function canEdit(me) {
  return !!me && STAFF_ROLES.includes(me.role);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = join(UPLOAD_DIR, req._eventId);
    fs.mkdir(dir, { recursive: true }, () => cb(null, dir));
  },
  filename: (req, file, cb) => {
    const safe = file.fieldname.replace(/[^a-z0-9]/gi, '_');
    cb(null, `${safe}-${Date.now()}${extname(file.originalname)}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } });
const uploadGallery = upload.fields([
  { name: 'photo', maxCount: 1 },
  { name: 'poster', maxCount: 1 },
  { name: 'certificate', maxCount: 1 }
]);

// ---------- Events ----------
router.get('/', async (req, res) => {
  const q = req.query;
  let sql = 'SELECT * FROM events_module WHERE 1=1';
  const params = [];

  if (q.title) { sql += ' AND title LIKE ?'; params.push(`%${q.title}%`); }
  if (q.theme) { sql += ' AND theme LIKE ?'; params.push(`%${q.theme}%`); }
  if (q.venue) { sql += ' AND venue LIKE ?'; params.push(`%${q.venue}%`); }
  if (q.fromDate) { sql += ' AND dateTime >= ?'; params.push(q.fromDate); }
  if (q.toDate) { sql += ' AND dateTime <= ?'; params.push(q.toDate); }

  sql += ' ORDER BY dateTime ASC';
  const list = await all(sql, params);

  res.json({
    events: list.map(e => ({
      id: e.id,
      title: e.title,
      theme: e.theme,
      dateTime: e.dateTime,
      venue: e.venue,
      description: e.description ? e.description.slice(0, 200) + (e.description.length > 200 ? '…' : '') : '',
      registrationLink: e.registrationLink,
      programFlow: e.programFlow,
      speakers: e.speakers,
      createdAt: e.createdAt
    }))
  });
});

router.get('/:id', async (req, res) => {
  const e = await get('SELECT * FROM events_module WHERE id = ?', [req.params.id]);
  if (!e) return res.status(404).json({ error: 'Event not found.' });
  res.json({ event: e });
});

router.post('/', requireAuth, async (req, res) => {
  const me = await caller(req);
  if (!me || !canEdit(me)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });

  const b = req.body || {};
  const required = ['title', 'theme', 'dateTime', 'venue'];
  for (const f of required) {
    if (!b[f]) return res.status(400).json({ error: `Field "${f}" is required.` });
  }

  const rec = {
    id: randomUUID(),
    title: String(b.title).trim(),
    theme: String(b.theme).trim(),
    dateTime: String(b.dateTime).trim(),
    venue: String(b.venue).trim(),
    description: b.description ? String(b.description).trim() : '',
    registrationLink: b.registrationLink ? String(b.registrationLink).trim() : '',
    programFlow: b.programFlow ? String(b.programFlow).trim() : '',
    speakers: b.speakers ? String(b.speakers).trim() : '',
    gallery: JSON.stringify([]),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await insert('events_module', rec);
  res.status(201).json({ message: 'Event created.', event: rec });
});

router.patch('/:id', requireAuth, async (req, res) => {
  const me = await caller(req);
  if (!me || !canEdit(me)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });

  const e = await get('SELECT * FROM events_module WHERE id = ?', [req.params.id]);
  if (!e) return res.status(404).json({ error: 'Event not found.' });

  const b = req.body || {};
  const changes = {};
  const editable = ['title', 'theme', 'dateTime', 'venue', 'description', 'registrationLink', 'programFlow', 'speakers'];
  for (const f of editable) {
    if (b[f] !== undefined) changes[f] = String(b[f]).trim();
  }
  changes.updatedAt = new Date().toISOString();
  await update('events_module', req.params.id, changes);
  const updated = await get('SELECT * FROM events_module WHERE id = ?', [req.params.id]);
  res.json({ message: 'Event updated.', event: updated });
});

router.delete('/:id', requireAuth, async (req, res) => {
  const me = await caller(req);
  if (!me || !canEdit(me)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });

  const e = await get('SELECT * FROM events_module WHERE id = ?', [req.params.id]);
  if (!e) return res.status(404).json({ error: 'Event not found.' });
  await remove('events_module', req.params.id);
  res.json({ message: 'Event removed.' });
});

// ---------- Registrations ----------
router.post('/:id/register', requireAuth, async (req, res) => {
  const me = await caller(req);
  const e = await get('SELECT * FROM events_module WHERE id = ?', [req.params.id]);
  if (!e) return res.status(404).json({ error: 'Event not found.' });

  const b = req.body || {};
  const required = ['participantName', 'institution', 'email', 'participantType'];
  for (const f of required) {
    if (!b[f]) return res.status(400).json({ error: `Field "${f}" is required.` });
  }

  const existing = await get('SELECT id FROM event_registrations WHERE eventId = ? AND email = ?', [e.id, String(b.email).trim()]);
  if (existing) return res.status(409).json({ error: 'This email is already registered for this event.' });

  const reg = {
    id: randomUUID(),
    eventId: e.id,
    userId: me.id,
    participantName: String(b.participantName).trim(),
    institution: String(b.institution).trim(),
    email: String(b.email).trim(),
    participantType: String(b.participantType).trim(),
    role: b.role ? String(b.role).trim() : 'attendee',
    abstractFile: null,
    attendanceStatus: 'absent',
    certificateIssued: false,
    certificateData: JSON.stringify(null),
    createdAt: new Date().toISOString()
  };

  await insert('event_registrations', reg);
  res.status(201).json({ message: 'Registered successfully.', registration: reg });
});

router.get('/:id/registrations', requireAuth, async (req, res) => {
  const me = await caller(req);
  if (!me || !canEdit(me)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });

  const regs = await all('SELECT * FROM event_registrations WHERE eventId = ?', [req.params.id]);
  res.json({ registrations: regs });
});

router.patch('/:id/registrations/:regId/attendance', requireAuth, async (req, res) => {
  const me = await caller(req);
  if (!me || !canEdit(me)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });

  const r = await get('SELECT * FROM event_registrations WHERE id = ? AND eventId = ?', [req.params.regId, req.params.id]);
  if (!r) return res.status(404).json({ error: 'Registration not found.' });

  const { attendanceStatus } = req.body || {};
  if (attendanceStatus) await update('event_registrations', r.id, { attendanceStatus: String(attendanceStatus).trim() });
  const updated = await get('SELECT * FROM event_registrations WHERE id = ?', [r.id]);
  res.json({ message: 'Attendance updated.', registration: updated });
});

router.post('/:id/registrations/:regId/certificate', requireAuth, async (req, res) => {
  const me = await caller(req);
  if (!me || !canEdit(me)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });

  const r = await get('SELECT * FROM event_registrations WHERE id = ? AND eventId = ?', [req.params.regId, req.params.id]);
  if (!r) return res.status(404).json({ error: 'Registration not found.' });

  const b = req.body || {};
  const certificateData = {
    certificateNumber: b.certificateNumber ? String(b.certificateNumber).trim() : '',
    issuedAt: new Date().toISOString(),
    issuedBy: me.fullName || me.username
  };

  await update('event_registrations', r.id, {
    certificateIssued: true,
    certificateData: JSON.stringify(certificateData)
  });
  const updated = await get('SELECT * FROM event_registrations WHERE id = ?', [r.id]);
  res.json({ message: 'Certificate issued.', registration: updated });
});

router.get('/:id/certificates', requireAuth, async (req, res) => {
  const me = await caller(req);
  if (!me || !canEdit(me)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });

  const regs = await all('SELECT * FROM event_registrations WHERE eventId = ?', [req.params.id]);
  res.json({
    certificates: regs.map(r => ({
      id: r.id,
      participantName: r.participantName,
      email: r.email,
      institution: r.institution,
      participantType: r.participantType,
      attendanceStatus: r.attendanceStatus,
      certificateIssued: r.certificateIssued,
      certificateNumber: r.certificateData?.certificateNumber || null,
      issuedAt: r.certificateData?.issuedAt || null,
      issuedBy: r.certificateData?.issuedBy || null
    }))
  });
});

// ---------- Abstracts ----------
router.post('/:id/abstracts', requireAuth, async (req, res) => {
  const me = await caller(req);
  const e = await get('SELECT * FROM events_module WHERE id = ?', [req.params.id]);
  if (!e) return res.status(404).json({ error: 'Event not found.' });

  const b = req.body || {};
  const required = ['title', 'authors', 'abstract', 'strand'];
  for (const f of required) {
    if (!b[f]) return res.status(400).json({ error: `Field "${f}" is required.` });
  }

  const abs = {
    id: randomUUID(),
    eventId: e.id,
    userId: me.id,
    title: String(b.title).trim(),
    authors: String(b.authors).trim(),
    abstract: String(b.abstract).trim(),
    keywords: b.keywords ? String(b.keywords).trim() : '',
    strand: String(b.strand).trim(),
    status: 'submitted',
    createdAt: new Date().toISOString()
  };

  await insert('event_abstracts', abs);
  res.status(201).json({ message: 'Abstract submitted.', abstract: abs });
});

router.get('/:id/abstracts', requireAuth, async (req, res) => {
  const me = await caller(req);
  if (!me || !canEdit(me)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });

  const list = await all('SELECT * FROM event_abstracts WHERE eventId = ?', [req.params.id]);
  res.json({ abstracts: list });
});

router.patch('/:id/abstracts/:absId/status', requireAuth, async (req, res) => {
  const me = await caller(req);
  if (!me || !canEdit(me)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });

  const a = await get('SELECT * FROM event_abstracts WHERE id = ? AND eventId = ?', [req.params.absId, req.params.id]);
  if (!a) return res.status(404).json({ error: 'Abstract not found.' });

  const { status } = req.body || {};
  if (!ABSTRACT_STATUS[status]) return res.status(400).json({ error: 'Invalid status.' });
  await update('event_abstracts', a.id, { status });
  const updated = await get('SELECT * FROM event_abstracts WHERE id = ?', [a.id]);
  res.json({ message: 'Abstract status updated.', abstract: updated });
});

// ---------- Gallery ----------
router.post('/:id/gallery', requireAuth, async (req, res, next) => {
  const me = await caller(req);
  if (!me || !canEdit(me)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });

  const e = await get('SELECT * FROM events_module WHERE id = ?', [req.params.id]);
  if (!e) return res.status(404).json({ error: 'Event not found.' });
  req._eventId = e.id;
  next();
}, uploadGallery, async (req, res) => {
  const items = [];
  for (const [type, files] of Object.entries(req.files || {})) {
    if (files && files[0]) {
      items.push({
        id: randomUUID(),
        type,
        filename: files[0].filename,
        originalName: files[0].originalname,
        uploadedAt: new Date().toISOString()
      });
    }
  }

  const e = await get('SELECT * FROM events_module WHERE id = ?', [req.params.id]);
  const gallery = e.gallery || [];
  gallery.push(...items);
  await update('events_module', e.id, { gallery: JSON.stringify(gallery), updatedAt: new Date().toISOString() });
  res.status(201).json({ message: 'Gallery items uploaded.', gallery: items });
});

router.get('/:id/gallery', async (req, res) => {
  const e = await get('SELECT * FROM events_module WHERE id = ?', [req.params.id]);
  if (!e) return res.status(404).json({ error: 'Event not found.' });
  res.json({ gallery: e.gallery || [] });
});

router.get('/:id/gallery/:filename', async (req, res) => {
  const e = await get('SELECT * FROM events_module WHERE id = ?', [req.params.id]);
  if (!e || !e.gallery) return res.status(404).json({ error: 'Not found.' });

  const item = e.gallery.find(g => g.filename === req.params.filename);
  if (!item) return res.status(404).json({ error: 'File not found.' });

  const filePath = join(UPLOAD_DIR, e.id, req.params.filename);
  res.download(filePath, item.originalName);
});

export { router as eventsModuleRouter, PARTICIPANT_TYPES, ABSTRACT_STATUS, STAFF_ROLES };

