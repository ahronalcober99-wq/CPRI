# Notification Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe per-user single and bulk notification deletion with an undoable dropdown interaction.

**Architecture:** Extend the existing notifications router with session-authenticated, UUID-validated hard-delete routes scoped to `req.session.userId`; preserve the current personal-row model so no migration is needed. Extend the shared navbar notification panel renderer and CSS with per-row delete actions, five-second undo, close/unload flushing, clear-all confirmation, empty state, and accurate unread badges. Keep API requests on the current relative `/api/...` transport, which maps to the configured Render origin and includes credentials.

**Tech Stack:** Node.js >=18, Express, MySQL/MariaDB parameterized queries, browser fetch, Bootstrap Icons, existing CSS variables.

## Global Constraints

- Notification `id` values are UUID strings in `VARCHAR(36)`; validate UUID format, not positive integers.
- Every destructive query must constrain `userId` to `req.session.userId`.
- Use parameterized SQL only.
- Keep anonymous notifications read-only and unchanged.
- No schema change or SQL migration is needed.
- Do not commit or push; leave implementation changes visible in the worktree.

---

### Task 1: Add authenticated user-scoped delete routes

**Files:**
- Modify: `server/notifications.js`

**Interfaces:**
- `DELETE /api/notifications/:id` consumes a UUID path ID and authenticated session; returns `{ ok: true }`, 400 for malformed UUID, 404 for no owned row, or 500 `{ ok: false, message }`.
- `DELETE /api/notifications` consumes an authenticated session and returns `{ ok: true, deleted: number }`.

- [x] **Step 1: Add UUID validation and the single-delete route**

Register the route next to the existing mark-read endpoints. Validate a canonical UUID with `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`; return status 400 with a JSON error if it does not match. Inside a `try`, call:

```js
const result = await run(
  'DELETE FROM notifications WHERE id = ? AND userId = ?',
  [req.params.id, req.session.userId]
);
```

If `result.affectedRows === 0`, return 404. Otherwise return `{ ok: true }`. Catch database errors, log the server-side error message, and return HTTP 500 `{ ok: false, message: 'Failed to delete notification.' }`.

- [x] **Step 2: Add the authenticated clear-all route**

Use `router.delete('/notifications', requireAuth, ...)` and:

```js
const result = await run(
  'DELETE FROM notifications WHERE userId = ?',
  [req.session.userId]
);
res.json({ ok: true, deleted: result.affectedRows });
```

On database failure, log the error and return HTTP 500 `{ ok: false, message: 'Failed to delete notifications.' }`. Never accept a user ID from request params, query, or body.

- [x] **Step 3: Verify SQL and route behavior**

Run `node --check server/notifications.js`. Inspect both SQL statements to confirm placeholders are used and the session user ID is always included. Confirm GET list/unread SQL is already user-scoped, so hard deletion removes records from both.

### Task 2: Add dropdown deletion and undo behavior

**Files:**
- Modify: `public/assets/js/main.js`

**Interfaces:**
- The backend endpoints return the responses defined in Task 1.
- Pending deletes are kept in an in-memory `Map` keyed by notification UUID with the detached row node, original index, unread state, toast node, and timer.

- [x] **Step 1: Add the clear-all header action**

Add a hidden-for-guests `Clear all` button beside `npMarkAll` in the injected notification header. On activation, call `window.confirmDialog('Delete all notifications?', 'Delete')`; on cancel, do nothing. On confirmation, cancel all single-delete timers and restore their detached rows before sending the bulk request:

```js
const res = await fetch('/api/notifications', {
  method: 'DELETE',
  credentials: 'include'
});
```

Check `res.ok` and the JSON `out.ok`. If successful, replace the personal list with the exact empty-state copy, set `notifUnread = 0`, and call `updateNotifBadge()`. If it fails, retain the restored list and show an in-dropdown error message.

- [x] **Step 2: Render a delete button for personal rows**

Render each authenticated `.np-item` as a wrapper `div` with a child navigation link and a sibling `<button type="button" class="np-delete" aria-label="Delete notification">`. Include Bootstrap Icon children `.np-delete-trash` and `.np-delete-x`; CSS selects the trash on desktop and X on touch. Keep public-feed rows read-only. The button click listener calls both `preventDefault()` and `stopPropagation()` before starting the delete flow so the anchor does not navigate and mark-read is not triggered. Attach mark-read only to the child link.

- [x] **Step 3: Implement optimistic single-delete and undo**

On delete click, store the row's current sibling index and unread state, remove it immediately, decrement `notifUnread` only if the row was unread, and update all bell badges. Append a per-deletion in-dropdown toast containing `Notification deleted` and its own `Undo` button to `#npToasts`. Start a 5,000 ms timer; Undo before expiry clears the timer, restores the row at its saved index, restores the unread count if necessary, removes that toast, and updates badges. At timer expiry, send `DELETE /api/notifications/<encoded UUID>` through:

```js
fetch('/api/notifications/' + encodeURIComponent(id), {
  method: 'DELETE',
  credentials: 'include'
});
```

Check both the HTTP status and response JSON. On failure while the page remains active, restore the row/badge and replace that toast with `Couldn't delete that notification. Try again.`; remove the error toast after a short display interval.

- [x] **Step 4: Flush pending deletes on dropdown close and page exit**

Create a single `flushPendingNotificationDeletes()` helper that clears each pending timer and sends its DELETE with `credentials: 'include'` and `keepalive: true`. Call it whenever the panel closes (same bell toggle, outside click, Escape) and from `pagehide`. Mark each entry in-flight before dispatching to avoid duplicate sends; retain the row data until its response settles so a failed request can restore the row if the document is still active. Requests continue to rely on the existing session cookie; no client-supplied user ID is sent.

- [x] **Step 5: Add exact empty state and preserve header visibility**

For an authenticated empty list, render “You're all caught up” and “New notifications will show up here.” Hide both Clear all and Mark all read for public visitors; show Clear all only when a logged-in list is nonempty. Render a `<div id="npToasts" class="np-toasts" aria-live="polite">` sibling after `#npBody` inside the panel.

### Task 3: Style delete controls, toast, and responsive states

**Files:**
- Modify: `public/assets/css/styles.css`

**Interfaces:**
- Uses `.np-delete`, `.np-delete-trash`, `.np-delete-x`, and `.np-toasts` rendered by `main.js`.

- [x] **Step 1: Add theme-aware delete affordances**

Keep the row layout intact by placing the delete button at the row edge. Use existing `--cpri-*` variables for background, text, borders, and hover/focus states. Hide the button at rest on hover-capable devices; reveal it for `.np-item:hover` and keyboard focus-within.

- [x] **Step 2: Keep an accessible control visible on touch**

Under `@media (hover: none)`, always display the compact X delete control, with a touch target large enough to activate and focus-visible styling. Confirm the row remains readable in both themes.

- [x] **Step 3: Style the undo toast and Clear all**

Add a dark, theme-aware in-dropdown toast anchored at the bottom of `.notif-panel`, with readable Undo affordance and no overlap with the scrollable list. Style Clear all red using existing theme tokens or the project’s established danger color and keep other navbar actions visually unchanged.

### Task 4: Validate routes, CORS, and manual user flows

**Files:**
- Verify: `server/notifications.js`
- Verify: `server/server.js`
- Verify: `public/assets/js/main.js`
- Verify: `public/assets/css/styles.css`
- Verify: `server/init-db.sql`
- Verify: `db/schema.sql`
- Verify: `db/schema.ts`

- [x] **Step 1: Run targeted syntax and formatting checks**

Run `node --check server/notifications.js`, `node --check public/assets/js/main.js`, and `git diff --check`.

- [x] **Step 2: Verify CORS preflight support**

Confirm `server/server.js` returns `DELETE` in `Access-Control-Allow-Methods`, echoes the browser's requested headers (including `Authorization` if requested), and returns `Access-Control-Allow-Credentials: true` for allowlisted origins. Do not change CORS unless this validation fails.

- [ ] **Step 3: Manually exercise authenticated endpoints and UI**

As an authenticated user, test single delete, Undo within five seconds, single delete after five seconds, clear-all Cancel, clear-all Delete, refresh persistence, unread badge decrements/restoration/hide behavior, and logged-out 401 behavior. Use two users to confirm one cannot delete another user's notification (expect 404 because `id` and session `userId` must both match). Confirm public feed rows have no delete controls.

- [x] **Step 4: Review final diff and SQL requirements**

Run `git diff --check` and inspect the final diff. Confirm no schema files changed and report “No SQL required” if the existing table is present. Leave all changes uncommitted and unpushed.
