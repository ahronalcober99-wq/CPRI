import pool from '../../db.js';

// JSON columns that need parsing on read
const JSON_COLS = new Set([
  'researches','files','additionalDocs','versions','comments','statusHistory',
  'proofDocuments','certificate','compliance','gallery','impactDocuments',
  'supportingDocuments','revisedDocuments','completedResearches','publishedWorks',
  'presentedPapers','awards','innovationProjects','data','profile','user_prefs'
]);

// Postgres folds unquoted identifiers to lower case, so a column written as
// `fullName` in SQL comes back as `fullname`. Map result keys back to the
// camelCase names the rest of the app (and the front end) expects.
const CAMEL_COLUMNS = [
  'abstractFile', 'accessLevel', 'actorName', 'actorUsername', 'additionalDocs',
  'attendanceStatus', 'authorType', 'certificateData', 'certificateIssued',
  'communityOutcome', 'communityPartner', 'completedResearches', 'contactNumber',
  'createdAt', 'dateTime', 'evaluationResult', 'eventId', 'fileAvailable', 'fullName',
  'googleScholar', 'impactDocuments', 'implementationDate', 'indexingStatus',
  'innovationProjects', 'interventionConducted', 'journalOrConference', 'needsAssessment',
  'outputProduct', 'participantName', 'participantType', 'passwordHash',
  'presentedPapers', 'profilePhoto', 'programFlow', 'projectType', 'proofDocuments',
  'pubType', 'publicationDate', 'publicationLink', 'publishedWorks', 'readAt',
  'receivedAt', 'recipientId', 'registrationLink', 'researchGate', 'researchInterests',
  'researchOutputStatus', 'researchTitle', 'researchType', 'resetToken',
  'resetTokenExpiry', 'revisedDocuments', 'riskLevel', 'schoolYear', 'senderId',
  'setupPending', 'sourceSubmissionId', 'statusHistory', 'submitterId', 'submitterName',
  'supportingDocuments', 'sustainabilityPlan', 'updatedAt', 'userAgent', 'userId',
  'yearCompleted'
];
const KEY_MAP = new Map(CAMEL_COLUMNS.map((c) => [c.toLowerCase(), c]));

// int8 (COUNT(*), bigserial ids) and numeric (SUM/AVG) arrive as strings from
// the Postgres driver; MySQL returned numbers, so convert them back.
const NUMERIC_TYPE_IDS = new Set([20, 1700]);

function parseRow(row, numericKeys) {
  if (!row) return row;
  const out = {};
  for (const [rawKey, v] of Object.entries(row)) {
    const k = KEY_MAP.get(rawKey) || rawKey;
    if (JSON_COLS.has(k) && typeof v === 'string') {
      try { out[k] = v ? JSON.parse(v) : null; }
      catch { out[k] = v; }
    } else if (numericKeys.has(rawKey) && typeof v === 'string') {
      out[k] = Number(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function numericKeysOf(result) {
  return new Set((result.fields || [])
    .filter((f) => NUMERIC_TYPE_IDS.has(f.dataTypeID))
    .map((f) => f.name));
}

// The SQL across the app was written for MySQL: `?` placeholders and a
// case-insensitive LIKE. Translate to Postgres (`$1`, `$2`, … and ILIKE),
// leaving anything inside single-quoted string literals untouched.
const sqlCache = new Map();
function toPgSql(sql) {
  let cached = sqlCache.get(sql);
  if (cached) return cached;
  let out = '';
  let n = 0;
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") inString = !inString;
    if (!inString && ch === '?') { out += '$' + (++n); continue; }
    out += ch;
  }
  cached = out
    .replace(/\bLOWER\((\$\d+)\)/gi, 'LOWER($1::text)')
    .replace(/(?<!I)\bLIKE\b/gi, 'ILIKE');
  sqlCache.set(sql, cached);
  return cached;
}

function toDbValue(v) {
  // MySQL accepted true/false for TINYINT(1) flags; the Postgres columns are
  // SMALLINT, so send 1/0.
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === undefined) return null;
  return v;
}

function toDbParams(params) {
  return Array.isArray(params) ? params.map(toDbValue) : [];
}

async function query(sql, params) {
  return pool.query(toPgSql(sql), toDbParams(params));
}

function mapRows(result) {
  const numericKeys = numericKeysOf(result);
  return (result.rows || []).map((r) => parseRow(r, numericKeys));
}

export async function all(sql, params = []) {
  return mapRows(await query(sql, params));
}

export async function get(sql, params = []) {
  return mapRows(await query(sql, params))[0] || null;
}

// Returns a MySQL-style result summary so existing callers that check
// `affectedRows` keep working.
export async function run(sql, params = []) {
  const result = await query(sql, params);
  return { affectedRows: result.rowCount ?? 0, rows: mapRows(result) };
}

export async function insert(table, obj) {
  const cols = Object.keys(obj);
  const vals = Object.values(obj).map(toDbValue);
  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`;
  const result = await pool.query(sql, vals);
  const id = result.rows[0] && result.rows[0].id;
  return typeof id === 'string' && /^\d+$/.test(id) && result.fields?.[0]?.dataTypeID === 20 ? Number(id) : id;
}

export async function update(table, id, obj) {
  const cols = Object.keys(obj);
  if (!cols.length) return;
  const sql = `UPDATE ${table} SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(',')} WHERE id = $${cols.length + 1}`;
  const vals = [...Object.values(obj).map(toDbValue), id];
  await pool.query(sql, vals);
}

export async function remove(table, id) {
  await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
}
