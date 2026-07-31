import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { promises as fs } from 'fs';
import { requireAdmin, readUsers } from './auth.js';
import { all, get } from './server/db/queries.js';
import { addLog } from './audit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLIC_UPLOADS = join(__dirname, '..', 'public', 'assets', 'uploads');
const FILE_UPLOAD_DIR = join(PUBLIC_UPLOADS, 'files');

const router = Router();

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

function parseDate(value) {
  const d = new Date(value);
  return isNaN(d) ? null : d;
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

// ============================================================
// ANALYTICS & REPORTS — reuses the same DB tables as the
// Operations Overview / Research Impact Dashboard so numbers
// stay consistent.
// ============================================================
router.get('/analytics', requireAdmin, async (req, res) => {
  try {
    const [
      submissions,
      repository,
      publications,
      ethics,
      researchers,
      innovation
    ] = await Promise.all([
      all('SELECT id, researchType, category, program, submitterId, submitterName, status, statusHistory, createdAt FROM submissions'),
      all('SELECT id, department, yearCompleted FROM repository'),
      all('SELECT id, department, schoolYear, publicationDate FROM publications'),
      all('SELECT id, department, status FROM ethics'),
      all('SELECT id, fullName, type, department, program, citations FROM researchers'),
      all('SELECT id, title, projectType, department, implementationDate FROM innovation_extension')
    ]);

    // ---- Submissions over time (12-month trailing window) ----
    const months = Array.from({ length: 12 }, (_, i) => {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - 11 + i);
      return { key: monthKey(d), label: d.toLocaleString('en-US', { month: 'short' }), count: 0, approved: 0 };
    });
    submissions.forEach(s => {
      const d = parseDate(s.createdAt);
      if (!d) return;
      const bucket = months.find(m => m.key === monthKey(d));
      if (!bucket) return;
      bucket.count += 1;
      if (['approved', 'published'].includes(s.status)) bucket.approved += 1;
    });

    // ---- Approval rate ----
    const approvedCount = submissions.filter(s => ['approved', 'published'].includes(s.status)).length;
    const approvalRate = submissions.length ? Math.round((approvedCount / submissions.length) * 100) : 0;

    // ---- Category breakdown (researchType) ----
    const categoryMap = {};
    submissions.forEach(s => {
      const cat = s.researchType || s.category || 'Uncategorized';
      categoryMap[cat] = (categoryMap[cat] || 0) + 1;
    });

    // ---- Top programs ----
    const programMap = {};
    submissions.forEach(s => {
      const p = s.program || 'Unknown';
      programMap[p] = (programMap[p] || 0) + 1;
    });
    const topPrograms = Object.entries(programMap)
      .map(([program, count]) => ({ program, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    // ---- Top researchers (by submissions; enriched from directory) ----
    const researcherMap = {};
    submissions.forEach(s => {
      const key = s.submitterName || s.submitterId || 'Unknown';
      researcherMap[key] = researcherMap[key] || { name: key, submissions: 0, citations: 0, department: '' };
      researcherMap[key].submissions += 1;
    });
    researchers.forEach(r => {
      if (researcherMap[r.fullName]) {
        researcherMap[r.fullName].citations = r.citations || 0;
        researcherMap[r.fullName].department = r.department || r.program || '';
      }
    });
    const topResearchers = Object.values(researcherMap)
      .sort((a, b) => b.submissions - a.submissions)
      .slice(0, 8);

    // ---- Department output (repository) ----
    const deptMap = {};
    repository.forEach(r => {
      const d = r.department || 'Unknown';
      deptMap[d] = (deptMap[d] || 0) + 1;
    });

    // ---- Publications per school year ----
    const pubYearMap = {};
    publications.forEach(p => {
      const yr = p.schoolYear || (p.publicationDate ? String(p.publicationDate).slice(0, 4) : 'Unknown');
      pubYearMap[yr] = (pubYearMap[yr] || 0) + 1;
    });

    // ---- Ethics by status ----
    const ethicsStatusMap = {};
    ethics.forEach(e => {
      ethicsStatusMap[e.status] = (ethicsStatusMap[e.status] || 0) + 1;
    });

    // ---- Innovation by type ----
    const innoTypeMap = {};
    innovation.forEach(i => {
      innoTypeMap[i.projectType] = (innoTypeMap[i.projectType] || 0) + 1;
    });

    res.json({
      analytics: {
        submissionsOverTime: months,
        totalSubmissions: submissions.length,
        approvedCount,
        approvalRate,
        categoryBreakdown: Object.entries(categoryMap).map(([name, count]) => ({ name, count })),
        topPrograms,
        topResearchers,
        departmentOutput: Object.entries(deptMap).map(([name, count]) => ({ name, count })),
        publicationsPerYear: Object.entries(pubYearMap).map(([year, count]) => ({ year, count })),
        ethicsByStatus: Object.entries(ethicsStatusMap).map(([status, count]) => ({ status, count })),
        innovationByType: Object.entries(innoTypeMap).map(([type, count]) => ({ type, count })),
        totalRepository: repository.length,
        totalPublications: publications.length,
        totalEthics: ethics.length,
        totalResearchers: researchers.length,
        totalInnovation: innovation.length,
        lastUpdated: new Date().toISOString()
      }
    });
  } catch (err) {
    console.error('[admin-insights] analytics error:', err);
    res.status(500).json({ error: 'Failed to generate analytics.' });
  }
});

// Top researchers (dedicated endpoint)
router.get('/reports/top-researchers', requireAdmin, async (req, res) => {
  try {
    const submissions = await all('SELECT submitterName, submitterId FROM submissions');
    const researchers = await all('SELECT fullName, citations, department FROM researchers');
    const map = {};
    submissions.forEach(s => {
      const key = s.submitterName || s.submitterId || 'Unknown';
      map[key] = map[key] || { name: key, count: 0 };
      map[key].count += 1;
    });
    Object.values(map).forEach(row => {
      const dir = researchers.find(r => r.fullName === row.name);
      if (dir) { row.citations = dir.citations || 0; row.department = dir.department || ''; }
    });
    res.json({ report: Object.values(map).sort((a, b) => b.count - a.count).slice(0, 10) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load top researchers.' });
  }
});

// Top programs (dedicated endpoint)
router.get('/reports/top-programs', requireAdmin, async (req, res) => {
  try {
    const submissions = await all('SELECT program FROM submissions');
    const map = {};
    submissions.forEach(s => {
      const p = s.program || 'Unknown';
      map[p] = (map[p] || 0) + 1;
    });
    res.json({ report: Object.entries(map).map(([program, count]) => ({ program, count })).sort((a, b) => b.count - a.count).slice(0, 10) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load top programs.' });
  }
});

// Category breakdown (dedicated endpoint)
router.get('/reports/category', requireAdmin, async (req, res) => {
  try {
    const submissions = await all('SELECT researchType, category FROM submissions');
    const map = {};
    submissions.forEach(s => {
      const c = s.researchType || s.category || 'Uncategorized';
      map[c] = (map[c] || 0) + 1;
    });
    res.json({ report: Object.entries(map).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load category breakdown.' });
  }
});

// ============================================================
// CALENDAR — aggregate key dates from existing records.
// ============================================================
router.get('/calendar', requireAdmin, async (req, res) => {
  try {
    const [submissions, ethics, publications, events, innovation] = await Promise.all([
      all('SELECT id, title, status, createdAt FROM submissions'),
      all('SELECT id, title, status, createdAt FROM ethics'),
      all('SELECT id, title, status, publicationDate FROM publications'),
      all('SELECT id, title, theme, dateTime FROM events_module'),
      all('SELECT id, title, implementationDate FROM innovation_extension')
    ]);

    const items = [];

    submissions.forEach(s => {
      const d = parseDate(s.createdAt);
      if (d) items.push({ date: d.toISOString().slice(0, 10), title: s.title, type: 'Submission', status: STATUS_LABELS[s.status] || s.status, id: s.id, link: `submission.html?id=${s.id}` });
    });
    ethics.forEach(e => {
      const d = parseDate(e.createdAt);
      if (d) items.push({ date: d.toISOString().slice(0, 10), title: e.title, type: 'Ethics Review', status: e.status, id: e.id, link: `ethics-detail.html?id=${e.id}` });
    });
    publications.forEach(p => {
      const d = parseDate(p.publicationDate);
      if (d) items.push({ date: d.toISOString().slice(0, 10), title: p.title, type: 'Publication', status: p.status, id: p.id, link: `publication-detail.html?id=${p.id}` });
    });
    events.forEach(e => {
      const d = parseDate(e.dateTime);
      if (d) items.push({ date: d.toISOString().slice(0, 10), title: e.title, type: 'Event', status: e.theme || 'Event', id: e.id, link: `event-detail.html?id=${e.id}` });
    });
    innovation.forEach(i => {
      const d = parseDate(i.implementationDate);
      if (d) items.push({ date: d.toISOString().slice(0, 10), title: i.title, type: 'Innovation & Extension', status: '', id: i.id, link: `innovation-extension-detail.html?id=${i.id}` });
    });

    items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    // Group by month for easy rendering
    const byMonth = {};
    items.forEach(item => {
      const mk = item.date.slice(0, 7);
      if (!byMonth[mk]) byMonth[mk] = [];
      byMonth[mk].push(item);
    });

    res.json({ events: items, byMonth });
  } catch (err) {
    console.error('[admin-insights] calendar error:', err);
    res.status(500).json({ error: 'Failed to load calendar.' });
  }
});

// ============================================================
// FILE MANAGER — list / upload / delete across all modules.
// ============================================================
function safeUploadDir() {
  return join(PUBLIC_UPLOADS, 'files');
}

async function walkDir(dir, baseRel, out, depth = 0) {
  if (depth > 3) return;
  let entries = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const rel = baseRel ? `${baseRel}/${entry.name}` : `/assets/uploads/${entry.name}`;
    if (entry.isDirectory()) {
      await walkDir(full, rel, out, depth + 1);
    } else {
      try {
        const stat = await fs.stat(full);
        out.push({
          name: entry.name,
          size: stat.size,
          path: rel,
          url: rel,
          type: extname(entry.name).replace('.', '').toUpperCase() || 'FILE',
          mtime: stat.mtime,
          module: 'Direct Upload'
        });
      } catch { /* skip */ }
    }
  }
}

async function collectUploadsFiles() {
  const out = [];
  // Recursively scan the public/uploads/files directory
  await walkDir(FILE_UPLOAD_DIR, '/assets/uploads/files', out);
  return out;
}

router.get('/files', requireAdmin, async (req, res) => {
  try {
    const [
      submissions,
      ethics,
      publications,
      events,
      innovation
    ] = await Promise.all([
      all('SELECT id, title, submitterName, files, additionalDocs, versions FROM submissions'),
      all('SELECT id, title, submitterName, files, revisedDocuments FROM ethics'),
      all('SELECT id, title, submitterName, proofDocuments FROM publications'),
      all('SELECT id, title, gallery FROM events_module'),
      all('SELECT id, title, supportingDocuments, impactDocuments FROM innovation_extension')
    ]);

    const files = [];

    const pushFile = (rec, meta, module, folder, uploader) => {
      if (!meta || !meta.filename) return;
      files.push({
        name: meta.originalName || meta.filename,
        filename: meta.filename,
        size: 0,
        path: `/assets/uploads/${folder}/${rec.id}/${meta.filename}`,
        url: `/assets/uploads/${folder}/${rec.id}/${meta.filename}`,
        type: extname(meta.filename).replace('.', '').toUpperCase() || 'FILE',
        module,
        recordTitle: rec.title,
        uploader: uploader || rec.submitterName || '',
        uploadedAt: meta.uploadedAt || rec.createdAt || null
      });
    };

    submissions.forEach(s => {
      const folder = 'submissions';
      Object.values(s.files || {}).forEach(meta => pushFile(s, meta, 'Submission', folder, s.submitterName));
      (s.additionalDocs || []).forEach(doc => pushFile(s, doc, 'Submission (Additional)', folder, s.submitterName));
      (s.versions || []).forEach(v => {
        Object.values(v.files || {}).forEach(meta => pushFile(s, meta, `Submission v${v.version}`, folder, v.by));
        (v.additionalDocs || []).forEach(doc => pushFile(s, doc, `Submission v${v.version}`, folder, v.by));
      });
    });
    ethics.forEach(e => {
      const folder = 'ethics';
      Object.values(e.files || {}).forEach(meta => pushFile(e, meta, 'Ethics', folder, e.submitterName));
      (e.revisedDocuments || []).forEach(doc => pushFile(e, doc, 'Ethics (Revision)', folder, e.submitterName));
    });
    publications.forEach(p => {
      const folder = 'publications';
      (p.proofDocuments || []).forEach(doc => pushFile(p, doc, 'Publication Proof', folder, p.submitterName));
    });
    events.forEach(e => {
      const folder = 'events-module';
      (e.gallery || []).forEach(doc => pushFile(e, doc, 'Event', folder, ''));
    });
    innovation.forEach(i => {
      const folder = 'innovation-extension';
      (i.supportingDocuments || []).forEach(doc => pushFile(i, doc, 'Innovation & Extension', folder, ''));
      (i.impactDocuments || []).forEach(doc => pushFile(i, doc, 'Innovation & Extension (Impact)', folder, ''));
    });

    // Include direct uploads dir
    const direct = await collectUploadsFiles();
    files.push(...direct);

    // Get file sizes from disk where available
    for (const f of files) {
      if (f.path && f.path.startsWith('/assets/uploads/')) {
        const diskPath = join(__dirname, '..', 'public', f.path);
        try {
          const stat = await fs.stat(diskPath);
          f.size = stat.size;
        } catch { /* file may not exist on disk */ }
      }
    }

    files.sort((a, b) => (b.uploadedAt || '') < (a.uploadedAt || '') ? -1 : 1);

    res.json({ files });
  } catch (err) {
    console.error('[admin-insights] files error:', err);
    res.status(500).json({ error: 'Failed to list files.' });
  }
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdir(FILE_UPLOAD_DIR, { recursive: true }).then(() => cb(null, FILE_UPLOAD_DIR));
  },
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } });

router.post('/files/upload', requireAdmin, upload.array('files', 10), async (req, res) => {
  try {
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files uploaded.' });
    await addLog('file_upload', `Uploaded ${req.files.length} file(s) to File Manager`, req);
    res.status(201).json({
      message: `${req.files.length} file(s) uploaded.`,
      files: req.files.map(f => ({
        name: f.originalname,
        filename: f.filename,
        size: f.size,
        path: `/assets/uploads/files/${f.filename}`,
        url: `/assets/uploads/files/${f.filename}`,
        type: extname(f.filename).replace('.', '').toUpperCase() || 'FILE',
        mtime: new Date(f.mtime || Date.now()),
        module: 'Direct Upload'
      }))
    });
  } catch (err) {
    console.error('[admin-insights] upload error:', err);
    res.status(500).json({ error: 'Upload failed.' });
  }
});

router.post('/files/delete', requireAdmin, async (req, res) => {
  try {
    const { path } = req.body || {};
    if (!path) return res.status(400).json({ error: 'Path is required.' });

    // Validate: only allow deletion inside the public uploads directory
    const uploadsRoot = join(__dirname, '..', 'public', 'assets', 'uploads');
    const target = join(__dirname, '..', 'public', path.replace(/^\/+/, ''));
    if (!target.startsWith(uploadsRoot)) return res.status(400).json({ error: 'Invalid path.' });

    try {
      await fs.unlink(target);
    } catch (err) {
      return res.status(404).json({ error: 'File not found.' });
    }
    await addLog('file_delete', `Deleted file ${path}`, req);
    res.json({ message: 'File deleted.' });
  } catch (err) {
    console.error('[admin-insights] delete error:', err);
    res.status(500).json({ error: 'Delete failed.' });
  }
});

// ============================================================
// EMAIL NOTIFICATIONS
// ============================================================
const NOTIF_PREFS_FILE = join(__dirname, 'data', 'notification-preferences.json');

async function readPrefs() {
  try {
    return JSON.parse(await fs.readFile(NOTIF_PREFS_FILE, 'utf8'));
  } catch {
    return {
      enabled: true,
      sendSubmissionAlerts: true,
      sendEthicsAlerts: true,
      sendEventAlerts: true,
      sendUserAlerts: true,
      sendPasswordAlerts: false,
      sendErrorAlerts: true,
      senderEmail: 'noreply@cpri.edu',
      senderName: 'CPRI Notifications',
      digestTime: '08:00'
    };
  }
}

async function writePrefs(data) {
  await fs.mkdir(join(__dirname, 'data'), { recursive: true });
  await fs.writeFile(NOTIF_PREFS_FILE, JSON.stringify(data, null, 2));
}

router.get('/notifications/status', requireAdmin, async (req, res) => {
  const smtpConfigured = !!process.env.SMTP_HOST;
  res.json({
    smtpConfigured,
    mailFrom: process.env.MAIL_FROM || process.env.SMTP_USER || 'noreply@cpri.edu',
    emailServiceReady: smtpConfigured,
    note: smtpConfigured
      ? 'SMTP is configured. Email delivery is active.'
      : 'SMTP is NOT configured. Set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS in server/.env to enable email delivery.'
  });
});

router.get('/notifications/history', requireAdmin, async (req, res) => {
  try {
    const q = req.query || {};
    let sql = "SELECT * FROM system_logs WHERE action LIKE 'email%' OR action LIKE 'notif%' OR action IN ('submission_approve','submission_reject','submission_publish','submission_archive')";
    const params = [];
    if (q.action) { sql += ' AND action = ?'; params.push(q.action); }
    if (q.from) { sql += ' AND timestamp >= ?'; params.push(q.from); }
    if (q.to) { sql += ' AND timestamp <= ?'; params.push(q.to); }
    sql += ' ORDER BY timestamp DESC LIMIT 200';
    const logs = await all(sql, params);
    res.json({ history: logs });
  } catch (err) {
    console.error('[admin-insights] notif history error:', err);
    res.status(500).json({ error: 'Failed to load notification history.' });
  }
});

router.get('/notifications/prefs', requireAdmin, async (req, res) => {
  res.json({ prefs: await readPrefs() });
});

router.put('/notifications/prefs', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const allowed = [
      'enabled', 'sendSubmissionAlerts', 'sendEthicsAlerts', 'sendEventAlerts',
      'sendUserAlerts', 'sendPasswordAlerts', 'sendErrorAlerts',
      'senderEmail', 'senderName', 'digestTime'
    ];
    const current = await readPrefs();
    for (const key of allowed) {
      if (b[key] !== undefined) current[key] = b[key];
    }
    await writePrefs(current);
    await addLog('notif_prefs_update', 'Updated notification preferences', req);
    res.json({ message: 'Preferences saved.', prefs: current });
  } catch (err) {
    console.error('[admin-insights] prefs error:', err);
    res.status(500).json({ error: 'Failed to save preferences.' });
  }
});

export { router as adminInsightsRouter };

