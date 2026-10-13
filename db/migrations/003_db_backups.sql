-- ============================================================
--  003 — db_backups (backup index)
--
--  Keeps the list of taken backups (date, size, table and row counts, where the
--  file lives) so the admin Backups page can show and download them without
--  listing the storage bucket. The database is the durable place to keep this
--  index: the server's own disk is wiped on every Render restart.
--
--  Already applied automatically at boot by ensureBackupSchema()
--  (server/lib/backup-service.js). Same change as SQL for a manual run.
--
--  APPLY
--    mysql -h <host> -P <port> -u <user> -p <database> < db/migrations/003_db_backups.sql
--
--  ROLLBACK
--    DROP TABLE db_backups;
--  Dropping the table only forgets the index. The backup files themselves stay
--  in Supabase Storage (backups/<timestamp>.json) or in ./backups/ on disk and
--  can still be restored by hand.
-- ============================================================

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
