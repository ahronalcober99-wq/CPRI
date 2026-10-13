-- ============================================================
--  001 — users: role-owned profile fields
--
--  Adds the extra profile columns the new account types own:
--    Non-Teaching Researcher ... officeUnit, position
--    Presenter ................ institution, nationality
--
--  Already applied automatically at boot by ensureUsersSchema()
--  (server/auth.js). This file is the same change as SQL for a manual run.
--
--  APPLY
--    mysql -h <host> -P <port> -u <user> -p <database> < db/migrations/001_users_role_profile_fields.sql
--
--  ROLLBACK
--    ALTER TABLE users DROP COLUMN officeUnit,
--                      DROP COLUMN position,
--                      DROP COLUMN institution,
--                      DROP COLUMN nationality;
--  Safe to roll back: the columns are optional profile data. Accounts whose
--  role is `non_teaching_researcher` or `presenter` keep working, they simply
--  lose the extra fields (and any values stored in them).
-- ============================================================

ALTER TABLE users ADD COLUMN officeUnit  VARCHAR(160) NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN position    VARCHAR(120) NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN institution VARCHAR(180) NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN nationality VARCHAR(80)  NOT NULL DEFAULT '';
