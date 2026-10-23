-- ============================================================
--  008 — Research Gala final-paper submission
--
--  Extends gala_submissions (created by 002) so a Presenter can submit the
--  FINAL paper through a three-step form: presentation details, required
--  documents, review and submit. Adds the new fields, the reference number,
--  the schedule an admin assigns, and the draft-resume marker.
--
--  Already applied automatically at boot by ensureGalaSchema() (server/gala.js),
--  which only adds what is missing. This file is the same change as SQL for a
--  manual run. MySQL has no ADD COLUMN IF NOT EXISTS, so on a database that
--  already has a column the matching statement fails with "Duplicate column
--  name" — that is safe to ignore; skip the statement and carry on.
--
--  STATUS VOCABULARY
--    Old:  submitted | under_review | accepted | rejected
--    New:  draft | submitted | under_checking | for_revision |
--          scheduled | presented | rejected
--  The two renamed statuses are converted once, at the bottom of this file.
--
--  APPLY
--    mysql -h <host> -P <port> -u <user> -p <database> < db/migrations/008_gala_final_paper.sql
--
--  ROLLBACK  (see the end of the file)
-- ============================================================

ALTER TABLE gala_submissions
  ADD COLUMN refNo              varchar(30)  DEFAULT NULL,
  ADD COLUMN presenters         JSON         DEFAULT NULL,
  ADD COLUMN coAuthors          JSON         DEFAULT NULL,
  ADD COLUMN program            varchar(180) DEFAULT NULL,
  ADD COLUMN category           varchar(60)  DEFAULT NULL,
  ADD COLUMN adviser            varchar(160) DEFAULT NULL,
  ADD COLUMN schoolYear         varchar(40)  DEFAULT NULL,
  ADD COLUMN semester           varchar(20)  DEFAULT NULL,
  ADD COLUMN schedulePreference varchar(20)  DEFAULT 'none',
  ADD COLUMN scheduleDate       varchar(10)  DEFAULT NULL,   -- YYYY-MM-DD, kept as text so no timezone can shift it
  ADD COLUMN scheduleTime       varchar(5)   DEFAULT NULL,   -- HH:MM
  ADD COLUMN scheduleRoom       varchar(120) DEFAULT NULL,
  ADD COLUMN draftStep          tinyint      DEFAULT 1,
  ADD COLUMN submittedAt        datetime     DEFAULT NULL;

-- A reference number is unique once assigned (drafts have none; NULLs do not collide).
ALTER TABLE gala_submissions ADD UNIQUE KEY uq_gala_refno (refNo);
ALTER TABLE gala_submissions ADD KEY idx_gala_schedule (scheduleDate, scheduleTime);

-- Rows saved under the old status names move to the nearest new status, once.
-- Afterwards these two statements match nothing.
UPDATE gala_submissions SET status = 'under_checking' WHERE status = 'under_review';
UPDATE gala_submissions SET status = 'scheduled'      WHERE status = 'accepted';

-- ============================================================
--  ROLLBACK
--    UPDATE gala_submissions SET status = 'under_review' WHERE status = 'under_checking';
--    UPDATE gala_submissions SET status = 'accepted'     WHERE status IN ('scheduled', 'presented');
--    UPDATE gala_submissions SET status = 'submitted'    WHERE status IN ('draft', 'for_revision');
--    ALTER TABLE gala_submissions
--      DROP INDEX uq_gala_refno, DROP INDEX idx_gala_schedule,
--      DROP COLUMN refNo, DROP COLUMN presenters, DROP COLUMN coAuthors,
--      DROP COLUMN program, DROP COLUMN category, DROP COLUMN adviser,
--      DROP COLUMN schoolYear, DROP COLUMN semester, DROP COLUMN schedulePreference,
--      DROP COLUMN scheduleDate, DROP COLUMN scheduleTime, DROP COLUMN scheduleRoom,
--      DROP COLUMN draftStep, DROP COLUMN submittedAt;
--  Documents uploaded through the new form are NOT removed by the rollback:
--  they live in the private store under submissions/<user_id>/<submission_id>/final/
--  (Supabase Storage, or server/data/gala-files/ on local disk).
-- ============================================================
