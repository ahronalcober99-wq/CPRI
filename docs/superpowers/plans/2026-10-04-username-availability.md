# Username Availability and Suggestions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add case-insensitive live username availability checks and suggestions to registration, while enforcing the same username rules on the server and handling concurrent registrations safely.

**Architecture:** Put normalization, validation, and suggestion-candidate construction in `server/utils/username.js`. A public, rate-limited router will query MySQL through the existing parameterized query helpers; the existing registration route will reuse the shared validator and repeat username/email checks before insert. The registration page will use the existing `CPRI.apiFetch` transport for debounced checks and suggestions.

**Tech Stack:** Node.js 18+, Express 4, express-rate-limit, MySQL/TiDB, plain HTML/CSS/JavaScript, Node's built-in `node:test`.

## Global Constraints

- Normalize usernames by trimming and lowercasing before validation, availability queries, and persistence.
- Valid usernames are 4–20 ASCII characters, start with an ASCII letter, contain only ASCII letters, digits, dots, or underscores, and contain no consecutive dots or underscores.
- Use parameterized SQL for every username query; only construct placeholder marks from candidate counts.
- Check username candidates in batched `LOWER(username) IN (...)` queries and return no user/account details.
- Rate-limit the public check endpoint to 30 requests per minute per IP.
- Debounce valid frontend checks by 500 ms and abort checks after 15 seconds; stale responses must not update the UI.
- Network errors must not block registration; taken or invalid usernames must block submission.
- Do not add dependencies, run production SQL, commit, or push.
- Preserve existing uncommitted work outside the username feature.

---

## File map

- Create `server/utils/username.js` for normalized validation and deterministic/random suggestion candidate construction.
- Create `server/username.js` for the public `GET /api/username/check` endpoint and its endpoint-specific limiter.
- Modify `server/server.js` to mount the new public router; existing CORS already allows the GitHub Pages origin and GET.
- Modify `server/auth.js` to use shared validation, normalize stored usernames, separate username/email duplicate checks, and map duplicate-key races to HTTP 409.
- Modify `public/register.html` to render username status/rules/chips and run checks through the existing `CPRI.apiFetch`.
- Create `server/dev/test-username.mjs` with built-in Node tests for helper behavior, route behavior using injected query stubs, and rate limiting. Registration remains coupled to the existing auth/session and database flow, so cover its DB-dependent cases in the manual integration checklist if no local test database is available.
- No database schema file is changed: repository schemas already declare a unique username index. Live Render/TiDB index and collation could not be inspected because the local database connection was refused.

### Task 1: Creating shared username normalization and candidate helpers

**Files:**
- Create: `server/utils/username.js`
- Create: `server/dev/test-username.mjs`

**Interfaces:**
- Produces `normalizeUsername(value)`, returning a trimmed lowercase string.
- Produces `validateUsername(value)`, returning `{ valid: true, username }` or `{ valid: false, username, reason, message }`.
- Produces `buildUsernameCandidates(username, fullName, year, randomSuffixes)`, returning deduplicated candidate strings. `fullName` contributes the final whitespace-delimited name token: `username="ahron"` and `fullName="Ahron Alcober"` produce `ahron_alcober`. `randomSuffixes` is a list of generated four-character lowercase-alphanumeric suffixes supplied by the route.

- [ ] **Step 1: Add built-in tests for normalization and each validation rule**

Add tests in `server/dev/test-username.mjs` using `node:test` and `node:assert/strict`. Cover trimming/lowercasing, lengths 3/4/20/21, leading digit, illegal characters, repeated dots, repeated underscores, and valid mixed punctuation.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsername, validateUsername, buildUsernameCandidates } from '../utils/username.js';

test('normalizes by trimming and lowercasing', () => {
  assert.equal(normalizeUsername('  Ahron_2  '), 'ahron_2');
});

test('enforces all username rules with specific reasons', () => {
  assert.equal(validateUsername('abc').reason, 'too_short');
  assert.equal(validateUsername('abcd').valid, true);
  assert.equal(validateUsername('a'.repeat(20)).valid, true);
  assert.equal(validateUsername('a'.repeat(21)).reason, 'too_long');
  assert.equal(validateUsername('2abc').reason, 'start');
  assert.equal(validateUsername('abc-1').reason, 'characters');
  assert.equal(validateUsername('ab..cd').reason, 'repeated_dot');
  assert.equal(validateUsername('ab__cd').reason, 'repeated_underscore');
  assert.equal(validateUsername('Ahron_2.test').username, 'ahron_2.test');
});

test('builds normalized full-name, cpri, year, and random candidates', () => {
  assert.deepEqual(
    buildUsernameCandidates('Ahron', 'Ahron Alcober', 2026, ['z9q2']),
    ['ahron_alcober', 'ahron.cpri', 'ahron_cpri26', 'ahron.z9q2']
  );
});
```

- [ ] **Step 2: Run tests and confirm the helper is not implemented yet**

Run: `node --test server/dev/test-username.mjs`

Expected: FAIL because `server/utils/username.js` does not exist yet.

- [ ] **Step 3: Implement the shared helper**

Use a single ordered validator so invalid inputs report one consistent display message. The valid shape is:

```js
const username = normalizeUsername(value);
if (username.length < 4) return invalid('too_short', 'Username must be at least 4 characters.');
if (username.length > 20) return invalid('too_long', 'Username must be no more than 20 characters.');
if (!/^[a-z]/.test(username)) return invalid('start', 'Username must start with a letter.');
if (!/^[a-z0-9._]+$/.test(username)) return invalid('characters', 'Use only letters, numbers, dot and underscore.');
if (/\.\./.test(username)) return invalid('repeated_dot', 'Username cannot contain consecutive dots.');
if (/__/.test(username)) return invalid('repeated_underscore', 'Username cannot contain consecutive underscores.');
return { valid: true, username };
```

Construct the full-name candidate as `${username}_${lastNameToken}` after lowercasing and replacing any non-alphanumeric characters in that final token with nothing. Add `.cpri`, `_cpri${twoDigitYear}`, and `${username}.${suffix}` candidates in that order. Deduplicate candidates and retain only candidates that pass `validateUsername`.

- [ ] **Step 4: Run the helper tests**

Run: `node --test server/dev/test-username.mjs`

Expected: PASS for normalization, each rule, and candidate ordering/filtering.

- [ ] **Step 5: Extend helper tests for candidate filtering**

Verify that an invalid full-name-derived candidate is omitted, duplicate candidates are returned once, and every result passes `validateUsername`.

Run: `node --test server/dev/test-username.mjs`

Expected: PASS; candidate helper output contains only valid, unique normalized names.

### Task 2: Adding the public rate-limited check route and hardening registration

**Files:**
- Create: `server/username.js`
- Modify: `server/server.js`
- Modify: `server/auth.js`
- Test: `server/dev/test-username.mjs`

**Interfaces:**
- Consumes `normalizeUsername`, `validateUsername`, and `buildUsernameCandidates` from Task 1.
- Produces `createUsernameRouter({ getQuery, allQuery, randomSuffix })` for injected query/random stubs in tests and a production `usernameRouter`, mounted at `/api/username`, with public `GET /check`.
- `GET /api/username/check` accepts `username` and optional `fullName`; it returns exactly `{ available: true }`, `{ available: false, reason: "invalid", message }`, or `{ available: false, reason: "taken", suggestions }`.
- Registration stores the normalized lowercase username and returns HTTP 409 `{ error: "That username is already taken. Try another." }` for an existing name or `ER_DUP_ENTRY` raised by the insert.

- [ ] **Step 1: Add route/helper contract tests before implementation**

Extend the Node test script with focused cases for HTTP response shapes and candidate filtering. The test harness should exercise an Express router with stubbed query results rather than require a live database; factor the route construction as `createUsernameRouter({ getQuery, allQuery, randomSuffix })`, defaulting those dependencies to the existing query helpers and a cryptographic suffix generator in production. Use an isolated in-memory store in the test to confirm SQL parameters are normalized and candidate lookups are batched.

Expected assertions:

```js
const api = await startTestApi({
  getQuery: async (sql, params) => {
    recordedCalls.push({ sql, params });
    return params[0] === 'taken' ? { id: 'existing-user' } : null;
  },
  allQuery: async (sql, params) => {
    recordedCalls.push({ sql, params });
    return [];
  },
  randomSuffix: () => 'ab12'
});
try {
  assert.deepEqual(await getJson(api.url + '/check?username=%20BAD-USER%20'), {
    status: 200,
    body: { available: false, reason: 'invalid', message: 'Use only letters, numbers, dot and underscore.' }
  });
  assert.deepEqual(await getJson(api.url + '/check?username=Free_Name'), {
    status: 200,
    body: { available: true }
  });
  recordedCalls.length = 0;
  const taken = await getJson(api.url + '/check?username=taken&fullName=Ahron%20Alcober');
  assert.equal(taken.status, 200);
  assert.equal(taken.body.reason, 'taken');
  assert.equal(recordedCalls[0].params[0], 'taken');
  assert.equal(recordedCalls.filter(call => call.sql.includes('LOWER(username) IN')).length, 1);
  assert.deepEqual(recordedCalls.at(-1).params, ['taken_alcober', 'taken.cpri', 'taken_cpri26', 'taken.ab12']);
} finally {
  await api.close();
}
```

Define these test helpers in `server/dev/test-username.mjs`:

```js
import express from 'express';
import { once } from 'node:events';
import { createUsernameRouter } from '../username.js';

async function startTestApi(dependencies) {
  const app = express();
  app.use('/api/username', createUsernameRouter(dependencies));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/api/username`,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    })
  };
}

async function getJson(url) {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}
```

Configure the route factory's `randomSuffix` stub to return `ab12` so the candidate batch is deterministic.

- [ ] **Step 2: Run endpoint tests and confirm they fail before implementation**

Run: `node --test server/dev/test-username.mjs`

Expected: FAIL because the route factory is not implemented.

- [ ] **Step 3: Implement the public check router**

Create an endpoint-specific limiter with `windowMs: 60_000`, `limit: 30`, standard rate-limit headers, and no legacy headers. Generate each production suffix from four independently selected characters in `abcdefghijklmnopqrstuvwxyz0123456789` using `crypto.randomInt`; injected `randomSuffix` makes tests deterministic. Use `getQuery('SELECT id FROM users WHERE LOWER(username) = ?', [normalized])` for the initial lookup. On a taken name, build and validate the initial suggestions, then fetch enough random four-character suffixes to fill the candidate batch. Use one `allQuery('SELECT username FROM users WHERE LOWER(username) IN (?, ...)', candidates)` query per batch; derive placeholders from the count only and bind every candidate. Return at most four suggestions not present in the case-insensitive result set; make no more than five candidate batches. Never return account data.

- [ ] **Step 4: Mount the route and run route tests**

Import `usernameRouter` in `server/server.js` and mount it as `app.use('/api/username', usernameRouter);` alongside the existing API routers. Keep it public (no auth middleware). Confirm existing CORS answers the GitHub Pages preflight with GET and credentials. Run:

```powershell
node --check server/username.js
node --check server/server.js
node --test server/dev/test-username.mjs
```

Expected: syntax checks and all route tests pass; request stubs observe only parameterized SQL and batched candidate lookups.

- [ ] **Step 5: Verify the route-specific rate limit**

Create a fresh test API instance with a free-name query stub and send 31 valid check requests from the same local client within one minute. Assert the first 30 return the endpoint's normal 200 response and request 31 returns 429. Close the server in `finally`.

- [ ] **Step 6: Enforce shared validation, uniqueness, and duplicate-race behavior**

In `server/auth.js`, import the helper. Validate and normalize the submitted username before database writes. Replace the combined `SELECT id` lookup with separate parameterized username and email lookups so each conflict is identified correctly:

```js
const normalizedUsername = normalizeUsername(username);
const usernameResult = validateUsername(username);
if (!usernameResult.valid) return res.status(400).json({ error: usernameResult.message });
const existingUsername = await get('SELECT id FROM users WHERE LOWER(username) = ?', [normalizedUsername]);
if (existingUsername) return res.status(409).json({ error: 'That username is already taken. Try another.' });
const existingEmail = await get('SELECT id FROM users WHERE LOWER(email) = ?', [String(email).trim().toLowerCase()]);
if (existingEmail) return res.status(409).json({ error: 'Email already registered.' });
```

Set the user object's `username` to `normalizedUsername`. Catch only the insert failure needed to map `err.code === 'ER_DUP_ENTRY'` to the same username-taken 409; rethrow every other error to the existing Express error handling. The unique index remains the concurrency authority.

- [ ] **Step 7: Run backend validation**

Run:

```powershell
node --check server/auth.js
node --check server/username.js
node --check server/server.js
node --test server/dev/test-username.mjs
git diff --check
```

Expected: all checks pass. Inspect the test/query assertions to confirm values are bound as parameters and username values are normalized before both reads and writes.

### Task 3: Adding live availability UI, suggestions, and registration guards

**Files:**
- Modify: `public/register.html`

**Interfaces:**
- Consumes `GET /api/username/check` from Task 2 through `CPRI.apiFetch(path, options)`, which uses the configured Render API base and `credentials: 'include'`.
- Sends `username` and optional `fullName` as encoded query parameters.
- Updates the registration form's username input, message line, rules, and suggestion chips without changing the email-verification behavior.

- [ ] **Step 1: Add the accessible username status and rule elements**

Immediately under the Username input, add a message element with `aria-live="polite"`, a suggestion-chip container, and indicators for minimum/maximum length, allowed characters, and leading letter. Give each chip `type="button"` and an `aria-label` that says it will use that username. Add field-state classes using existing CSS variables (`--cpri-success`, `--cpri-danger` or existing error token, `--cpri-accent`, `--cpri-border`) rather than hard-coded light-mode colors.

- [ ] **Step 2: Add local validation, rule indicators, debounce, and timeout**

On username input, cancel the pending debounce and abort the previous request. Normalize locally for checks; show the exact validator message without a request when invalid. For valid input, update all three rule indicators, wait 500 ms, then call `CPRI.apiFetch('/api/username/check?...', { method: 'GET', credentials: 'include', signal })` with an `AbortController` timeout of 15 seconds and a monotonically increasing request id. Update the DOM only if that request id is still current. Render a small spinner with `Checking...`, a green border/check icon with `<username> is available`, a red border with `That username is already taken. Try one of these:` and its chips, and the exact validation text for invalid input. Network/timeout failures use a neutral style and the message `Couldn't check right now. We'll check again when you submit.`; they must not set a blocking state. Clear the timeout when the request finishes and refresh suggestions if Full Name changes while the username is taken.

- [ ] **Step 3: Render taken suggestions and wire chip selection**

For `reason: "taken"`, show `That username is already taken. Try one of these:` and create each suggestion chip with DOM text properties (not interpolated HTML). Clicking a chip copies its candidate into the username field and dispatches the same input flow so validation is rerun. Include the current Full Name value in each check request when non-empty.

- [ ] **Step 4: Guard submit and refresh suggestions on a 409**

Prevent submit immediately for current invalid/taken states. If a debounced check is pending, await the current check before allowing a known taken/invalid value through; if the check fails due to network/timeout, continue to the normal registration request. Send the normalized username in registration data. When registration returns HTTP 409 for a username conflict, show the taken state and issue a fresh availability request to populate current suggestions. Keep existing email verification and password validation behavior intact.

- [ ] **Step 5: Verify browser script syntax and focused source behavior**

Extract the inline script from `public/register.html` to a temporary file outside the repository and run `node --check` on it, then remove the temporary file. Also run:

```powershell
node --test server/dev/test-username.mjs
git diff --check
```

Manually verify the rendered registration page with:

1. An existing username shows taken plus only free suggestions.
2. An available username shows the green available state.
3. Too-short, leading-number, illegal-character, repeated-dot, and repeated-underscore values show the specific invalid rule without network calls.
4. Uppercase input is checked and submitted in lowercase.
5. Clicking a chip fills and rechecks that candidate.
6. Typing rapidly never lets an older response replace the newest state.
7. A slow request times out after 15 seconds and shows the neutral network message.
8. Submit is blocked for known taken/invalid values but proceeds after a network failure.
9. A registration conflict from a second browser tab returns 409 and refreshes suggestions.
10. With a local database and verified email state available, two simultaneous registrations for the same username yield at most one successful insert; the other gets HTTP 409. If no local database is available, report that this race test requires post-deployment/manual verification and confirm the unique-index insert catch by code inspection.

## Completion checks

- Confirm the SQL contains no interpolated username values and that username normalization is applied identically in the availability route and registration route.
- Confirm `express-rate-limit` rejects the 31st check request within a one-minute window from the same client IP.
- Confirm production CORS still allows the configured GitHub Pages origin and GET preflight; no CORS change is needed.
- Do not provide an index-creation SQL statement based solely on repository DDL. The live Render/TiDB metadata could not be queried; report this limitation and provide duplicate-detection/index SQL only if production inspection confirms the unique index is absent.
- Do not commit or push any changes.
