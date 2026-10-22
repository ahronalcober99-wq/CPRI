// ---------------------------------------------------------------------------
//  /api/school-years — the School Year list behind the Submit Research form
//  and its admin settings (Content > School Years).
//
//    GET   /api/school-years             the years offered now + which is current (public)
//    GET   /api/school-years?all=1       every year incl. hidden ones + settings (admin)
//    POST  /api/school-years             add a school year { label } (admin)
//    PATCH /api/school-years             { label, isActive?, newLabel? } edit / hide / show (admin)
//    PUT   /api/school-years/settings    { startMonth } month a school year begins (admin)
//
//  Years are keyed by label in the body, not the URL: the label holds an en dash.
//  The list rules (current + previous 4, plus admin additions) live in
//  lib/school-years.js, which the submission validator reads too.
// ---------------------------------------------------------------------------
import { Router } from 'express';
import { requireAdmin } from './auth.js';
import { all, get, run } from './server/db/queries.js';
import { addLog } from './audit.js';
import {
  DEFAULT_START_MONTH,
  START_MONTH_KEY,
  loadSchoolYears,
  monthName,
  normalizeSchoolYear,
  offeredSchoolYears,
  sanitizeStartMonth
} from './lib/school-years.js';

const router = Router();

async function actorName(req) {
  const me = await get('SELECT username, fullName FROM users WHERE id = ?', [req.session?.userId]).catch(() => null);
  return me ? (me.username || me.fullName) : 'an administrator';
}

async function isAdminSession(req) {
  if (!req.session?.userId) return false;
  const me = await get('SELECT role, status FROM users WHERE id = ?', [req.session.userId]).catch(() => null);
  return Boolean(me && me.role === 'admin' && me.status === 'active');
}

const publicYear = (y) => ({
  label: y.label,
  value: y.label,
  source: y.source,
  isActive: y.isActive,
  isCurrent: y.isCurrent
});

const BAD_LABEL = 'Use the format 2026–2027: two consecutive years.';

router.get('/', async (req, res) => {
  try {
    const config = await loadSchoolYears({ all });
    if (req.query.all === '1') {
      if (!(await isAdminSession(req))) return res.status(403).json({ error: 'Admin access required.' });
      return res.json({
        current: config.current,
        startMonth: config.startMonth,
        startMonthName: monthName(config.startMonth),
        defaultStartMonth: DEFAULT_START_MONTH,
        years: config.years.map(publicYear)
      });
    }
    res.json({
      current: config.current,
      schoolYears: offeredSchoolYears(config).map(publicYear)
    });
  } catch (err) {
    console.error('[school-years] list failed:', err.message);
    res.status(503).json({ error: 'The school year list could not be loaded. Please try again.' });
  }
});

router.post('/', requireAdmin, async (req, res) => {
  const label = normalizeSchoolYear(req.body?.label);
  if (!label) return res.status(400).json({ error: BAD_LABEL });

  const config = await loadSchoolYears({ all });
  const known = config.years.find(y => y.label === label);
  if (known && known.isActive) return res.status(409).json({ error: `${label} is already on the list.` });
  if (known) {
    // Hidden before: adding it again shows it.
    await run('UPDATE school_years SET is_active = 1, updated_at = ? WHERE label = ?', [new Date().toISOString(), label]);
  } else {
    await run('INSERT INTO school_years (label, is_active) VALUES (?, 1)', [label]);
  }
  await addLog('school_year_create', `School year ${label} added by ${await actorName(req)}.`, req);
  res.status(201).json({ message: `School year ${label} added.`, label });
});

router.patch('/', requireAdmin, async (req, res) => {
  const label = normalizeSchoolYear(req.body?.label);
  if (!label) return res.status(400).json({ error: BAD_LABEL });

  const config = await loadSchoolYears({ all });
  const year = config.years.find(y => y.label === label);
  if (!year) return res.status(404).json({ error: 'School year not found.' });

  const body = req.body || {};
  const now = new Date().toISOString();
  const notes = [];

  if (body.newLabel !== undefined) {
    const next = normalizeSchoolYear(body.newLabel);
    if (!next) return res.status(400).json({ error: BAD_LABEL });
    if (next !== label) {
      // A generated year is defined by the calendar; only an added year can be renamed.
      if (year.source === 'auto') {
        return res.status(400).json({ error: `${label} is generated automatically and cannot be renamed. Hide it instead, or add the year you need.` });
      }
      if (config.years.some(y => y.label === next)) {
        return res.status(409).json({ error: `${next} is already on the list.` });
      }
      await run('UPDATE school_years SET label = ?, updated_at = ? WHERE label = ?', [next, now, label]);
      notes.push(`renamed to ${next}`);
      year.label = next;
    }
  }

  if (body.isActive !== undefined) {
    const active = body.isActive === true || body.isActive === 1 || body.isActive === '1' || body.isActive === 'true';
    if (active !== year.isActive) {
      if (!active && year.isCurrent) {
        return res.status(400).json({ error: `${label} is the current school year and cannot be hidden.` });
      }
      const row = await get('SELECT id FROM school_years WHERE label = ?', [year.label]);
      if (row) await run('UPDATE school_years SET is_active = ?, updated_at = ? WHERE label = ?', [active ? 1 : 0, now, year.label]);
      else await run('INSERT INTO school_years (label, is_active) VALUES (?, ?)', [year.label, active ? 1 : 0]);
      notes.push(active ? 'shown' : 'hidden');
    }
  }

  if (!notes.length) return res.json({ message: 'Nothing to change.', label: year.label });
  await addLog('school_year_update', `School year ${label}: ${notes.join('; ')} by ${await actorName(req)}.`, req);
  res.json({ message: `School year ${year.label} saved.`, label: year.label });
});

router.put('/settings', requireAdmin, async (req, res) => {
  const month = sanitizeStartMonth(req.body?.startMonth);
  if (!month) return res.status(400).json({ error: 'Choose the month a school year starts (1–12).' });

  const value = String(month);
  const row = await get('SELECT setting_key FROM app_settings WHERE setting_key = ?', [START_MONTH_KEY]);
  if (row) await run('UPDATE app_settings SET setting_value = ?, updated_at = ? WHERE setting_key = ?', [value, new Date().toISOString(), START_MONTH_KEY]);
  else await run('INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)', [START_MONTH_KEY, value]);

  const config = await loadSchoolYears({ all });
  await addLog('school_year_settings', `School year start month set to ${monthName(month)} by ${await actorName(req)}. Current school year is now ${config.current}.`, req);
  res.json({ message: `A school year now starts in ${monthName(month)}. The current school year is ${config.current}.`, current: config.current, startMonth: month });
});

export { router as schoolYearsRouter };
