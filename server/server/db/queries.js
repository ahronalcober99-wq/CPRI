import pool from '../../db.js';

// JSON columns that need parsing on read
const JSON_COLS = new Set([
  'researches','files','additionalDocs','versions','comments','statusHistory',
  'proofDocuments','certificate','compliance','gallery','impactDocuments',
  'supportingDocuments','revisedDocuments','completedResearches','publishedWorks',
  'presentedPapers','awards','innovationProjects','data','profile','user_prefs'
]);

function parseRow(row) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (JSON_COLS.has(k) && typeof v === 'string') {
      try { out[k] = v ? JSON.parse(v) : null; }
      catch { out[k] = v; }
    } else {
      out[k] = v;
    }
  }
  return out;
}

// MariaDB (STRICT_TRANS_TABLES) rejects ISO-8601 timestamps that carry
// fractional seconds (e.g. '2026-08-04T00:39:05.438Z' from Date#toISOString())
// when written to DATETIME columns. Normalize ISO strings to MySQL's
// 'YYYY-MM-DD HH:MM:SS' before they reach the driver so every insert/update
// (submissions, repository, audit logs, …) survives regardless of sql_mode.
function toDbValue(v) {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) {
    return v.slice(0, 10) + ' ' + v.slice(11, 19);
  }
  return v;
}

function toDbParams(params) {
  return Array.isArray(params) ? params.map(toDbValue) : params;
}

function escapeId(identifier) {
  return '`' + String(identifier).replace(/`/g, '``') + '`';
}

export async function all(sql, params = []) {
  const [rows] = await pool.query(sql, toDbParams(params));
  return rows.map(parseRow);
}

export async function get(sql, params = []) {
  const [rows] = await pool.query(sql, toDbParams(params));
  return parseRow(rows[0] || null);
}

export async function run(sql, params = []) {
  const [result] = await pool.query(sql, toDbParams(params));
  return result;
}

export async function insert(table, obj) {
  const cols = Object.keys(obj);
  const vals = Object.values(obj).map(toDbValue);
  const safeTable = escapeId(table);
  const safeCols = cols.map(escapeId).join(', ');
  const sql = `INSERT INTO ${safeTable} (${safeCols}) VALUES (${cols.map(() => '?').join(', ')})`;
  const [result] = await pool.query(sql, vals);
  return result.insertId;
}

export async function update(table, id, obj) {
  const cols = Object.keys(obj);
  const safeTable = escapeId(table);
  const safeAssignments = cols.map(c => `${escapeId(c)} = ?`).join(', ');
  const sql = `UPDATE ${safeTable} SET ${safeAssignments} WHERE id = ?`;
  const vals = [...Object.values(obj).map(toDbValue), id];
  await pool.query(sql, vals);
}

export async function remove(table, id) {
  const safeTable = escapeId(table);
  await pool.query(`DELETE FROM ${safeTable} WHERE id = ?`, [id]);
}