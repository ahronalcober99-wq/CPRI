// Backup script — dumps the cpri MySQL database with mysqldump and copies the
// server/data/*.json content files into a timestamped backups/ folder.
//
//   npm run backup              -> create a backup, keep the latest 10
//   npm run backup -- --keep 5  -> keep only the latest 5 backups
//   npm run backup -- --prune   -> only prune old backups, don't create one
//
// Backup layout:
//   backups/
//     2026-08-04_213000/
//       cpri.sql            <- full mysqldump of the database
//       data/               <- copy of server/data/*.json
//       manifest.json       <- metadata (time, counts, version)
//
// Restore (from a backup folder):
//   mysql -u root cpri < backups/<folder>/cpri.sql
//   copy backups/<folder>/data/*.json back into server/data/

import 'dotenv/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import { createWriteStream } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const DATA_DIR = join(__dirname, 'data');
const BACKUPS_DIR = join(ROOT, 'backups');
const DEFAULT_KEEP = 10;

const DB = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || '3306',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  name: process.env.DB_NAME || 'cpri'
};

// Common mysqldump locations (Windows XAMPP + PATH fallback).
const MYSQLDUMP_CANDIDATES = [
  process.env.MYSQLDUMP_PATH,
  'C:/xampp/mysql/bin/mysqldump.exe',
  '/c/xampp/mysql/bin/mysqldump.exe',
  'C:/wamp64/bin/mysql/mysql8.0.36/bin/mysqldump.exe', // common WAMP layout
  'mysqldump'
].filter(Boolean);

async function findMysqldump() {
  for (const candidate of MYSQLDUMP_CANDIDATES) {
    try {
      await execFileAsync(candidate, ['--version'], { windowsHide: true });
      return candidate;
    } catch { /* try next */ }
  }
  return null;
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  // Milliseconds prevent same-second collisions when backups run back-to-back.
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${p(d.getMilliseconds())}`;
}

async function pruneBackups(keep) {
  const entries = await fs.readdir(BACKUPS_DIR, { withFileTypes: true }).catch(() => []);
  const dirs = entries
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort()
    .reverse();
  const toRemove = dirs.slice(keep);
  for (const dir of toRemove) {
    await fs.rm(join(BACKUPS_DIR, dir), { recursive: true, force: true });
    console.log(`[backup] Pruned old backup: ${dir}`);
  }
  return toRemove.length;
}

async function dumpDatabase(mysqldump, destFile) {
  // NOTE: --password= is passed on the command line (standard for mysqldump;
  // visible in process listings). MYSQL_PWD env is the alternative.
  const args = [
    '--host=' + DB.host,
    '--port=' + DB.port,
    '--user=' + DB.user,
    '--password=' + DB.password,
    '--single-transaction',
    '--routines',
    '--no-tablespaces',
    '--add-drop-table',
    DB.name
  ];
  let stderr = '';
  await new Promise((resolve, reject) => {
    const proc = execFile(mysqldump, args, { maxBuffer: 256 * 1024 * 1024, windowsHide: true }, () => {
      /* completion handled via 'close' below; callback kept for stderr capture */
    });
    const out = createWriteStream(destFile, { flags: 'w' });
    proc.stdout.pipe(out);
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', reject);
    out.on('error', reject);
    // Resolve/reject ONLY on 'close': 'finish' on the write stream can fire
    // before the child exits, which would swallow a non-zero mysqldump exit
    // and leave a truncated/empty dump treated as success.
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`mysqldump exited with code ${code}${stderr ? ': ' + stderr.trim().split('\n').pop() : ''}`));
    });
  });
}

async function copyJsonFiles(destDir) {
  const files = await fs.readdir(DATA_DIR).catch(() => []);
  const jsonFiles = files.filter(f => f.endsWith('.json'));
  await fs.mkdir(destDir, { recursive: true });
  for (const f of jsonFiles) {
    await fs.copyFile(join(DATA_DIR, f), join(destDir, f));
  }
  return jsonFiles.length;
}

async function main() {
  const argv = process.argv.slice(2);
  const keepIdx = argv.indexOf('--keep');
  const keep = keepIdx !== -1 ? Math.max(1, parseInt(argv[keepIdx + 1], 10) || DEFAULT_KEEP) : DEFAULT_KEEP;
  const pruneOnly = argv.includes('--prune');

  await fs.mkdir(BACKUPS_DIR, { recursive: true });

  if (pruneOnly) {
    const n = await pruneBackups(keep);
    console.log(`[backup] Prune complete — removed ${n}, keeping ${keep}.`);
    return;
  }

  const mysqldump = await findMysqldump();
  if (!mysqldump) {
    console.error('[backup] ERROR: mysqldump not found. Set MYSQLDUMP_PATH in .env to the full path (e.g. C:/xampp/mysql/bin/mysqldump.exe).');
    process.exit(1);
  }

  const stamp = timestamp();
  const backupDir = join(BACKUPS_DIR, stamp);
  const dataDest = join(backupDir, 'data');
  await fs.mkdir(dataDest, { recursive: true });

  const sqlFile = join(backupDir, 'cpri.sql');
  console.log(`[backup] Dumping database "${DB.name}" with ${mysqldump} ...`);
  try {
    await dumpDatabase(mysqldump, sqlFile);
  } catch (err) {
    console.error('[backup] ERROR: mysqldump failed:', err.message);
    console.error('[backup] Is MySQL running? Check the run doc (XAMPP mysqld on :3306).');
    process.exit(1);
  }
  const sqlSize = (await fs.stat(sqlFile)).size;
  if (sqlSize === 0) {
    console.error('[backup] ERROR: mysqldump produced an empty dump — database may be unreachable.');
    process.exit(1);
  }

  const jsonCount = await copyJsonFiles(dataDest);
  console.log(`[backup] Copied ${jsonCount} JSON content files.`);

  const manifest = {
    createdAt: new Date().toISOString(),
    database: DB.name,
    mysqlDump: basename(sqlFile),
    sqlBytes: sqlSize,
    jsonFiles: jsonCount,
    node: process.version
  };
  await fs.writeFile(join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const pruned = await pruneBackups(keep);
  console.log(`[backup] Done → ${backupDir}  (sql: ${(sqlSize / 1024).toFixed(1)} KB, json: ${jsonCount})`);
  if (pruned) console.log(`[backup] Pruned ${pruned} old backup(s), keeping ${keep}.`);
  console.log('[backup] Restore:  mysql -u <user> cpri < backups/<folder>/cpri.sql');
}

main().catch((err) => {
  console.error('[backup] Failed:', err);
  process.exit(1);
});
