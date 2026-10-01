import mysql from 'mysql2/promise';

const databaseName = process.env.DB_NAME || 'cpri';

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: databaseName,
  ...(process.env.DB_SSL === 'true'
    ? { ssl: { rejectUnauthorized: true } }
    : {}),
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_LIMIT || 10),
  charset: 'utf8mb4',
  timezone: 'Z'
});

export async function testConnection() {
  let c;
  try {
    c = await pool.getConnection();
    await c.query('SELECT 1');
    console.log('[db] Connected to MySQL database "' + databaseName + '".');
    return true;
  } catch (err) {
    console.warn('[db] MySQL not available — running in file-only mode.', err.message);
    return false;
  } finally {
    if (c) c.release();
  }
}

export default pool;