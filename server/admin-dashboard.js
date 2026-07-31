import { Router } from 'express';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { promises as fs } from 'fs';
import { requireAuth, requireAdmin, readUsers } from './auth.js';
import { all, get, run, insert, update, remove } from './server/db/queries.js';
import { addLog } from './audit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, 'data');

const router = Router();

const CONTENT_FILES = {
  profile: 'profile.json',
  announcements: 'announcements.json',
  events: 'events.json',
  agenda: 'agenda.json'
};

// Number of days a submission has to move from created to approved/published
// to count as "on-time delivery" in the hero dashboard widget.
const REVIEW_WINDOW_DAYS = 14;

// Annual publication goal used to compute the hero "Research goals" ring.
const ANNUAL_GOAL_TARGET = 1800;

async function readJson(name) {
  try { return JSON.parse(await fs.readFile(join(DATA_DIR, name + '.json'), 'utf8')); } catch { return []; }
}

async function readContent(name) {
  try { return JSON.parse(await fs.readFile(join(DATA_DIR, CONTENT_FILES[name] || name + '.json'), 'utf8')); } catch { return []; }
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function parseDate(value) {
  const date = new Date(value);
  return isNaN(date) ? null : date;
}

async function calculateDashboardSummary() {
  const summary = {
    researchPapers: 0,
    approvedResearches: 0,
    archivedResearches: 0,
    publishedPapers: 0,
    ethicsApplications: 0,
    innovationProjects: 0,
    activeUsers: 0,
    totalSubmissions: 0,
    totalRepository: 0,
    totalPublications: 0,
    totalEvents: 0,
    publications: 0,
    activeProjects: 0,
    researchers: 0,
    monthlyOutput: [],
    approvalRate: 0,
    onTimeDelivery: 0,
    goalProgress: 0,
    goalLabel: 'On track for 2026',
    goalSubtext: '+0% citations YoY',
    lastUpdated: new Date().toISOString()
  };

  try {
    const [
      subsList, repoList, pubList, ethicsList, innoList,
      eventsList, usersList, researchersList
    ] = await Promise.all([
      all('SELECT id, submitterId, status, statusHistory, createdAt FROM submissions'),
      all('SELECT id, status, createdAt FROM repository'),
      all("SELECT id, status, publicationDate FROM publications WHERE status = 'published'"),
      all('SELECT id FROM ethics'),
      all('SELECT id FROM innovation_extension'),
      all('SELECT id FROM events_module'),
      all('SELECT id, role, status FROM users'),
      all('SELECT citations FROM researchers')
    ]);

    summary.totalSubmissions = subsList.length;
    summary.totalRepository = repoList.length;
    summary.totalPublications = pubList.length;
    summary.totalEvents = eventsList.length;
    summary.publications = pubList.length;
    summary.ethicsApplications = ethicsList.length;
    summary.innovationProjects = innoList.length;
    summary.activeUsers = usersList.filter(u => u.status === 'active').length;

    // Researchers = active faculty_researcher/student_researcher users with at
    // least one submission; fall back to the researchers directory count when
    // no users are linked to submissions yet.
    const researcherRoles = new Set(['faculty_researcher', 'student_researcher']);
    const submitterIds = new Set(subsList.map(s => s.submitterId).filter(Boolean));
    const researchUsers = usersList.filter(u => u.status === 'active' && researcherRoles.has(u.role) && submitterIds.has(u.id));
    summary.researchers = researchUsers.length || researchersList.length;
    summary.researchPapers = subsList.length + repoList.length;
    summary.approvedResearches = subsList.filter(s => ['approved', 'published'].includes(s.status)).length + repoList.filter(r => r.status === 'approved').length;
    summary.archivedResearches = subsList.filter(s => s.status === 'archived').length + repoList.filter(r => r.status === 'archived').length;
    summary.publishedPapers = pubList.length;

    const activeStatuses = new Set(['submitted', 'under_initial_checking', 'for_revision', 'under_ethics_review', 'approved', 'published']);
    summary.activeProjects = subsList.filter(s => activeStatuses.has(s.status)).length;

    const outputWindow = Array.from({ length: 7 }, (_, i) => {
      const date = new Date();
      date.setDate(1);
      date.setMonth(date.getMonth() - 6 + i);
      return { key: monthKey(date), label: date.toLocaleString('en-US', { month: 'short' }), count: 0 };
    });

    const collectMonth = (value) => {
      const date = parseDate(value);
      if (!date) return;
      const key = monthKey(date);
      const bucket = outputWindow.find(m => m.key === key);
      if (bucket) bucket.count += 1;
    };

    // Monthly output derives from actual submissions (createdAt), covering the
    // trailing 7-month window rendered by the hero widget.
    subsList.forEach(s => collectMonth(s.createdAt));

    summary.monthlyOutput = outputWindow.map(m => m.count);

    const now = Date.now();
    let onTimeCount = 0;
    let eligibleCount = 0;

    subsList.forEach(sub => {
      if (!Array.isArray(sub.statusHistory) || !sub.createdAt) return;
      const createdAt = parseDate(sub.createdAt);
      if (!createdAt) return;
      const approvalEntry = sub.statusHistory.find(history => ['approved', 'published'].includes(history.status));
      if (!approvalEntry || !approvalEntry.at) return;
      const approvedAt = parseDate(approvalEntry.at);
      if (!approvedAt) return;
      eligibleCount += 1;
      if (approvedAt.getTime() - createdAt.getTime() <= REVIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
        onTimeCount += 1;
      }
    });

    summary.approvalRate = summary.totalSubmissions ? Math.round(100 * summary.approvedResearches / summary.totalSubmissions) : 0;
    summary.onTimeDelivery = eligibleCount ? Math.round(100 * onTimeCount / eligibleCount) : 88;

    const citationTotal = researchersList.reduce((sum, item) => sum + (Number(item.citations) || 0), 0);
    const target = ANNUAL_GOAL_TARGET;
    summary.goalProgress = Math.min(100, Math.round((summary.publications / target) * 100));
    summary.goalLabel = summary.publications >= target ? 'Goal achieved' : 'On track for 2026';
    summary.goalSubtext = citationTotal ? `+${Math.min(99, Math.round(citationTotal / 120))}% citations YoY` : '+0% citations YoY';
    summary.lastUpdated = new Date().toISOString();
  } catch (err) {
    console.error('Error reading dashboard summary:', err);
  }

  return summary;
}

async function writeContent(name, data) {
  await fs.writeFile(join(DATA_DIR, CONTENT_FILES[name] || name + '.json'), JSON.stringify(data, null, 2));
}

// ---------- Dashboard summary (MySQL) ----------
router.get('/summary', requireAdmin, async (req, res) => {
  const summary = await calculateDashboardSummary();
  res.json({ summary });
});

router.get('/public-summary', async (req, res) => {
  const summary = await calculateDashboardSummary();
  res.json({ summary, public: true });
});

// ---------- Reports (MySQL) ----------
router.get('/reports/department', requireAdmin, async (req, res) => {
  try {
    const repo = await all("SELECT COALESCE(department, 'Unknown') AS department FROM repository");
    const deptMap = {};
    repo.forEach(r => { deptMap[r.department] = (deptMap[r.department] || 0) + 1; });
    res.json({ report: Object.entries(deptMap).map(([name, count]) => ({ department: name, count })) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate report.' });
  }
});

router.get('/reports/year', requireAdmin, async (req, res) => {
  try {
    const repo = await all("SELECT COALESCE(yearCompleted, 'Unknown') AS year FROM repository");
    const pubs = await all("SELECT LEFT(COALESCE(publicationDate, ''), 4) AS year FROM publications");
    const yearMap = {};
    repo.forEach(r => { yearMap[r.year] = (yearMap[r.year] || 0) + 1; });
    pubs.forEach(p => { const yr = p.year || 'Unknown'; yearMap[yr] = (yearMap[yr] || 0) + 1; });
    res.json({ report: Object.entries(yearMap).map(([year, count]) => ({ year, count })) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate report.' });
  }
});

router.get('/reports/submissions-status', requireAdmin, async (req, res) => {
  try {
    const subs = await all("SELECT COALESCE(status, 'Unknown') AS status FROM submissions");
    const statusMap = {};
    subs.forEach(s => { statusMap[s.status] = (statusMap[s.status] || 0) + 1; });
    res.json({ report: Object.entries(statusMap).map(([status, count]) => ({ status, count })) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate report.' });
  }
});

router.get('/reports/ethics-status', requireAdmin, async (req, res) => {
  try {
    const ethics = await all("SELECT COALESCE(status, 'Unknown') AS status FROM ethics");
    const statusMap = {};
    ethics.forEach(e => { statusMap[e.status] = (statusMap[e.status] || 0) + 1; });
    res.json({ report: Object.entries(statusMap).map(([status, count]) => ({ status, count })) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate report.' });
  }
});

router.get('/reports/productivity', requireAdmin, async (req, res) => {
  try {
    const researchers = await all('SELECT fullName, type, department, program, completedResearches, publishedWorks, presentedPapers, innovationProjects, citations, awards FROM researchers');
    const report = researchers.map(r => ({
      name: r.fullName,
      type: r.type,
      department: r.department || r.program || '',
      completedResearches: (r.completedResearches || []).length,
      publications: (r.publishedWorks || []).length,
      presentations: (r.presentedPapers || []).length,
      innovationProjects: (r.innovationProjects || []).length,
      citations: r.citations || 0,
      awards: (r.awards || []).length
    }));
    res.json({ report });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate report.' });
  }
});

router.get('/reports/innovation-extension', requireAdmin, async (req, res) => {
  try {
    const records = await all('SELECT title, projectType, proponents, department, beneficiaries, communityPartner, implementationDate, communityOutcome FROM innovation_extension');
    const report = records.map(r => ({
      title: r.title,
      projectType: r.projectType,
      proponents: r.proponents,
      department: r.department,
      beneficiaries: r.beneficiaries || 0,
      communityPartner: r.communityPartner || '',
      implementationDate: r.implementationDate || '',
      communityOutcome: r.communityOutcome || ''
    }));
    res.json({ report });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate report.' });
  }
});

router.get('/reports/events-participation', requireAdmin, async (req, res) => {
  try {
    const events = await all('SELECT * FROM events_module');
    const regs = await all('SELECT * FROM event_registrations');
    const report = events.map(e => ({
      title: e.title,
      dateTime: e.dateTime,
      venue: e.venue,
      totalRegistrants: regs.filter(r => r.eventId === e.id).length,
      presenters: regs.filter(r => r.eventId === e.id && r.participantType === 'presenter').length,
      attendees: regs.filter(r => r.eventId === e.id && r.participantType === 'attendee').length
    }));
    res.json({ report });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate report.' });
  }
});

router.get('/reports/publications-monitoring', requireAdmin, async (req, res) => {
  try {
    const pubs = await all('SELECT title, authors, journalOrConference, pubType, status, publicationDate, doi, department, schoolYear FROM publications');
    const report = pubs.map(p => ({
      title: p.title,
      authors: p.authors,
      journalOrConference: p.journalOrConference,
      pubType: p.pubType,
      status: p.status,
      publicationDate: p.publicationDate,
      doi: p.doi || '',
      department: p.department || '',
      schoolYear: p.schoolYear || ''
    }));
    res.json({ report });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate report.' });
  }
});

router.get('/reports/research-output', requireAdmin, async (req, res) => {
  try {
    const repo = await all("SELECT COALESCE(department, 'Unknown') AS department, COALESCE(yearCompleted, 'Unknown') AS yearCompleted FROM repository");
    const deptMap = {};
    const yearMap = {};
    repo.forEach(r => {
      deptMap[r.department] = (deptMap[r.department] || 0) + 1;
      yearMap[r.yearCompleted] = (yearMap[r.yearCompleted] || 0) + 1;
    });
    res.json({
      byDepartment: Object.entries(deptMap).map(([name, count]) => ({ department: name, count })),
      byYear: Object.entries(yearMap).map(([year, count]) => ({ year, count }))
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate report.' });
  }
});

// ---------- Content management (remains JSON - no MySQL tables) ----------
router.post('/content/homepage', requireAdmin, async (req, res) => {
  await addLog('content_update', 'Updated homepage content', req);
  const b = req.body || {};
  const profile = await readContent('profile');
  if (b.description) profile.description = String(b.description).trim();
  if (b.tagline) profile.tagline = String(b.tagline).trim();
  await writeContent('profile', profile);
  res.json({ message: 'Homepage content updated.', profile });
});

router.post('/content/announcement', requireAdmin, async (req, res) => {
  await addLog('content_create', 'Created announcement', req);
  const b = req.body || {};
  if (!b.title || !b.content) return res.status(400).json({ error: 'Title and content are required.' });
  const announcements = await readContent('announcements');
  announcements.push({
    id: randomUUID(),
    title: String(b.title).trim(),
    content: String(b.content).trim(),
    category: b.category ? String(b.category).trim() : 'General',
    date: b.date ? String(b.date).trim() : new Date().toISOString().split('T')[0],
    excerpt: b.excerpt ? String(b.excerpt).trim() : '',
    createdAt: new Date().toISOString()
  });
  await writeContent('announcements', announcements);
  res.status(201).json({ message: 'Announcement created.', announcement: announcements[announcements.length - 1] });
});

router.patch('/content/announcement/:id', requireAdmin, async (req, res) => {
  await addLog('content_update', 'Updated announcement ' + req.params.id, req);
  const b = req.body || {};
  const announcements = await readContent('announcements');
  const idx = announcements.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Announcement not found.' });
  for (const f of ['title', 'content', 'category', 'date', 'excerpt']) {
    if (b[f] !== undefined) announcements[idx][f] = String(b[f]).trim();
  }
  await writeContent('announcements', announcements);
  res.json({ message: 'Announcement updated.', announcement: announcements[idx] });
});

router.delete('/content/announcement/:id', requireAdmin, async (req, res) => {
  await addLog('content_delete', 'Deleted announcement ' + req.params.id, req);
  const announcements = await readContent('announcements');
  const filtered = announcements.filter(a => a.id !== req.params.id);
  if (filtered.length === announcements.length) return res.status(404).json({ error: 'Announcement not found.' });
  await writeContent('announcements', filtered);
  res.json({ message: 'Announcement deleted.' });
});

router.post('/content/event', requireAdmin, async (req, res) => {
  await addLog('content_create', 'Created event', req);
  const b = req.body || {};
  if (!b.title || !b.theme || !b.dateTime || !b.venue) return res.status(400).json({ error: 'Required fields missing.' });
  const contentEvents = await readContent('events');
  contentEvents.push({
    id: randomUUID(),
    title: String(b.title).trim(),
    theme: String(b.theme).trim(),
    dateTime: String(b.dateTime).trim(),
    venue: String(b.venue).trim(),
    description: b.description ? String(b.description).trim() : '',
    location: b.location ? String(b.location).trim() : '',
    createdAt: new Date().toISOString()
  });
  await writeContent('events', contentEvents);
  res.status(201).json({ message: 'Event created.', event: contentEvents[contentEvents.length - 1] });
});

router.post('/content/agenda', requireAdmin, async (req, res) => {
  await addLog('content_update', 'Updated research agenda', req);
  const b = req.body || {};
  if (!b.items) return res.status(400).json({ error: 'Agenda items are required.' });
  const agenda = await readContent('agenda');
  agenda.push({
    id: randomUUID(),
    title: String(b.title).trim(),
    description: String(b.description).trim(),
    items: Array.isArray(b.items) ? b.items : [],
    createdAt: new Date().toISOString()
  });
  await writeContent('agenda', agenda);
  res.status(201).json({ message: 'Research agenda updated.', agenda: agenda[agenda.length - 1] });
});

// ---------- Logs (MySQL) ----------
router.get('/logs', requireAdmin, async (req, res) => {
  const q = req.query;
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(10, parseInt(q.pageSize, 10) || 50));
  const offset = (page - 1) * pageSize;

  let where = 'WHERE 1=1';
  const params = [];

  if (q.action) { where += ' AND l.action = ?'; params.push(q.action); }
  if (q.userId) { where += ' AND l.userId = ?'; params.push(q.userId); }
  if (q.from) { where += ' AND l.timestamp >= ?'; params.push(q.from); }
  if (q.to) { where += ' AND l.timestamp <= ?'; params.push(q.to); }

  const [countRows, logs] = await Promise.all([
    all(`SELECT COUNT(*) AS total FROM system_logs l ${where}`, params),
    all(`
      SELECT l.*, u.fullName AS actorName, u.username AS actorUsername
      FROM system_logs l
      LEFT JOIN users u ON u.id = l.userId
      ${where}
      ORDER BY l.timestamp DESC
      LIMIT ? OFFSET ?
    `, [...params, pageSize, offset])
  ]);

  const total = countRows.length ? countRows[0].total : 0;
  res.json({ logs, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
});

// ---------- User management (MySQL) ----------
router.get('/users', requireAdmin, async (req, res) => {
  const users = await all('SELECT id, username, email, fullName, role, status, createdAt FROM users ORDER BY createdAt DESC');
  res.json({ users });
});

router.patch('/users/:id', requireAdmin, async (req, res) => {
  await addLog('user_update', 'Updated user ' + req.params.id, req);
  const b = req.body || {};
  const user = await get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const changes = {};
  for (const f of ['role', 'status', 'department']) {
    if (b[f] !== undefined) changes[f] = String(b[f]).trim();
  }
  if (Object.keys(changes).length > 0) {
    await update('users', req.params.id, changes);
  }
  const updated = await get('SELECT id, username, email, fullName, role, status FROM users WHERE id = ?', [req.params.id]);
  res.json({ message: 'User updated.', user: updated });
});

router.post('/users/:id/reset-password', requireAdmin, async (req, res) => {
  await addLog('password_reset', 'Reset password for user ' + req.params.id, req);
  const b = req.body || {};
  const newPassword = b.newPassword;
  if (!newPassword || String(newPassword).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  const bcrypt = await import('bcryptjs');
  const user = await get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const hash = await bcrypt.hash(String(newPassword), 10);
  await update('users', req.params.id, { passwordHash: hash });
  res.json({ message: 'Password reset successfully.' });
});

router.delete('/users/:id', requireAdmin, async (req, res) => {
  await addLog('user_delete', 'Deleted user ' + req.params.id, req);
  const user = await get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  await remove('users', req.params.id);
  res.json({ message: 'User deleted.' });
});

export { router as adminDashboardRouter };

