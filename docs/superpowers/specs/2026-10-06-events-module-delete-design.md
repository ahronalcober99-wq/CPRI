# Research Events Module Delete Design

## Context

`public/events-module.html` renders a combined list fetched from
`GET /api/events-module`. The response can contain database-backed module
events (`source: "module"`) and JSON-backed Admin Console events
(`source: "content"`). The existing `DELETE /api/events/:id` route in
`server/server.js` already enforces the active-admin session middleware and
deletes across both storage sources, including same-title duplicates and
module registration/abstract rows. It also cleans up event-owned uploads.

## Design

Reuse the unified `DELETE /api/events/:id` route rather than introduce a
second module-only deletion endpoint. Tighten it to reject malformed UUIDs
with HTTP 400 and return `{ message, id, title }` on success; missing events
remain HTTP 404 and unexpected failures remain logged HTTP 500 responses.
Authentication continues to use the existing session cookie and
`requireAdmin`; no `ADMIN_TOKEN` environment variable is required.

On the module page, show a red destructive pill button only to users whose
active session role is `admin`. Place it beside the Admin Console badge for
content events; for module events without that badge, place it in the same
metadata row. Escape rendered event fields, including the event ID used in
attributes. On click, confirm with the shared in-page dialog using
`Delete '<event title>'? This cannot be undone.`. Send a same-origin DELETE
request, disable and relabel the button while pending, fade out the matching
card on success, and show a success toast. On failure, use the server's error
message in an error toast and restore the button.

## Error handling and compatibility

Keep event listing, creation, editing, search, and filtering unchanged. The
existing unified route remains compatible with `events.html` and other
consumers; the response adds the requested `id` and `title` fields. Since the
route is authenticated by the existing admin session middleware, callers need
no new Render secret.

## Verification

- Add focused tests for valid and invalid UUIDs, not-found results, success
  response metadata, and server failures.
- Verify the page's inline script parses and rendered values remain escaped.
- Manually test as an active admin and a signed-in non-admin; verify the
  admin-only control, confirmation, in-progress state, card fade/removal,
  success/error toast behavior, and preservation of create/edit/list behavior.
- Confirm the endpoint accepts the session cookie and does not require an
  `ADMIN_TOKEN`.
