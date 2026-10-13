-- ============================================================
--  004 — publications: Publication Monitoring fields
--
--  Report 9 already had title, authors, journalOrConference, publicationDate,
--  volume, issue, pages, doi, publicationLink and indexingStatus. These four
--  columns complete the bibliographic record it must report:
--    issn, isbn, indexing (the databases, e.g. "Scopus, Web of Science"),
--    impactFactor.
--
--  Already applied automatically at boot by ensurePublicationSchema()
--  (server/publications.js). Same change as SQL for a manual run.
--
--  APPLY
--    mysql -h <host> -P <port> -u <user> -p <database> < db/migrations/004_publication_monitoring_fields.sql
--
--  ROLLBACK
--    ALTER TABLE publications DROP COLUMN issn,
--                            DROP COLUMN isbn,
--                            DROP COLUMN indexing,
--                            DROP COLUMN impactFactor;
--  Safe to roll back: the columns are extra metadata. Report 9 simply stops
--  showing those four fields.
-- ============================================================

ALTER TABLE publications ADD COLUMN issn         VARCHAR(40)  NOT NULL DEFAULT '';
ALTER TABLE publications ADD COLUMN isbn         VARCHAR(40)  NOT NULL DEFAULT '';
ALTER TABLE publications ADD COLUMN indexing     VARCHAR(255) NOT NULL DEFAULT '';
ALTER TABLE publications ADD COLUMN impactFactor VARCHAR(40)  NOT NULL DEFAULT '';
