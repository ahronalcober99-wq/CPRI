# Migrations

Every schema change in this project is **additive and self-applying**. On boot,
`server/server.js` runs a small `ensure*` function per module, and each one checks
`information_schema` (or `SHOW COLUMNS`) before it adds anything, so running
twice is safe and an older deployment catches up automatically.

The `.sql` files in this folder are the **same changes written out by hand**, for
a database you want to bring up to date manually (a fresh TiDB Cloud instance, a
restore, or CI). They are written to be idempotent-safe to re-run where the
engine allows it; the `ensure*` functions remain the source of truth.

| # | File | Applied at boot by |
|---|------|--------------------|
| 001 | `001_users_role_profile_fields.sql` | `ensureUsersSchema()` — `server/auth.js` |
| 002 | `002_gala_submissions.sql` | `ensureGalaSchema()` — `server/gala.js` |
| 003 | `003_db_backups.sql` | `ensureBackupSchema()` — `server/lib/backup-service.js` |
| 004 | `004_publication_monitoring_fields.sql` | `ensurePublicationSchema()` — `server/publications.js` |
| 005 | `005_research_submissions.sql` | `ensureResearchSubmissionsSchema()` — `server/research-submissions.js` |
| 006 | `006_courses.sql` | `ensureCoursesSchema()` — `server/lib/courses.js` (also seeds an empty `courses` table from `server/data/courses-seed.json`) |
| 008 | `008_gala_final_paper.sql` | `ensureGalaSchema()` — `server/gala.js` (adds the final-paper columns to `gala_submissions` and renames two old statuses) |
| 009 | `009_plagiarism_record.sql` | `ensureGalaSchema()` — `server/gala.js` and `ensureResearchSubmissionsSchema()` — `server/research-submissions.js` (the hand-entered Turnitin score and report link; admin and staff only, advisory) |

## Order

Apply in numeric order. 001 must precede 002 in practice (a Gala submission
belongs to a user whose role is `presenter`), and 003 must precede the first
backup.

```bash
mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" \
  < db/migrations/001_users_role_profile_fields.sql
# …002, 003, 004, 005
```

Verified on this project's TiDB Cloud database — the boot log reports each one:

```
[schema] added missing users columns: officeUnit, position, institution, nationality
[schema] added missing publications columns: issn, isbn, indexing, impactFactor
```

## Rollback notes

Each file carries its own rollback statement in a trailing comment block. Summary:

| # | Rollback | Consequence |
|---|----------|-------------|
| 001 | `ALTER TABLE users DROP COLUMN officeUnit, DROP COLUMN position, DROP COLUMN institution, DROP COLUMN nationality` | Non-Teaching Researcher / Presenter accounts keep working but lose those profile values. |
| 002 | `DROP TABLE gala_submissions` | Deletes every Research Gala entry. Uploaded abstracts under `public/assets/uploads/gala/` are **not** removed by the rollback. |
| 003 | `DROP TABLE db_backups` | Only forgets the backup index. The backup files themselves stay in Supabase Storage (`backups/<timestamp>.json`) or in `./backups/` and can still be restored by hand. |
| 004 | `ALTER TABLE publications DROP COLUMN issn, DROP COLUMN isbn, DROP COLUMN indexing, DROP COLUMN impactFactor` | Report 9 stops showing those four fields. |
| 006 | `ALTER TABLE users DROP INDEX idx_users_course, DROP COLUMN course_id, DROP COLUMN course_other, DROP COLUMN course_review; DROP TABLE courses` | Students lose their course. Every other account is unaffected. |
| 008 | Reverse the two status renames, then drop the added columns and the `uq_gala_refno` / `idx_gala_schedule` indexes (full statements at the end of the file) | Presenters lose their reference numbers, schedules and the new form fields. Uploaded documents stay in the private store. |
| 009 | `ALTER TABLE gala_submissions DROP COLUMN similarityScore, DROP COLUMN similarityReportUrl, DROP COLUMN similarityCheckedAt, DROP COLUMN similarityCheckedBy` and the four `similarity_*` columns of `research_submissions` (full statements at the end of the file) | Only the recorded Turnitin results are lost. |

**User roles need no migration.** `role` is a `VARCHAR(30)`, so adding
`non_teaching_researcher`, `presenter` and self-registered `cpri_staff` is a code
change only — nothing to alter in the database. Rolling the roles back is
equally free: remove them from `ROLES` / `ROLE_META` in `server/auth.js`.

## Backups (module 2.5)

Backups are configured entirely with environment variables, all optional:

| Variable | Default | Meaning |
|----------|---------|---------|
| `BACKUP_SCHEDULE_ENABLED` | `true` | `false` turns the daily job off (manual "Backup now" still works). |
| `BACKUP_INTERVAL_HOURS` | `24` | Hours between automatic backups. |
| `BACKUP_KEEP` | `7` | How many backups to keep; older ones are deleted. |
| `BACKUP_RUN_ON_START` | off | `true` takes one backup as soon as the server boots. |

Where the file goes:

* **Supabase Storage** (`backups/<timestamp>.json`) when `SUPABASE_URL`,
  `SUPABASE_SERVICE_KEY` and `SUPABASE_BUCKET` are set — this is what you want on
  Render, whose disk is wiped on every restart.
* **Local `./backups/`** otherwise, which is fine for development.

The boot log states which one is in use:

```
[backup] scheduled backups: every 24h, keeping 7 (storage: supabase)
```

### Restoring a backup

The file is JSON: `{ schema, rows }`, where `schema[table]` is the
`SHOW CREATE TABLE` statement and `rows[table]` is an array of row objects.

1. Download it from **Admin → Backups → Download**.
2. Recreate the tables: run each value of `schema` as SQL.
3. Re-insert the rows in dependency order (`users`, then everything that
   references a user id).
