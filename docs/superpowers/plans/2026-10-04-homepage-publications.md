# Homepage Publications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show published database publications on the homepage with counts, staff-curated ordering, local filters, responsive cards, and reliable loading/error states.

**Architecture:** Add a narrow public featured-publications router that returns published-only homepage fields and counts, with a 60-second in-memory cache. Add a `featured` field to the canonical MySQL schema and enforce staff-only, six-slot curation in the existing publication form/API. Replace homepage research-content rendering with safe DOM-based publication cards and client-side faculty/student filters.

**Tech Stack:** Node.js 18+, Express 4, MySQL/TiDB via mysql2, built-in `node:test`, HTML/CSS/JavaScript, existing `CPRI.apiFetch` transport.

## Global Constraints

- Return only rows with `status = 'published'`; compute all response counts from published rows only.
- Default `limit` to 6, accept only integer values from 1 through 12, and return HTTP 400 for invalid limits.
- Sort featured rows first, then newest publication year, then newest creation date.
- The homepage API response may expose only `id`, `title`, `authors`, `venue`, `year`, `type`, `level`, and `link` for each item, plus published `total`, `faculty`, and `student` counts.
- Cache responses in process for 60 seconds and invalidate the cache after publication create, update, or delete.
- Only `admin` and `cpri_staff` can change `featured`; never allow more than six featured publications, including concurrent staff changes.
- Only published publications may be featured; clear `featured` if a record changes to another status.
- Do not run SQL against Render/TiDB, commit, or push.
- Render API-controlled text using DOM `textContent`; allow only HTTP(S) external links and use `rel="noopener noreferrer"` for new tabs.
- Use the existing CPRI API base/credentials transport and theme variables; preserve unrelated worktree changes.

---

## File map

- Create `server/featured-publications.js`: public route factory, input validation, aggregate/list queries, output mapping, 60-second cache, and cache invalidation export.
- Create `server/publication-feature-service.js`: transaction-based create/update logic that enforces the six-featured cap and clears feature flags when records become unpublished.
- Modify `server/server.js`: mount the new route before the general publications router.
- Modify `server/publications.js`: restrict feature-flag writes to staff/admin, enforce the six-item limit transactionally, clear flags on unpublish, and invalidate cached homepage data on publication mutations.
- Modify `server/server/db/queries.js`: expose a connection-scoped transaction helper for the feature cap lock and writes.
- Modify `server/init-db.sql`: add the `featured` default-zero column to the canonical MySQL schema.
- Modify `db/schema.sql`: keep the MySQL structure mirror in sync.
- Create `server/dev/test-featured-publications.mjs`: built-in tests using injected query and transaction functions; no live TiDB credentials required.
- Modify `public/index.html`: replace the topic toolbar and research-card mount point with homepage publications stats, filters, card grid, loading/error/empty states, and existing section structure.
- Modify `public/assets/css/styles.css`: add scoped responsive styles, card clamps, skeletons, chips, and badges using existing theme variables.
- Leave `db/schema.ts` and `netlify/database/migrations/` unchanged: `drizzle.config.ts` identifies that migration stream as PostgreSQL, while `server/init-db.sql` is documented as the active MySQL/TiDB schema.

### Task 1: Adding the featured field and transactional query helper

**Files:**
- Modify: `server/init-db.sql` (publications table)
- Modify: `db/schema.sql` (publications table)
- Modify: `server/server/db/queries.js`
- Test: `server/dev/test-featured-publications.mjs`

**Interfaces:**
- Produces `withTransaction(callback)` from the query helper module. The callback receives `{ all(sql, params), get(sql, params), run(sql, params) }` bound to one MySQL connection; it commits on success, rolls back on errors, releases the connection in `finally`, and rethrows errors.
- Adds `featured TINYINT NOT NULL DEFAULT 0` to both MySQL schema definitions.
- Does not apply schema changes to the live database.

- [ ] **Step 1: Add transaction-helper tests with a mock connection**

Create `server/dev/test-featured-publications.mjs` with `node:test` and `node:assert/strict`. To test the transaction contract without connecting to MySQL, extract a small `runTransaction(pool, callback)` helper in `server/server/db/queries.js` and export it for tests. Supply a fake pool whose connection records `beginTransaction`, `commit`, `rollback`, and `release` calls.

```js
test('transaction commits successful work and always releases its connection', async () => {
  const calls = [];
  const result = await runTransaction(fakePool(calls), async ({ get }) => {
    await get('SELECT id FROM publications WHERE id = ?', ['pub-1']);
    return 'saved';
  });
  assert.equal(result, 'saved');
  assert.deepEqual(calls, ['begin', ['query', 'SELECT id FROM publications WHERE id = ?', ['pub-1']], 'commit', 'release']);
});

test('transaction rolls back and rethrows a query failure', async () => {
  const calls = [];
  await assert.rejects(
    runTransaction(fakePool(calls), async ({ run }) => run('UPDATE publications SET featured = ? WHERE id = ?', [1, 'pub-1'])),
    /database failure/
  );
  assert.ok(calls.includes('rollback'));
  assert.ok(calls.includes('release'));
});
```

Define the mock used by those tests in the same file:

```js
function fakePool(calls) {
  return {
    async getConnection() {
      return {
        async beginTransaction() { calls.push('begin'); },
        async query(sql, params) {
          calls.push(['query', sql, params]);
          if (sql.startsWith('UPDATE')) throw new Error('database failure');
          return [[{ id: 'pub-1' }], []];
        },
        async commit() { calls.push('commit'); },
        async rollback() { calls.push('rollback'); },
        release() { calls.push('release'); }
      };
    }
  };
}
```

- [ ] **Step 2: Run transaction tests and confirm they fail**

Run: `node --test server/dev/test-featured-publications.mjs`

Expected: FAIL because `runTransaction` and the test connection factory do not exist yet.

- [ ] **Step 3: Implement connection-scoped transactions**

Implement `runTransaction(pool, callback)` using `pool.getConnection()`, `beginTransaction()`, `commit()`, `rollback()`, and `release()`. Build callback query functions that apply existing `toDbParams` and `parseRow` behavior, matching `all`, `get`, and `run`. Export `withTransaction(callback)` that calls `runTransaction(pool, callback)`.

```js
export async function withTransaction(callback) {
  return runTransaction(pool, callback);
}
```

Do not swallow rollback errors in place of the original operation error; retain the operation failure as the thrown error and always release the connection.

- [ ] **Step 4: Add the default-off column to both MySQL DDL files**

Add `featured TINYINT NOT NULL DEFAULT 0` adjacent to `status` in the `publications` definition in `server/init-db.sql` and `db/schema.sql`. Keep the two MySQL definitions equivalent. Do not edit PostgreSQL Drizzle migration files.

- [ ] **Step 5: Run transaction and schema checks**

Run:

```powershell
node --test server/dev/test-featured-publications.mjs
node --check server/server/db/queries.js
git diff --check
```

Expected: transaction tests pass for commit, rollback, error propagation, and release; syntax and whitespace checks pass.

### Task 2: Exposing the cached published-publications endpoint

**Files:**
- Create: `server/featured-publications.js`
- Modify: `server/server.js`
- Test: `server/dev/test-featured-publications.mjs`

**Interfaces:**
- Produces `createFeaturedPublicationsRouter({ allQuery, getQuery, now })` for deterministic tests and `featuredPublicationsRouter` for production.
- Produces `invalidateFeaturedPublicationsCache()` for publication write routes.
- Public `GET /api/publications/featured?limit=N` returns `{ items, counts }`, where each item has exactly `{ id, title, authors, venue, year, type, level, link }` and counts has `{ total, faculty, student }`.

- [ ] **Step 1: Add failing endpoint tests for limits, fields, counts, and query bindings**

Use a temporary Express server as in the existing `server/dev/test-username.mjs` pattern. Inject fake query functions and a clock. Have the fake count query return published count rows and the fake list query return fixtures containing internal fields; verify those internal fields do not reach the API response.

```js
assert.deepEqual(await getJson(`${api.url}/featured`), {
  status: 200,
  body: {
    items: [{
      id: 'p1', title: 'Study', authors: 'A. Author', venue: 'Journal',
      year: '2026', type: 'faculty', level: 'international',
      link: 'https://example.org/paper'
    }],
    counts: { total: 2, faculty: 1, student: 1 }
  }
});
assert.deepEqual(await getJson(`${api.url}/featured?limit=0`), {
  status: 400,
  body: { error: 'limit must be an integer from 1 to 12.' }
});
assert.ok(recordedQueries.every(query => !query.sql.includes('p1')));
```

- [ ] **Step 2: Run endpoint tests and confirm they fail**

Run: `node --test server/dev/test-featured-publications.mjs`

Expected: FAIL because the route factory is not implemented.

- [ ] **Step 3: Implement limit parsing, mapping, ordering, and published counts**

Accept no limit as 6; accept integer query values 1 through 12; return 400 for arrays, nonnumeric strings, decimals, zero, negative values, or values above 12. Query counts using a parameterized `status = ?` condition with `published` bound. Query item rows using `status = ?`, order by `featured DESC`, `LEFT(publicationDate, 4) DESC`, then `createdAt DESC`, and bind the validated limit. Map `authorType` to `faculty`, `student`, or `other`; map `pubType` local/national/international journal values to their level labels and all other values to `other`. Prefer a safe HTTP(S) `publicationLink`, then an HTTP(S) DOI URL or bare DOI normalized as `https://doi.org/<identifier>`, then the published-PDF proof API route when available; otherwise return an empty `link`. The proof-document details are used only to build that route and are never returned. Select and serialize no submitter details, volume, pages, or status.

- [ ] **Step 4: Add a 60-second cache and invalidation API**

Keep a `Map` keyed by validated limit with `{ expiresAt, body }` values. Inject `now()` to make cache expiry testable. Reuse an unexpired response; after expiry, rerun both published counts and list queries. Export `invalidateFeaturedPublicationsCache()` to clear the map.

- [ ] **Step 5: Mount the route ahead of the general publications route**

In `server/server.js`, mount `app.use('/api/publications', featuredPublicationsRouter)` before `app.use('/api/publications', publicationsRouter)`. The route remains public; existing CORS already accepts GET from GitHub Pages and same-origin Render requires no CORS changes.

- [ ] **Step 6: Test ordering, published-only filtering, and cache behavior**

Extend the injected-query tests to assert both SQL queries bind `published`, the list query's last parameter is the validated limit, featured/year/date sort terms appear in the SQL, and only the declared response keys are present. Call the endpoint twice before expiry and once after advancing the fake clock by 60,001 ms; assert two total count/list query pairs. Invalidate the cache and assert the next request fetches again.

- [ ] **Step 7: Run endpoint tests and syntax checks**

Run:

```powershell
node --test server/dev/test-featured-publications.mjs
node --check server/featured-publications.js
node --check server/server.js
git diff --check
```

Expected: every endpoint, privacy-shape, ordering, limit, and cache assertion passes.

### Task 3: Adding staff-only homepage curation and the six-item cap

**Files:**
- Create: `server/publication-feature-service.js`
- Modify: `server/publications.js`
- Modify: `public/publication-form.html`
- Test: `server/dev/test-featured-publications.mjs`

**Interfaces:**
- Consumes `withTransaction(callback)` from Task 1 and `invalidateFeaturedPublicationsCache()` from Task 2.
- Produces `createPublicationFeatureService({ withTransaction })`, whose returned `create(record)` and `update(id, changes)` methods enforce feature/status rules in one transaction and return the updated record or a typed not-found/limit/unpublished result.
- The `featured` flag is written only by `admin`/`cpri_staff`, only for published rows, with no more than six featured rows at any time.
- Owners retain existing publication edit permissions for other fields; they cannot change `featured`.

- [ ] **Step 1: Add failing authorization and capacity tests**

Test the injected `createPublicationFeatureService({ withTransaction })` using a fake transactional store in `server/dev/test-featured-publications.mjs`. Its `create(record)` and `update(id, changes)` methods receive values after route-level role authorization. Assert creating or updating to a seventh featured record returns the limit result; disabling a feature works; already-featured records can be updated while the count is six; a non-published record cannot be featured; and changing a featured record's status away from Published clears its flag in the same transaction. Simulate serialized concurrent transactions and assert only six updates can enable the flag. Separately assert the HTTP routes reject nonstaff `featured` changes with 403.

- [ ] **Step 2: Run feature-cap tests and confirm they fail**

Run: `node --test server/dev/test-featured-publications.mjs`

Expected: FAIL because the feature service and server-side capacity checks do not exist.

- [ ] **Step 3: Implement transactional feature assignment**

In `server/publication-feature-service.js`, implement the service factory. For `create(record)` and `update(id, changes)`, acquire `SELECT id FROM publications FOR UPDATE` within the transaction before checking or changing featured state. Read the target record inside that transaction, compute its effective status and feature flag, require Published when enabling, and count current featured rows excluding the target id. Reject a new seventh feature with `{ ok: false, reason: 'limit' }`; reject a non-published target with `{ ok: false, reason: 'unpublished' }`. A status change away from Published clears the feature flag in the same write. Bind every value; the locking read uses no input. Return `{ ok: true, publication }` on success and `{ ok: false, reason: 'not_found' }` for a missing row. An already-featured row may be edited while the count is six without consuming another slot.

- [ ] **Step 4: Guard create and patch paths**

For create, accept `featured` only from staff/admin; initialize it to 0 for everyone else and reject unauthorized attempts to set it. For patch, if a request includes `featured`, reject nonstaff users with HTTP 403. Owners may still update other permitted fields. Route creates and patches through the feature service so status changes and flag changes are atomic; call `invalidateFeaturedPublicationsCache()` after successful create, update, or delete. Map `reason: 'limit'` to HTTP 409 with `Only six publications can be featured on the homepage.`, `reason: 'unpublished'` to HTTP 400 with `Only published publications can be featured.`, and `reason: 'not_found'` to HTTP 404. Return the updated publication management response as before.

- [ ] **Step 5: Add the staff/admin checkbox and save it through the existing form**

In `public/publication-form.html`, add a checkbox named `featured` with label “Feature on homepage” and a note that up to six published items can be featured. In the existing `/api/auth/me` initialization, show the checkbox only for `admin` or `cpri_staff`; when editing, initialize it from `publication.featured`. Serialize it as a boolean (not `FormData`’s `"on"` string) when submitting. If the API responds with HTTP 409 at the six-item limit, show the server message next to the form; do not silently reset or discard the user's other edits.

- [ ] **Step 6: Run capacity, permission, and mutation checks**

Run the focused tests and verify:

```powershell
node --test server/dev/test-featured-publications.mjs
node --check server/publications.js
node --check server/server/db/queries.js
git diff --check
```

Expected: staff/admin can feature at most six published records; owners cannot change the flag; unpublishing clears it; successful changes invalidate the cache.

### Task 4: Rendering publications on the homepage

**Files:**
- Modify: `public/index.html`
- Modify: `public/assets/css/styles.css`

**Interfaces:**
- Consumes `/api/publications/featured?limit=6` through `CPRI.apiFetch`.
- Uses only response `{ items, counts }`; filters Faculty/Student locally without additional requests.
- Renders cards, counts, skeleton/loading hint, empty state, and retry state using text-safe DOM APIs.

- [ ] **Step 1: Replace the old toolbar and research-card mount point**

Keep the existing section id, title, and subtitle. Replace `#researchToolbar` with the count line `<total> published publications · <faculty> faculty · <student> student`, an accessible filter group containing All, Faculty, Student, and a “View all N publications” link. Replace the existing research card mount with an aria-live status region and a grid mount. Keep loading/error/empty messages in dedicated text nodes.

- [ ] **Step 2: Add scoped responsive CSS using existing tokens**

In `public/assets/css/styles.css`, define the publication grid with `repeat(auto-fit, minmax(min(100%, 220px), 1fr))`, card surfaces and borders using `--cpri-card`, `--cpri-border`, `--cpri-text`, `--cpri-muted`, and badge accents from existing variables. Clamp titles to three lines, add three skeleton-card styles, and force one column at narrow/mobile widths. Do not introduce hard-coded light-only card or text colors.

- [ ] **Step 3: Add the loading, wake-up hint, request, and retry flow**

Remove the `/api/publications` call and `CPRI.buildResearch(research, publications)` call from the homepage `Promise.all` initialization. Start `loadFeaturedPublications()` independently so other homepage data still loads. Render exactly three skeleton cards immediately; after 5 seconds update the status to `Waking up the server, this can take a moment...` while leaving the request active. Fetch `CPRI.apiFetch('/api/publications/featured?limit=6')`, require both `res.ok` and a valid `{ items, counts }` shape, and clear the wake-up timer in `finally`. On failure show `Couldn't load research right now.` and a Retry button wired to rerun the same loader. Only show `No featured research yet` after a successful response with zero items.

- [ ] **Step 4: Build safe cards and client-side filter chips**

Build article/card elements with `document.createElement`, set all database text through `textContent`, and set attribute values only after validation. Show faculty/student and local/national/international badges, title, venue, authors, year, and View details. Resolve `/api/publications/...` PDF links through `CPRI.apiUrl`; use external links only after confirming their parsed protocol is `http:` or `https:`; all such links use `target="_blank"` and `rel="noopener noreferrer"`. Otherwise use `publications.html#` plus `encodeURIComponent(id)`. Keep the loaded full item array and rerender it when All/Faculty/Student chips are selected; the selected chip has the project primary-fill class and no filtering request is sent. Set the view-all link to `publications.html` and update its total from counts.

- [ ] **Step 5: Verify page-script syntax and endpoint tests**

Extract the last inline script in `public/index.html` to a temporary file outside the repository, run `node --check`, then remove the temporary file. Run:

```powershell
node --test server/dev/test-featured-publications.mjs
node --check server/featured-publications.js
node --check server/publications.js
node --check server/server.js
git diff --check
```

Expected: all automated tests and syntax/whitespace checks pass.

- [ ] **Step 6: Run the homepage manual test checklist**

With the API available or controlled fixtures, verify:

1. Homepage with published items shows correct total/faculty/student counts and cards.
2. All, Faculty, and Student chips filter only the already-loaded items and show the active state.
3. A successful empty response shows the no-publications state, not an error.
4. An API error shows Retry; clicking Retry requests the endpoint again.
5. A response taking more than five seconds displays the wake-up hint and later renders normally.
6. A title containing quotes and `< >` displays literally and creates no HTML element.
7. External links open in a new tab with `noopener noreferrer`; absent/unsafe links use the local publication hash.
8. At narrow/mobile viewport width cards use one column without horizontal overflow.
9. The publication form shows the checkbox to staff/admin only; an owner cannot change it through a crafted request.
10. The seventh simultaneous/current featured selection is rejected, and changing a featured record away from Published removes it from the homepage after cache invalidation.

## Completion and deployment checks

- Confirm CORS already allows GET for `https://ahronalcober99-wq.github.io` and same-origin Render serving; do not widen the allowlist.
- Check whether the `featured` column exists before running DDL:

```sql
SELECT COLUMN_NAME
FROM information_schema.columns
WHERE table_schema = DATABASE()
  AND table_name = 'publications'
  AND column_name = 'featured';
```

If that query returns no row, run exactly once:

```sql
ALTER TABLE publications
  ADD COLUMN featured TINYINT NOT NULL DEFAULT 0;
```

Do not run either statement from the implementation session. Confirm final worktree changes and list every touched file. Do not commit or push.
