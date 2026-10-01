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
const databaseHost = process.env.DB_HOST || localDefaults?.host;
const databasePort = Number(process.env.DB_PORT || localDefaults?.port);
const normalizedHost = databaseHost.toLowerCase().replace(/^\[|\]$/g, '');
const isLoopbackHost = normalizedHost === 'localhost'
  || normalizedHost === '127.0.0.1'
  || normalizedHost === '::1';
const sslEnabled = process.env.DB_SSL === 'true' || !isLoopbackHost;

const pool = mysql.createPool({
  host: databaseHost,
  port: databasePort,
  user: process.env.DB_USER || localDefaults?.user,
  password: process.env.DB_PASSWORD ?? localDefaults?.password,
  database: databaseName,
  ...(sslEnabled
    ? { ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true } }
    : {}),
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_LIMIT || 10),
  charset: 'utf8mb4',
  timezone: 'Z'
});

console.log(`[db] MySQL connection host=${databaseHost} port=${databasePort} ssl=${sslEnabled}`);

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