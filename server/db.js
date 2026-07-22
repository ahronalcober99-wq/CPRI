import mysql from 'mysql2/promise';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Optional dotenv loading
try {
  const { config } = await import('dotenv');
  config({ path: join(__dirname, '..', '.env') });
} catch { /* dotenv not installed; optional */ }

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'cpri',
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
    console.log('[db] Connected to MySQL database "' + (process.env.DB_NAME || 'cpri') + '".');
    return true;
  } catch (err) {
    console.warn('[db] MySQL not available — running in file-only mode.', err.message);
    return false;
  } finally {
    if (c) c.release();
  }
}

export default pool;