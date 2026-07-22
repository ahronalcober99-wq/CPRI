import pool from '../../db.js';

// JSON columns that need parsing on read
const JSON_COLS = new Set([
  'researches','files','additionalDocs','versions','comments','statusHistory',
  'proofDocuments','certificate','compliance','gallery','impactDocuments',
  'supportingDocuments','completedResearches','publishedWorks','presentedPapers',
  'awards','innovationProjects','data','profile'
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

export async function all(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows.map(parseRow);
}

export async function get(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return parseRow(rows[0] || null);
}

export async function run(sql, params = []) {
  const [result] = await pool.query(sql, params);
  return result;
}

export async function insert(table, obj) {
  const cols = Object.keys(obj);
  const vals = Object.values(obj);
  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  const [result] = await pool.query(sql, vals);
  return result.insertId;
}

export async function update(table, id, obj) {
  const cols = Object.keys(obj);
  const sql = `UPDATE ${table} SET ${cols.map(c => `${c} = ?`).join(',')} WHERE id = ?`;
  const vals = [...Object.values(obj), id];
  await pool.query(sql, vals);
}

export async function remove(table, id) {
  await pool.query(`DELETE FROM ${table} WHERE id = ?`, [id]);
}