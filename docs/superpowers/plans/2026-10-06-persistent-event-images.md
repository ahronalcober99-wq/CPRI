# Persistent Event Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist event cover images outside Render's ephemeral disk and render them reliably on the public events page, event module, and homepage.

**Architecture:** Reuse Supabase Storage with a dedicated public event-image bucket, leaving the existing private bucket as the default for documents. Save the stable public URL and object path on both database-backed module events and JSON-backed Admin Console events, then expose a shared compatibility-aware image URL resolver to the browser.

**Tech Stack:** Node.js 18+, Express, multer, existing Supabase Storage REST adapter, Netlify Drizzle/Postgres migrations, vanilla browser JavaScript, Node's built-in test runner.

## Global Constraints

- Follow the existing stack, structure, naming, and code style.
- Keep changes minimal and consistent with the existing code.
- Use the project's existing database layer, and add no new dependencies unless necessary.
- Accept only jpg, jpeg, png and webp, with a max size of 5 MB.
- Save the full https image URL as imageUrl and the storage id as imagePublicId on the event.
- Don't break existing event listing, add/edit/delete features.
- Escape any user-provided text rendered into the DOM.
- A dedicated public event bucket must not make the existing private-file bucket public.

## Files and responsibilities

- Modify `server/storage/supabase-storage.js` to support bucket-scoped upload, delete, and stable public URLs while preserving private-bucket defaults.
- Modify `server/events-module.js` to persist durable covers for module events and clean up replaced/deleted storage objects.
- Modify `server/admin-dashboard.js` to persist durable covers for Admin Console JSON events and clean up replacements/deletions.
- Modify `server/server.js` to return canonical image metadata in merged event feeds and remove storage objects on unified event deletion.
- Create `netlify/database/migrations/20261006120000_add_event_image_storage/migration.sql` for nullable module-event image metadata.
- Create `server/event-image-utils.js` for shared server-side validation and legacy metadata normalization.
- Create `public/assets/js/event-image-utils.js` for shared browser URL resolution and the fixed placeholder.
- Modify `public/assets/js/main.js` to expose `CPRI.resolveImageUrl(event)` and use it in homepage event cards.
- Modify `public/index.html`, `public/events.html`, and `public/events-module.html` to load the utility and use the shared resolver and consistent image fallback rendering.
- Modify `server/dev/test-supabase-storage.mjs` and create `server/dev/test-event-image-helpers.mjs` for regression coverage.

## Implementation tasks

### Task 1: Add safe bucket-specific public image operations

**Files:**
- Modify: `server/storage/supabase-storage.js`
- Test: `server/dev/test-supabase-storage.mjs`

**Interfaces:**
- Preserve `uploadObject({ path, buffer, contentType })` and `deleteObjects(paths)` behavior for `SUPABASE_BUCKET`.
- Add optional `bucket` to `uploadObject` and `deleteObjects`.
- Add `publicObjectUrl({ path, bucket })` returning a stable HTTPS Supabase public-object URL.
- Use `SUPABASE_EVENT_BUCKET` only when explicitly requested as `bucket: 'events'`; resolve it separately from `SUPABASE_BUCKET`.

- [ ] **Step 1: Add failing adapter tests**

Add tests asserting:

```js
const storage = createSupabaseStorage({ env: {
  ...env,
  SUPABASE_EVENT_BUCKET: 'public-event-images'
}, fetchImpl });
assert.deepEqual(await storage.uploadObject({
  path: 'events/id/cover.webp',
  buffer: Buffer.from('image'),
  contentType: 'image/webp',
  bucket: 'events'
}), { path: 'events/id/cover.webp' });
assert.match(storage.publicObjectUrl({
  path: 'events/id/cover.webp',
  bucket: 'events'
}), /^https:\/\/project\.example\.test\/storage\/v1\/object\/public\/public-event-images\//);
await storage.deleteObjects(['events/id/cover.webp'], { bucket: 'events' });
```

Also assert omitted `bucket` continues to use `private-files` and missing
`SUPABASE_EVENT_BUCKET` fails without echoing credentials.

- [ ] **Step 2: Run the focused test and confirm the new API fails**

Run: `node --test server/dev/test-supabase-storage.mjs`

Expected: new bucket-override/public-URL assertions fail before implementation;
all previous private storage tests continue to pass.

- [ ] **Step 3: Implement bucket resolution and public URL construction**

Add a bucket resolver that returns `SUPABASE_BUCKET` for the default path and
requires `SUPABASE_EVENT_BUCKET` only for event-bucket operations. Reuse
`encodePath` for URL paths; do not modify private storage callers.

- [ ] **Step 4: Run adapter regression tests**

Run: `node --test server/dev/test-supabase-storage.mjs`

Expected: all existing and new tests pass.

- [ ] **Step 5: Commit the storage adapter task**

```powershell
git add server/storage/supabase-storage.js server/dev/test-supabase-storage.mjs
git commit -m "feat: support durable event image storage"
```

### Task 2: Persist module-event cover images

**Files:**
- Create: `netlify/database/migrations/20261006120000_add_event_image_storage/migration.sql`
- Modify: `server/events-module.js`
- Modify: `server/init-db.sql` only if local initialization must mirror the deployed schema.
- Test: `server/dev/test-event-image-helpers.mjs`

**Interfaces:**
- Module event records store `imageUrl` and `imagePublicId`; `photo` is retained for reading legacy rows.
- Existing create/update endpoints continue accepting multipart `photo`.
- Event list/detail responses return `imageUrl` and `imagePublicId` without a second URL property named `photo`.
- `server/event-image-utils.js` exports `validateEventImage(file)` and `normalizeEventImage(event)` for both backend event stores.

- [ ] **Step 1: Add failing cover-validation tests**

Test a shared validation helper with these cases:

```js
assert.equal(validateEventImage({ originalname: 'cover.webp', mimetype: 'image/webp' }), 'image/webp');
assert.throws(() => validateEventImage({ originalname: 'cover.gif', mimetype: 'image/gif' }), /JPG, JPEG, PNG, or WebP/);
assert.throws(() => validateEventImage({ originalname: 'cover.jpg', mimetype: 'image/png' }), /does not match/);
```

Test upload middleware configuration separately for a 5 MiB maximum; leave the
existing 15 MiB gallery-document upload limit unchanged.

- [ ] **Step 2: Run the helper test to confirm it fails**

Run: `node --test server/dev/test-event-image-helpers.mjs`

Expected: FAIL because the image validation/storage helpers are not yet
exported.

- [ ] **Step 3: Implement module upload and migration**

Use multer memory storage on the existing cover-only POST route, use a random
object path under `events-module/<event-id>/`, upload the buffer to the event
bucket, and save the returned stable URL and path. Do not persist a local cover
path. For PATCH, parse the existing multipart form, replace the object only
when a new `photo` is present, save metadata, and best-effort delete the old
object after the row update. On a failed row write, remove the newly uploaded
object and return the repository-standard error response. During reads,
normalize `imageUrl || photo || ''` to `imageUrl`.

Add nullable `imageurl varchar(1000)` and `imagepublicid varchar(500)` columns
in the new Drizzle SQL migration using the existing `--> statement-breakpoint`
format. Keep the legacy `photo` column for back-compatibility. Mirror both
nullable columns in `server/init-db.sql` for local MySQL initialization.

- [ ] **Step 4: Implement module deletion cleanup**

Before deleting the module row, retain `imagePublicId`; after a successful
database removal, call `deleteObjects([imagePublicId], { bucket: 'events' })`
and log cleanup failures without failing the completed deletion. Continue
removing the existing local gallery-attachment folder.

- [ ] **Step 5: Run focused tests**

Run: `node --test server/dev/test-event-image-helpers.mjs server/dev/test-event-deletion.mjs`

Expected: image validation and current event-deletion safety tests pass.

- [ ] **Step 6: Commit the module image task**

```powershell
git add netlify/database/migrations/20261006120000_add_event_image_storage/migration.sql server/events-module.js server/event-image-utils.js server/init-db.sql server/dev/test-event-image-helpers.mjs
git commit -m "feat: persist event module cover images"
```

### Task 3: Persist Admin Console event images and unified deletion

**Files:**
- Modify: `server/admin-dashboard.js`
- Modify: `server/server.js`
- Modify: `server/dev/test-event-deletion.mjs`
- Test: `server/dev/test-event-image-helpers.mjs`

**Interfaces:**
- Admin photo upload `POST /api/admin/content/event/photo` (router-mounted path) returns `{ imageUrl, imagePublicId }`.
- Content event POST/PATCH persist those fields while accepting legacy `photo` input.
- Unified event deletion removes Supabase objects from both source records in addition to existing local cleanup.
- Public event feeds map legacy `photo` into canonical `imageUrl`.

- [ ] **Step 1: Add failing content-event storage tests**

Test helper operations for:

```js
assert.equal(validateEventImage({ originalname: 'cover.JPG', mimetype: 'image/jpeg' }), 'image/jpeg');
assert.throws(() => validateEventImage({ originalname: 'cover.svg', mimetype: 'image/svg+xml' }), /JPG, JPEG, PNG, or WebP/);
assert.deepEqual(normalizeEventImage({ photo: '/assets/old.jpg' }), {
  imageUrl: '/assets/old.jpg',
  imagePublicId: ''
});
```

Also test that a cleanup failure is logged, not thrown, once the durable event
record has been removed.

- [ ] **Step 2: Run tests and confirm the new assertions fail**

Run: `node --test server/dev/test-event-image-helpers.mjs server/dev/test-event-deletion.mjs`

Expected: new helper/storage-metadata tests fail; existing deletion tests pass.

- [ ] **Step 3: Replace Admin Console local cover upload with Supabase**

Use multer memory storage, 5 MiB cap, and the common JPEG/PNG/WebP allowlist.
Upload under `content-events/<uuid>/<safe-generated-filename>`. Return the
Supabase public URL and object path. Update create and patch handlers to save
canonical metadata; only preserve a legacy `photo` field when reading old
JSON, not as a second URL output. On image replacement, save JSON first and
then best-effort remove the old object; on JSON write failure, remove the new
object and return an error.

- [ ] **Step 4: Update unified event API and delete cleanup**

Map both stores to `imageUrl` and `imagePublicId`, preferring canonical values
then legacy `photo`. Extend the existing deletion service data passed to
`cleanupDeletedEventFiles` or add a separate safe Supabase cleanup step so
both JSON and module `imagePublicId` objects are removed. Catch/log object
deletion failures; preserve current path-basename safeguards and local
attachment cleanup.

- [ ] **Step 5: Run event deletion and image helper tests**

Run: `node --test server/dev/test-event-image-helpers.mjs server/dev/test-event-deletion.mjs`

Expected: all tests pass, including legacy path safety and best-effort cloud
cleanup.

- [ ] **Step 6: Commit Admin Console and API changes**

```powershell
git add server/admin-dashboard.js server/server.js server/dev/test-event-deletion.mjs server/dev/test-event-image-helpers.mjs
git commit -m "feat: persist admin event images"
```

### Task 4: Resolve and render durable images consistently

**Files:**
- Modify: `public/assets/js/main.js`
- Create: `public/assets/js/event-image-utils.js`
- Modify: `public/index.html`
- Modify: `public/events.html`
- Modify: `public/events-module.html`
- Test: `server/dev/test-event-image-helpers.mjs`

**Interfaces:**
- Add `CPRI.resolveImageUrl(event)`, returning an HTTPS URL, a fully resolved API-origin URL for a relative legacy path, or `''` if no image URL exists.
- `imageUrl` takes precedence over legacy `photo` and `image`.
- `public/assets/js/event-image-utils.js` assigns `globalThis.CPRIEventImages.resolveImageUrl(event, apiBase)` and `globalThis.CPRIEventImages.placeholderDataUrl`.
- All event images use lazy loading, escaped alt text, consistent fixed-height cover sizing, and a local inline SVG “No image” fallback.

- [ ] **Step 1: Add resolver behavior tests**

Add cases for canonical URL, legacy field fallback, HTTP-to-HTTPS upgrade,
relative API path resolution, and empty fields. Expected examples:

```js
assert.equal(resolveImageUrl({ imageUrl: 'http://cdn.example/image.jpg' }), 'https://cdn.example/image.jpg');
assert.equal(resolveImageUrl({ photo: '/assets/old.jpg' }, 'https://cpri.example'), 'https://cpri.example/assets/old.jpg');
assert.equal(resolveImageUrl({}), '');
```

- [ ] **Step 2: Implement the shared resolver**

Add the pure resolver to `event-image-utils.js` and test the classic script by
evaluating it in a Node `vm` context. Add `CPRI.resolveImageUrl(event)` to the
shared API in `main.js`, delegating with existing `API_BASE`. The fixed inline
SVG placeholder must contain no user-provided string. Load the utility before
`main.js` on `index.html`, `events.html`, and `events-module.html`.

- [ ] **Step 3: Render image cards**

Use `CPRI.resolveImageUrl(e)` in homepage cards, event-list cards, gallery cards,
and module-list cards. Where a URL exists, set `loading="lazy"`, `alt` from the
escaped title, and existing image aspect sizing. Use a fixed encoded
data-URI SVG with the visible label “No image” when no image exists or an
`onerror` fires. Keep gallery/admin delete buttons and card links functional.

- [ ] **Step 4: Run rendering/helper checks**

Run: `node --test server/dev/test-event-image-helpers.mjs`

Then use `node --check` on any extracted inline scripts and run the browser
pages with the existing local server when the environment supports it.
Expected: resolver tests pass, scripts parse, and empty/broken image paths
show the placeholder instead of the browser's broken-image icon.

- [ ] **Step 5: Commit frontend image rendering**

```powershell
git add public/assets/js/event-image-utils.js public/assets/js/main.js public/index.html public/events.html public/events-module.html server/dev/test-event-image-helpers.mjs
git commit -m "fix: render persistent event images consistently"
```

### Task 5: Verify deployment requirements and the complete regression set

**Files:**
- Modify: `docs/superpowers/specs/2026-10-06-persistent-event-images-design.md`
- Verify: Render environment and browser behavior after deploy.

**Interfaces:**
- Render config requires `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, and `SUPABASE_EVENT_BUCKET`.
- The event bucket is public; `SUPABASE_BUCKET` remains private.
- Existing local images that disappeared cannot be reconstructed and need admin re-upload.

- [ ] **Step 1: Run all targeted built-in tests**

Run:

```powershell
node --test server/dev/test-supabase-storage.mjs server/dev/test-event-image-helpers.mjs server/dev/test-event-deletion.mjs
```

Expected: all targeted tests pass with no missing dependency installation.

- [ ] **Step 2: Check syntax and whitespace**

Run:

```powershell
node --check server/storage/supabase-storage.js
node --check server/events-module.js
node --check server/admin-dashboard.js
node --check server/server.js
git diff --check
```

Expected: commands exit successfully.

- [ ] **Step 3: Verify Render deployment flow**

Configure the three Supabase environment values and create the event bucket
with public reads. Upload a JPG or WebP from each event authoring surface,
redeploy, reload `events.html`, `events-module.html`, and the homepage, and
confirm the image still loads. Replace an image and verify the old object is
gone; delete the event and verify its current image object is gone. Test an
invalid file type and a file larger than 5 MB; both must be rejected.

- [ ] **Step 4: Review worktree scope**

Run: `git status --short` and `git diff --stat`.

Expected: only the files listed in this plan are changed.
