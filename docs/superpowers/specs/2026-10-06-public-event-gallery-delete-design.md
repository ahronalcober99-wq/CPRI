# Public Event Gallery Delete Design

## Context

`public/events.html` renders Upcoming Activities and Past Events cards plus a
gallery grid. It already checks `/api/auth/me` for an active `admin`, and its
list-card delete action calls the strict-admin `DELETE /api/events/:id`
endpoint. The gallery cards currently display a camera placeholder, title,
and date without an action.

The shared endpoint in `server/server.js` already validates UUIDs, returns
400/404/200/500 as appropriate, and deletes the selected event across the
JSON and database stores. It removes associated registration/abstract rows
and cleans module event directories/content photos. The existing admin
session is the credential; no token or environment variable is needed.

## Design

Reuse the existing endpoint and active-admin session check. Add one
round, red trash button to the top-right of every gallery card for an active
admin. Reveal it on hover for pointer devices, keep it visible on touch
devices, and provide an accessible label and keyboard focus indicator. Stop
click propagation so the button cannot trigger future card-level navigation.

On click, confirm with `Delete '<event title>'? This also removes its photos
and cannot be undone.`. Disable the button during the same-origin DELETE
request. On success, fade/remove the gallery card and all matching upcoming
or past cards without reloading, then show the shared success toast. On
failure, keep the card, restore the button, and show the server error in the
shared error toast. Toast text is HTML-escaped because the shared toast helper
renders its arguments as markup.

Make the content-photo cleanup explicitly use `path.basename` after verifying
the photo belongs to the expected public upload directory. Continue deleting
module-owned upload directories by validated event UUID, ignoring missing
files and logging other cleanup failures without turning a successful record
deletion into a failed request.

## Error handling and compatibility

Do not add another route or auth mechanism. Keep listing, create, edit,
filtering, and existing list-card deletion behavior intact. No `ADMIN_TOKEN`
or other Render environment variable is required. Upload-cleanup errors remain
logged and do not fail the delete response.

## Verification

- Test safe content-photo file resolution and the existing event deletion
  behavior.
- Parse `events.html` inline scripts and run the targeted event deletion tests.
- Manually verify an active admin sees and can operate the gallery control;
  a non-admin sees no control and receives 401/403 from a direct API call.
- Verify errors retain the cards and re-enable the control; successful
  deletion removes matching cards from all three sections without reload.
