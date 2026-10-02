import { Router } from 'express';
import { requireAdmin } from './auth.js';
import { all, get, run } from './server/db/queries.js';

const router = Router();

router.get('/research-output-per-department', requireAdmin, async (req, res) => {
  const repo = await all("SELECT COALESCE(department, 'Unknown') AS dept FROM repository");
  const deptMap = {};
  repo.forEach(r => { deptMap[r.dept] = (deptMap[r.dept] || 0) + 1; });
  res.json({ report: Object.entries(deptMap).map(([department, count]) => ({ department, count })) });
});

router.get('/research-output-per-year', requireAdmin, async (req, res) => {
  const repo = await all("SELECT COALESCE(yearCompleted, 'Unknown') AS year FROM repository");
  const pubs = await all("SELECT LEFT(COALESCE(publicationDate, ''), 4) AS year FROM publications");
  const yearMap = {};
  repo.forEach(r => { yearMap[r.year] = (yearMap[r.year] || 0) + 1; });
  pubs.forEach(p => { const yr = p.year || 'Unknown'; yearMap[yr] = (yearMap[yr] || 0) + 1; });
  res.json({ report: Object.entries(yearMap).map(([year, count]) => ({ year, count })) });
});

router.get('/publications-per-year', requireAdmin, async (req, res) => {
  const pubs = await all("SELECT LEFT(COALESCE(publicationDate, ''), 4) AS year FROM publications");
  const yearMap = {};
  pubs.forEach(p => { const yr = p.year || 'Unknown'; yearMap[yr] = (yearMap[yr] || 0) + 1; });
  res.json({ report: Object.entries(yearMap).map(([year, count]) => ({ year, count })) });
});

router.get('/submissions-by-status', requireAdmin, async (req, res) => {
  const subs = await all("SELECT COALESCE(status, 'Unknown') AS status FROM submissions");
  const statusMap = {};
  subs.forEach(s => { statusMap[s.status] = (statusMap[s.status] || 0) + 1; });
  res.json({ report: Object.entries(statusMap).map(([status, count]) => ({ status, count })) });
});

router.get('/ethics-by-status', requireAdmin, async (req, res) => {
  const ethics = await all("SELECT COALESCE(status, 'Unknown') AS status FROM ethics");
  const statusMap = {};
  ethics.forEach(e => { statusMap[e.status] = (statusMap[e.status] || 0) + 1; });
  res.json({ report: Object.entries(statusMap).map(([status, count]) => ({ status, count })) });
});

router.get('/faculty-productivity', requireAdmin, async (req, res) => {
  const researchers = await all("SELECT fullName, department, completedResearches, publishedWorks, presentedPapers, innovationProjects, citations FROM researchers WHERE type = 'faculty'");
  const report = researchers.map(r => ({
    name: r.fullName,
    department: r.department,
    completedResearches: (r.completedResearches || []).length,
    publications: (r.publishedWorks || []).length,
    presentations: (r.presentedPapers || []).length,
    innovationProjects: (r.innovationProjects || []).length,
    citations: r.citations || 0
  }));
  res.json({ report });
});

router.get('/student-output', requireAdmin, async (req, res) => {
  const researchers = await all("SELECT fullName, program, researchTitle, adviser, yearCompleted, researchOutputStatus FROM researchers WHERE type = 'student'");
  const report = researchers.map(r => ({
    name: r.fullName,
    program: r.program,
    researchTitle: r.researchTitle || '',
    adviser: r.adviser || '',
    yearCompleted: r.yearCompleted || '',
    status: r.researchOutputStatus || ''
  }));
  res.json({ report });
});

router.get('/innovation-extension-report', requireAdmin, async (req, res) => {
  const records = await all('SELECT title, projectType, proponents, department, beneficiaries, communityPartner, implementationDate FROM innovation_extension');
  const report = records.map(r => ({
    title: r.title,
    projectType: r.projectType,
    proponents: r.proponents,
    department: r.department,
    beneficiaries: r.beneficiaries || 0,
    communityPartner: r.communityPartner || '',
    implementationDate: r.implementationDate || ''
  }));
  res.json({ report });
});

router.get('/events-participation-report', requireAdmin, async (req, res) => {
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
});

router.get('/publications-monitoring', requireAdmin, async (req, res) => {
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
});

router.get('/repository-inventory', requireAdmin, async (req, res) => {
  const repo = await all('SELECT title, authors, department, category, yearCompleted, status, accessLevel, fileAvailable FROM repository');
  const report = repo.map(r => ({
    title: r.title,
    authors: r.authors,
    department: r.department,
    category: r.category,
    yearCompleted: r.yearCompleted,
    status: r.status,
    accessLevel: r.accessLevel,
    fileAvailable: r.fileAvailable
  }));
  res.json({ report });
});

router.get('/export/:reportType', requireAdmin, async (req, res) => {
  const format = (req.query.format || 'csv').toString().toLowerCase();
  const reportType = req.params.reportType;
  let reportData = null;
  let filename = '';

  const reportEndpoints = {
    'research-output-per-department': '/api/reports/research-output-per-department',
    'research-output-per-year': '/api/reports/research-output-per-year',
    'publications-per-year': '/api/reports/publications-per-year',
    'submissions-by-status': '/api/reports/submissions-by-status',
    'ethics-by-status': '/api/reports/ethics-by-status',
    'faculty-productivity': '/api/reports/faculty-productivity',
    'student-output': '/api/reports/student-output',
    'innovation-extension-report': '/api/reports/innovation-extension-report',
    'events-participation-report': '/api/reports/events-participation-report',
    'publications-monitoring': '/api/reports/publications-monitoring',
    'repository-inventory': '/api/reports/repository-inventory'
  };

  const endpoint = reportEndpoints[reportType];
  if (!endpoint) return res.status(404).json({ error: 'Report type not found.' });

  try {
    const { protocol, host } = req;
    const response = await fetch(`${protocol}://${host}${endpoint}`, { headers: { 'Accept': 'application/json' } });
    if (!response.ok) return res.status(500).json({ error: 'Failed to fetch report data.' });
    const data = await response.json();
    reportData = data.report;
    filename = reportType.replace(/-/g, '_');
  } catch (err) {
    return res.status(500).json({ error: 'Failed to generate report.' });
  }

  if (!reportData || !reportData.length) return res.status(404).json({ error: 'No data available for this report.' });

  if (format === 'csv') {
    const headers = Object.keys(reportData[0]);
    const csvRows = [headers.join(',')];
    reportData.forEach(row => {
      const values = headers.map(h => {
        const val = row[h] !== undefined && row[h] !== null ? String(row[h]) : '';
        return val.includes(',') || val.includes('"') || val.includes('\n') ? '"' + val.replace(/"/g, '""') + '"' : val;
      });
      csvRows.push(values.join(','));
    });
    const csv = csvRows.join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}.csv`);
    res.send(csv);
  } else if (format === 'excel') {
    const headers = Object.keys(reportData[0]);
    let table = `<table border="1"><thead><tr style="background-color:#0b2545;color:#ffffff;">`;
    headers.forEach(h => { table += `<th style="padding:8px;">${h}</th>`; });
    table += `</tr></thead><tbody>`;
    reportData.forEach(row => {
      table += `<tr>`;
      headers.forEach(h => { table += `<td style="padding:6px;">${row[h] !== undefined ? row[h] : ''}</td>`; });
      table += `</tr>`;
    });
    table += `</tbody></table>`;
    const excelDoc = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"/><style>td,th{font-family:Arial;font-size:12px;}</style></head><body><h2>CPRI Report: ${filename.replace(/-/g, ' ').toUpperCase()}</h2>${table}</body></html>`;
    res.setHeader('Content-Type', 'application/vnd.ms-excel;charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}.xls`);
    res.send(excelDoc);
  } else if (format === 'pdf') {
    const headers = Object.keys(reportData[0]);
    let table = `<table border="1" cellpadding="6" cellspacing="0" style="width:100%;border-collapse:collapse;margin-top:16px;"><thead><tr style="background-color:#0b2545;color:#ffffff;">`;
    headers.forEach(h => { table += `<th style="text-align:left;padding:8px;">${h}</th>`; });
    table += `</tr></thead><tbody>`;
    reportData.forEach(row => {
      table += `<tr>`;
      headers.forEach(h => { table += `<td style="padding:6px;">${row[h] !== undefined ? row[h] : ''}</td>`; });
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
    res.send(fullHtml);
  } else {
    res.status(400).json({ error: 'Unsupported format. Use csv, excel, or pdf.' });
  }
});

export { router as reportsRouter };

