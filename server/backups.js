// ============================================================
//  CPRI — Admin backups API
//
//    GET  /api/admin/backups              list (date, size, tables, storage)
//    POST /api/admin/backups              take a backup now
//    GET  /api/admin/backups/:id/download stream one backup as a .json file
//    GET  /api/admin/backups/config       retention + schedule (for the UI)
//
//  Every route is admin-only, and taking or downloading a backup is written to
//  the audit trail. A backup never contains credentials other than the rows the
//  database itself holds.
// ============================================================
import { Router } from 'express';
import { requireAdmin } from './auth.js';
import { addLog } from './audit.js';
import {
  createBackup,
  listBackups,
  readBackup,
  keepCount,
  ensureBackupSchema
} from './lib/backup-service.js';

export function createBackupsRouter(dependencies = {}) {
  const router = Router();
  const adminOnly = dependencies.requireAdmin || requireAdmin;
  const log = dependencies.addLog || addLog;
  const makeBackup = dependencies.createBackup || createBackup;
  const list = dependencies.listBackups || listBackups;
  const read = dependencies.readBackup || readBackup;
  const ensure = dependencies.ensureBackupSchema || ensureBackupSchema;

  // A single backup at a time: two concurrent dumps of the same database would
  // double the load and race on the retention list.
  let running = false;

  router.get('/', adminOnly, async (req, res) => {
    try {
      await ensure();
      const backups = await list();
      res.json({ backups, running, keep: keepCount() });
    } catch (err) {
      console.error('[backup] list failed:', err.message);
      res.status(500).json({ error: 'Could not read the backup list.' });
    }
  });

  router.get('/config', adminOnly, (req, res) => {
    res.json({
      enabled: String(process.env.BACKUP_SCHEDULE_ENABLED ?? 'true').toLowerCase() !== 'false',
      intervalHours: Math.max(1, parseInt(process.env.BACKUP_INTERVAL_HOURS, 10) || 24),
      keep: keepCount(),
      runOnStart: String(process.env.BACKUP_RUN_ON_START).toLowerCase() === 'true'
    });
  });

  router.post('/', adminOnly, async (req, res) => {
    if (running) {
      return res.status(409).json({ error: 'A backup is already running. Please wait for it to finish.' });
    }
    running = true;
    try {
      const actor = req.session?.userId || 'admin';
      const { backup, pruned } = await makeBackup({ actor, triggerSource: 'manual' });
      await log('backup_created',
        `Database backup taken (${(backup.bytes / 1024).toFixed(1)} KB, ${backup.tableCount} tables, stored in ${backup.storage}).`,
        req);
      res.status(201).json({
        message: 'Backup created.',
        backup,
        pruned,
        note: backup.storage === 'local'
          ? 'Stored on the server disk. Set SUPABASE_URL and SUPABASE_SERVICE_KEY to keep backups off the ephemeral disk.'
          : 'Stored in Supabase Storage.'
      });
    } catch (err) {
      console.error('[backup] create failed:', err);
      res.status(500).json({ error: `The backup could not be created: ${err.message}` });
    } finally {
      running = false;
    }
  });

  router.get('/:id/download', adminOnly, async (req, res) => {
    try {
      const found = await read(req.params.id);
      if (!found) return res.status(404).json({ error: 'Backup not found.' });
      const stamp = String(found.record.createdAt || '').replace(/[:.]/g, '-');
      const filename = `cpri-backup-${stamp || found.filename}.json`;
      await log('backup_downloaded', `Database backup ${found.record.id} downloaded.`, req);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(found.buffer);
    } catch (err) {
      console.error('[backup] download failed:', err.message);
      res.status(500).json({ error: 'Could not read that backup file.' });
    }
  });

  return router;
}

const router = createBackupsRouter();

export { router as backupsRouter };
