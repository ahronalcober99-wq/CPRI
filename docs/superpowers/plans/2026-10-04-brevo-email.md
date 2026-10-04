# Brevo Email Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use Brevo HTTPS delivery for app email, report verification-send failures, and avoid logging verification codes.

**Architecture:** Keep the current mail module as the provider boundary and use Node 18+ `fetch` with an abort timeout to send Brevo email. The auth route retains code generation and expiry, deletes a pending code if delivery fails, and the registration page uses the existing API transport with a 60-second abort signal. Port the existing standalone mail probes to Brevo, then remove the unused SMTP dependency from both manifests.

**Tech Stack:** Node.js >=18, Express, native `fetch`/`AbortController`, Brevo SMTP API, browser `fetch`.

## Global Constraints

- Use only the built-in fetch; add no packages.
- Configure delivery using `BREVO_API_KEY` and `BREVO_SENDER_EMAIL`; never hardcode keys or print variable values.
- Verification codes expire in 10 minutes and must never appear in logs.
- The registration frontend timeout is 60 seconds.
- Preserve the forgot-password route's generic response to avoid revealing whether an account exists.

---

### Task 1: Replace server mail transport

**Files:**
- Modify: `server/lib/mail.js`
- Modify: `server/auth.js`
- Modify: `server/server.js`
- Modify: `.env.example`
- Modify: `docs/SETUP-DEPLOY-TEST.md`

**Interfaces:**
- `sendVerificationCode(email, code)` sends the specified verification subject/body using Brevo and rejects on timeout or non-2xx response.
- `sendResetEmail(email, token, baseUrl)` sends the existing reset link email using Brevo; it catches and logs delivery failures without including the reset URL, so the caller continues to return its existing generic response.

- [x] **Step 1: Replace the Gmail transport in `server/lib/mail.js`**

The mail module uses a private `sendBrevoEmail(to, subject, htmlContent)` helper that POSTs JSON to `https://api.brevo.com/v3/smtp/email`, sets the three required headers (`accept`, `content-type`, `api-key`), uses `sender: { name: 'CPRI', email: process.env.BREVO_SENDER_EMAIL }`, and aborts after 10 seconds. Throw `Error(\`Brevo ${res.status}: ${await res.text()}\`)` for non-2xx responses and always clear the timer.

Keep the verification email content exactly: subject `Your CPRI verification code` and HTML `<p>Your verification code is <b>${code}</b>.</p><p>It expires in 10 minutes.</p>`. Log only `[mail] verification email sent to` and the recipient after a successful response. Have `sendResetEmail` build its existing reset URL and content, send with `sendBrevoEmail`, catch delivery failures to log the error message without the reset URL, and resolve normally so the forgot-password route still returns its generic response.

- [x] **Step 2: Make verification-send failure invalidate the code**

In `server/auth.js`, retain `randomSixDigitCode()` and `Date.now() + CODE_TTL_MS`; after storing the code, call `await sendVerificationCode(email, code)` inside `try`. On failure, call `codeStore.delete(email)`, log `[mail] send failed:` with `err.message` only, and return HTTP 500 `{ ok: false, message: 'Could not send the email. Please try again.' }`. Return HTTP 200 `{ ok: true, message: 'Code sent! Check your inbox (also check spam).' }` on success.

Remove the attempt/stored-code logs and the `verify-code` missing/mismatch diagnostics that print submitted or stored codes. Retain non-sensitive expiry and successful-verification messages.

- [x] **Step 3: Update startup mail diagnostics**

In `server/server.js`, retain only boolean configuration-presence output:

```js
console.log('[mail] BREVO_API_KEY set:', Boolean(process.env.BREVO_API_KEY));
console.log('[mail] BREVO_SENDER_EMAIL set:', Boolean(process.env.BREVO_SENDER_EMAIL));
```

Do not run an SMTP startup check.

- [x] **Step 4: Update email setup and registration documentation**

In `.env.example`, replace Gmail SMTP placeholders and instructions with `BREVO_API_KEY` and `BREVO_SENDER_EMAIL` placeholders. In `docs/SETUP-DEPLOY-TEST.md`, document these variables, note that Brevo requires a verified sender, and remove the sample server-console verification code in favor of checking the recipient's inbox.

- [x] **Step 5: Check changed server modules**

Run `node --check server/lib/mail.js`, `node --check server/auth.js`, and `node --check server/server.js`. Confirm code generation and `CODE_TTL_MS` were not altered.

### Task 2: Port email test utilities and remove unused dependency

**Files:**
- Modify: `test-email.js`
- Modify: `test-email.cjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Both test utilities accept an optional recipient argument (defaulting to `BREVO_SENDER_EMAIL`) and require `BREVO_API_KEY` plus `BREVO_SENDER_EMAIL`.

- [x] **Step 1: Update the ESM test utility**

Replace the Gmail SMTP verification/send flow in `test-email.js` with a single native `fetch` POST to the Brevo endpoint, using the configured sender and optional command-line recipient (default the recipient to `BREVO_SENDER_EMAIL`). Report only whether the variables are set, report HTTP errors without printing credentials, and exit nonzero on missing configuration or failed send.

- [x] **Step 2: Update the CommonJS test utility**

Apply the same Brevo request and error behavior in `test-email.cjs`. Use the Node 18+ global `fetch`; default the recipient to `BREVO_SENDER_EMAIL` and do not require a package.

- [x] **Step 3: Remove unused mail dependency**

Keep `package.json` and `package-lock.json` free of the removed SMTP dependency. Do not regenerate unrelated lockfile sections.

- [x] **Step 4: Check test utility syntax and dependency metadata**

Run `node --check test-email.js` and `node --check test-email.cjs`. Search both manifests and all runtime/test utilities for obsolete mail provider imports and credentials.

### Task 3: Make the register flow report errors and time out

**Files:**
- Modify: `public/register.html`

**Interfaces:**
- The send-verification endpoint response is `{ ok: true, message }` or `{ ok: false, message }`.
- `postJSON(url, payload, signal)` passes the optional signal to `CPRI.apiFetch`.

- [x] **Step 1: Pass an abort signal through the registration helper**

Add an optional third `signal` argument to `postJSON` and include it in the `CPRI.apiFetch` options. When the signal aborts, return an error result that the click handler can render; preserve existing API base, credentials, JSON handling, and generic errors for network failures.

- [x] **Step 2: Enforce a 60-second send timeout and honor response status**

In the send-code click handler, create an `AbortController`, start a 60,000 ms timer, and pass its signal to `postJSON`. Treat either `!res.ok` or `out.ok !== true` as failure, using `out.message` first and then `out.error` as the displayed message. On success, keep showing the server's message and start the existing cooldown. On any failure, show the error and re-enable the button with its normal label. Clear the timer in `finally`. Remove the send-code response `console.log`.

- [x] **Step 3: Check inline JavaScript and button states**

Review the send-code flow to confirm each error path returns from `Sending…` to the enabled `Send Verification Code` state, while success still reveals the code row and starts the cooldown. Confirm the timeout signal reaches the actual browser `fetch` through `CPRI.apiFetch`.

### Task 4: Final validation

**Files:**
- Verify: `server/lib/mail.js`
- Verify: `server/auth.js`
- Verify: `server/server.js`
- Verify: `public/register.html`
- Verify: `test-email.js`
- Verify: `test-email.cjs`
- Verify: `package.json`
- Verify: `package-lock.json`
- Verify: `.env.example`
- Verify: `docs/SETUP-DEPLOY-TEST.md`

- [x] **Step 1: Run targeted syntax checks**

Run `node --check` on each modified JavaScript file. Extract and parse the inline script from `public/register.html` if a repository-supported HTML/JS checker is available.

- [x] **Step 2: Search for remaining unsafe or stale email paths**

Search the project for obsolete SMTP configuration, packages, fallback logging, and verification-code log messages. Confirm no match remains in active mail code or the test utilities.

- [x] **Step 3: Review the final diff**

Run `git diff --check` and inspect `git diff --stat` plus the edited diff to ensure the changes are limited to Brevo delivery, safe failure handling, frontend timeout/error state, dependency cleanup, and the related design/plan documents.
