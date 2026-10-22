// ---------------------------------------------------------------------------
//  School years — the ONE list behind the School Year dropdown, plus the
//  server-side validation of the two listed Research Submission fields
//  (Program or Department, School Year).
//
//  The offered list is:
//    * generated: the current school year and the 4 before it. A school year
//      starts in SCHOOL_YEAR_START_MONTH (default June; an admin can change it
//      under Content > School Years);
//    * plus the school years an admin added (table `school_years`);
//    * minus the ones an admin hid. Hiding a generated year stores a row with
//      is_active = 0, so the choice survives the window moving on.
//
//  Values are stored in research_submissions.school_year exactly as before
//  (VARCHAR), in the format "2026–2027" (en dash). Older free-text rows are
//  never rewritten.
// ---------------------------------------------------------------------------
import { all as defaultAll, run as defaultRun } from '../server/db/queries.js';

export const DEFAULT_START_MONTH = 6; // June
export const WINDOW_SIZE = 5;         // current + previous 4
export const START_MONTH_KEY = 'school_year_start_month';
export const PROGRAM_MAX = 180;       // research_submissions.program is VARCHAR(180)

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
export const monthName = (m) => MONTHS[m - 1] || '';

const isOn = (v) => v === 1 || v === '1' || v === true;

// "2026-2027", "2026 – 2027", "2026—2027" -> "2026–2027". Only consecutive
// years are a school year. Anything else -> null.
export function normalizeSchoolYear(text) {
  const m = String(text ?? '').trim().match(/^(\d{4})\s*[-‐-―]\s*(\d{4})$/);
  if (!m) return null;
  const start = Number(m[1]);
  if (Number(m[2]) !== start + 1) return null;
  return `${start}–${start + 1}`;
}

export function startYearOf(label) {
  const m = String(label || '').match(/^(\d{4})/);
  return m ? Number(m[1]) : 0;
}

export function formatSchoolYear(startYear) {
  return `${startYear}–${startYear + 1}`;
}

// The year a school year that contains `date` started in.
export function currentStartYear(date = new Date(), startMonth = DEFAULT_START_MONTH) {
  return date.getMonth() + 1 >= startMonth ? date.getFullYear() : date.getFullYear() - 1;
}

export function sanitizeStartMonth(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null;
}

// ---------- Schema (additive, safe on every boot) ----------
// Mirrored by hand in db/migrations/007_school_years.sql.
export async function ensureSchoolYearsSchema(dependencies = {}) {
  const run = dependencies.run || defaultRun;
  await run(`
    CREATE TABLE IF NOT EXISTS school_years (
      id          INT NOT NULL AUTO_INCREMENT,
      label       VARCHAR(20) NOT NULL,
      is_active   TINYINT(1) NOT NULL DEFAULT 1,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_school_years_label (label)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key    VARCHAR(60) NOT NULL,
      setting_value  VARCHAR(255) NOT NULL DEFAULT '',
      updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (setting_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

// ---------- The merged list ----------
// Returns { startMonth, current, years } where years is every known school year
// (newest first): { label, startYear, source: 'auto'|'added', isActive, isCurrent }.
// "Offered" = isActive. A missing table reads as "no admin changes yet".
export async function loadSchoolYears({ all = defaultAll, now = new Date() } = {}) {
  const rows = await all('SELECT label, is_active FROM school_years').catch(() => []);
  const settings = await all('SELECT setting_key, setting_value FROM app_settings').catch(() => []);

  const stored = settings.find(r => r.setting_key === START_MONTH_KEY);
  const startMonth = sanitizeStartMonth(stored && stored.setting_value) || DEFAULT_START_MONTH;

  const currentStart = currentStartYear(now, startMonth);
  const current = formatSchoolYear(currentStart);
  const years = new Map();
  for (let i = 0; i < WINDOW_SIZE; i++) {
    const label = formatSchoolYear(currentStart - i);
    years.set(label, { label, startYear: currentStart - i, source: 'auto', isActive: true });
  }
  for (const row of rows) {
    const label = normalizeSchoolYear(row.label);
    if (!label) continue;
    const active = isOn(row.is_active);
    const known = years.get(label);
    if (known) known.isActive = active;
    else years.set(label, { label, startYear: startYearOf(label), source: 'added', isActive: active });
  }
  const list = [...years.values()]
    .sort((a, b) => b.startYear - a.startYear)
    .map(y => ({ ...y, isCurrent: y.label === current }));
  return { startMonth, current, years: list };
}

export function offeredSchoolYears(config) {
  return config.years.filter(y => y.isActive);
}

// ---------- Validation of the two listed fields ----------
const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// body:     the request ({ program, program_mode, school_year })
// existing: the stored row when editing — a value that is already on the
//           record (an old free-text one) may stay as it is.
// keys:     which fields this request is changing (all by default)
//
// Returns { values } (the exact strings to store) or { error, field }.
// An empty value is passed through as '' — "required" is the completeness
// check's job, so a draft can still be saved half-filled.
export async function resolveListedFields({ body = {}, existing = null, keys = ['program', 'school_year'], all = defaultAll, now = new Date() } = {}) {
  const values = {};

  if (keys.includes('program')) {
    const raw = String(body.program ?? '').replace(/\s+/g, ' ').trim();
    if (!raw) {
      values.program = '';
    } else if (existing && raw === String(existing.program || '').trim()) {
      values.program = raw;
    } else {
      const rows = await all('SELECT name, is_active FROM courses').catch(() => []);
      const listed = rows.find(r => isOn(r.is_active) && same(r.name, raw));
      const other = String(body.program_mode || '').toLowerCase() === 'other';
      if (listed) {
        values.program = String(listed.name);
      } else if (!other) {
        return { field: 'program', error: 'Choose a program or department from the list, or pick "Other (please specify)".' };
      } else if (raw.length < 2) {
        return { field: 'program', error: 'Please type the full name of your program or department.' };
      } else if (raw.length > PROGRAM_MAX) {
        return { field: 'program', error: `Program or Department must be ${PROGRAM_MAX} characters or fewer.` };
      } else {
        values.program = raw;
      }
    }
  }

  if (keys.includes('school_year')) {
    const raw = String(body.school_year ?? '').trim();
    if (!raw) {
      values.school_year = '';
    } else if (existing && raw === String(existing.school_year || '').trim()) {
      values.school_year = raw;
    } else {
      const label = normalizeSchoolYear(raw);
      const config = await loadSchoolYears({ all, now });
      const offered = label && offeredSchoolYears(config).find(y => y.label === label);
      if (!offered) {
        return { field: 'school_year', error: 'Choose a school year from the list.' };
      }
      values.school_year = offered.label;
    }
  }

  return { values };
}
