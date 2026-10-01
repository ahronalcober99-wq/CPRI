import mysql from 'mysql2/promise';

const isProduction = process.env.NODE_ENV === 'production';
const localDefaults = isProduction
  ? null
  : { host: 'localhost', port: 3306, user: 'root', password: '', database: 'cpri' };

if (isProduction) {
  const requiredVariables = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
  const missingVariables = requiredVariables.filter((name) => {
    const value = process.env[name];
    return value === undefined || (name !== 'DB_PASSWORD' && value.trim() === '');
  });
  if (missingVariables.length > 0) {
    throw new Error(`[db] Missing required production environment variables: ${missingVariables.join(', ')}`);
  }
}

const databaseName = process.env.DB_NAME || localDefaults?.database;

const pool = mysql.createPool({
  host: process.env.DB_HOST || localDefaults?.host,
  port: Number(process.env.DB_PORT || localDefaults?.port),
  user: process.env.DB_USER || localDefaults?.user,
  password: process.env.DB_PASSWORD ?? localDefaults?.password,
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