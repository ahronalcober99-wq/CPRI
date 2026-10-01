# Render MySQL Configuration Design

## Goal

Allow the CPRI Node.js API to connect to the deployed MySQL service on Render
instead of attempting a local connection, while retaining XAMPP defaults for
local development.

## Design

- Load the repository `.env` only when `NODE_ENV` is not `production`. A small
  bootstrap module will run before server modules initialize, so pool settings
  see the loaded local values.
- Configure the sole application MySQL pool from `DB_HOST`, `DB_PORT`,
  `DB_USER`, `DB_PASSWORD`, and `DB_NAME`. Convert the port to a number and
  retain `localhost`, `3306`, `root`, an empty password, and `cpri` as local
  defaults.
- Add `ssl: { rejectUnauthorized: true }` only when `DB_SSL` is exactly
  `"true"`.
- Keep the existing server port behavior, which already honors a valid
  `process.env.PORT` and otherwise uses `3000`.
- Keep `.env` ignored; add the `DB_SSL` placeholder to the existing
  `.env.example` and expose the optional setting through the Render blueprint.

## Scope and validation

Do not alter local-only localhost references in docs and developer tools or
change unrelated application behavior. Verify the changed configuration and
run the smallest available checks for the server startup/configuration.
