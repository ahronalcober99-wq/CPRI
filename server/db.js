import mysql from 'mysql2/promise';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

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

// ---- TLS ----------------------------------------------------------------
// Managed MySQL hosts almost always require TLS, and several (Aiven, Clever
// Cloud, …) sign their certificate with their OWN CA, which Node's trust store
// does not know. TLS used to be forced on for every non-loopback host with no
// way to supply that CA or to switch TLS off, so those providers could not be
// used at all.
//
//   DB_SSL_MODE=auto     (default) TLS for any non-loopback host
//   DB_SSL_MODE=require  always TLS, even to localhost
//   DB_SSL_MODE=disable  never TLS (for providers that do not offer it)
//   DB_SSL_CA=<pem|path> the provider's CA certificate — PEM text (real
//                        newlines, or escaped "\n") or a path to a .pem file
//   DB_SSL_REJECT_UNAUTHORIZED=false  keep TLS but skip the certificate check
//
// DB_SSL=true/false is still honoured as a legacy alias (true ⇒ require,
// false ⇒ auto), so existing deployments keep the behaviour they already had.
const SSL_MODES = ['auto', 'require', 'disable'];
const sslMode = String(
  process.env.DB_SSL_MODE || (process.env.DB_SSL === 'true' ? 'require' : 'auto')
).toLowerCase();
if (!SSL_MODES.includes(sslMode)) {
  throw new Error(`[db] DB_SSL_MODE must be one of ${SSL_MODES.join(', ')} (got "${sslMode}")`);
}
const sslEnabled = sslMode === 'disable' ? false : (sslMode === 'require' || !isLoopbackHost);
const sslRejectUnauthorized = process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false';

function resolveSslCa() {
  const raw = process.env.DB_SSL_CA;
  if (!raw || !raw.trim()) return null;
  if (raw.includes('BEGIN CERTIFICATE')) {
    // A PEM pasted into a host's env-var box often arrives with literal "\n"
    // instead of real newlines; accept either form.
    return raw.replace(/\\n/g, '\n');
  }
  const asPath = resolve(raw.trim());
  if (existsSync(asPath)) return readFileSync(asPath, 'utf8');
  throw new Error('[db] DB_SSL_CA is neither a PEM certificate nor a path to an existing file.');
}

const sslCa = sslEnabled ? resolveSslCa() : null;
const sslOptions = sslEnabled
  ? { minVersion: 'TLSv1.2', rejectUnauthorized: sslRejectUnauthorized, ...(sslCa ? { ca: sslCa } : {}) }
  : null;

// Shared by the pool and by `npm run db:init` (server/dev/db-init.mjs), so a
// schema import always uses exactly the same host, credentials and TLS settings
// as the running API.
export const connectionOptions = {
  host: databaseHost,
  port: databasePort,
  user: process.env.DB_USER || localDefaults?.user,
  password: process.env.DB_PASSWORD ?? localDefaults?.password,
  database: databaseName,
  ...(sslOptions ? { ssl: sslOptions } : {}),
  charset: 'utf8mb4',
  timezone: 'Z'
};

const pool = mysql.createPool({
  ...connectionOptions,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_LIMIT || 10)
});

const rawPassword = String(process.env.DB_PASSWORD ?? localDefaults?.password ?? '');

const sslLabel = sslEnabled
  ? `on (mode=${sslMode}, ca=${sslCa ? 'custom' : 'system'}, verify=${sslRejectUnauthorized})`
  : `off (mode=${sslMode})`;

console.log(`[db] MySQL connection host=${databaseHost} port=${databasePort} ssl=${sslLabel}`);

// A password that arrives with surrounding whitespace or wrapping quotation
// marks is sent to the server verbatim and always fails with "Access denied".
// This happens when a value is pasted as `"secret"` (including the quotes) or
// copied with a trailing newline into a host's env-var box. Flag the *shape*
// (never the value) so the cause is obvious from the deploy log.
if (rawPassword !== rawPassword.trim() || /^(['"]).*\1$/.test(rawPassword)) {
  console.warn('[db] DB_PASSWORD has surrounding whitespace or quotation marks. '
    + 'They are sent verbatim and cause "Access denied" — re-enter the password without them.');
}

// The connection target, minus the secret. Used by the boot log and the
// `npm run doctor` diagnostic so both describe the same configuration.
export function describeDbTarget() {
  return {
    host: databaseHost,
    port: databasePort,
    user: process.env.DB_USER || localDefaults?.user,
    database: databaseName,
    ssl: sslEnabled,
    sslMode,
    sslCa: Boolean(sslCa),
    sslVerify: sslEnabled ? sslRejectUnauthorized : false
  };
}

// Turns a driver error into the likely cause and the fix, so a failed
// connection reports something actionable instead of a bare error code.
// Returns null when the error is not one we can explain. Never includes the
// password (the driver itself only ever reports "(using password: YES/NO)").
export function explainDbError(err) {
  if (!err) return null;
  const code = err.code || '';
  const errno = err.errno;
  const message = String(err.message || '');

  if (code === 'ER_ACCESS_DENIED_ERROR' || errno === 1045) {
    return [
      'Cause: the database rejected the username/password.',
      '  • DB_PASSWORD is wrong or stale — re-copy it from the database console.',
      '  • The database firewall does not allow this host\'s public IP (see docs/FIX-DB-CONNECTION.md once it is restored, or the guide comment below).',
      '  • DB_USER is truncated (some providers need the full prefixed name, e.g. "abc123.root").'
    ].join('\n');
  }
  if (code === 'ER_DBACCESS_DENIED_ERROR' || errno === 1044) {
    return 'Cause: the user may not access DB_NAME. Grant it or pick a database the user owns.';
  }
  if (code === 'ER_BAD_DB_ERROR' || errno === 1049) {
    return `Cause: database "${databaseName}" does not exist on the server. Create it, or fix DB_NAME.`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `Cause: the hostname "${databaseHost}" does not resolve. Check DB_HOST for typos.`;
  }
  if (code === 'ECONNREFUSED') {
    return `Cause: nothing is listening on ${databaseHost}:${databasePort}. Check DB_PORT `
      + '(TiDB Cloud uses 4000, not 3306) and that the server is running.';
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'PROTOCOL_CONNECTION_LOST') {
    return 'Cause: the connection timed out or was dropped mid-handshake. Usually a firewall '
      + 'blocking this host\'s public IP, or the database not exposing a public endpoint.';
  }
  if (/self.signed|certificate|TLS|handshake/i.test(message)) {
    return [
      'Cause: the TLS handshake failed.',
      '  • A managed host usually needs TLS — set DB_SSL_MODE=require.',
      '  • If the provider signs with its own CA (Aiven, Clever Cloud, …), supply it with DB_SSL_CA=<ca.pem>.',
      '  • A local MySQL usually needs none — set DB_SSL_MODE=disable.'
    ].join('\n');
  }
  return null;
}

export async function testConnection() {
  let c;
  try {
    c = await pool.getConnection();
    await c.query('SELECT 1');
    console.log('[db] Connected to MySQL database "' + databaseName + '".');
    return true;
  } catch (err) {
    console.warn('[db] MySQL not available — running in file-only mode.', err.message);
    const hint = explainDbError(err);
    if (hint) console.warn('[db] ' + hint.replace(/\n/g, '\n[db] '));
    return false;
  } finally {
    if (c) c.release();
  }
}

export default pool;

export function getDbConfig() {
  return {
    host: databaseHost,
    port: databasePort,
    user: process.env.DB_USER || localDefaults?.user,
    password: process.env.DB_PASSWORD ?? localDefaults?.password,
    database: databaseName,
    ssl: sslEnabled ? { minVersion: 'TLSv1.2', rejectUnauthorized: sslRejectUnauthorized, ...(sslCa ? { ca: sslCa } : {}) } : false
  };
}