import { getDatabase } from '@netlify/database';

// Netlify Database (managed Postgres). The connection string is provided by the
// platform (and by `netlify dev` locally), so there is nothing to configure.
let database;

export function getPool() {
  if (!database) database = getDatabase();
  return database.pool;
}

const pool = {
  query: (...args) => getPool().query(...args),
  connect: () => getPool().connect()
};

export default pool;

export async function testConnection() {
  try {
    await pool.query('SELECT 1');
    console.log('[db] Connected to Netlify Database.');
    return true;
  } catch (err) {
    console.warn('[db] Netlify Database not available:', err.message);
    return false;
  }
}
