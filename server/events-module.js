import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { promises as fs } from 'fs';
import { requireAuth, requireRole, readUsers } from './auth.js';
import { all, get, run, insert, update, remove } from './server/db/queries.js';
import { notify } from './notifications.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const UPLOAD_DIR = join(__dirname, '..', 'public', 'assets', 'uploads', 'events-module');
const DATA_DIR = join(__dirname, 'data');

const router = Router();

// The schema (including the `photo` column) is managed by the Netlify Database
// migrations in netlify/database/migrations. Called once at boot.
export async function ensureEventsSchema() {
  // Sweep leftover temp folders from crashed/interrupted requests.
  try {
    await fs.rm(join(UPLOAD_DIR, '_tmp'), { recursive: true, force: true });
  } catch { /* no-op */ }
}

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
  destination: async (req, file, cb) => {
    const dir = join(UPLOAD_DIR, req._eventId);
    try { await fs.mkdir(dir, { recursive: true }); cb(null, dir); }
    catch (err) { cb(err); }
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

// Cover-photo upload for the Create Event form. The event id doesn't exist
// yet at upload time, so files land in a per-request temp folder and are
// moved into <UPLOAD_DIR>/<eventId>/ once the event row is created.
const coverStorage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const dir = join(UPLOAD_DIR, '_tmp', req._tmpId);
    try { await fs.mkdir(dir, { recursive: true }); cb(null, dir); }
    catch (err) { cb(err); }
  },
  filename: (req, file, cb) => cb(null, `cover${extname(file.originalname).toLowerCase() || '.jpg'}`)
});
const uploadCover = multer({
  storage: coverStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/'))
}).single('photo');

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

  // Unified feed: module events PLUS content events (events.json, published
  // from the Admin Console Content tab). Both carry a `source` flag so the
  // frontend can route detail links appropriately.
  const content = JSON.parse(await fs.readFile(join(DATA_DIR, 'events.json'), 'utf8').catch(() => '[]'));
  const contentEvents = (Array.isArray(content) ? content : []).map(e => {
    // Apply the same filters as the module query so search behaves uniformly.
    const title = e.title || '', theme = e.type || '', venue = e.location || '', date = e.date || '';
    const matches =
      (!q.title || title.toLowerCase().includes(String(q.title).toLowerCase())) &&
      (!q.theme || theme.toLowerCase().includes(String(q.theme).toLowerCase())) &&
      (!q.venue || venue.toLowerCase().includes(String(q.venue).toLowerCase())) &&
      (!q.fromDate || date >= q.fromDate) &&
      (!q.toDate || date <= q.toDate);
    if (!matches) return null;
    return {
      id: e.id,
      title,
      theme,
      dateTime: date,
      venue,
      description: (e.description || '').slice(0, 200),
      registrationLink: e.registrationLink || '',
      programFlow: '',
      speakers: '',
      photo: e.photo || '',
      createdAt: e.createdAt || '',
      source: 'content'
    };
  }).filter(Boolean);

  // Dedupe by title: the seed mirrors the same events in both stores. The
  // module copy (richer: registration, program flow) wins on this page; only
  // events that exist solely as content events fall through.
  const merged = [
    ...list.map(e => ({
      id: e.id,
      title: e.title,
      theme: e.theme,
      dateTime: e.dateTime,
      venue: e.venue,
      description: e.description ? e.description.slice(0, 200) + (e.description.length > 200 ? '…' : '') : '',
      registrationLink: e.registrationLink,
      programFlow: e.programFlow,
      speakers: e.speakers,
      photo: e.photo || '',
      createdAt: e.createdAt,
      source: 'module'
    })),
    ...contentEvents
  ];
  const seen = new Set();
  const events = merged.filter(e => {
    const key = String(e.title || '').trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => new Date(a.dateTime || 0) - new Date(b.dateTime || 0));

  res.json({ events });
});

router.get('/:id', async (req, res) => {
  const e = await get('SELECT * FROM events_module WHERE id = ?', [req.params.id]);
  if (!e) return res.status(404).json({ error: 'Event not found.' });
  res.json({ event: e });
});

router.post('/', requireAuth, (req, res, next) => {
  // The event id doesn't exist until the row is created, so the photo lands
  // in a temp folder keyed by a throwaway id; the handler moves it after insert.
  req._tmpId = randomUUID();
  next();
}, uploadCover, async (req, res) => {
  const me = await caller(req);
  if (!me || !canEdit(me)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });

  const b = req.body || {};
  const id = randomUUID();
  const tmpDir = join(UPLOAD_DIR, '_tmp', req._tmpId);
  let photo = '';

  // Make sure the temp folder is removed whether validation fails below or the
  // move above succeeded — no orphaned uploads left behind.
  async function cleanupTmp() {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.error('[events] temp cleanup failed:', cleanupErr.message);
    }
  }

  const required = ['title', 'theme', 'dateTime', 'venue'];
  for (const f of required) {
    if (!b[f]) {
      await cleanupTmp();
      return res.status(400).json({ error: `Field "${f}" is required.` });
    }
  }

  try {
    if (req.file) {
      const dir = join(UPLOAD_DIR, id);
      await fs.mkdir(dir, { recursive: true });
      await fs.rename(join(tmpDir, req.file.filename), join(dir, req.file.filename));
      // Public path, matching what content events use (e.g. /assets/uploads/events/...).
      photo = `/assets/uploads/events-module/${id}/${req.file.filename}`;
    }
  } catch (err) {
    console.error('[events] cover move failed:', err.message);
    photo = '';
  }

  const rec = {
    id,
    title: String(b.title).trim(),
    theme: String(b.theme).trim(),
    dateTime: String(b.dateTime).trim(),
    venue: String(b.venue).trim(),
    description: b.description ? String(b.description).trim() : '',
    registrationLink: b.registrationLink ? String(b.registrationLink).trim() : '',
    programFlow: b.programFlow ? String(b.programFlow).trim() : '',
    speakers: b.speakers ? String(b.speakers).trim() : '',
    photo,
    gallery: JSON.stringify([]),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await insert('events_module', rec);
  await cleanupTmp();
  res.status(201).json({ message: 'Event created.', event: rec });
});

// Turn multer failures (oversized file, bad content type) into clean 400s
// instead of the generic 500 the global handler would produce.
router.use((err, req, res, next) => {
  if (err && (err instanceof multer.MulterError || err.code === 'LIMIT_FILE_SIZE')) {
    return res.status(400).json({ error: 'Photo upload failed: ' + (err.message || 'invalid file.') });
  }
  next(err);
});

router.patch('/:id', requireAuth, async (req, res) => {
  const me = await caller(req);
  if (!me || !canEdit(me)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });

  const e = await get('SELECT * FROM events_module WHERE id = ?', [req.params.id]);
  if (!e) return res.status(404).json({ error: 'Event not found.' });

  const b = req.body || {};
  const changes = {};
  const editable = ['title', 'theme', 'dateTime', 'venue', 'description', 'registrationLink', 'programFlow', 'speakers', 'photo'];
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
  // Clean up the event's photo/gallery folder.
  await fs.rm(join(UPLOAD_DIR, req.params.id), { recursive: true, force: true }).catch(() => {});
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

  // In-app notification confirming the registration to the user.
  await notify(me.id, 'event_registered', 'Event registration confirmed',
    `You are registered for "${e.title}".`, `event-detail.html?id=${e.id}`);

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
router.get('/:id/registrations/:regId/certificate/view', async (req, res) => {
  const r = await get('SELECT * FROM event_registrations WHERE id = ? AND eventId = ?', [req.params.regId, req.params.id]);
  if (!r) return res.status(404).json({ error: 'Registration record not found.' });
  if (!r.certificateIssued) return res.status(400).json({ error: 'Certificate has not been issued yet.' });
  const e = await get('SELECT * FROM events_module WHERE id = ?', [req.params.id]);

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Certificate of Participation - ${r.participantName}</title>
  <style>
    @page { size: landscape; margin: 0; }
    body { font-family: 'Georgia', serif; background: #f8fafc; margin: 0; padding: 40px; text-align: center; }
    .cert-border { border: 12px double #0b2545; padding: 40px; background: #ffffff; max-width: 900px; margin: 0 auto; box-shadow: 0 10px 30px rgba(0,0,0,0.1); border-radius: 8px; }
    .header { font-size: 28px; font-weight: bold; color: #0b2545; text-transform: uppercase; letter-spacing: 2px; }
    .sub-header { font-size: 16px; color: #64748b; margin-top: 5px; }
    .title { font-size: 38px; color: #1e3a8a; margin: 25px 0 10px; font-family: 'Cinzel', 'Times New Roman', serif; text-transform: uppercase; }
    .recipient { font-size: 30px; font-weight: bold; color: #0f172a; margin: 15px 0; border-bottom: 2px solid #cbd5e1; display: inline-block; padding-bottom: 5px; }
    .body-text { font-size: 18px; color: #334155; line-height: 1.6; margin: 20px 40px; }
    .event-title { font-weight: bold; color: #0b2545; }
    .footer { margin-top: 50px; display: flex; justify-content: space-around; align-items: flex-end; }
    .sig-block { text-align: center; width: 220px; }
    .sig-line { border-top: 1px solid #475569; margin-top: 40px; padding-top: 5px; font-size: 14px; font-weight: bold; color: #1e293b; }
    .cert-no { font-family: monospace; font-size: 12px; color: #94a3b8; margin-top: 25px; }
    @media print { .no-print { display: none; } }
  </style>
</head>
<body onload="window.print()">
  <div class="no-print" style="margin-bottom:20px;">
    <button onclick="window.print()" style="padding:10px 20px;background:#0b2545;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;">Print Certificate</button>
  </div>
  <div class="cert-border">
    <div class="header">Center for Policy Research and Innovation</div>
    <div class="sub-header">CPRI Official Certificate</div>
    <div class="title">Certificate of ${r.participantType === 'presenter' ? 'Presentation' : 'Participation'}</div>
    <p class="body-text">This is proudly presented to</p>
    <div class="recipient">${r.participantName}</div>
    <p class="body-text">for actively participating as a <b>${r.participantType === 'presenter' ? 'Research Presenter' : 'Participant'}</b> in the event titled<br><span class="event-title">"${e ? e.title : 'CPRI Symposium'}"</span><br>held on ${e ? e.dateTime : '2026'}.</p>
    <div class="footer">
      <div class="sig-block">
        <div class="sig-line">CPRI Executive Director</div>
      </div>
      <div class="sig-block">
        <div class="sig-line">Event Chairperson</div>
      </div>
    </div>
    <div class="cert-no">Certificate No: ${r.certificateData?.certificateNumber || r.id.substring(0,8).toUpperCase()} | Date Issued: ${new Date(r.certificateData?.issuedAt || Date.now()).toLocaleDateString()}</div>
  </div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
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

