-- ============================================================
--  006 — courses: the shared student course list
--
--  Adds the `courses` table (one list for Create Account, User Management
--  and every page that shows a course) and three nullable columns on users:
--    course_id      courses.id the student chose (NULL = none / "Other")
--    course_other   text typed for "Other (please specify)"
--    course_review  1 while an "Other" entry waits for admin review
--
--  Existing users are unchanged: the new columns are NULL / 0, so every
--  existing Student Researcher reads as "no course yet" until an admin sets it.
--
--  Already applied automatically at boot by ensureCoursesSchema()
--  (server/lib/courses.js), which also seeds an EMPTY courses table from
--  server/data/courses-seed.json. This file is the same change as SQL for a
--  manual run; seed rows are inserted by the app, or add them with
--  INSERT INTO courses (name, department, sort_order) VALUES (...).
--
--  APPLY
--    mysql -h <host> -P <port> -u <user> -p <database> < db/migrations/006_courses.sql
--
--  ROLLBACK
--    ALTER TABLE users DROP INDEX idx_users_course,
--                      DROP COLUMN course_id,
--                      DROP COLUMN course_other,
--                      DROP COLUMN course_review;
--    DROP TABLE courses;
--  Students lose their course; every other account is unaffected.
-- ============================================================

CREATE TABLE IF NOT EXISTS courses (
  id          INT NOT NULL AUTO_INCREMENT,
  name        VARCHAR(180) NOT NULL,
  department  VARCHAR(120) NOT NULL DEFAULT '',
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_courses_name (name),
  KEY idx_courses_active_order (is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE users ADD COLUMN course_id     INT NULL DEFAULT NULL;
ALTER TABLE users ADD COLUMN course_other  VARCHAR(180) NULL DEFAULT NULL;
ALTER TABLE users ADD COLUMN course_review TINYINT(1) NOT NULL DEFAULT 0;
CREATE INDEX idx_users_course ON users (course_id);
