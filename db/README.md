# Database

`schema.sql` in this folder is a **structure-only** dump of the local `cpri`
database (14 tables, `CREATE TABLE` statements, no rows). It contains no user
records, no password hashes and no credentials, so it is safe in this public
repository.

Tables: `users`, `submissions`, `repository`, `publications`, `researchers`,
`ethics`, `events_module`, `event_abstracts`, `event_registrations`,
`innovation_extension`, `inquiries`, `notifications`, `direct_messages`,
`system_logs`.

`server/init-db.sql` is the canonical schema. The API applies it automatically
on every boot to the database named by `DB_NAME` (every statement is
`CREATE TABLE IF NOT EXISTS`, so it is safe to run every deploy). The commands
below are for doing it by hand.

## Create the tables on a hosted MySQL

```bash
# Any MySQL 8 / MariaDB 10.4+ works: Railway MySQL, Aiven, TiDB Cloud, or a VPS.
mysql -h <HOST> -P <PORT> -u <USER> -p <DATABASE> < db/schema.sql
```

Windows (XAMPP client):

```bash
"C:\xampp\mysql\bin\mysql.exe" -h <HOST> -P <PORT> -u <USER> -p <DATABASE> < db/schema.sql
```

Then point the API at that database with `DB_HOST`, `DB_PORT`, `DB_USER`,
`DB_PASSWORD`, `DB_NAME`. `npm run check:api` against the API will report
`db up` once the connection works.

## The first admin account is created automatically

On boot the API creates an admin when the `users` table has no admin row, using
`ADMIN_EMAIL` and `ADMIN_PASSWORD`. If `ADMIN_PASSWORD` is not set it generates a
random one and prints it **once** in the server log:

```
[seed] Default admin created — username: admin
[seed] ADMIN_PASSWORD was not set, so this one-time password was generated: <random>
```

Sign in with that account and change the password (Admin Console → Users →
Reset password, or set `ADMIN_PASSWORD` in the host's environment and delete the
row so it is recreated).

## Copying your real data across (private)

`schema.sql` intentionally carries no rows. To move your actual records, run the
dump yourself and keep the file **out of Git** — it contains real email
addresses and password hashes:

```bash
"C:\xampp\mysql\bin\mysqldump.exe" -u root --no-tablespaces --single-transaction cpri > cpri-data.sql
# import
mysql -h <HOST> -P <PORT> -u <USER> -p <DATABASE> < cpri-data.sql
```

`.gitignore` does not track `*.sql` files automatically, so if you create one,
do not `git add` it.

`server/data/*.json` (site profile, announcements, events, agenda, research
content) is served from the filesystem, not MySQL. The tracked files in
`server/data/` travel with a deploy; uploads under `public/assets/uploads/` do
not, so copy that folder to the host or move it to object storage.
