# Persistent Event Images Design

## Diagnosis

Module cover uploads currently use multer disk storage under
`public/assets/uploads/events-module/<event-id>/`. The create route saves that
relative local URL as `events_module.photo`; the API maps and returns `photo`,
and page renderers read `e.photo`. Express serves `PUBLIC_DIR` statically, so
the upload directory is served, and the current field mapping is consistent.
The primary failure is that Render's local filesystem is ephemeral: the
database URL can survive a restart/redeploy while the file does not.

The public events gallery has an additional display omission: it renders a
camera placeholder for every event rather than using an available event photo.
The checked-in JSON event samples currently have empty `photo` values. The
deployed `GET /api/events` endpoint returned HTTP 200 with an empty array during
diagnosis, so no production row or image URL could be inspected directly.

## Storage choice

Reuse the repository's existing Supabase Storage adapter and credentials.
Event images use a new dedicated public bucket selected by
`SUPABASE_EVENT_BUCKET`; the existing `SUPABASE_BUCKET` remains private for
documents. Render must configure `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, and
`SUPABASE_EVENT_BUCKET`; create the latter bucket as public before deployment.
No Cloudinary dependency, Render persistent disk, or service secret in client
code is needed.

## Data model and backend behavior

Persist event image metadata using canonical `imageUrl` and `imagePublicId`
fields. `imageUrl` is the complete HTTPS public URL returned by Supabase;
`imagePublicId` is the safe object path within the event bucket. Add nullable
metadata columns to the `events_module` schema and retain the old `photo`
column only as a compatibility source for existing rows. The Express server
uses its MySQL pool, so fresh databases get these columns in
`server/init-db.sql`, and the existing-event startup check adds them
idempotently. The unrelated Netlify migration directory is not the schema path
used by these event routes. JSON-backed Admin Console events gain the same
canonical fields; legacy `photo` values remain readable during migration.

Extend the existing Supabase adapter to upload and delete objects from the
configured event bucket without changing its default private-bucket behavior.
The public event upload accepts only `.jpg`, `.jpeg`, `.png`, or `.webp`,
checks the matching image media type, and caps file size at 5 MB. Use
memory-backed multer so Render's local disk is not part of cover-image
persistence.

Wire uploads through both database-backed module event create/update routes
(including the event-detail admin edit form) and the Admin Console JSON-backed
event photo/create/update flow. When a new
image is successfully saved, remove the previous Supabase object by
`imagePublicId`; if saving fails, clean up the newly uploaded object instead.
Event deletion also removes the stored object best-effort and logs storage
failures without masking an otherwise successful record deletion. Existing
local event gallery attachments continue using their current path and folder
cleanup behavior.

Normalize event API responses to use one URL field, `imageUrl`, with
`imagePublicId` as associated storage metadata. While old events are being
re-uploaded, map their legacy `photo` values into `imageUrl` and do not emit
both `photo` and `imageUrl` as parallel URL fields.

## Frontend behavior

Expose a shared `CPRI.resolveImageUrl(event)` helper that chooses
`imageUrl`, then legacy `photo`/`image`; upgrades `http:` to `https:`; and
resolves relative legacy paths against the configured API origin when one is
available.

Use the helper for images rendered by `events-module.html`, `events.html`,
and the homepage event cards in `main.js`. Render valid image URLs with lazy
loading, escaped descriptive alt text, fixed-height `object-fit: cover`
styling, and an error handler that replaces a broken image with a local inline
SVG placeholder reading “No image”. Keep layout, event controls, and image
fallback behavior consistent across all three surfaces.

## Existing data and deployment

Existing local paths may already be missing after Render restarts. They remain
visible through compatibility mapping but cannot be recovered from a dead
file; admins must re-upload those event images. No signed URLs are used for
public images, so saved URLs do not expire.

## Verification

- Test Supabase bucket-specific upload/public URL/delete operations and retain
  private-bucket defaults.
- Test file type, MIME type, and 5 MB limits for event cover uploads.
- Test that existing MySQL installations acquire both image columns at boot
  while the database still permits the previous private-bucket defaults.
- Test create/update replacement cleanup and delete cleanup for both event
  storage sources.
- Verify API event responses expose `imageUrl` and no parallel legacy URL
  field; verify legacy `photo` maps to `imageUrl`.
- Verify the shared URL resolver for HTTPS, HTTP upgrade, relative, legacy,
  and empty/broken image values.
- Parse inline page scripts and run targeted tests for storage, event routes,
  and deletion.
- Deploy with the three Supabase Render variables and a public event bucket;
  upload, redeploy, verify the image persists, delete the event, and verify
  the object is removed.
