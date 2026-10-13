-- ============================================================
--  002 — Research Gala submissions
--
--  One row per Research Gala entry (Presenter role and any researcher who may
--  present). Statuses: submitted → under_review → accepted | rejected.
--  `eventId` optionally links the entry to an event in `events_module`.
--
--  Already applied automatically at boot by ensureGalaSchema() (server/gala.js).
--  This file is the same change as SQL for a manual run.
--
--  APPLY
--    mysql -h <host> -P <port> -u <user> -p <database> < db/migrations/002_gala_submissions.sql
--
--  ROLLBACK
--    DROP TABLE gala_submissions;
--  This deletes every Gala submission and its metadata; uploads on disk under
--  public/assets/uploads/gala/ are not touched by the rollback and can be
--  removed separately.
-- ============================================================

CREATE TABLE IF NOT EXISTS gala_submissions (
  id varchar(36) NOT NULL,
  userId varchar(36) DEFAULT NULL,
  submitterName varchar(160) DEFAULT NULL,
  eventId varchar(36) DEFAULT NULL,
  title varchar(255) DEFAULT NULL,
  authors varchar(255) DEFAULT NULL,
  institution varchar(180) DEFAULT NULL,
  nationality varchar(80) DEFAULT NULL,
  contactNumber varchar(60) DEFAULT NULL,
  researchInterests text DEFAULT NULL,
  presentationType varchar(40) DEFAULT 'oral',
  strand varchar(120) DEFAULT NULL,
  keywords varchar(255) DEFAULT NULL,
  abstractText text DEFAULT NULL,
  status varchar(40) DEFAULT 'submitted',
  reviewNote text DEFAULT NULL,
  reviewedBy varchar(160) DEFAULT NULL,
  reviewedAt datetime DEFAULT NULL,
  -- JSON (not longtext) so the driver hands these back parsed, matching the
  -- convention in server/init-db.sql (ethics.statusHistory, publications.proofDocuments).
  statusHistory JSON DEFAULT NULL,
  files JSON DEFAULT NULL,
  createdAt datetime DEFAULT NULL,
  updatedAt datetime DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_gala_user (userId),
  KEY idx_gala_event (eventId),
  KEY idx_gala_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
