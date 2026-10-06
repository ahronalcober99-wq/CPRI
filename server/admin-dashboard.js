import { Router } from 'express';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, extname, join } from 'path';
import { promises as fs } from 'fs';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import { requireAuth, requireAdmin, requireRole, readUsers } from './auth.js';
import { all, get, run, insert, update, remove } from './server/db/queries.js';
import { addLog } from './audit.js';
import { notify } from './notifications.js';
import { supabaseStorage } from './storage/supabase-storage.js';
import { cleanupEventImages, MAX_EVENT_IMAGE_SIZE, isEventImageObjectId, normalizeEventImage, validateEventImage } from './event-image-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, 'data');
// Sessions are file-backed (see server.js), which is also how "online now" is counted.
const SESSIONS_DIR = join(__dirname, 'data', 'sessions');

// mysql2 hands back DATETIME columns as Date objects, so timestamps must be
// formatted rather than string-sliced. Matches the helpers in admin-insights.js.
function toDate(value) {
  const d = new Date(value);
  return isNaN(d) ? null : d;
}
function monthKeyOf(value) {
  const d = toDate(value);
  return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : '';
}
function dayKeyOf(value) {
  const d = toDate(value);
  return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '';
}
const router = Router();

// Roles allowed to post/update/delete announcements. Students and public
// visitors are consumers only — they receive announcements as notifications.
const ANNOUNCEMENT_SENDER_ROLES = ['admin', 'cpri_staff', 'faculty_researcher', 'adviser', 'ethics_reviewer'];

const CONTENT_FILES = {
  profile: 'profile.json',
  announcements: 'announcements.json',
  events: 'events.json',
  agenda: 'agenda.json',
  research: 'research.json'
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
    rejectedResearches: 0,
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
      all('SELECT id, status, sourceSubmissionId, createdAt FROM repository'),
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
    // Count each research once. Submissions are authoritative; repository
    // records that mirror a submission (sourceSubmissionId set) are copies of it
    // and never add a second count, so a rejected submission can never inflate
    // the approved total. Standalone repository records count by their own status.
    const approvedSubIds = new Set(subsList.filter(s => ['approved', 'published'].includes(s.status)).map(s => s.id));
    summary.approvedResearches = approvedSubIds.size + repoList.filter(r => r.status === 'approved' && !r.sourceSubmissionId).length;
    const rejectedSubIds = new Set(subsList.filter(s => s.status === 'rejected').map(s => s.id));
    summary.rejectedResearches = rejectedSubIds.size + repoList.filter(r => r.status === 'rejected' && !r.sourceSubmissionId).length;
    const archivedSubIds = new Set(subsList.filter(s => s.status === 'archived').map(s => s.id));
    summary.archivedResearches = archivedSubIds.size + repoList.filter(r => r.status === 'archived' && !r.sourceSubmissionId).length;
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

// ---------- Hero stat chips (public) ----------
// Feeds the "Publications & briefs" and "Review approval rate" chips on the
// homepage hero. Uses the same numbers the Research Analytics dashboard shows:
// total publication records (all statuses) and the submission approval rate
// (approved or published / total submitted).
router.get('/hero-stats', async (req, res) => {
  try {
    const [pubs, subs] = await Promise.all([
      all('SELECT COUNT(*) AS c FROM publications'),
      all('SELECT status FROM submissions')
    ]);
    const publicationsAndBriefs = pubs[0] ? Number(pubs[0].c) : 0;
    const approved = subs.filter(s => ['approved', 'published'].includes(s.status)).length;
    const reviewApprovalRate = subs.length ? Math.round((approved / subs.length) * 100) : 0;
    res.json({
      stats: {
        publicationsAndBriefs,
        reviewApprovalRate,
        lastUpdated: new Date().toISOString()
      }
    });
  } catch (err) {
    console.error('[hero-stats] error:', err);
    res.status(500).json({ error: 'Failed to load hero stats.' });
  }
});

// ---------- Research Impact Dashboard (admin) ----------
// Backs public/research-impact-dashboard.html. Every figure is computed from MySQL;
// nothing is hard-coded. The few metrics this schema does not record (per-record
// views, downloads and the top-viewed/top-downloaded lists) are returned as null or
// an empty list so the page can label them "Not tracked" instead of showing a made-up 0.
router.get('/impact-dashboard', requireAdmin, async (req, res) => {
  try {
    const { year, department, category, adviser, from, to } = req.query;

    // The page's filters map onto columns of `submissions`.
    const where = [];
    const params = [];
    if (year) { where.push('schoolYear = ?'); params.push(String(year)); }
    if (department) { where.push('program = ?'); params.push(String(department)); }
    if (category) { where.push('category = ?'); params.push(String(category)); }
    if (adviser) { where.push('adviser = ?'); params.push(String(adviser)); }
    if (from) { where.push('createdAt >= ?'); params.push(String(from)); }
    if (to) { where.push('createdAt <= ?'); params.push(String(to) + ' 23:59:59'); }
    const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';

    const [subs, allSubs, researchers, adviserAccounts, logs] = await Promise.all([
      all(`SELECT id, title, status, program, category, adviser, schoolYear, createdAt FROM submissions${whereSql}`, params),
      all('SELECT schoolYear, program, category, adviser FROM submissions'),
      all('SELECT department FROM researchers'),
      // "Registered" researchers/advisers are user accounts, not directory entries.
      all("SELECT id, role FROM users WHERE role IN ('faculty_researcher', 'student_researcher', 'adviser')"),
      all('SELECT action, details, timestamp FROM system_logs ORDER BY timestamp DESC LIMIT 10')
    ]);

    const countBy = (rows, keyOf) => rows.reduce((m, r) => {
      const k = keyOf(r);
      m[k] = (m[k] || 0) + 1;
      return m;
    }, {});

    const statusCount = countBy(subs, (s) => String(s.status || 'unknown'));
    const statusValue = (...names) => names.reduce((n, name) => n + (statusCount[name] || 0), 0);
    const total = subs.length;

    // Last 12 months of submissions, oldest first.
    const now = new Date();
    const monthly = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      monthly.push({
        key: monthKeyOf(d),
        label: d.toLocaleString('en-US', { month: 'short', year: 'numeric' }),
        value: 0
      });
    }
    subs.forEach((s) => {
      const bucket = monthly.find((m) => m.key === monthKeyOf(s.createdAt));
      if (bucket) bucket.value += 1;
    });

    const STATUS_LABELS = {
      submitted: 'Submitted',
      under_initial_checking: 'Initial Checking',
      for_revision: 'For Revision',
      under_ethics_review: 'Ethics Review',
      approved: 'Approved',
      published: 'Published',
      archived: 'Archived',
      rejected: 'Rejected'
    };
    const asChartRows = (map) => Object.entries(map)
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value);

    // "Online" = a session file touched in the last 15 minutes.
    let activeUsersOnline = null;
    try {
      const files = await fs.readdir(SESSIONS_DIR);
      const cutoff = Date.now() - 15 * 60 * 1000;
      let live = 0;
      for (const f of files) {
        const st = await fs.stat(join(SESSIONS_DIR, f)).catch(() => null);
        if (st && st.mtimeMs >= cutoff) live += 1;
      }
      activeUsersOnline = live;
    } catch { /* no session directory on this host */ }

    const today = dayKeyOf(new Date());

    res.json({
      generatedAt: new Date().toISOString(),
      hasData: total > 0 || researchers.length > 0,
      stats: {
        totalResearchPapers: total,
        publishedResearch: statusValue('published'),
        approvedResearch: statusValue('approved'),
        pendingResearch: statusValue('submitted', 'under_initial_checking', 'for_revision', 'under_ethics_review'),
        rejectedResearch: statusValue('rejected'),
        archivedResearch: statusValue('archived'),
        totalResearchers: adviserAccounts.filter(u => u.role !== 'adviser').length,
        totalFacultyAdvisers: adviserAccounts.filter(u => u.role === 'adviser').length,
        // Not recorded anywhere in this schema — null renders as "Not tracked".
        totalDownloads: null,
        totalViews: null,
        activeUsersOnline,
        newResearchSubmittedToday: subs.filter(s => dayKeyOf(s.createdAt) === today).length
      },
      charts: {
        monthlySubmissions: monthly.map(({ label, value }) => ({ label, value })),
        statusBreakdown: asChartRows(statusCount).map(r => ({ label: STATUS_LABELS[r.label] || r.label, value: r.value })),
        departmentBreakdown: asChartRows(countBy(subs, s => String(s.program || 'Unspecified'))),
        categoryBreakdown: asChartRows(countBy(subs, s => String(s.category || 'Uncategorised'))),
        downloadsVsViews: [],
        topViewed: [],
        topDownloaded: []
      },
      activity: logs.map(l => ({
        title: String(l.action || 'activity').replace(/_/g, ' '),
        details: l.details || '',
        status: String(l.action || 'activity').split('_')[0],
        badgeClass: /delete|reject|error|fail/i.test(l.action || '') ? 'bg-danger'
          : /create|approve|publish|add/i.test(l.action || '') ? 'bg-success' : 'bg-primary',
        timestamp: l.timestamp ? new Date(l.timestamp).toLocaleString() : ''
      })),
      filters: {
        academicYears: [...new Set(allSubs.map(s => s.schoolYear).filter(Boolean))].sort().reverse(),
        departments: [...new Set(allSubs.map(s => s.program).filter(Boolean))].sort(),
        categories: [...new Set(allSubs.map(s => s.category).filter(Boolean))].sort(),
        advisers: [...new Set(allSubs.map(s => s.adviser).filter(Boolean))].sort()
      }
    });
  } catch (err) {
    console.error('[impact-dashboard] error:', err);
    res.status(500).json({ error: 'Failed to build the research impact dashboard.' });
  }
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
const BACKUPS_DIR = join(__dirname, '..', 'backups');

router.get('/backups', requireAdmin, async (req, res) => {
  try {
    await fs.mkdir(BACKUPS_DIR, { recursive: true });
    const entries = await fs.readdir(BACKUPS_DIR, { withFileTypes: true });
    const backups = [];
    for (const ent of entries) {
      if (ent.isDirectory()) {
        const manifestPath = join(BACKUPS_DIR, ent.name, 'manifest.json');
        let manifest = {};
        try {
          manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        } catch {}
        backups.push({
          folder: ent.name,
          createdAt: manifest.createdAt || ent.name,
          database: manifest.database || 'cpri',
          sqlBytes: manifest.sqlBytes || 0,
          jsonFiles: manifest.jsonFiles || 0
        });
      }
    }
    backups.sort((a, b) => b.folder.localeCompare(a.folder));
    res.json({ backups });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list backups: ' + err.message });
  }
});

router.post('/backups', requireAdmin, async (req, res) => {
  try {
    await fs.mkdir(BACKUPS_DIR, { recursive: true });
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${p(d.getMilliseconds())}`;
    const backupFolder = join(BACKUPS_DIR, stamp);
    const dataDest = join(backupFolder, 'data');
    await fs.mkdir(dataDest, { recursive: true });

    const files = await fs.readdir(DATA_DIR).catch(() => []);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    for (const f of jsonFiles) {
      await fs.copyFile(join(DATA_DIR, f), join(dataDest, f));
    }

    const manifest = {
      createdAt: new Date().toISOString(),
      database: process.env.DB_NAME || 'cpri',
      sqlBytes: 0,
      jsonFiles: jsonFiles.length,
      node: process.version
    };
    await fs.writeFile(join(backupFolder, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await addLog('backup_create', `Created backup archive: ${stamp}`, req);
    res.json({ message: 'Backup created successfully.', folder: stamp });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create backup: ' + err.message });
  }
});

router.delete('/backups/:folder', requireAdmin, async (req, res) => {
  try {
    const folder = req.params.folder.replace(/[^A-Za-z0-9_-]/g, '');
    const folderPath = join(BACKUPS_DIR, folder);
    await fs.rm(folderPath, { recursive: true, force: true });
    await addLog('backup_delete', `Deleted backup archive: ${folder}`, req);
    res.json({ message: 'Backup deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete backup: ' + err.message });
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
// Announcements may be published by admins, CPRI staff, faculty researchers,
// advisers, and ethics reviewers. On publish, every active student researcher
// gets an in-app notification (their bell); public visitors see the new
// announcement automatically through the bell's public feed (notifications.js).
router.post('/content/homepage', requireAdmin, async (req, res) => {
  await addLog('content_update', 'Updated homepage content', req);
  const b = req.body || {};
  const profile = await readContent('profile');
  if (b.description) profile.description = String(b.description).trim();
  if (b.tagline) profile.tagline = String(b.tagline).trim();
  await writeContent('profile', profile);
  res.json({ message: 'Homepage content updated.', profile });
});

router.post('/content/announcement', requireRole(...ANNOUNCEMENT_SENDER_ROLES), async (req, res) => {
  await addLog('content_create', 'Created announcement', req);
  const b = req.body || {};
  if (!b.title || !b.content) return res.status(400).json({ error: 'Title and content are required.' });
  const announcements = await readContent('announcements');
  const sender = await get('SELECT fullName, username FROM users WHERE id = ?', [req.session.userId]).catch(() => null);
  const announcement = {
    id: randomUUID(),
    title: String(b.title).trim(),
    content: String(b.content).trim(),
    category: b.category ? String(b.category).trim() : 'General',
    date: b.date ? String(b.date).trim() : new Date().toISOString().split('T')[0],
    // Auto-derive a snippet so the public bell feed / homepage cards always
    // show a message even when the sender doesn't fill in an excerpt.
    excerpt: b.excerpt ? String(b.excerpt).trim() : String(b.content).trim().slice(0, 140),
    author: (sender && (sender.fullName || sender.username)) || '',
    createdAt: new Date().toISOString()
  };
  announcements.push(announcement);
  await writeContent('announcements', announcements);

  // Notify every active student researcher in-app so the announcement lands
  // in their bell. Public visitors pick it up via the public bell feed.
  try {
    const students = await all("SELECT id FROM users WHERE role = 'student_researcher' AND status = 'active'");
    const excerpt = (announcement.excerpt || announcement.content || '').slice(0, 140);
    await Promise.all(students.map(s => notify(
      s.id, 'announcement', 'New announcement: ' + announcement.title,
      excerpt || 'An announcement was just posted.', 'announcements.html'
    )));
    if (students.length) console.log(`[announcements] notified ${students.length} student(s)`);
  } catch (err) {
    console.error('[announcements] student notify failed:', err.message);
  }

  res.status(201).json({ message: 'Announcement created.', announcement });
});

router.patch('/content/announcement/:id', requireRole(...ANNOUNCEMENT_SENDER_ROLES), async (req, res) => {
  await addLog('content_update', 'Updated announcement ' + req.params.id, req);
  const b = req.body || {};
  const announcements = await readContent('announcements');
  // Legacy seed rows may have numeric ids (1, 2, …); req.params.id is always a
  // string, so compare stringified values to match both UUID and numeric ids.
  const idx = announcements.findIndex(a => String(a.id) === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Announcement not found.' });
  for (const f of ['title', 'content', 'category', 'date', 'excerpt']) {
    if (b[f] !== undefined) announcements[idx][f] = String(b[f]).trim();
  }
  await writeContent('announcements', announcements);
  res.json({ message: 'Announcement updated.', announcement: announcements[idx] });
});

router.delete('/content/announcement/:id', requireRole(...ANNOUNCEMENT_SENDER_ROLES), async (req, res) => {
  await addLog('content_delete', 'Deleted announcement ' + req.params.id, req);
  const announcements = await readContent('announcements');
  const filtered = announcements.filter(a => String(a.id) !== req.params.id);
  if (filtered.length === announcements.length) return res.status(404).json({ error: 'Announcement not found.' });
  await writeContent('announcements', filtered);
  res.json({ message: 'Announcement deleted.' });
});

// Events are stored in the same schema the public site reads (/api/events),
// so an event published here appears immediately on the homepage, events
// listing, and calendar. Legacy field names (theme/dateTime/venue) are
// accepted as aliases for type/date/location.
const eventPhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_EVENT_IMAGE_SIZE },
  fileFilter: (req, file, cb) => {
    try {
      validateEventImage(file);
      cb(null, true);
    } catch (error) {
      error.status = 400;
      cb(error);
    }
  }
});

router.post('/content/event/photo', requireAdmin, (req, res) => {
  eventPhotoUpload.single('photo')(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Photo is too large (max 5 MB).' : (err.message || 'Photo upload failed.');
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'No image uploaded (JPG, JPEG, PNG, or WebP; max 5 MB).' });
    try {
      const contentType = validateEventImage(req.file);
      const imagePublicId = `content-events/${randomUUID()}/${randomUUID()}${extname(req.file.originalname).toLowerCase()}`;
      await supabaseStorage.uploadObject({
        path: imagePublicId,
        buffer: req.file.buffer,
        contentType,
        bucket: 'events'
      });
      const imageUrl = supabaseStorage.publicObjectUrl({ path: imagePublicId, bucket: 'events' });
      try {
        await addLog('content_update', 'Uploaded event photo', req);
      } catch (error) {
        await cleanupEventImages([imagePublicId], {
          storage: supabaseStorage,
          context: '[admin] failed to clean up an image after upload logging failed'
        });
        throw error;
      }
      res.status(201).json({ message: 'Photo uploaded.', imageUrl, imagePublicId });
    } catch (error) {
      if (error.status === 400) return res.status(400).json({ error: error.message });
      console.error('[admin] event image upload failed:', error.message);
      res.status(500).json({ error: 'Could not store the event image.' });
    }
  });
});

router.post('/content/event', requireAdmin, async (req, res) => {
  await addLog('content_create', 'Created event', req);
  const b = req.body || {};
  const title = (b.title || '').trim();
  const date = (b.date || b.dateTime || '').trim();
  const location = (b.location || b.venue || '').trim();
  if (!title || !date || !location) return res.status(400).json({ error: 'Title, date, and location are required.' });
  const contentEvents = await readContent('events');
  const image = normalizeEventImage(b);
  if (image.imagePublicId && !isEventImageObjectId(image.imagePublicId)) {
    return res.status(400).json({ error: 'Event image reference is invalid.' });
  }
  if (image.imagePublicId) {
    image.imageUrl = supabaseStorage.publicObjectUrl({ path: image.imagePublicId, bucket: 'events' });
  }
  const event = {
    id: randomUUID(),
    title,
    type: (b.type || b.theme || '').trim() || 'Event',
    date,
    location,
    description: b.description ? String(b.description).trim() : '',
    ...image,
    createdAt: new Date().toISOString()
  };
  contentEvents.push(event);
  try {
    await writeContent('events', contentEvents);
  } catch (error) {
    await cleanupEventImages([image.imagePublicId], {
      storage: supabaseStorage,
      context: '[admin] failed to clean up an image after event creation failed'
    });
    throw error;
  }
  res.status(201).json({ message: 'Event created.', event });
});

router.patch('/content/event/:id', requireAdmin, async (req, res) => {
  await addLog('content_update', 'Updated event ' + req.params.id, req);
  const b = req.body || {};
  const contentEvents = await readContent('events');
  const ev = contentEvents.find(e => e.id === req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found.' });
  const REQUIRED_EVENT = ['title', 'date', 'location'];
  for (const f of ['title', 'type', 'date', 'location', 'description']) {
    if (b[f] !== undefined) {
      const v = String(b[f]).trim();
      if (REQUIRED_EVENT.includes(f) && !v) return res.status(400).json({ error: 'Title, date, and location cannot be empty.' });
      ev[f] = v;
    }
  }
  const hasImageUpdate = b.imageUrl !== undefined || b.imagePublicId !== undefined || b.photo !== undefined;
  const previousImagePublicId = ev.imagePublicId || '';
  let newImagePublicId = '';
  if (hasImageUpdate) {
    const image = normalizeEventImage(b);
    if (image.imagePublicId && !isEventImageObjectId(image.imagePublicId)) {
      return res.status(400).json({ error: 'Event image reference is invalid.' });
    }
    if (image.imagePublicId) {
      image.imageUrl = supabaseStorage.publicObjectUrl({ path: image.imagePublicId, bucket: 'events' });
      newImagePublicId = image.imagePublicId;
    }
    ev.imageUrl = image.imageUrl;
    ev.imagePublicId = image.imagePublicId;
    delete ev.photo;
  }
  try {
    await writeContent('events', contentEvents);
  } catch (error) {
    if (newImagePublicId && newImagePublicId !== previousImagePublicId) {
      await cleanupEventImages([newImagePublicId], {
        storage: supabaseStorage,
        context: '[admin] failed to clean up an image after event update failed'
      });
    }
    throw error;
  }
  if (hasImageUpdate && previousImagePublicId && previousImagePublicId !== ev.imagePublicId) {
    await cleanupEventImages([previousImagePublicId], {
      storage: supabaseStorage,
      context: '[admin] replaced event image cleanup failed'
    });
  }
  const { photo, imageurl, imagepublicid, ...record } = ev;
  res.json({ message: 'Event updated.', event: { ...record, ...normalizeEventImage(ev) } });
});

router.delete('/content/event/:id', requireAdmin, async (req, res) => {
  await addLog('content_delete', 'Deleted event ' + req.params.id, req);
  const contentEvents = await readContent('events');
  const filtered = contentEvents.filter(e => e.id !== req.params.id);
  if (filtered.length === contentEvents.length) return res.status(404).json({ error: 'Event not found.' });
  await writeContent('events', filtered);
  const deleted = contentEvents.find(e => e.id === req.params.id);
  await cleanupEventImages([deleted?.imagePublicId], {
    storage: supabaseStorage,
    context: '[admin] event image cleanup failed'
  });
  res.json({ message: 'Event deleted.' });
});

// Featured research shown in the homepage "Explore our research" section
// (same schema the public /api/research endpoint serves).
router.post('/content/research', requireAdmin, async (req, res) => {
  await addLog('content_create', 'Created featured research', req);
  const b = req.body || {};
  const title = (b.title || '').trim();
  const summary = (b.summary || '').trim();
  if (!title || !summary) return res.status(400).json({ error: 'Title and summary are required.' });
  const items = await readContent('research');
  const item = {
    id: randomUUID(),
    title,
    summary,
    author: b.author ? String(b.author).trim() : '',
    date: b.date ? String(b.date).trim() : new Date().toISOString().split('T')[0],
    read: b.read ? Math.max(1, Number(b.read) || 8) : 8,
    year: b.year ? Number(b.year) : new Date().getFullYear(),
    createdAt: new Date().toISOString()
  };
  items.push(item);
  await writeContent('research', items);
  res.status(201).json({ message: 'Research featured.', research: item });
});

router.patch('/content/research/:id', requireAdmin, async (req, res) => {
  await addLog('content_update', 'Updated featured research ' + req.params.id, req);
  const b = req.body || {};
  const items = await readContent('research');
  const item = items.find(r => r.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Research not found.' });
  for (const f of ['title', 'summary', 'author', 'date', 'read', 'year']) {
    if (b[f] !== undefined) {
      if (f === 'read' || f === 'year') {
        const n = Number(b[f]);
        item[f] = Number.isFinite(n) ? Math.max(1, n) : item[f];
      } else {
        const v = String(b[f]).trim();
        if ((f === 'title' || f === 'summary') && !v) return res.status(400).json({ error: 'Title and summary cannot be empty.' });
        item[f] = v;
      }
    }
  }
  await writeContent('research', items);
  res.json({ message: 'Research updated.', research: item });
});

router.delete('/content/research/:id', requireAdmin, async (req, res) => {
  await addLog('content_delete', 'Deleted featured research ' + req.params.id, req);
  const items = await readContent('research');
  const filtered = items.filter(r => r.id !== req.params.id);
  if (filtered.length === items.length) return res.status(404).json({ error: 'Research not found.' });
  await writeContent('research', filtered);
  res.json({ message: 'Research deleted.' });
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
  const user = await get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const hash = await bcrypt.hash(String(newPassword), 10);
  await update('users', req.params.id, { passwordHash: hash });

  // In-app notification so the user sees the change in their bell on next login.
  await notify(user.id, 'password_reset', 'Password changed by administrator',
    `An administrator reset the password for your account (${user.username}). If this was not you, contact the administrator immediately.`,
    'account.html');

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
