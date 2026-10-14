-- ============================================================
--  CPRI — Research Submission Module schema
--
--  Tables are prefixed with `research_` so they never collide with the
--  legacy `submissions` table used by the generic submit.html flow.
--
--  This file mirrors the DDL in
--  server/research-submissions.js
--  (`ensureResearchSubmissionsSchema()`), which applies it on every boot.
--  Both are written with IF NOT EXISTS so re-running is safe.
--  `server/dev/test-research-submissions.mjs` asserts the two stay in sync.
--
--  Manual apply:
--    mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" \
--      < server/schema.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS research_submissions (
  id              VARCHAR(36) NOT NULL,
  owner_id        VARCHAR(36) NOT NULL,
  owner_name      VARCHAR(160) NOT NULL DEFAULT '',
  owner_role      VARCHAR(40) NOT NULL DEFAULT '',
  stage           VARCHAR(20) NOT NULL DEFAULT 'initial',
  title           VARCHAR(255) NOT NULL DEFAULT '',
  authors         VARCHAR(255) NOT NULL DEFAULT '',
  program         VARCHAR(180) NOT NULL DEFAULT '',
  institution     VARCHAR(180) NOT NULL DEFAULT '',
  nationality     VARCHAR(80) NOT NULL DEFAULT '',
  category        VARCHAR(120) NOT NULL DEFAULT '',
  research_type   VARCHAR(120) NOT NULL DEFAULT '',
  school_year     VARCHAR(40) NOT NULL DEFAULT '',
  semester        VARCHAR(40) NOT NULL DEFAULT '',
  adviser_id      VARCHAR(36) DEFAULT NULL,
  facilitator_id  VARCHAR(36) DEFAULT NULL,
  abstract        TEXT DEFAULT NULL,
  keywords        VARCHAR(255) DEFAULT NULL,
  adviser_eval_link VARCHAR(1000) NOT NULL DEFAULT '',
  status          VARCHAR(40) NOT NULL DEFAULT 'submitted',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_research_owner (owner_id),
  KEY idx_research_status (status),
  KEY idx_research_stage (stage)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS research_submission_files (
  id               VARCHAR(36) NOT NULL,
  submission_id    VARCHAR(36) NOT NULL,
  slot_key         VARCHAR(80) NOT NULL,
  original_name    VARCHAR(255) NOT NULL DEFAULT '',
  stored_path      VARCHAR(512) NOT NULL,
  storage_backend  VARCHAR(20) NOT NULL DEFAULT 'disk',
  mime             VARCHAR(120) NOT NULL DEFAULT 'application/octet-stream',
  size             BIGINT NOT NULL DEFAULT 0,
  version          INT NOT NULL DEFAULT 1,
  uploaded_by      VARCHAR(36) NOT NULL,
  uploaded_by_name VARCHAR(160) NOT NULL DEFAULT '',
  uploaded_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_research_file_submission (submission_id),
  KEY idx_research_file_slot (submission_id, slot_key, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS research_comments (
  id            VARCHAR(36) NOT NULL,
  submission_id VARCHAR(36) NOT NULL,
  author_id     VARCHAR(36) NOT NULL,
  author_name   VARCHAR(160) NOT NULL DEFAULT '',
  author_role   VARCHAR(40) NOT NULL DEFAULT '',
  comment_type  VARCHAR(40) NOT NULL DEFAULT 'comment',
  body          TEXT NOT NULL,
  parent_id     VARCHAR(36) DEFAULT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_research_comment_submission (submission_id),
  KEY idx_research_comment_parent (parent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS research_status_history (
  id              VARCHAR(36) NOT NULL,
  submission_id   VARCHAR(36) NOT NULL,
  from_status     VARCHAR(40) DEFAULT NULL,
  to_status       VARCHAR(40) NOT NULL,
  changed_by      VARCHAR(36) NOT NULL,
  changed_by_name VARCHAR(160) NOT NULL DEFAULT '',
  note            VARCHAR(500) DEFAULT NULL,
  changed_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_research_history_submission (submission_id),
  KEY idx_research_history_changed_by (changed_by)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS research_ethics_clearances (
  id            VARCHAR(36) NOT NULL,
  submission_id VARCHAR(36) NOT NULL,
  reviewer_id   VARCHAR(36) NOT NULL,
  reviewer_name VARCHAR(160) NOT NULL DEFAULT '',
  decision      VARCHAR(20) NOT NULL,
  file_path     VARCHAR(512) DEFAULT NULL,
  file_name     VARCHAR(255) DEFAULT NULL,
  storage_backend VARCHAR(20) NOT NULL DEFAULT 'disk',
  decided_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_research_ethics_submission (submission_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
