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
const EVENTS_FILE = join(DATA_DIR, 'events-module.json');
const REGISTRATIONS_FILE = join(DATA_DIR, 'event-registrations.json');
const ABSTRACTS_FILE = join(DATA_DIR, 'event-abstracts.json');
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

async function readEvents() {
  try { return JSON.parse(await fs.readFile(EVENTS_FILE, 'utf8')); } catch { return []; }
}
async function writeEvents(list) {
  await fs.writeFile(EVENTS_FILE, JSON.stringify(list, null, 2));
}
async function readRegistrations() {
  try { return JSON.parse(await fs.readFile(REGISTRATIONS_FILE, 'utf8')); } catch { return []; }
}
async function writeRegistrations(list) {
  await fs.writeFile(REGISTRATIONS_FILE, JSON.stringify(list, null, 2));
}
async function readAbstracts() {
  try { return JSON.parse(await fs.readFile(ABSTRACTS_FILE, 'utf8')); } catch { return []; }
}
async function writeAbstracts(list) {
  await fs.writeFile(ABSTRACTS_FILE, JSON.stringify(list, null, 2));
}
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
  let list = await readEvents();

  const match = (val, term) => !term || String(val || '').toLowerCase().includes(String(term).toLowerCase());
  list = list.filter(e => {
    if (q.title && !match(e.title, q.title)) return false;
    if (q.theme && !match(e.theme, q.theme)) return false;
    if (q.venue && !match(e.venue, q.venue)) return false;
    if (q.fromDate && new Date(e.dateTime) < new Date(q.fromDate)) return false;
    if (q.toDate && new Date(e.dateTime) > new Date(q.toDate)) return false;
    return true;
  });

  res.json({
    events: list
      .sort((a, b) => new Date(a.dateTime) - new Date(b.dateTime))
      .map(e => ({
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
  const list = await readEvents();
  const e = list.find(x => x.id === req.params.id);
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const list = await readEvents();
  list.push(rec);
  await writeEvents(list);
  res.status(201).json({ message: 'Event created.', event: rec });
});

router.patch('/:id', requireAuth, async (req, res) => {
  const me = await caller(req);
  if (!me || !canEdit(me)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });

  const list = await readEvents();
  const e = list.find(x => x.id === req.params.id);
  if (!e) return res.status(404).json({ error: 'Event not found.' });

  const b = req.body || {};
  const editable = ['title', 'theme', 'dateTime', 'venue', 'description', 'registrationLink', 'programFlow', 'speakers'];
  for (const f of editable) {
    if (b[f] !== undefined) e[f] = String(b[f]).trim();
  }
  e.updatedAt = new Date().toISOString();
  await writeEvents(list);
  res.json({ message: 'Event updated.', event: e });
});

router.delete('/:id', requireAuth, async (req, res) => {
  const me = await caller(req);
  if (!me || !canEdit(me)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });

  const list = await readEvents();
  const filtered = list.filter(x => x.id !== req.params.id);
  if (filtered.length === list.length) return res.status(404).json({ error: 'Event not found.' });
  await writeEvents(filtered);
  res.json({ message: 'Event removed.' });
});

// ---------- Registrations ----------
router.post('/:id/register', requireAuth, async (req, res) => {
  const me = await caller(req);
  const eventList = await readEvents();
  const e = eventList.find(x => x.id === req.params.id);
  if (!e) return res.status(404).json({ error: 'Event not found.' });

  const b = req.body || {};
  const required = ['participantName', 'institution', 'email', 'participantType'];
  for (const f of required) {
    if (!b[f]) return res.status(400).json({ error: `Field "${f}" is required.` });
  }

  const regs = await readRegistrations();
  const existing = regs.find(r => r.eventId === e.id && r.email === b.email);
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
    certificateData: null,
    createdAt: new Date().toISOString()
  };

  regs.push(reg);
  await writeRegistrations(regs);
  res.status(201).json({ message: 'Registered successfully.', registration: reg });
});

router.get('/:id/registrations', requireAuth, async (req, res) => {
  const me = await caller(req);
  if (!me || !canEdit(me)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });

  const regs = await readRegistrations();
  const eventRegs = regs.filter(r => r.eventId === req.params.id);
  res.json({ registrations: eventRegs });
});

router.patch('/:id/registrations/:regId/attendance', requireAuth, async (req, res) => {
  const me = await caller(req);
  if (!me || !canEdit(me)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });

  const regs = await readRegistrations();
  const r = regs.find(x => x.id === req.params.regId && x.eventId === req.params.id);
  if (!r) return res.status(404).json({ error: 'Registration not found.' });

  const { attendanceStatus } = req.body || {};
  if (attendanceStatus) r.attendanceStatus = String(attendanceStatus).trim();
  await writeRegistrations(regs);
  res.json({ message: 'Attendance updated.', registration: r });
});

router.post('/:id/registrations/:regId/certificate', requireAuth, async (req, res) => {
  const me = await caller(req);
  if (!me || !canEdit(me)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });

  const regs = await readRegistrations();
  const r = regs.find(x => x.id === req.params.regId && x.eventId === req.params.id);
  if (!r) return res.status(404).json({ error: 'Registration not found.' });

  const b = req.body || {};
  r.certificateIssued = true;
  r.certificateData = {
    certificateNumber: b.certificateNumber ? String(b.certificateNumber).trim() : '',
    issuedAt: new Date().toISOString(),
    issuedBy: me.fullName || me.username
  };
  await writeRegistrations(regs);
  res.json({ message: 'Certificate issued.', registration: r });
});

router.get('/:id/certificates', requireAuth, async (req, res) => {
  const me = await caller(req);
  if (!me || !canEdit(me)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });

  const regs = await readRegistrations();
  const eventRegs = regs.filter(r => r.eventId === req.params.id);
  res.json({
    certificates: eventRegs.map(r => ({
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
  const eventList = await readEvents();
  const e = eventList.find(x => x.id === req.params.id);
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

  const list = await readAbstracts();
  list.push(abs);
  await writeAbstracts(list);
  res.status(201).json({ message: 'Abstract submitted.', abstract: abs });
});

router.get('/:id/abstracts', requireAuth, async (req, res) => {
  const me = await caller(req);
  if (!me || !canEdit(me)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });

  const list = await readAbstracts();
  const eventAbs = list.filter(a => a.eventId === req.params.id);
  res.json({ abstracts: eventAbs });
});

router.patch('/:id/abstracts/:absId/status', requireAuth, async (req, res) => {
  const me = await caller(req);
  if (!me || !canEdit(me)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });

  const list = await readAbstracts();
  const a = list.find(x => x.id === req.params.absId && x.eventId === req.params.id);
  if (!a) return res.status(404).json({ error: 'Abstract not found.' });

  const { status } = req.body || {};
  if (!ABSTRACT_STATUS[status]) return res.status(400).json({ error: 'Invalid status.' });
  a.status = status;
  await writeAbstracts(list);
  res.json({ message: 'Abstract status updated.', abstract: a });
});

// ---------- Gallery ----------
router.post('/:id/gallery', requireAuth, async (req, res, next) => {
  const me = await caller(req);
  if (!me || !canEdit(me)) return res.status(403).json({ error: 'Admin/CPRI staff only.' });

  const eventList = await readEvents();
  const e = eventList.find(x => x.id === req.params.id);
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
  const list = await readEvents();
  const e = list.find(x => x.id === req.params.id);
  e.gallery = e.gallery || [];
  e.gallery.push(...items);
  await writeEvents(list);
  res.status(201).json({ message: 'Gallery items uploaded.', gallery: items });
});

router.get('/:id/gallery', async (req, res) => {
  const list = await readEvents();
  const e = list.find(x => x.id === req.params.id);
  if (!e) return res.status(404).json({ error: 'Event not found.' });
  res.json({ gallery: e.gallery || [] });
});

router.get('/:id/gallery/:filename', async (req, res) => {
  const list = await readEvents();
  const e = list.find(x => x.id === req.params.id);
  if (!e || !e.gallery) return res.status(404).json({ error: 'Not found.' });

  const item = e.gallery.find(g => g.filename === req.params.filename);
  if (!item) return res.status(404).json({ error: 'File not found.' });

  const filePath = join(UPLOAD_DIR, e.id, req.params.filename);
  res.download(filePath, item.originalName);
});

export { router as eventsModuleRouter, PARTICIPANT_TYPES, ABSTRACT_STATUS, STAFF_ROLES };
