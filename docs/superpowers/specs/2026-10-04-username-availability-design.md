# Username Availability and Suggestions Design

## Goal

Provide live, case-insensitive username availability feedback and useful
suggestions during registration while preserving server-side validation and
database uniqueness as the final authority.

## Existing state

The MySQL users table stores `username VARCHAR(80)`. The repository's MySQL
schema declares a unique username index and defaults to `utf8mb4_unicode_ci`;
the PostgreSQL-oriented schema/migration also declare a unique index. The
existing register route checks case-insensitively but saves the submitted
trimmed casing and does not enforce the desired username format. The local
database was unavailable for metadata inspection, so the live Render/TiDB
index and collation remain unverified.

Production CORS already allowlists the GitHub Pages origin. `express-rate-limit`
is already installed and the API is behind a global limiter.

## Shared validation and normalization

Create a small shared helper module at `server/utils/username.js`. It exports
normalization, validation, and suggestion-candidate helpers used by the public
check route and registration route. Normalize with trim plus lowercase.
Accept only 4–20 characters, require a leading ASCII letter, allow only ASCII
letters/digits/dot/underscore, and reject consecutive dots or underscores.
Return a distinct, user-displayable validation message for each failing rule.

Registration stores the normalized username and repeats validation and
case-insensitive uniqueness checking immediately before insert. The database
unique index remains the race-condition authority; catch MySQL/TiDB
`ER_DUP_ENTRY` from insertion and return HTTP 409 with the requested
username-taken message.

## Public check endpoint

Add `GET /api/username/check?username=...` in a dedicated username route
module, mounted from `server/server.js`. Apply an express-rate-limit limiter
of 30 requests per minute keyed by the trusted request IP. Invalid input
returns `{ available: false, reason: "invalid", message }`; valid free input
returns `{ available: true }`; a taken input returns
`{ available: false, reason: "taken", suggestions: [...] }`. Do not return
account details.

Use parameterized lookups only. To compare case-insensitively regardless of
the actual database collation, query `LOWER(username) = ?` for the requested
value. When taken, form base suggestions from the normalized username plus
the usable full-name token, `.cpri`, `_cpri` plus the current year's last two
digits, and a four-character random lowercase-alphanumeric suffix. Filter
each through the same validator. Check each batch using one parameterized
`LOWER(username) IN (?, ...)` lookup and return only free candidates. If fewer
than four are free, generate more randomized candidates and batch-check up to
five attempts. Return at most four suggestions.

## Registration UI

Update `public/register.html` beneath the Username field with an
`aria-live="polite"` message, suggestion chips with accessible labels, and
three rule indicators. Keep the existing form style and use project accent
tokens so the field works in dark mode.

Validate locally on each input. Debounce valid checks by 500 ms, abort the
previous request, and use a 15-second abort timeout. Stale responses must
never replace a newer state. Show checking, available, taken, invalid, and
neutral network-error states with matching field borders and icons. Network
errors do not block submission. Clicking a suggestion fills the field and
restarts validation. Send the optional full name when available.

Block submission while the latest username state is invalid or taken. If
registration returns HTTP 409 for a username collision, display the same
taken message and refresh suggestions. Server-side validation and the unique
index remain mandatory regardless of frontend state.

## Database and deployment

No schema change is planned because repository schema files declare a unique
username index and case-insensitive collation. Do not run production SQL. If
Render/TiDB inspection later shows the index is missing, first identify
case-insensitive duplicates using a grouped `LOWER(username)` query; only
after those are resolved should a unique index be added.

## Validation

Test each validation rule, normalization, taken/free lookups, suggestion
filtering and batch queries, rate-limit behavior, duplicate insert races,
credential-free public responses, API CORS, frontend debounce and stale
response handling, timeout, suggestion selection, and submit behavior. Report
whether production schema inspection was available and provide SQL only if
the live schema is confirmed to lack the unique index.
