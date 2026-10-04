# Render Brevo Deployment Verification Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure Render deploys the already-correct Brevo implementation and remove stale local/project artifacts that still describe the retired mail path.

**Architecture:** Leave the verified active mailer, route, startup checks, and frontend unchanged unless validation uncovers a regression. Remove obsolete tracked server snapshots, update stale deployment notes, safely remove legacy settings from the ignored local environment file and matching local logs, then reconcile dependencies. Confirm the actual Render target branch with the user before merging or pushing.

**Tech Stack:** Node.js >=18, npm, Git, Brevo HTTPS API, Render.

## Global Constraints

- Exclude `node_modules` and `.git` from project-wide marker checks.
- Never display, commit, or otherwise expose local environment values.
- Do not force-push or merge until the Render deployment branch is confirmed.
- Commit intended tracked changes with message `Switch verification email from Gmail SMTP to Brevo API`.
- Push only to the confirmed Render branch, then verify its remote history.

---

### Task 1: Clean stale source snapshots and notes

**Files:**
- Delete: `server/server.js.clean`
- Delete: `server/server.js.ck2`
- Delete: `server/server.js.bak`
- Modify: `.freebuff/run.md`
- Modify: `docs/superpowers/plans/2026-10-04-brevo-email.md`

**Interfaces:**
- The active runtime remains `server/server.js`, `server/auth.js`, and `server/lib/mail.js`.

- [x] **Step 1: Remove obsolete server snapshots**

Delete only the three named checked-in snapshots. They are not imported or used by the active startup script and contain superseded mail startup behavior.

- [x] **Step 2: Update stale notes**

Replace the mail section in `.freebuff/run.md` with a short accurate note that verification and password-reset email use Brevo, and update the previous implementation plan's retired-provider wording so the repository-wide marker scan is meaningful.

- [x] **Step 3: Verify active runtime still calls Brevo**

Confirm `server/auth.js` imports and awaits `sendVerificationEmail`, `server/lib/mail.js` POSTs to the Brevo endpoint and throws on non-success, and `server/server.js` prints only the two configuration-presence booleans.

### Task 2: Clean ignored local mail residue and reconcile dependencies

**Files:**
- Modify locally, do not commit: `.env`
- Modify locally, do not commit: matching `.freebuff/*.log` files
- Verify: `package.json`
- Verify: `package-lock.json`

**Interfaces:**
- The ignored `.env` keeps unrelated settings intact; matching credential lines are removed without printing their values.

- [x] **Step 1: Remove only retired mail settings from `.env`**

Use a script that filters lines by the two retired variable names and writes the remaining lines back without echoing file content. Do not stage `.env`.

- [x] **Step 2: Sanitize matching local logs**

For the specific `.freebuff` logs returned by the marker search, remove lines containing retired mail configuration/fallback output or verification-code disclosures. Do not print file content or commit logs.

- [x] **Step 3: Run `npm install`**

Run `npm install` at the repository root to reconcile the existing `node_modules` installation with the current package manifest and lockfile. Confirm package manifests remain valid and no new package is added.

### Task 3: Confirm deployment target, commit, and publish

**Files:**
- Commit intended tracked changes only.

**Interfaces:**
- Render deployment branch is supplied by the user.
- The commit message is exactly `Switch verification email from Gmail SMTP to Brevo API`.

- [x] **Step 1: Report repository state**

Run `git status`, `git branch --show-current`, `git remote -v`, and `git log --oneline -5`. Report the current branch and whether there are uncommitted changes; redact any embedded credentials in remote URLs if present.

- [x] **Step 2: Ask which branch Render deploys**

Ask the user for the value in Render > CPRI > Settings > Build & Deploy > Branch. Do not guess the target.

- [ ] **Step 3: Align the confirmed branch**

If the target is `main` and the current branch differs, merge the current branch into `main` without discarding commits. Otherwise use the confirmed target branch. Re-check for unexpected conflicts and stop for guidance if preserving both sides is unclear.

- [ ] **Step 4: Commit and push**

Stage only the intended tracked cleanup and documentation changes, create the exact requested commit, push the confirmed branch to `origin`, then run `git log origin/<branch> --oneline -3` and verify the new commit is present.

### Task 4: Final verification

**Files:**
- Verify all tracked project files outside `node_modules` and `.git`.
- Verify: `.env` and the named local logs without exposing their contents.

- [x] **Step 1: Search for retired mail markers**

Run the same case-sensitive whole-project searches from the initial check, excluding `node_modules` and `.git`. Confirm there are no matches in project files, and separately confirm the dependency manifests contain no retired mail package entry.

- [x] **Step 2: Check local change hygiene**

Run `git diff --check`, inspect `git status`, and confirm `.env` and logs are not staged.

- [ ] **Step 3: Report expected Render startup lines**

Tell the user to expect `[mail] BREVO_API_KEY set: true` and `[mail] BREVO_SENDER_EMAIL set: true` when both Render variables are present; otherwise the corresponding line should be `false`. State that no verification code should be printed.
