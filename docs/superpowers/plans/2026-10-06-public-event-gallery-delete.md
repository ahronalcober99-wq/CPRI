# Public Event Gallery Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let active admins delete events directly from the public event gallery with confirmation, safe file cleanup, and immediate UI feedback.

**Architecture:** Reuse the existing active-admin session and `DELETE /api/events/:id` endpoint. Add a path-safe content-photo resolver using `path.basename`, then add an admin-only gallery trash button that calls the endpoint, fades out all matching event cards, and uses the shared toast and confirmation utilities.

**Tech Stack:** Express, existing session middleware, MySQL/JSON stores, Node.js built-in test runner, plain browser JavaScript, shared CPRI toast/confirmation helpers, CSS.

## Global Constraints

- Reuse the existing admin auth/session/middleware; do not add an `ADMIN_TOKEN` or dependency.
- Keep the existing delete endpoint's 400 invalid-ID, 404 missing-event, 200 `{ message, id, title }`, and logged 500 behavior.
- Use `path.basename` to constrain uploaded content-photo deletion to the event upload directory.
- Ignore `ENOENT` during file cleanup and log other cleanup failures without failing event deletion.
- Render event-provided text safely, stop delete-button propagation, and keep existing list/create/edit behavior.
- On failure, keep the cards, show the server error in an error toast, and re-enable the button.

---

## File Structure

- `server/event-deletion.js`: Provide a safe, testable resolver for content event photo paths; leave cross-store deletion semantics intact.
- `server/server.js`: Use the resolver during existing event file cleanup and preserve non-fatal cleanup logging.
- `server/dev/test-event-deletion.mjs`: Verify valid upload paths resolve within the upload folder and traversal/external paths cannot escape.
- `public/events.html`: Add admin-only gallery controls and delegate delete actions using existing auth, endpoint, confirmation, and toast systems.
- `public/assets/css/styles.css`: Add gallery-card positioning, round hover/touch trash-control styles, keyboard focus styling, and fade-out transitions.

### Task 1: Make content photo cleanup explicitly path-safe

**Files:**
- Modify: `server/event-deletion.js`
- Modify: `server/server.js`
- Test: `server/dev/test-event-deletion.mjs`

**Interfaces:**
- Add `resolveContentEventPhotoPath(photo, uploadDir)`, returning a child path under `uploadDir` only for local `/assets/uploads/events/` URLs; return `null` for unsupported, empty, or invalid paths.
- The helper uses `path.basename` on the decoded URL pathname and `path.join(uploadDir, basename)`.
- Existing `cleanupDeletedEventFiles()` continues to ignore `ENOENT`, log other cleanup errors, and return warnings without failing deletion.

- [ ] **Step 1: Add failing safe-path tests**

Import `resolveContentEventPhotoPath` from `../event-deletion.js` and add:

```js
import { join } from 'path';

test('content event photo paths stay inside the upload directory', () => {
  const uploadDir = 'C:\\uploads\\events';
  assert.equal(
    resolveContentEventPhotoPath('/assets/uploads/events/photo.jpg', uploadDir),
    join(uploadDir, 'photo.jpg')
  );
  assert.equal(
    resolveContentEventPhotoPath('/assets/uploads/events/%2e%2e%2fsecret.jpg', uploadDir),
    join(uploadDir, 'secret.jpg')
  );
  assert.equal(resolveContentEventPhotoPath('https://example.com/photo.jpg', uploadDir), null);
  assert.equal(resolveContentEventPhotoPath('', uploadDir), null);
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `node --test server/dev/test-event-deletion.mjs`

Expected: FAIL because `resolveContentEventPhotoPath` is not exported.

- [ ] **Step 3: Implement and use the safe path resolver**

At the top of `server/event-deletion.js`, add:

```js
import { basename, join } from 'path';
```

Add:

```js
export function resolveContentEventPhotoPath(photo, uploadDir) {
  if (typeof photo !== 'string' || !photo.startsWith('/') || photo.startsWith('//')) return null;
  try {
    const pathname = decodeURIComponent(new URL(photo, 'http://localhost').pathname);
    if (!pathname.startsWith('/assets/uploads/events/')) return null;
    const filename = basename(pathname);
    if (!filename || filename === '.' || filename === '..') return null;
    return join(uploadDir, filename);
  } catch {
    return null;
  }
}
```

In `server/server.js`, import the helper with the existing deletion helpers and replace the local URL/path parsing in `contentEventPhotoPath(photo)` with:

```js
return resolveContentEventPhotoPath(photo, EVENT_CONTENT_UPLOAD_DIR);
```

Keep the cleanup loops' behavior unchanged: unlink content photo files; remove module folders under their UUID; ignore `ENOENT`; log and return warnings for other cleanup errors.

- [ ] **Step 4: Run the focused tests and syntax checks**

Run:

```powershell
node --test server/dev/test-event-deletion.mjs
node --check server/event-deletion.js
node --check server/server.js
node --check server/dev/test-event-deletion.mjs
git diff --check
```

Expected: all event deletion/path tests pass and syntax/whitespace checks succeed.

### Task 2: Add the admin-only gallery deletion interaction

**Files:**
- Modify: `public/events.html`
- Modify: `public/assets/css/styles.css`

**Interfaces:**
- Reuse `isAdmin`, already derived from `/api/auth/me` and active `admin` status before gallery rendering.
- Send same-origin `DELETE /api/events/:id`; do not add credentials or token configuration outside the existing session.
- Reuse `window.confirmDialog(message, 'Delete')` and `CPRI.toast(title, escapedMessage, icon)`.
- On success, fade/remove gallery and matching upcoming/past cards using their existing `data-event-id` values.

- [ ] **Step 1: Add accessible gallery action markup**

In the gallery template in `public/events.html`, render event title with `CPRI.escapeHtml`, format the existing event date as before, and include a button only when `isAdmin` is true:

```html
<button
  type="button"
  class="event-gallery-delete"
  data-id="${CPRI.escapeHtml(String(e.id))}"
  data-title="${CPRI.escapeHtml(e.title)}"
  aria-label="Delete ${CPRI.escapeHtml(e.title)}"
  title="Delete event">
  <i class="bi bi-trash" aria-hidden="true"></i>
</button>
```

Add a stable event ID attribute on each gallery card and a dedicated gallery-card class. Do not wrap the card in a new link or change its placeholder/photo layout.

- [ ] **Step 2: Style the round trash button**

Add narrowly scoped CSS:

```css
.event-gallery-card { position: relative; transition: opacity .28s ease, transform .28s ease; }
.event-gallery-delete {
  position: absolute; top: 10px; right: 10px; z-index: 1;
  width: 40px; height: 40px; padding: 0; border: 1px solid #b23b32;
  border-radius: 50%; display: grid; place-items: center;
  background: #fff; color: #b23b32; cursor: pointer;
  opacity: 0; transition: opacity .18s ease, background .18s ease, transform .18s ease;
}
.event-gallery-card:hover .event-gallery-delete,
.event-gallery-delete:focus-visible { opacity: 1; }
.event-gallery-delete:focus-visible { outline: 3px solid var(--cpri-accent); outline-offset: 2px; }
.event-gallery-delete:hover { background: #b23b32; color: #fff; }
.event-gallery-delete:disabled { opacity: .65; cursor: wait; }
.event-gallery-card.is-removing { opacity: 0; transform: translateY(8px); pointer-events: none; }
@media (hover: none) { .event-gallery-delete { opacity: 1; } }
```

- [ ] **Step 3: Handle confirmation and deletion safely**

Add a delegated `click` handler to `gallery`. It must call `preventDefault()` and `stopPropagation()` for `.event-gallery-delete` before confirmation. Build confirmation exactly as:

```js
`Delete '${button.dataset.title}'? This also removes its photos and cannot be undone.`
```

After confirmation, disable the button and send:

```js
const response = await fetch('/api/events/' + encodeURIComponent(button.dataset.id), {
  method: 'DELETE',
  credentials: 'same-origin'
});
const result = await response.json().catch(() => ({}));
```

If the response is not successful, re-enable the button, keep all cards, and show `CPRI.toast('Delete failed', CPRI.escapeHtml(result.error || 'Could not delete the event.'), 'exclamation-triangle')`. On a network error, do the same with a fixed fallback message.

On success, collect all `.event-list-card` and `.event-gallery-card` nodes whose `data-event-id` matches the returned/requested ID, add `.is-removing`, and remove them on `transitionend` with a 350ms fallback. If no gallery cards remain, show the existing “No photos yet.” empty state. Then call `CPRI.toast('Event deleted', CPRI.escapeHtml(result.title || button.dataset.title), 'check-circle-fill')`.

- [ ] **Step 4: Validate page script, backend tests, and diff**

Run:

```powershell
node --test server/dev/test-event-deletion.mjs
node --check server/event-deletion.js
node --check server/server.js
node --check server/dev/test-event-deletion.mjs
node -e "const fs=require('fs');const html=fs.readFileSync('public/events.html','utf8');html.split('<script>').slice(1).map(x=>x.split('</script>')[0]).forEach(s=>new Function(s));console.log('Inline scripts parsed')"
git diff --check
```

Expected: all tests and syntax checks pass.

- [ ] **Step 5: Manually verify admin and non-admin behavior**

As an active admin, open `/public/events.html`, verify each gallery trash button appears on hover and remains visible on touch, tab to it and confirm the focus ring, then delete a disposable event. Confirm the prompt quotes the event title, pending state disables the button, all matching cards fade away, and a success toast appears without reload.

As a non-admin, verify the gallery has no delete controls and a direct DELETE request receives 401 when signed out or 403 when signed in without the admin role. To test a server error without deleting data, use browser devtools to make the request fail before it reaches the API and confirm the card remains and the button is restored.
