# Repository Permanent File Storage Design

## Goal

Store submission files in private persistent object storage, make repository downloads reliable and authorization-aware, and hide non-public research from visitors.

## Diagnosis

Submission upload routes use Multer disk storage under `public/assets/uploads/submissions`. File metadata is kept in the existing `submissions.files`, `submissions.additionalDocs`, and `submissions.versions` JSON fields as a local generated filename plus original name. Repository entries link to submissions using `sourceSubmissionId`. The repository download endpoint reads the source submission’s manuscript metadata, rebuilds the local filesystem path, and responds with `res.download`. The repository detail page currently uses a plain anchor for that endpoint.

The repository file route currently requires a logged-in user and checks only the access-level field; it does not check the linked submission owner or repository status. Repository list and detail routes currently include all statuses for visitors. No storage SDK/service is used by the application; `@netlify/blobs` is an unused dependency.

## Storage design

Use Supabase Storage’s HTTPS API via Node’s built-in `fetch`, without adding a package. Create a private bucket configured by `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, and `SUPABASE_BUCKET`. Never expose or log the service key.

New submission and revision uploads accept PDF, DOC, and DOCX files only, retain the current 15 MB per-file limit, use Multer memory storage with file-count limits, and upload each buffer sequentially to a UUID-named object path. Store only `storage_path`, `original_name`, and `mime_type` in the existing file JSON metadata. Existing local-only records have no `storage_path` and are reported as unavailable; no filesystem fallback is attempted. This uses the existing JSON schema, so no TiDB migration is required.

## Authorization and visibility

Treat `admin` and `cpri_staff` as privileged repository administrators, matching existing repository management permissions. A record owner is identified through the linked submission’s `submitterId`. Privileged staff and owners may see/download records at any status. Other visitors and signed-in users may only see records with status `approved` or `published`. Existing access-level rules for downloadable content remain in force.

Repository list and detail endpoints filter by status and current viewer. Detail responses calculate file availability from the source submission’s cloud `storage_path`, not the legacy `fileAvailable` flag alone.

File download requires authentication. Denied status/access-level combinations return 403. Missing metadata, legacy local-only files, and missing Storage objects return HTTP 404 with `{ ok: false, message: "The file is no longer available. Please ask the author to upload it again." }`. Successful downloads return a Supabase signed URL expiring in 60 seconds and specify the original filename as the download name. Unexpected storage/database failures are logged with `console.error` and returned as JSON without stack traces or secrets.

## Frontend and audit script

The repository detail page calls the download endpoint using the shared `CPRI.apiFetch` setup, opens the returned signed URL, handles 401 by redirecting to login with a return path, displays an explicit unavailable-file message for 404, and displays a generic retry message for other failures. It only exposes the button when the API confirms both file availability and download permission.

Add `scripts/find-missing-files.js`, a read-only one-time audit. It enumerates repository records and their source submission manuscript metadata, reports every record with no Supabase storage path (including legacy local-only records), and checks each stored path against the private bucket. Output includes record ID, title, author, and status. It makes no changes.

## Validation

Add focused tests for upload validation/limits and storage metadata, repository list/detail status visibility, owner/admin/other-user download access, missing file responses, signed URL response behavior, and JSON error handling. Validate syntax, run the focused test suite, and run `git diff --check`. Live Supabase and Render verification must be completed after the owner configures the private bucket and environment variables.

## Deployment requirements

Set `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, and `SUPABASE_BUCKET` in Render. Create a Supabase project and a private Storage bucket matching `SUPABASE_BUCKET`. No SQL is required because storage metadata uses existing JSON columns.

## Constraints

- Do not commit or push changes.
- Keep existing upload size at 15 MB per file.
- Support PDF, DOC, and DOCX only.
- Old local-path records must be treated as missing, not served from local disk.
- Never log or send the service key to the browser.
