// ============================================================
//  CPRI — database backup service (admin Backups module)
//
//  `npm run backup` (server/backup.mjs) shells out to mysqldump, which only
//  exists on a developer machine. A hosted deployment has no mysqldump and an
//  ephemeral disk, so this service:
//
//   1. dumps every table in pure JavaScript — SHOW CREATE TABLE for the
//      schema and SELECT * for the rows — into one JSON document;
//   2. stores it in Supabase Storage (the same project the rest of the site
//      uses) so it survives restarts and redeploys, falling back to the local
//      backups/ folder when Storage is not configured;
//   3. records the backup in the `db_backups` table so the admin page can list
//      date, size and table count without listing the bucket;
//   4. prunes to the newest BACKUP_KEEP entries (default 7).
//
//  Configuration (all optional):
//    BACKUP_SCHEDULE_ENABLED   'false' turns the daily job off (default on)
//    BACKUP_INTERVAL_HOURS     hours between runs (default 24)
//    BACKUP_KEEP               how many backups to keep (default 7)
//    BACKUP_RUN_ON_START       'true' takes one backup at boot (default off)
//
//  Never logs or returns a credential: the storage key never reaches a response.
// ============================================================
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { all, get, run, insert, remove } from '../server/db/queries.js';
import { supabaseStorage } from '../storage/supabase-storage.js';
import { BACKUPS_DIR, timestamp } from '../backup.mjs';

const DEFAULT_KEEP = 7;
const BACKUP_PREFIX = 'backups';

export function keepCount(env = process.env) {
  const parsed = parseInt(env.BACKUP_KEEP, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_KEEP;
}

function storageAvailable() {
  try {
    return Boolean(supabaseStorage?.isConfigured?.({}));
  } catch {
    return false;
  }
}

// ---------- Schema ----------
export async function ensureBackupSchema(dependencies = {}) {
  const runQuery = dependencies.run || run;
  await runQuery(`
    CREATE TABLE IF NOT EXISTS db_backups (
      id varchar(36) NOT NULL,
      createdAt datetime NOT NULL,
      bytes bigint NOT NULL DEFAULT 0,
      tableCount int NOT NULL DEFAULT 0,
      rowCount bigint NOT NULL DEFAULT 0,
      storage varchar(20) NOT NULL DEFAULT 'local',
      objectPath varchar(500) DEFAULT NULL,
      createdBy varchar(160) DEFAULT NULL,
      triggerSource varchar(20) NOT NULL DEFAULT 'manual',
      PRIMARY KEY (id),
      KEY idx_backup_created (createdAt)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

// ---------- Dump ----------
// Reads the live schema and every row. Table names come from the server's own
// information_schema (never from a request), and identifiers are re-quoted with
// backticks so a table called `group` still works.
function quoteIdentifier(name) {
  return '`' + String(name).replace(/`/g, '``') + '`';
}

export async function dumpDatabase(dependencies = {}) {
  const queryAll = dependencies.all || all;
  const database = String(process.env.DB_NAME || '');

  const tables = await queryAll(
    'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = ?',
    ['BASE TABLE']
  );
  const names = tables.map(t => t.name || t.TABLE_NAME || t.table_name).filter(Boolean);

  const schema = {};
  const rows = {};
  let rowCount = 0;
  for (const name of names) {
    const create = await queryAll(`SHOW CREATE TABLE ${quoteIdentifier(name)}`);
    const first = Array.isArray(create) ? create[0] : null;
    const createSql = first?.['Create Table'] || first?.['Create View'] || '';
    if (createSql) schema[name] = createSql;
    const tableRows = await queryAll(`SELECT * FROM ${quoteIdentifier(name)}`);
    rows[name] = tableRows;
    rowCount += tableRows.length;
  }

  return {
    format: 'cpri-backup/1',
    createdAt: new Date().toISOString(),
    database,
    node: process.version,
    tables: names.length,
    rowCount,
    schema,
    rows
  };
}

// ---------- Store ----------
async function storeBackup({ id, stamp, buffer }) {
  if (storageAvailable()) {
    const objectPath = `${BACKUP_PREFIX}/${stamp}.json`;
    await supabaseStorage.uploadObject({
      path: objectPath,
      buffer,
      contentType: 'application/json'
    });
    return { storage: 'supabase', objectPath };
  }
  await fs.mkdir(BACKUPS_DIR, { recursive: true });
  const filename = `${stamp}.json`;
  await fs.writeFile(join(BACKUPS_DIR, filename), buffer);
  return { storage: 'local', objectPath: filename };
}

// ---------- Create ----------
export async function createBackup({ actor = 'system', triggerSource = 'manual', env = process.env } = {}) {
  await ensureBackupSchema();
  const dump = await dumpDatabase();
  const buffer = Buffer.from(JSON.stringify(dump, null, 2), 'utf8');

  const id = randomUUID();
  const stamp = timestamp();
  const { storage, objectPath } = await storeBackup({ id, stamp, buffer });

  const record = {
    id,
    createdAt: new Date().toISOString(),
    bytes: buffer.length,
    tableCount: dump.tables,
    rowCount: dump.rowCount,
    storage,
    objectPath,
    createdBy: String(actor || 'system').slice(0, 160),
    triggerSource
  };
  await insert('db_backups', record);
  const pruned = await pruneBackups(keepCount(env));
  return { backup: record, pruned };
}

// ---------- List ----------
export async function listBackups() {
  await ensureBackupSchema();
  const rows = await all('SELECT * FROM db_backups ORDER BY createdAt DESC LIMIT 100');
  return rows.map(r => ({
    id: r.id,
    createdAt: r.createdAt,
    bytes: Number(r.bytes || 0),
    tableCount: Number(r.tableCount || 0),
    rowCount: Number(r.rowCount || 0),
    storage: r.storage,
    createdBy: r.createdBy || '',
    triggerSource: r.triggerSource || 'manual'
  }));
}

// ---------- Read one (for download) ----------
export async function readBackup(id) {
  await ensureBackupSchema();
  const record = await get('SELECT * FROM db_backups WHERE id = ?', [id]);
  if (!record) return null;
  const filename = String(record.objectPath || 'backup.json').split('/').pop() || 'backup.json';

  if (record.storage === 'supabase') {
    // Signed URLs are short-lived by design (1–60 s); the admin endpoint fetches
    // the URL server-side and streams the bytes, so the URL never reaches the
    // browser and the download stays behind the admin gate.
    const signed = await supabaseStorage.createSignedDownloadUrl({
      path: record.objectPath,
      downloadName: filename,
      expiresIn: 60
    });
    const response = await fetch(signed.url || signed);
    if (!response.ok) throw new Error(`Storage returned ${response.status} for the backup object.`);
    const buffer = Buffer.from(await response.arrayBuffer());
    return { record, filename, buffer };
  }

  const filePath = join(BACKUPS_DIR, record.objectPath);
  const buffer = await fs.readFile(filePath);
  return { record, filename, buffer };
}

// ---------- Prune ----------
export async function pruneBackups(keep = DEFAULT_KEEP) {
  const rows = await all('SELECT * FROM db_backups ORDER BY createdAt DESC');
  const stale = rows.slice(keep);
  for (const row of stale) {
    try {
      if (row.storage === 'supabase') {
        await supabaseStorage.deleteObjects([row.objectPath]);
      } else {
        await fs.rm(join(BACKUPS_DIR, row.objectPath), { force: true });
      }
    } catch (err) {
      console.error(`[backup] could not remove old backup ${row.id}: ${err.message}`);
    }
    await remove('db_backups', row.id);
  }
  return stale.length;
}

// ---------- Daily scheduler ----------
let schedulerTimer = null;

/**
 * Start the daily backup job. Uses a plain timer instead of a cron dependency:
 * the app is a single long-running Node process, so one interval is enough, and
 * it avoids adding a package for a 24-hour tick.
 */
export function startBackupScheduler({ env = process.env, logger = console } = {}) {
  const enabled = String(env.BACKUP_SCHEDULE_ENABLED ?? 'true').toLowerCase() !== 'false';
  if (!enabled) {
    logger.log('[backup] scheduled backups: disabled (BACKUP_SCHEDULE_ENABLED=false)');
    return null;
  }
  if (schedulerTimer) return schedulerTimer;

  const hours = Math.max(1, parseInt(env.BACKUP_INTERVAL_HOURS, 10) || 24);
  const intervalMs = hours * 60 * 60 * 1000;

  const runJob = async () => {
    try {
      const { backup } = await createBackup({ actor: 'scheduler', triggerSource: 'scheduled' });
      logger.log(`[backup] scheduled backup ok: ${(backup.bytes / 1024).toFixed(1)} KB, ${backup.tableCount} tables`);
    } catch (err) {
      logger.error('[backup] scheduled backup failed:', err.message);
    }
  };

  if (String(env.BACKUP_RUN_ON_START).toLowerCase() === 'true') {
    runJob();
  }

  schedulerTimer = setInterval(runJob, intervalMs);
  if (schedulerTimer.unref) schedulerTimer.unref();
  logger.log(`[backup] scheduled backups: every ${hours}h, keeping ${keepCount(env)} (storage: ${storageAvailable() ? 'supabase' : 'local disk'})`);
  return schedulerTimer;
}

export function stopBackupScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}
