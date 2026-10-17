// ============================================================
//  CPRI — Administrative reports (module A–H reporting layer)
//
//  Every report is defined once, as a builder in REPORT_BUILDERS, and used by
//  two routes:
//
//    GET /api/reports/<type>                    the JSON the admin page renders
//    GET /api/reports/export/<type>?format=…     CSV / Excel / PDF of the same rows
//
//  The export route used to re-fetch its own JSON endpoint over HTTP. That
//  request carried no session cookie, so requireAdmin answered 403 and every
//  single export failed with "Failed to generate report." Calling the builder
//  directly fixes all of them and removes a pointless round trip.
//
//  The exporters derive their columns from the keys of the returned rows, so a
//  field added to a builder automatically appears in CSV, Excel and PDF.
// ============================================================
import { Router } from 'express';
import { requireAdmin } from './auth.js';
import { all } from './server/db/queries.js';
import { listAllSubmissions } from './lib/submission-index.js';
import { FACULTY_ROLES } from './lib/research-config.js';

// Submissions from BOTH forms — the classic `submissions` table and the
// Research Submission module — once each, drafts excluded. Every report that
// is about submissions reads this, so work sent through either form counts.
const submissionsForReports = () => listAllSubmissions({ all });

const APPROVED = new Set(['approved', 'published']);

// Published publications per submitter id, for the productivity figures.
async function publicationCountBySubmitter() {
  const pubs = await all("SELECT submitterId FROM publications WHERE status = 'published'");
  const counts = new Map();
  for (const p of pubs) {
    if (p.submitterId) counts.set(p.submitterId, (counts.get(p.submitterId) || 0) + 1);
  }
  return counts;
}

const router = Router();

const REPORT_BUILDERS = {
  // ---- Research output ----
  'research-output-per-department': async () => {
    const repo = await all("SELECT COALESCE(department, 'Unknown') AS dept FROM repository");
    const deptMap = {};
    repo.forEach(r => { deptMap[r.dept] = (deptMap[r.dept] || 0) + 1; });
    return Object.entries(deptMap).map(([department, count]) => ({ department, count }));
  },

  'research-output-per-year': async () => {
    const repo = await all("SELECT COALESCE(yearCompleted, 'Unknown') AS year FROM repository");
    const pubs = await all("SELECT LEFT(COALESCE(publicationDate, ''), 4) AS year FROM publications");
    const yearMap = {};
    repo.forEach(r => { yearMap[r.year] = (yearMap[r.year] || 0) + 1; });
    pubs.forEach(p => { const yr = p.year || 'Unknown'; yearMap[yr] = (yearMap[yr] || 0) + 1; });
    return Object.entries(yearMap).map(([year, count]) => ({ year, count }));
  },

  'publications-per-year': async () => {
    const pubs = await all("SELECT LEFT(COALESCE(publicationDate, ''), 4) AS year FROM publications");
    const yearMap = {};
    pubs.forEach(p => { const yr = p.year || 'Unknown'; yearMap[yr] = (yearMap[yr] || 0) + 1; });
    return Object.entries(yearMap).map(([year, count]) => ({ year, count }));
  },

  // ---- Workflow ----
  'submissions-by-status': async () => {
    const subs = await submissionsForReports();
    const statusMap = {};
    subs.forEach(s => { const key = s.status || 'Unknown'; statusMap[key] = (statusMap[key] || 0) + 1; });
    return Object.entries(statusMap).map(([status, count]) => ({ status, count }));
  },

  // Every submission, one row each, from both forms: the list behind the
  // status counts above.
  'research-submissions': async () => {
    const subs = await submissionsForReports();
    return subs.map(s => ({
      title: s.title,
      authors: s.authors,
      submittedBy: s.studentName,
      program: s.program,
      researchCategory: s.category || '',
      researchType: s.research_type || '',
      form: s.source === 'module' ? 'Research Submission' : 'Classic form',
      stage: s.source === 'module' ? s.stage : '',
      schoolYear: s.school_year || '',
      status: s.statusLabel || s.status,
      submitted: s.created_at ? new Date(s.created_at).toISOString().slice(0, 10) : '',
      inRepository: s.inRepository ? 'Yes' : 'No'
    }));
  },

  'ethics-by-status': async () => {
    const ethics = await all("SELECT COALESCE(status, 'Unknown') AS status FROM ethics");
    const statusMap = {};
    ethics.forEach(e => { statusMap[e.status] = (statusMap[e.status] || 0) + 1; });
    return Object.entries(statusMap).map(([status, count]) => ({ status, count }));
  },

  // ---- People ----
  // One row per faculty / non-teaching researcher who has submitted work
  // (either form), then any hand-entered faculty profiles from the legacy
  // `researchers` directory. Presentations, innovation projects and citations
  // are only recorded in that directory, so they are blank for the rest.
  'faculty-productivity': async () => {
    const [subs, pubCounts, directory] = await Promise.all([
      submissionsForReports(),
      publicationCountBySubmitter(),
      all("SELECT fullName, department, completedResearches, publishedWorks, presentedPapers, innovationProjects, citations FROM researchers WHERE type = 'faculty'").catch(() => [])
    ]);
    const byPerson = new Map();
    for (const s of subs) {
      if (!FACULTY_ROLES.has(s.ownerRole)) continue;
      const key = s.studentId || s.studentName;
      if (!byPerson.has(key)) {
        byPerson.set(key, {
          name: s.studentName,
          department: s.program,
          role: s.ownerRole === 'non_teaching_researcher' ? 'Non-Teaching' : 'Faculty',
          submittedResearches: 0,
          completedResearches: 0,
          inRepository: 0,
          publications: pubCounts.get(s.studentId) || 0,
          presentations: '',
          innovationProjects: '',
          citations: '',
          source: 'Submissions'
        });
      }
      const row = byPerson.get(key);
      row.submittedResearches += 1;
      if (APPROVED.has(s.status)) row.completedResearches += 1;
      if (s.inRepository) row.inRepository += 1;
    }
    const fromDirectory = directory.map(r => ({
      name: r.fullName,
      department: r.department,
      role: 'Faculty',
      submittedResearches: '',
      completedResearches: (r.completedResearches || []).length,
      inRepository: '',
      publications: (r.publishedWorks || []).length,
      presentations: (r.presentedPapers || []).length,
      innovationProjects: (r.innovationProjects || []).length,
      citations: r.citations || 0,
      source: 'Researcher directory'
    }));
    return [...byPerson.values()].concat(fromDirectory);
  },

  // One row per student research output (either form), then any hand-entered
  // student profiles from the legacy `researchers` directory.
  'student-output': async () => {
    const [subs, directory] = await Promise.all([
      submissionsForReports(),
      all("SELECT fullName, program, researchTitle, adviser, yearCompleted, researchOutputStatus FROM researchers WHERE type = 'student'").catch(() => [])
    ]);
    const fromSubmissions = subs
      .filter(s => s.ownerRole === 'student_researcher')
      .map(s => ({
        name: s.studentName,
        program: s.program,
        researchTitle: s.title,
        adviser: s.adviser || '',
        stage: s.source === 'module' ? s.stage : '',
        schoolYear: s.school_year || '',
        status: s.statusLabel || s.status,
        inRepository: s.inRepository ? 'Yes' : 'No',
        source: 'Submissions'
      }));
    const fromDirectory = directory.map(r => ({
      name: r.fullName,
      program: r.program,
      researchTitle: r.researchTitle || '',
      adviser: r.adviser || '',
      stage: '',
      schoolYear: r.yearCompleted || '',
      status: r.researchOutputStatus || '',
      inRepository: '',
      source: 'Researcher directory'
    }));
    return fromSubmissions.concat(fromDirectory);
  },

  // ---- Projects and events ----
  'innovation-extension-report': async () => {
    const records = await all('SELECT title, projectType, proponents, department, beneficiaries, communityPartner, implementationDate FROM innovation_extension');
    return records.map(r => ({
      title: r.title,
      projectType: r.projectType,
      proponents: r.proponents,
      department: r.department,
      beneficiaries: r.beneficiaries || 0,
      communityPartner: r.communityPartner || '',
      implementationDate: r.implementationDate || ''
    }));
  },

  'events-participation-report': async () => {
    const events = await all('SELECT * FROM events_module');
    const regs = await all('SELECT * FROM event_registrations');
    return events.map(e => ({
      title: e.title,
      dateTime: e.dateTime,
      venue: e.venue,
      totalRegistrants: regs.filter(r => r.eventId === e.id).length,
      presenters: regs.filter(r => r.eventId === e.id && r.participantType === 'presenter').length,
      attendees: regs.filter(r => r.eventId === e.id && r.participantType === 'attendee').length
    }));
  },

  // ---- Report 9 — Publication Monitoring ----
  // The full bibliographic record: journal/conference name, volume, issue,
  // pages, ISSN/ISBN, the indexing databases, the indexing status, the impact
  // factor and the DOI.
  'publications-monitoring': async () => {
    const pubs = await all(
      'SELECT title, authors, journalOrConference, pubType, status, publicationDate, '
      + 'volume, issue, pages, issn, isbn, indexing, indexingStatus, impactFactor, doi, '
      + 'department, schoolYear FROM publications'
    );
    return pubs.map(p => ({
      title: p.title,
      authors: p.authors,
      journalOrConference: p.journalOrConference,
      pubType: p.pubType,
      status: p.status,
      publicationDate: p.publicationDate,
      volume: p.volume || '',
      issue: p.issue || '',
      pages: p.pages || '',
      issn: p.issn || '',
      isbn: p.isbn || '',
      indexing: p.indexing || '',
      indexingStatus: p.indexingStatus || '',
      impactFactor: p.impactFactor || '',
      doi: p.doi || '',
      department: p.department || '',
      schoolYear: p.schoolYear || ''
    }));
  },

  // ---- Report 10 — Repository inventory ----
  'repository-inventory': async () => {
    const repo = await all('SELECT * FROM repository');
    return repo.map(r => ({
      title: r.title,
      authors: r.authors,
      adviser: r.adviser || '',
      facilitator: r.facilitator || '',
      department: r.department,
      category: r.category,
      researchCategory: r.researchCategory || '',
      yearCompleted: r.yearCompleted,
      status: r.status,
      accessLevel: r.accessLevel,
      fileAvailable: r.fileAvailable
    }));
  }
};

// Every GET /:type route below is the same three lines: look the builder up,
// run it, answer with { report }.
for (const [type, build] of Object.entries(REPORT_BUILDERS)) {
  router.get(`/${type}`, requireAdmin, async (req, res) => {
    const report = await build();
    res.json({ report });
  });
}

const REPORT_TYPES = Object.keys(REPORT_BUILDERS);

router.get('/export/:reportType', requireAdmin, async (req, res) => {
  const format = (req.query.format || 'csv').toString().toLowerCase();
  const reportType = req.params.reportType;

  const build = REPORT_BUILDERS[reportType];
  if (!build) return res.status(404).json({ error: 'Report type not found.' });

  let reportData;
  try {
    reportData = await build();
  } catch (err) {
    console.error(`[reports] building "${reportType}" failed:`, err.message);
    return res.status(500).json({ error: 'Failed to generate report.' });
  }

  const filename = reportType.replace(/-/g, '_');
  if (!reportData || !reportData.length) {
    return res.status(404).json({ error: 'No data available for this report.' });
  }

  const headers = Object.keys(reportData[0]);
  const escapeHtmlCell = (value) => String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  if (format === 'csv') {
    const csvRows = [headers.join(',')];
    reportData.forEach(row => {
      const values = headers.map(h => {
        const val = row[h] !== undefined && row[h] !== null ? String(row[h]) : '';
        return val.includes(',') || val.includes('"') || val.includes('\n')
          ? '"' + val.replace(/"/g, '""') + '"'
          : val;
      });
      csvRows.push(values.join(','));
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}.csv`);
    return res.send(csvRows.join('\n'));
  }

  if (format === 'excel') {
    let table = `<table border="1"><thead><tr style="background-color:#0b2545;color:#ffffff;">`;
    headers.forEach(h => { table += `<th style="padding:8px;">${escapeHtmlCell(h)}</th>`; });
    table += `</tr></thead><tbody>`;
    reportData.forEach(row => {
      table += `<tr>`;
      headers.forEach(h => { table += `<td style="padding:6px;">${escapeHtmlCell(row[h])}</td>`; });
      table += `</tr>`;
    });
    table += `</tbody></table>`;
    const excelDoc = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"/><style>td,th{font-family:Arial;font-size:12px;}</style></head><body><h2>CPRI Report: ${filename.replace(/-/g, ' ').toUpperCase()}</h2>${table}</body></html>`;
    res.setHeader('Content-Type', 'application/vnd.ms-excel;charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}.xls`);
    return res.send(excelDoc);
  }

  if (format === 'pdf') {
    let table = `<table border="1" cellpadding="6" cellspacing="0" style="width:100%;border-collapse:collapse;margin-top:16px;"><thead><tr style="background-color:#0b2545;color:#ffffff;">`;
    headers.forEach(h => { table += `<th style="text-align:left;padding:8px;">${escapeHtmlCell(h)}</th>`; });
    table += `</tr></thead><tbody>`;
    reportData.forEach(row => {
      table += `<tr>`;
      headers.forEach(h => { table += `<td style="padding:6px;">${escapeHtmlCell(row[h])}</td>`; });
      table += `</tr>`;
    });
    table += `</tbody></table>`;
    const fullHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${filename}</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 30px; color: #1e293b; }
        h1 { color: #0b2545; margin-bottom: 4px; }
        .meta { color: #64748b; font-size: 13px; margin-bottom: 20px; }
        table { font-size: 12px; border-color: #cbd5e1; }
        th { font-size: 13px; }
        @media print { .no-print { display: none; } }
      </style>
      </head><body onload="window.print()">
      <div class="no-print" style="margin-bottom:20px;">
        <button onclick="window.print()" style="padding:8px 16px;background:#0b2545;color:#fff;border:none;border-radius:4px;cursor:pointer;">Print / Save as PDF</button>
      </div>
      <h1>CPRI Administrative Report</h1>
      <div class="meta"><b>Report:</b> ${filename.replace(/-/g, ' ').toUpperCase()} | <b>Generated:</b> ${new Date().toLocaleString()}</div>
      ${table}
      </body></html>`;
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `inline; filename=${filename}.html`);
    return res.send(fullHtml);
  }

  return res.status(400).json({ error: 'Unsupported format. Use csv, excel, or pdf.' });
});

export { router as reportsRouter, REPORT_BUILDERS, REPORT_TYPES };
