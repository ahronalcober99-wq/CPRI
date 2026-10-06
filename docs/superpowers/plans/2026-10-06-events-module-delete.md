# Research Events Module Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe, active-admin-only deletion of event cards on `events-module.html` using the existing unified event deletion route and session authentication.

**Architecture:** Reuse `DELETE /api/events/:id` in `server/server.js`, which already removes JSON-backed and database-backed event records, title duplicates, linked module rows, and uploaded files. Add UUID validation and the requested success body, then have `events-module.html` render an admin-only destructive pill next to the source badge/metadata and provide confirmation, pending state, card fade/removal, and a toast.

**Tech Stack:** Express 4, existing `requireAdmin` session middleware, MySQL through `server/db/queries.js`, JSON event store, plain browser JavaScript, shared CPRI confirmation/toast utilities, Node.js built-in test runner.

## Global Constraints

- Keep event listing, filtering, creation, and editing behavior unchanged.
- Use the existing session cookie and `requireAdmin`; do not add `ADMIN_TOKEN` or dependencies.
- Reject malformed UUID event IDs with HTTP 400, return 404 for missing records, return HTTP 200 with `{ message, id, title }` on success, and log unexpected failures before returning HTTP 500.
- Escape all event-provided strings inserted into HTML, attributes, confirmation text, or toast markup.
- Keep deletion available only to active users with the `admin` role; CPRI staff can retain their existing create/edit access.

---

## File Structure

- `server/event-deletion.js`: Add the chosen event title to the deletion result and expose UUID shape validation for the endpoint.
- `server/server.js`: Validate the path ID before deletion and return the exact success payload while retaining `requireAdmin` and existing error handling.
- `server/dev/test-event-deletion.mjs`: Cover UUID validation and returned ID/title alongside existing storage and failure cases.
- `public/events-module.html`: Resolve admin status before rendering, add the delete control and action handler, and escape rendered IDs/text.
- `public/assets/css/styles.css`: Add narrowly scoped destructive-pill and fade-out styles for the module-page event cards.

### Task 1: Validate the unified deletion endpoint and its result

**Files:**
- Modify: `server/event-deletion.js`
- Modify: `server/server.js`
- Test: `server/dev/test-event-deletion.mjs`

**Interfaces:**
- Produces `isValidEventId(id)`, returning `true` only for a UUID-shaped string.
- Produces a deletion result containing `{ id, title, contentEvents, moduleEvents, warnings }`, where `title` is the deleted record's original title and `id` is the requested UUID.
- Keeps `DELETE /api/events/:id` behind `requireAdmin`; success response is `{ message: 'Event deleted.', id, title }`.

- [ ] **Step 1: Add failing UUID and result assertions**

In `server/dev/test-event-deletion.mjs`, import `isValidEventId` and add:

```js
test('event ids must be UUIDs', () => {
  assert.equal(isValidEventId('8f72ebb2-37e6-4388-ac87-5bf684f6c55c'), true);
  assert.equal(isValidEventId('not-an-id'), false);
  assert.equal(isValidEventId('8f72ebb2-37e6-4388-ac87-5bf684f6c55'), false);
});
```

In the existing successful content-event deletion test, assert:

```js
assert.equal(deleted.id, 'content-1');
assert.equal(deleted.title, '  Policy Forum  ');
```

- [ ] **Step 2: Run the focused test to confirm it fails**

Run: `node --test server/dev/test-event-deletion.mjs`

Expected: FAIL because `isValidEventId` is not exported and the deletion result has no `id` or `title`.

- [ ] **Step 3: Add UUID validation and deletion metadata**

In `server/event-deletion.js`, add:

```js
export function isValidEventId(id) {
  return typeof id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}
```

Before returning from `deleteEventAcrossStores`, choose the title from the matched content event, otherwise the matched module event, and return it with the requested ID:

```js
return {
  id: String(eventId),
  title: contentEvent?.title || moduleEvent?.title || '',
  contentEvents: removedContentEvents,
  moduleEvents
};
```

Update `server/server.js` to import `isValidEventId`, return HTTP 400 with `{ error: 'Invalid event id.' }` before reading either store when the ID is malformed, and return only:

```js
res.json({ message: 'Event deleted.', id: deleted.id, title: deleted.title });
```

Keep the current 404 branch and the logged 500 catch.

- [ ] **Step 4: Run focused deletion tests**

Run: `node --test server/dev/test-event-deletion.mjs`

Expected: all existing deletion tests and the new UUID/result assertions pass.

- [ ] **Step 5: Check backend syntax and diff**

Run: `node --check server/event-deletion.js; node --check server/server.js; node --check server/dev/test-event-deletion.mjs; git diff --check`

Expected: all commands exit successfully.

### Task 2: Add the admin-only delete interaction to event cards

**Files:**
- Modify: `public/events-module.html`
- Modify: `public/assets/css/styles.css`

**Interfaces:**
- Consumes `GET /api/auth/me` for active admin role detection.
- Calls `DELETE /api/events/:id` with `credentials: 'same-origin'`.
- Uses `window.confirmDialog(message, 'Delete')` and `CPRI.toast(title, message, icon)`.
- Removes only the deleted card after its fade transition finishes.

- [ ] **Step 1: Render cards with safely escaped action targets**

Resolve `/api/auth/me` before calling `load()` and set `isAdmin` only when `user.role === 'admin' && user.status === 'active'`. Preserve the existing CPRI staff/admin create panel behavior independently.

Keep current escaped text. Encode the event ID in detail links and escape it before inserting into `data-event-id`. Place a small `btn btn-outline btn-sm` Delete pill next to the Admin Console badge for `source === 'content'`; for module events place the same control next to the event metadata. Give it an accessible label built from escaped text.

- [ ] **Step 2: Add focused delete and fade styles**

In `public/assets/css/styles.css`, add:

```css
.event-module-delete {
  padding: 5px 12px;
  border-color: #b23b32;
  color: #b23b32;
  font-size: .76rem;
}
.event-module-delete:hover { background: rgba(178,59,50,.08); color: #b23b32; }
.event-module-card { transition: opacity .28s ease, transform .28s ease; }
.event-module-card.is-removing { opacity: 0; transform: translateY(8px); pointer-events: none; }
```

- [ ] **Step 3: Handle confirmation, pending, success, and failure**

Delegate clicks from `recordsEl`. Build confirmation text as a string and pass it to `window.confirmDialog`, which inserts the message using `textContent`. On acceptance, disable the button, set its text to `Deleting…`, and send:

```js
const res = await fetch('/api/events/' + encodeURIComponent(eventId), {
  method: 'DELETE',
  credentials: 'same-origin'
});
```

Parse JSON with a safe `{}` fallback. For an error response, restore button enabled state and label, then call `CPRI.toast('Delete failed', escapeHtml(out.error || 'Could not delete the event.'), 'exclamation-triangle')`. For success, add `.is-removing`, remove the card after its `transitionend` or a 350ms fallback, render the empty state if no event cards remain, and call `CPRI.toast('Event deleted', escapeHtml(out.title || 'The event was deleted.'), 'check-circle-fill')`. For network/parse errors, restore the button and show a fixed escaped error message.

- [ ] **Step 4: Validate inline and server scripts**

Run:

```powershell
node --check server/event-deletion.js
node --check server/server.js
node --check server/dev/test-event-deletion.mjs
node -e "const fs=require('fs');const html=fs.readFileSync('public/events-module.html','utf8');html.split('<script>').slice(1).map(x=>x.split('</script>')[0]).forEach(s=>new Function(s));console.log('Inline scripts parsed')"
git diff --check
```

Expected: all scripts parse and `git diff --check` reports no whitespace errors.

- [ ] **Step 5: Re-run backend regression tests**

Run: `node --test server/dev/test-event-deletion.mjs`

Expected: all tests pass after the UI changes.

- [ ] **Step 6: Commit the implementation**

```bash
git add public/events-module.html public/assets/css/styles.css server/server.js server/event-deletion.js server/dev/test-event-deletion.mjs
git commit -m "feat: add admin event deletion"
```

Include the repository's required `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` trailer.
