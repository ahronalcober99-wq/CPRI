# Repository Permanent File Storage Implementation Plan

> **For agentic workers:** Execute inline task-by-task with review between tasks. Do not commit or push.

**Goal:** Persist uploaded research files in a private Supabase bucket, authorize repository visibility/downloads by role, and report missing files safely.

**Architecture:** Add a small Supabase Storage REST helper using Node's built-in `fetch`; upload submission and revision files to random object paths and keep only path/name/MIME metadata in existing JSON columns. Update submission downloads to redirect to short-lived signed URLs, enforce status/ownership visibility on repository routes, and have the repository detail page fetch authorized download URLs. Add a read-only audit script for missing repository files.

**Tech Stack:** Node.js 18+, Express, Multer, MySQL/TiDB, Supabase Storage REST API, browser JavaScript, Node built-in test runner.

## Global Constraints

- Do not commit or push changes.
- Keep existing upload size at 15 MB per file.
- Support PDF, DOC, and DOCX only.
- Old local-path records must be treated as missing, not served from local disk.
- Never log or send the service key to the browser.
- Treat `admin` and `cpri_staff` as privileged repository administrators.
- Owners are determined through `repository.sourceSubmissionId` → `submissions.submitterId`.
- Existing access-level restrictions remain in force for full-text access.
- Use existing JSON fields; do not add TiDB columns for file metadata.

---

## File map

- `server/storage/supabase-storage.js`: configuration validation, private upload, signed URL creation, object existence checks, and best-effort object cleanup using Supabase REST.
- `server/submissions.js`: memory-backed validated uploads for initial submissions and revisions; file metadata and authenticated download handling.
- `server/repository.js`: owner/admin/public-status list/detail filtering, file availability derived from cloud metadata, and signed download route.
- `public/repository-detail.html`: role-aware download button, credentialed request, login return URL, and download states.
- `public/repository.html`: same status visibility rule for public repository searches.
- `scripts/find-missing-files.js`: read-only report of repository records with absent or missing cloud manuscript files.
- `server/dev/test-supabase-storage.mjs`: injected-fetch unit tests for Supabase REST behavior.
- `server/dev/test-repository-files.mjs`: focused HTTP tests for upload/download authorization and public visibility.
- `docs/superpowers/specs/2026-10-04-repository-permanent-files-design.md`: approved design and deployment contract.

### Task 1: Add private Supabase Storage REST helper

**Files:**
- Create: `server/storage/supabase-storage.js`
- Create: `server/dev/test-supabase-storage.mjs`

**Interfaces:**
- `createSupabaseStorage({ env = process.env, fetchImpl = fetch } = {})`
- `uploadObject({ path, buffer, contentType })` resolves with `{ path }`.
- `createSignedDownloadUrl({ path, downloadName, expiresIn = 60 })` resolves with an absolute URL.
- `objectExists(path)` resolves `true` or `false` for HTTP 2xx/404 and throws on other HTTP/network errors.
- `deleteObjects(paths)` deletes a list of uploaded paths for request rollback.
- None of these functions may log or return credential values.

- [ ] **Step 1: Write REST helper tests with a fake fetch**

Test that configuration errors name only the missing variable, upload uses `PUT /storage/v1/object/<bucket>/<encoded path>` with service headers and raw buffer, signed URL uses a 60-second expiry and a download filename, 404 from `objectExists` returns false, and an unexpected 500 throws a sanitized storage error. Assert fake-fetch calls never serialize credentials into the returned URL.

- [ ] **Step 2: Run helper tests and verify they fail**

Run `node --test server\dev\test-supabase-storage.mjs`. Expected: the module export does not exist yet.

- [ ] **Step 3: Implement REST helper**

Read only `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, and `SUPABASE_BUCKET`; reject absent or malformed settings with an error that contains variable names but not values. Encode bucket and each storage-path segment independently. Upload with `PUT`, `apikey`, `Authorization: Bearer <service key>`, `Content-Type`, and `x-upsert: false`; sign with `POST /storage/v1/object/sign/{bucket}/{path}` and JSON `{ expiresIn, download: downloadName }`; resolve relative `signedURL` against `SUPABASE_URL`. Implement delete via the bucket object removal endpoint. Expose no service credential from the helper.

- [ ] **Step 4: Run helper tests**

Run `node --test server\dev\test-supabase-storage.mjs`. Expected: all REST method, header, path, URL expiry, 404, and error behavior tests pass.

### Task 2: Move initial and revision submission uploads to the bucket

**Files:**
- Modify: `server/submissions.js`
- Test: `server/dev/test-supabase-storage.mjs`

**Interfaces:**
- Use the `createSupabaseStorage()` methods from Task 1.
- Persist file JSON metadata as `{ storage_path, original_name, mime_type }`.
- Preserve current field names, required fields, and file-count limits.
- Export a pure upload validator for PDF/DOC/DOCX extension and MIME matching, or test it through the route factory if the implementation extracts a focused helper.

- [ ] **Step 1: Add upload validation tests**

Test accepted matching pairs: `.pdf`/`application/pdf`, `.doc`/`application/msword`, `.docx`/`application/vnd.openxmlformats-officedocument.wordprocessingml.document`. Test rejection of mismatched extension/MIME and unsupported file types. Test the multer size limit remains exactly `15 * 1024 * 1024`.

- [ ] **Step 2: Run upload validation tests and verify they fail**

Run `node --test server\dev\test-supabase-storage.mjs`. Expected: the validator is missing.

- [ ] **Step 3: Replace disk storage with bounded memory storage**

Configure Multer memory storage with `fileSize: 15 * 1024 * 1024`, existing field/count limits, and a file filter that rejects anything outside matching PDF/DOC/DOCX extension and MIME pairs. Return JSON 400 for invalid files and size/count `MulterError`s; do not return stack traces.

- [ ] **Step 4: Upload initial request files sequentially**

After existing required text/file checks, iterate `FILE_FIELDS` in order and upload one buffer at a time to `submissions/{submissionId}/{randomUUID()}.{pdf|doc|docx}`. Upload optional additional documents the same way, storing only `storage_path`, `original_name`, and `mime_type` (plus the existing random additional document ID). Use the original filename only as metadata and as download name; never include it in the object path. If any storage upload or database insert fails, delete every object already uploaded, log the real error without secrets, and return JSON 500.

- [ ] **Step 5: Upload revision request files sequentially**

Apply the same validator, 15 MB limit, sequential upload, random path, metadata shape, and cleanup behavior to revision uploads under `submissions/{submissionId}/revisions/{version}/{uuid}.{ext}`. Preserve existing version metadata and submission status changes.

- [ ] **Step 6: Run upload-focused tests and syntax checks**

Run `node --test server\dev\test-supabase-storage.mjs` and `node --check server\submissions.js`. Expected: accepted/rejected MIME pairs, exact file-size limit, and storage metadata behavior pass.

### Task 3: Serve submission files through signed URLs

**Files:**
- Modify: `server/submissions.js`
- Test: `server/dev/test-repository-files.mjs`

**Interfaces:**
- Keep `GET /api/submissions/:id/file?key=...&docId=...&version=...`.
- Continue using existing `requireAuth` and `canAccess(me, sub)`.
- Redirect successful downloads to a signed URL with a 60-second expiry.
- Metadata without `storage_path` returns JSON 404; never reconstruct a local path.

- [ ] **Step 1: Add a test for current and versioned metadata resolution**

Inject a fake storage signer and assert current manuscript, additional document, and revision lookups pass the correct `storage_path` and `original_name`; assert old `{ filename, originalName }` metadata returns JSON 404 without asking storage to sign.

- [ ] **Step 2: Run the new test and verify it fails**

Run `node --test server\dev\test-repository-files.mjs`. Expected: the test harness/helper does not exist yet.

- [ ] **Step 3: Replace filesystem download logic**

Select the current/versioned metadata as before. When `storage_path` is present, call `createSignedDownloadUrl` with 60 seconds and redirect to it. For absent paths, return `{ ok: false, message: "The file is no longer available. Please ask the author to upload it again." }` with 404. Catch storage errors, log with `console.error` without config values, and return a generic JSON 500.

- [ ] **Step 4: Test signed redirects and legacy missing-file responses**

Run `node --test server\dev\test-repository-files.mjs`. Expected: redirect destination, expiry invocation, authorization preservation, and JSON 404 pass.

### Task 4: Enforce repository public visibility and owner/admin status access

**Files:**
- Modify: `server/repository.js`
- Create: `server/dev/test-repository-files.mjs`

**Interfaces:**
- Add `createRepositoryRouter({ all, get, run, insert, update, remove, optionalUser, storage })` and preserve the exported production `repositoryRouter`.
- Public statuses are exactly `approved` and `published`, case-insensitive.
- Privileged roles are exactly `admin` and `cpri_staff`.
- Owner status access is based on linked submission `submitterId`.
- File route remains `GET /:id/file`; successful JSON response shape is `{ ok: true, url }`.

- [ ] **Step 1: Create the router HTTP test harness**

Create an Express app mounted at `/api/repository`, inject in-memory rows, owner identities, and fake storage calls, and parse JSON responses. Seed approved, published, pending, rejected, owner-linked, and unlinked records.

- [ ] **Step 2: Add failing list/detail visibility tests**

Assert anonymous and unrelated users receive only approved/published records and cannot access pending/rejected detail (404). Assert the record owner can see their linked record at any status and `admin`/`cpri_staff` can see every status. Assert detail `fileAvailable` is derived from `sub.files.manuscript.storage_path`, not only `repository.fileAvailable`.

- [ ] **Step 3: Implement list/detail filtering**

Load the optional current user. Build parameterized list queries using `repository r` and a linked-submission `EXISTS` condition for the owner. For anonymous/non-owner users, include only `LOWER(COALESCE(r.status,'')) IN ('approved','published')`; privileged users omit the status filter. Preserve current search filters using table-qualified columns. For detail, join/load the source submission and apply the same rule, returning 404 for hidden statuses. Do not serialize joined submission JSON or `submitterId` in list payloads.

- [ ] **Step 4: Implement download authorization and signed URL JSON**

Require authentication first (401 if absent). Resolve the record and source submission; return 404 for absent record/file or missing `storage_path`. Treat an active owner, `admin`, or `cpri_staff` as privileged for status checks; unrelated logged-in users may download only approved/published records. Apply existing `canAccessFile(accessLevel, user)` checks after the status check, returning 403 on denial. Call the storage signer with the original name and 60-second expiry, then return `{ ok: true, url }`. If Supabase confirms the object is missing, return the exact JSON 404 message; unexpected failures are logged without secrets and return JSON 500.

- [ ] **Step 5: Run list/detail/download tests**

Run `node --test server\dev\test-repository-files.mjs`. Expected: visitor visibility, owner/admin status visibility, 401/403/404 rules, signed URL output, and safe storage-error behavior pass.

### Task 5: Update repository list and detail UI

**Files:**
- Modify: `public/repository-detail.html`
- Modify: `public/repository.html`

**Interfaces:**
- Use `CPRI.apiFetch('/api/repository/...')` for API calls so configured API base and credentials are preserved.
- Detail response fields include `record`, `canDownload`, and cloud-derived `fileAvailable`.
- Download response is `{ ok: true, url }`; 401 is handled before opening a URL.

- [ ] **Step 1: Filter records in the repository list UI**

Keep server results authoritative; verify the page handles an empty filtered response without showing hidden/rejected records, and URL-encode IDs in detail links.

- [ ] **Step 2: Replace detail-page file link with a stateful button**

Build controls with DOM APIs and `textContent`. Show the button only when `fileAvailable` is true; disable it when `canDownload` is false and show a login action for logged-out users when access rules require login. On click, disable the button, label it “Preparing download...”, call `CPRI.apiFetch` with credentials, then open the returned signed URL. If HTTP 401, navigate to `login.html?next=` with the current path/query/hash encoded. On 404 show the server message; on all other failures show “Couldn't download the file. Try again.” Restore the button label and enabled state appropriately.

- [ ] **Step 3: Use DOM text assignment for repository detail output**

Remove API-derived strings from `innerHTML` template interpolation in the modified file-action flow; assign record text with `textContent` and create the button/link elements explicitly. Keep other existing detail-page content behavior unchanged.

- [ ] **Step 4: Run page script syntax checks and manual UI inspection**

Extract inline scripts from `public/repository.html` and `public/repository-detail.html` and parse with `new Function`. Verify button visibility for file-present/file-missing/can-download combinations and confirm login return URL encoding.

### Task 6: Add read-only missing-file report

**Files:**
- Create: `scripts/find-missing-files.js`

**Interfaces:**
- Run from the project root with `node scripts/find-missing-files.js`.
- Read repository rows and source-submission `files` metadata through existing `server/server/db/queries.js`.
- Check objects with the same Supabase service configuration; never delete or update rows/objects.
- Print columns `id`, `title`, `author`, `status`.

- [ ] **Step 1: Implement and test report formatting/classification**

Add a pure helper in the script for missing classification. Legacy metadata without `storage_path`, repository entries with no source/file, and Supabase HEAD 404s are missing. For each stored path, issue an authenticated HEAD request sequentially. Treat other HTTP/network errors as operational failures, log a sanitized error, and exit nonzero rather than misreporting files as absent. Print a tab-separated header and only missing records.

- [ ] **Step 2: Run syntax validation**

Run `node --check scripts\find-missing-files.js`. Do not run the script against production data during implementation.

### Task 7: Complete regression checks and deployment handoff

**Files:**
- Modify: `server/dev/test-supabase-storage.mjs`
- Modify: `server/dev/test-repository-files.mjs`
- Review: all files in Tasks 1–6

- [ ] **Step 1: Run all focused tests**

Run `node --test server\dev\test-supabase-storage.mjs server\dev\test-repository-files.mjs`. Expected: all unit and HTTP behavior tests pass.

- [ ] **Step 2: Check every changed JavaScript file**

Run `node --check` for `server/storage/supabase-storage.js`, `server/submissions.js`, `server/repository.js`, `scripts/find-missing-files.js`, and both new test modules. Extract and syntax-check inline scripts in `public/repository.html` and `public/repository-detail.html`.

- [ ] **Step 3: Verify no secrets, SQL requirements, or local fallback remain in the repository download path**

Search changed files for literal credential values and verify none exist. Confirm the repository download route never uses `join(SUB_UPLOAD_DIR, ...)` or `res.download`. Run `git diff --check`. Deployment SQL should be none; Render needs `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, and `SUPABASE_BUCKET`.

## Manual verification

1. Configure a private Supabase bucket and the three Render variables.
2. Upload a new PDF, DOC, and DOCX submission and verify metadata has random `storage_path`, original filename, and MIME type.
3. Download as the submission owner and as admin/CPRI staff; confirm file bytes and original download name.
4. Download logged out; confirm login redirect and return to the same detail URL.
5. Redeploy/restart Render and download again; verify persistent bucket object remains accessible.
6. Remove a bucket object or use a legacy local-only record; verify JSON 404 and “file no longer available” UI.
7. Try as an unrelated logged-in user; confirm only approved/published statuses and applicable access levels permit download.
8. Verify rejected/pending records are hidden from visitors and unrelated users but visible to their owner and privileged staff with status shown.
9. Upload a file larger than 15 MB and an unsupported extension; confirm JSON error and no partial record/object.
10. Run `node scripts/find-missing-files.js`; verify missing rows print ID, title, author, and status and nothing is deleted.

## Supabase and Render setup

1. Create a Supabase project and save its project URL and server-side service key in a password manager.
2. Open **Storage → New bucket**, name it (for example `cpri-private-files`), keep **Public bucket** disabled, and create it.
3. In Render’s service environment settings, add `SUPABASE_URL` (project URL), `SUPABASE_SERVICE_KEY` (service-role secret), and `SUPABASE_BUCKET` (exact bucket name).
4. Redeploy the backend. Never add the service key to frontend files or logs.
