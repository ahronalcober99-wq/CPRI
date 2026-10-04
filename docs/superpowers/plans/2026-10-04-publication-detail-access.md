# Publication Detail Access Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with inline execution and review after each task. Do not commit or push.

**Goal:** Make publication links consistently open a safe detail page and restrict unpublished details, proofs, and management actions to administrators.

**Architecture:** Keep the existing publication detail URL and API routes. The single-record GET route will return a public allowlist for published records and full details only to an active administrator; PATCH, DELETE, and proof downloads will enforce the administrator role on the server. The detail page will render safe text and reveal admin-only panels only after confirming the logged-in role.

**Tech Stack:** Node.js 18+, Express, MySQL/TiDB, vanilla browser JavaScript, Node built-in test runner.

## Global Constraints

- Do not commit or push changes.
- Do not expose private publication metadata to public API responses.
- Preserve the existing publication detail route and API base URL setup.
- All API-provided display text must be assigned using `textContent`.
- Administrator access is exactly `role === 'admin'`.

---

## File map

- `server/publications.js`: single-record public/admin projection and admin-only PATCH/DELETE/proof-download authorization.
- `server/dev/test-featured-publications.mjs`: regression coverage using the existing injectable publications router and in-process Express test pattern.
- `public/index.html`: canonical same-tab detail links on homepage card titles and actions.
- `public/assets/css/styles.css`: inherited theme color and hover treatment for linked homepage titles.
- `public/publications.html`: URL-encode IDs in existing detail links, keep DOI display on the detail page, and show delete controls only to admins.
- `public/publication-detail.html`: admin-only panels, safe detail rendering, DOI link, not-found UI, and same-site back navigation.

### Task 1: Protect publication API details and management endpoints

**Files:**
- Modify: `server/publications.js`
- Test: `server/dev/test-featured-publications.mjs`

**Interfaces:**
- Reuse `createPublicationsRouter({ all, get, update, remove, requireAuth, caller, ... })`.
- Preserve `GET /:id` response wrapper `{ publication, pubTypeLabel, statusLabel, authorTypeLabel }`.
- Use the existing `authenticate` and `resolveCaller` dependencies in this router factory.

- [ ] **Step 1: Add route tests for public projection and unpublished access**

Use an Express test app mounted at `/api/publications` and inject fake query functions and callers. Verify these cases:

```js
assert.equal(publicResponse.status, 200);
assert.equal(publicResponse.body.publication.title, 'Public paper');
assert.equal('submitterId' in publicResponse.body.publication, false);
assert.equal('proofDocuments' in publicResponse.body.publication, false);
assert.equal(privateResponse.status, 404);
assert.equal(adminPrivateResponse.status, 200);
```

The published fixture should contain sensitive fields (`submitterId`, `proofDocuments`, `sourceSubmissionId`) so the public allowlist is exercised rather than inferred.

- [ ] **Step 2: Run the focused tests and verify the new cases fail**

Run `node --test server\dev\test-featured-publications.mjs`. Expected: the current `GET /:id` returns private fields and a non-admin can read unpublished data.

- [ ] **Step 3: Implement conditional GET projections**

Resolve the caller from the session. Fetch the publication by parameterized ID. Return 404 when it is absent, or when it is not published and the caller is not an admin. For non-admins, construct a new object containing only `id`, `title`, `authors`, `journalOrConference`, `publicationDate`, `volume`, `issue`, `pages`, `doi`, `publicationLink`, `indexingStatus`, `pubType`, `status`, `authorType`, `department`, and `schoolYear`. For admins, retain the full record. Never spread the full record into the non-admin object.

- [ ] **Step 4: Add PATCH, DELETE, and proof-download authentication/role tests**

Test PATCH and DELETE with no session and with a logged-in CPRI staff user. Require 401 for anonymous requests and 403 for authenticated non-admin requests. Add a successful active-admin fixture for PATCH and DELETE and verify the handler reaches its existing update/delete operation. For proof downloads, verify anonymous and non-admin requests stop before the publication query.

- [ ] **Step 5: Require active administrator role in PATCH, DELETE, and proof downloads**

Retain `authenticate` as the first route middleware. After resolving the caller, return 401 if no user resolves and 403 unless `me.role === 'admin'` and `me.status === 'active'`. Apply this guard to PATCH, DELETE, and `GET /:id/file/:filename`; do not alter proof-upload or create permissions outside this request.

- [ ] **Step 6: Run the focused tests**

Run `node --test server\dev\test-featured-publications.mjs`. Expected: all route tests pass, including public field exclusion, admin access, 404 status behavior, and 401/403 enforcement.

### Task 2: Canonical links and safe, role-gated detail page

**Files:**
- Modify: `public/index.html`
- Modify: `public/assets/css/styles.css`
- Modify: `public/publications.html`
- Modify: `public/publication-detail.html`

**Interfaces:**
- Detail URL: `publication-detail.html?id=${encodeURIComponent(String(publication.id))}`.
- Detail API remains `GET /api/publications/:id`.
- Admin identity is read from existing `GET /api/auth/me`; only `user.role === 'admin'` enables restricted sections.

- [ ] **Step 1: Point homepage cards to the detail URL**

Replace `detailsHref` DOI/fallback logic with a helper that returns the encoded detail URL. Make the title an anchor using the same URL. Keep both anchors in the same tab and remove DOI behavior from the homepage card.

Add `.publication-title-link` styles that inherit the card title color and use the existing secondary color for hover, preserving the three-line title clamp.

- [ ] **Step 2: Encode IDs in publication-list detail links and keep DOI display on the detail page**

Update the generated heading link in `publications.html` to use `encodeURIComponent(String(p.id))`; retain same-tab navigation and remove the list's duplicate DOI display.

- [ ] **Step 3: Make restricted detail panels hidden in markup**

Change the proof-document container and the Manage Publication container to `hidden` by default. Remove the “log in to view details” block because published details are public. Add a dedicated not-found message with a publications-page link and keep record details hidden until a valid API response arrives.

- [ ] **Step 4: Safely render public detail fields and DOI**

Read `id` from `URLSearchParams`; if absent, display the not-found state without making an API request. On successful response, assign all API-derived plain text using `textContent`. For a DOI, normalize an optional DOI URL or `doi:` prefix to its identifier, create an anchor with `https://doi.org/` plus an encoded DOI path, and set `target="_blank"` and `rel="noopener noreferrer"`. Do not interpolate API data into `innerHTML`.

- [ ] **Step 5: Reveal private panels only after admin confirmation**

Fetch `/api/auth/me` using the page’s established API fetch helper with credentials. Only if the response is successful and `user.role === 'admin'` with `user.status === 'active'`, reveal Proof Documents and Manage Publication, populate the status/type form, and attach PATCH/DELETE handlers. Render proof names, types, dates, and download URLs by creating DOM elements and setting `textContent`/attributes; do not interpolate proof metadata into HTML.

- [ ] **Step 6: Add safe not-found and return navigation**

For absent ID, HTTP 404, or malformed detail data, hide record and admin sections and show “Publication not found” with a link to `publications.html`. Set the Back to publications link to call `history.back()` only when `document.referrer` parses and has the current page’s origin; otherwise use `publications.html`.

- [ ] **Step 7: Validate scripts and review the diff**

Extract and syntax-check inline scripts from `public/index.html`, `public/publications.html`, and `public/publication-detail.html` with Node. Run `node --check server\publications.js`, syntax-check inline scripts from all three edited HTML pages with Node, run `node --test server\dev\test-featured-publications.mjs`, and run `git diff --check`. Review that no public response or non-admin UI contains proof paths or management controls.

## Manual verification

1. From the homepage, click a card title and View details; both open `publication-detail.html?id=<encoded id>` in the same tab.
2. From `publications.html`, open a publication and confirm the same detail URL pattern.
3. Open a published detail URL in a private window while logged out; verify read-only details, DOI link, and no Proof Documents or Manage Publication section.
4. Sign in as CPRI staff (non-admin) and confirm restricted sections remain hidden; try PATCH, DELETE, and a proof-file URL directly and verify 403.
5. Sign in as an admin; confirm Proof Documents and Manage Publication appear, then test update/delete controls.
6. Open a nonexistent ID and a URL with no ID; verify the friendly not-found message and Back navigation fallback.
