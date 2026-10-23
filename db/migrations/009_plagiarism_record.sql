-- ============================================================
--  009 — Turnitin (plagiarism) result recorded by hand
--
--  The school checks papers in Turnitin; an admin or CPRI staff member types the
--  similarity score and the report link into the submission. The website does
--  not scan anything. The result is ADVISORY: no status move or submission is
--  ever allowed or refused because of it, and presenters / students never see it.
--
--  Already applied automatically at boot by ensureGalaSchema() (server/gala.js)
--  and ensureResearchSubmissionsSchema() (server/research-submissions.js), which
--  only add what is missing. This file is the same change as SQL for a manual
--  run. MySQL has no ADD COLUMN IF NOT EXISTS: a "Duplicate column name" error
--  means that column is already there and can be ignored.
--
--  APPLY
--    mysql -h <host> -P <port> -u <user> -p <database> < db/migrations/009_plagiarism_record.sql
--
--  ROLLBACK  (see the end of the file)
-- ============================================================

ALTER TABLE gala_submissions
  ADD COLUMN similarityScore      decimal(5,2) DEFAULT NULL,   -- 0.00 to 100.00
  ADD COLUMN similarityReportUrl  varchar(500) DEFAULT NULL,
  ADD COLUMN similarityCheckedAt  datetime     DEFAULT NULL,
  ADD COLUMN similarityCheckedBy  varchar(160) DEFAULT NULL;

ALTER TABLE research_submissions
  ADD COLUMN similarity_score       decimal(5,2) DEFAULT NULL,
  ADD COLUMN similarity_report_url  varchar(500) DEFAULT NULL,
  ADD COLUMN similarity_checked_at  datetime     DEFAULT NULL,
  ADD COLUMN similarity_checked_by  varchar(160) DEFAULT NULL;

-- ============================================================
--  ROLLBACK
--    ALTER TABLE gala_submissions
--      DROP COLUMN similarityScore, DROP COLUMN similarityReportUrl,
--      DROP COLUMN similarityCheckedAt, DROP COLUMN similarityCheckedBy;
--    ALTER TABLE research_submissions
--      DROP COLUMN similarity_score, DROP COLUMN similarity_report_url,
--      DROP COLUMN similarity_checked_at, DROP COLUMN similarity_checked_by;
--  Only the recorded scores and links are lost; submissions are untouched.
-- ============================================================
