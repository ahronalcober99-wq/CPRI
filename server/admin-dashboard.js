import { Router } from 'express';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { promises as fs } from 'fs';
import { requireAuth, requireAdmin, readUsers } from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, 'data');
const LOGS_FILE = join(DATA_DIR, 'system-logs.json');

const router = Router();

const CONTENT_FILES = {
  profile: 'profile.json',
  announcements: 'announcements.json',
  events: 'events.json',
  agenda: 'agenda.json'
};

async function readLogs() {
  try { return JSON.parse(await fs.readFile(LOGS_FILE, 'utf8')); } catch { return []; }
}
async function writeLogs(list) {
  await fs.writeFile(LOGS_FILE, JSON.stringify(list, null, 2));
}
async function addLog(action, details, req) {
  const logs = await readLogs();
  logs.push({
    id: randomUUID(),
    action,
    details,
    userId: req.session?.userId || null,
    ip: req.ip || req.connection?.remoteAddress || null,
    userAgent: req.get('user-agent') || null,
    timestamp: new Date().toISOString()
  });
  if (logs.length > 5000) logs.splice(0, logs.length - 5000);
  await writeLogs(logs);
}

router.get('/summary', requireAdmin, async (req, res) => {
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
    totalEvents: 0
  };

  try {
    const [subs, repo, pubs, ethics, innovation, events, users] = await Promise.all([
      fs.readFile(join(DATA_DIR, 'submissions.json'), 'utf8').catch(() => '[]'),
      fs.readFile(join(DATA_DIR, 'repository.json'), 'utf8').catch(() => '[]'),
      fs.readFile(join(DATA_DIR, 'publications.json'), 'utf8').catch(() => '[]'),
      fs.readFile(join(DATA_DIR, 'ethics.json'), 'utf8').catch(() => '[]'),
      fs.readFile(join(DATA_DIR, 'innovation-extension.json'), 'utf8').catch(() => '[]'),
      fs.readFile(join(DATA_DIR, 'events-module.json'), 'utf8').catch(() => '[]'),
      fs.readFile(join(DATA_DIR, 'users.json'), 'utf8').catch(() => '[]')
    ]);

    const subList = JSON.parse(subs);
    const repoList = JSON.parse(repo);
    const pubList = JSON.parse(pubs);
    const ethicsList = JSON.parse(ethics);
    const innoList = JSON.parse(innovation);
    const eventsList = JSON.parse(events);
    const usersList = JSON.parse(users);

    summary.totalSubmissions = subList.length;
    summary.totalRepository = repoList.length;
    summary.totalPublications = pubList.length;
    summary.totalEvents = eventsList.length;

    summary.researchPapers = subList.length + repoList.length;
    summary.approvedResearches = subList.filter(s => s.status === 'approved').length + repoList.filter(r => r.status === 'approved').length;
    summary.archivedResearches = subList.filter(s => s.status === 'archived').length + repoList.filter(r => r.status === 'archived').length;
    summary.publishedPapers = pubList.filter(p => p.status === 'published').length;
    summary.ethicsApplications = ethicsList.length;
    summary.innovationProjects = innoList.length;
    summary.activeUsers = usersList.filter(u => u.status === 'active').length;
  } catch (err) {
    console.error('Error reading dashboard summary:', err);
  }

  res.json({ summary });
});

router.get('/reports/department', requireAdmin, async (req, res) => {
  try {
    const repoRaw = await fs.readFile(join(DATA_DIR, 'repository.json'), 'utf8').catch(() => '[]');
    const repo = JSON.parse(repoRaw);
    const deptMap = {};
    repo.forEach(r => {
      const dept = r.department || 'Unknown';
      deptMap[dept] = (deptMap[dept] || 0) + 1;
    });
    res.json({ report: Object.entries(deptMap).map(([name, count]) => ({ department: name, count })) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate report.' });
  }
});

router.get('/reports/year', requireAdmin, async (req, res) => {
  try {
    const repoRaw = await fs.readFile(join(DATA_DIR, 'repository.json'), 'utf8').catch(() => '[]');
    const pubsRaw = await fs.readFile(join(DATA_DIR, 'publications.json'), 'utf8').catch(() => '[]');
    const repo = JSON.parse(repoRaw);
    const pubs = JSON.parse(pubsRaw);
    const yearMap = {};
    repo.forEach(r => {
      const yr = r.yearCompleted || 'Unknown';
      yearMap[yr] = (yearMap[yr] || 0) + 1;
    });
    pubs.forEach(p => {
      const yr = (p.publicationDate || '').slice(0, 4) || 'Unknown';
      yearMap[yr] = (yearMap[yr] || 0) + 1;
    });
    res.json({ report: Object.entries(yearMap).map(([year, count]) => ({ year, count })) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate report.' });
  }
});

router.get('/reports/submissions-status', requireAdmin, async (req, res) => {
  try {
    const subsRaw = await fs.readFile(join(DATA_DIR, 'submissions.json'), 'utf8').catch(() => '[]');
    const subs = JSON.parse(subsRaw);
    const statusMap = {};
    subs.forEach(s => {
      statusMap[s.status] = (statusMap[s.status] || 0) + 1;
    });
    res.json({ report: Object.entries(statusMap).map(([status, count]) => ({ status, count })) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate report.' });
  }
});

router.get('/reports/ethics-status', requireAdmin, async (req, res) => {
  try {
    const ethicsRaw = await fs.readFile(join(DATA_DIR, 'ethics.json'), 'utf8').catch(() => '[]');
    const ethics = JSON.parse(ethicsRaw);
    const statusMap = {};
    ethics.forEach(e => {
      statusMap[e.status] = (statusMap[e.status] || 0) + 1;
    });
    res.json({ report: Object.entries(statusMap).map(([status, count]) => ({ status, count })) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate report.' });
  }
});

router.get('/reports/productivity', requireAdmin, async (req, res) => {
  try {
    const researchersRaw = await fs.readFile(join(DATA_DIR, 'researchers.json'), 'utf8').catch(() => '[]');
    const researchers = JSON.parse(researchersRaw);
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
    const innoRaw = await fs.readFile(join(DATA_DIR, 'innovation-extension.json'), 'utf8').catch(() => '[]');
    const inno = JSON.parse(innoRaw);
    const report = inno.map(r => ({
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
    const eventsRaw = await fs.readFile(join(DATA_DIR, 'events-module.json'), 'utf8').catch(() => '[]');
    const regsRaw = await fs.readFile(join(DATA_DIR, 'event-registrations.json'), 'utf8').catch(() => '[]');
    const events = JSON.parse(eventsRaw);
    const regs = JSON.parse(regsRaw);
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
    const pubsRaw = await fs.readFile(join(DATA_DIR, 'publications.json'), 'utf8').catch(() => '[]');
    const pubs = JSON.parse(pubsRaw);
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
    const repoRaw = await fs.readFile(join(DATA_DIR, 'repository.json'), 'utf8').catch(() => '[]');
    const repo = JSON.parse(repoRaw);
    const deptMap = {};
    const yearMap = {};
    repo.forEach(r => {
      const dept = r.department || 'Unknown';
      const yr = r.yearCompleted || 'Unknown';
      deptMap[dept] = (deptMap[dept] || 0) + 1;
      yearMap[yr] = (yearMap[yr] || 0) + 1;
    });
    res.json({
      byDepartment: Object.entries(deptMap).map(([name, count]) => ({ department: name, count })),
      byYear: Object.entries(yearMap).map(([year, count]) => ({ year, count }))
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate report.' });
  }
});

router.post('/content/homepage', requireAdmin, async (req, res) => {
  await addLog('content_update', 'Updated homepage content', req);
  const b = req.body || {};
  const profileRaw = await fs.readFile(join(DATA_DIR, 'profile.json'), 'utf8').catch(() => '{}');
  const profile = JSON.parse(profileRaw);
  if (b.description) profile.description = String(b.description).trim();
  if (b.tagline) profile.tagline = String(b.tagline).trim();
  await fs.writeFile(join(DATA_DIR, 'profile.json'), JSON.stringify(profile, null, 2));
  res.json({ message: 'Homepage content updated.', profile });
});

router.post('/content/announcement', requireAdmin, async (req, res) => {
  await addLog('content_create', 'Created announcement', req);
  const b = req.body || {};
  if (!b.title || !b.content) return res.status(400).json({ error: 'Title and content are required.' });
  const announcementsRaw = await fs.readFile(join(DATA_DIR, 'announcements.json'), 'utf8').catch(() => '[]');
  const announcements = JSON.parse(announcementsRaw);
  announcements.push({
    id: randomUUID(),
    title: String(b.title).trim(),
    content: String(b.content).trim(),
    category: b.category ? String(b.category).trim() : 'General',
    date: b.date ? String(b.date).trim() : new Date().toISOString().split('T')[0],
    excerpt: b.excerpt ? String(b.excerpt).trim() : '',
    createdAt: new Date().toISOString()
  });
  await fs.writeFile(join(DATA_DIR, 'announcements.json'), JSON.stringify(announcements, null, 2));
  res.status(201).json({ message: 'Announcement created.', announcement: announcements[announcements.length - 1] });
});

router.patch('/content/announcement/:id', requireAdmin, async (req, res) => {
  await addLog('content_update', 'Updated announcement', req);
  const b = req.body || {};
  const announcementsRaw = await fs.readFile(join(DATA_DIR, 'announcements.json'), 'utf8').catch(() => '[]');
  const announcements = JSON.parse(announcementsRaw);
  const idx = announcements.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Announcement not found.' });
  for (const f of ['title', 'content', 'category', 'date', 'excerpt']) {
    if (b[f] !== undefined) announcements[idx][f] = String(b[f]).trim();
  }
  await fs.writeFile(join(DATA_DIR, 'announcements.json'), JSON.stringify(announcements, null, 2));
  res.json({ message: 'Announcement updated.', announcement: announcements[idx] });
});

router.delete('/content/announcement/:id', requireAdmin, async (req, res) => {
  await addLog('content_delete', 'Deleted announcement', req);
  const announcementsRaw = await fs.readFile(join(DATA_DIR, 'announcements.json'), 'utf8').catch(() => '[]');
  const announcements = JSON.parse(announcementsRaw);
  const filtered = announcements.filter(a => a.id !== req.params.id);
  if (filtered.length === announcements.length) return res.status(404).json({ error: 'Announcement not found.' });
  await fs.writeFile(join(DATA_DIR, 'announcements.json'), JSON.stringify(filtered, null, 2));
  res.json({ message: 'Announcement deleted.' });
});

router.post('/content/event', requireAdmin, async (req, res) => {
  await addLog('content_create', 'Created event', req);
  const b = req.body || {};
  if (!b.title || !b.theme || !b.dateTime || !b.venue) return res.status(400).json({ error: 'Required fields missing.' });
  const eventsRaw = await fs.readFile(join(DATA_DIR, 'events.json'), 'utf8').catch(() => '[]');
  const events = JSON.parse(eventsRaw);
  events.push({
    id: randomUUID(),
    title: String(b.title).trim(),
    theme: String(b.theme).trim(),
    dateTime: String(b.dateTime).trim(),
    venue: String(b.venue).trim(),
    description: b.description ? String(b.description).trim() : '',
    location: b.location ? String(b.location).trim() : '',
    createdAt: new Date().toISOString()
  });
  await fs.writeFile(join(DATA_DIR, 'events.json'), JSON.stringify(events, null, 2));
  res.status(201).json({ message: 'Event created.', event: events[events.length - 1] });
});

router.post('/content/agenda', requireAdmin, async (req, res) => {
  await addLog('content_update', 'Updated research agenda', req);
  const b = req.body || {};
  if (!b.items) return res.status(400).json({ error: 'Agenda items are required.' });
  const agendaRaw = await fs.readFile(join(DATA_DIR, 'agenda.json'), 'utf8').catch(() => '[]');
  const agenda = JSON.parse(agendaRaw);
  agenda.push({
    id: randomUUID(),
    title: String(b.title).trim(),
    description: String(b.description).trim(),
    items: Array.isArray(b.items) ? b.items : [],
    createdAt: new Date().toISOString()
  });
  await fs.writeFile(join(DATA_DIR, 'agenda.json'), JSON.stringify(agenda, null, 2));
  res.status(201).json({ message: 'Research agenda updated.', agenda: agenda[agenda.length - 1] });
});

router.get('/logs', requireAdmin, async (req, res) => {
  const logs = await readLogs();
  const q = req.query;
  let filtered = logs;
  if (q.action) filtered = filtered.filter(l => l.action === q.action);
  if (q.userId) filtered = filtered.filter(l => l.userId === q.userId);
  if (q.from) filtered = filtered.filter(l => new Date(l.timestamp) >= new Date(q.from));
  if (q.to) filtered = filtered.filter(l => new Date(l.timestamp) <= new Date(q.to));
  res.json({ logs: filtered.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 500) });
});

router.get('/users', requireAdmin, async (req, res) => {
  const users = await readUsers();
  res.json({ users: users.map(u => ({ id: u.id, username: u.username, email: u.email, fullName: u.fullName, role: u.role, status: u.status, createdAt: u.createdAt })) });
});

router.patch('/users/:id', requireAdmin, async (req, res) => {
  await addLog('user_update', 'Updated user ' + req.params.id, req);
  const b = req.body || {};
  const users = await readUsers();
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  for (const f of ['role', 'status', 'department']) {
    if (b[f] !== undefined) user[f] = String(b[f]).trim();
  }
  await fs.writeFile(join(DATA_DIR, 'users.json'), JSON.stringify(users, null, 2));
  res.json({ message: 'User updated.', user: { id: user.id, username: user.username, email: user.email, fullName: user.fullName, role: user.role, status: user.status } });
});

router.post('/users/:id/reset-password', requireAdmin, async (req, res) => {
  await addLog('password_reset', 'Reset password for user ' + req.params.id, req);
  const b = req.body || {};
  const newPassword = b.newPassword;
  if (!newPassword || String(newPassword).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  const bcrypt = await import('bcryptjs');
  const users = await readUsers();
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  user.passwordHash = await bcrypt.hash(String(newPassword), 10);
  await fs.writeFile(join(DATA_DIR, 'users.json'), JSON.stringify(users, null, 2));
  res.json({ message: 'Password reset successfully.' });
});

router.delete('/users/:id', requireAdmin, async (req, res) => {
  await addLog('user_delete', 'Deleted user ' + req.params.id, req);
  const users = await readUsers();
  const remaining = users.filter(u => u.id !== req.params.id);
  if (remaining.length === users.length) return res.status(404).json({ error: 'User not found.' });
  await fs.writeFile(join(DATA_DIR, 'users.json'), JSON.stringify(remaining, null, 2));
  res.json({ message: 'User deleted.' });
});

export { router as adminDashboardRouter };
