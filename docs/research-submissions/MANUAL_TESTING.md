# CPRI Research Submission Module — manual testing notes

## What was built
- `server/lib/research-config.js` — shared config: roles, stages, fields, file slots,
  statuses, transitions, and the one completeness check used by both sides.
- `server/schema.sql` — DDL for the five new tables, prefixed `research_` so they never
  collide with the legacy `submissions` table used by the generic submit.html.
- `server/research-submissions.js` — Express router mounted at `/api/research-submissions/*`,
  plus `ensureResearchSubmissionsSchema()` (the tables are created on boot).
- `server/research-submissions.test.mjs` — offline suite (no database needed).
- `server/research-submissions.db.test.mjs` — the same rules against the real database.
- `public/research-submission.html` — the form page.
- `public/research-submission-detail.html` — the detail/comment/version page.
- `ROUTES.md` — endpoint reference; `check-doc.js` proves it matches the router.
- `MANUAL_TESTING.md` — this file.

## Layout / theme
- Uses the same header/footer injection (`<div id="site-header">`, `<div id="site-footer">`)
  and same CSS bundle as the rest of the site (`assets/css/styles.css`).
- Same tokens as submit.html, contact.html, profile.html:
  `skip-link`, `page-header`, `section`, `container`, `card`, `form-message`,
  `empty-state`, `form-group`, `btn-primary`, `btn-navy`, `badge`, `contact-row`.
- Form fields render from `/api/research-submissions/form-config` — only the caller's
  role+stage is shown; the user never picks their role.

## Local run
Everything is already wired into the existing app — nothing to copy.

1. `npm install`
2. `npm run db:init` (or just start the server: the module's tables are created on boot by
   `ensureResearchSubmissionsSchema()`; `db/migrations/005_research_submissions.sql` is the
   hand-written mirror)
3. `npm start`, then open `http://localhost:3000/research-submission.html` while signed in.
   The pages live in the site's own `public/` folder, so the normal static mount serves
   them, and the server-side `MEMBER_ONLY_PAGES` guard gates both like the other member
   pages (signed out ⇒ redirect to `login.html?next=...`).
4. Tests: `npm run test:research-submissions` (offline), `npm run test:research-submissions:db`
   (needs the database), `npm run check:research-submissions-doc` (ROUTES.md vs the router).

## Auth requirement
- Every endpoint requires a valid Express session (`req.session.userId`). If you are
  signed out, the form page redirects to `login.html?next=research-submission.html`.
- The form's `/api/research-submissions/me` returns `{ id, name, role }` from the session.
  Client-supplied role / owner_id / status are ignored everywhere (only the session is trusted).

## Manual test procedure

### 1. Sign in as each role
Create or use existing accounts with these roles:
- `student_researcher` (can do Initial + Final)
- `faculty_researcher` (can do Initial + Final)
- `presenter` (Final only)
- `adviser` (assigned submissions only)
- `cpri_staff` or `admin` (all submissions, status updates, compare)

### 2. Form page — role + stage branching
- Sign in as a student: should show two tabs (Initial, Final). Initial tab has adviser +
  facilitator fields. Final tab has abstract + keywords.
- Sign in as a faculty researcher: same two tabs, but different research-type options.
- Sign in as a presenter: only Final tab, with institution + nationality fields.
- Sign in as an adviser or staff: should show "Your account type cannot submit research
  through this module." (Advisers can update assigned submissions, not create new ones here.)

### 3. File slots — required / conditional / optional
- Student Initial: 9 Required, 2 Conditional (`form_g`, `adviser_eval`), 1 Optional
  (`additional_documents`) — the counts under "File Uploads" should say exactly that.
- `form_g` is required only if "My adviser changed" is ticked, and `adviser_eval` only if
  "End of semester" is ticked. Those two checkboxes are drawn from the config
  (`conditionalFlags`), not hard-coded.
- Tick one and the live summary beside Submit should grow by one required file; untick it
  and it drops back. The server applies the same rule, so an unticked flag never demands
  the file and a ticked one does.
- Faculty only: try to upload `form_a`, `form_b`, `form_d`, `form_e1`, `form_e2`, `form_f`,
  `form_g`, `form_i` — should be rejected (403, "Your account type cannot upload this form.").
- All roles: `additional_documents` is optional; accepts PDF + Word.

### 4. Submit and draft
- Fill required fields, drop one required file, click Submit. Expect "Ready to submit."
  marker in the summary before submit.
- Leave a required field blank → inline field error + summary "X required fields missing."
- Leave a required file missing → summary "X required files missing."
- Submit → server creates the submission with status `submitted`, and the confirmation
  message stays on screen.
- "Save as draft" sends the same POST with `as_draft=1` and really does store a draft:
  the row's status is `draft`, and an empty form is accepted.
  - Open the new draft's detail page: it shows a "Submit for checking" card.
  - Press it while the draft is still incomplete → the server answers with what is
    missing (e.g. "Required field is missing: Author(s).") and the draft stays a draft.
  - Complete it (upload the required files, fill the fields), press it again → the status
    becomes `submitted` and the history shows Draft → Submitted.

### 5. Ownership isolation
- Create a submission as Student A.
- Sign in as Student B and open `research-submission-detail.html?id=<Student A's id>`.
  Should see "You don't have access to this submission."
- The detail page loads via `/api/research-submissions/:id`, which enforces ownership.
- Try editing the ID in the URL to another submission you don't own — same 403.

### 6. Upload to another user's submission
- Create a submission as Student A.
- Sign in as Student B, open the detail page's file upload section (if any) — upload
  endpoints are protected by `canWriteSubmission`, which checks ownership. Upload should
  be refused.

### 7. Download a file from another user's submission
- Create a submission as Student A, upload a file.
- Sign in as Student B and hit the download link. Must get 403.
- Confirm download only works when logged in as the owner or a reviewer/staff with access.

### 8. Status tracker + transitions
- On the form page the status tracker chips are read-only (Draft, Submitted, Under Initial
  Checking, …); on the detail page the chips show the workflow text.
- Sign in as `cpri_staff` and open someone else's submission. Should be able to change
  status, but only along allowed transitions:
  - Initial: `draft -> submitted -> under_initial_checking -> for_revision -> under_ethics_review -> approved | rejected`
  - Final: `draft -> submitted -> under_initial_checking -> for_revision -> approved -> published -> archived`
- Try an invalid transition (e.g. `submitted -> published` on an initial submission) — should
  get a 400 with "Cannot move from ... to ...".
- Try `under_initial_checking -> approved` on an initial submission — 400: approval only
  comes from the ethics decision, so a clearance is always attached.
- The owner may only move their own `draft -> submitted`; every other attempt by a
  researcher is refused (403).
- After a status change, the history list on the detail page updates (reload to confirm).

### 9. Comments / feedback
- Owner and reviewers/staff/adviser/facilitator can post comments.
- Comments are labeled by type: comment, feedback, revision_suggestion, response.
- Try posting as the owner → labeled "Researcher Response".
- Try posting as an adviser on an assigned submission → labeled "Feedback".
- A user who can't comment (e.g., student B on student A's submission) should not see the
  comment box.

### 9b. Notifications
- Sign in as staff, open a student's submission and move its status. The student's bell
  gains an in-app notification that links back to the detail page.
- Post a comment as staff → the owner is notified. Have the owner reply → they are not
  notified about their own comment.
- A new submission notifies CPRI staff / admin accounts (id-prefixed test users are ideal
  for this) and the adviser/facilitator when the typed name matches exactly one account.
- Email copies: `user_prefs.email` defaults to **off**, and quiet hours suppress the copy.
  Turn it on yourself on **profile.html#prefs → Notifications** (the bell's *Settings* gear
  goes there), or hit `PUT /api/auth/profile/prefs`. With email on, the send goes through
  Brevo — set `BREVO_API_KEY` and `BREVO_SENDER_EMAIL` first, otherwise you will see
  `[mail] notification email failed: …` in the log and the in-app row still arrives.
- The Notifications card round-trips: toggle *Email me a copy*, save, reload — it stays on.
  Confirm the effect at the source with
  `SELECT user_prefs FROM users WHERE id = '<your id>';`.
- To see the copy locally without Brevo, watch the server log for the
  `[research-submissions] quiet hours` / `[mail] notification email` lines.

### 10. Version history + compare
- Upload a revised file to the same slot → creates a new version (version number increments).
- On the detail page, version history lists version, date, uploader, files.
- Compare two versions via the compare inputs (admin only). The compare link hits
  `/api/research-submissions/:id/compare?a=&b=`.

### 11. Ethics clearance
- Move a submission into `under_ethics_review`.
- Sign in as `ethics_reviewer` and POST to `/api/research-submissions/:id/ethics` with
  `decision=approved` (optionally with a PDF clearance file). The submission moves to `approved`.
- POST with `decision=rejected` → moves to `rejected`.
- Non-reviewer attempts are rejected (403).

### 12. File integrity
- Upload a PDF and a Word doc → both accepted.
- Try uploading an `.exe` or `.html` → rejected at the file-slot validation level (extension + MIME).
- Confirm each upload creates a NEW file (random name); old versions remain.
- Without Supabase configured: the bytes are on disk under `server/data/research-submissions/`,
  the row's `storage_backend` reads `disk`, and the boot log says `local disk`.

### 12b. File durability (the Render case)
- Start with the three Supabase variables set. For a local run, point them at the project's mock:
  `node server/dev/mock-supabase-storage.mjs`, then `SUPABASE_URL=http://localhost:4599`,
  `SUPABASE_SERVICE_KEY=local-test-service-key`, `SUPABASE_BUCKET=private-files`.
- Boot log must say `[research] file storage: supabase (uploads survive a redeploy)`.
- Upload a file → its row's `storage_backend` reads `supabase`.
- Delete the whole local `server/data/research-submissions/` directory, then download the file
  again → it still comes back, because the bytes were never on that disk.
- Sign out and call the download endpoint anonymously → still `401`, and another researcher still
  gets `403`: the private bucket never bypasses the module's own authorization.

## The five required proofs (quick checklist)
- [ ] User cannot read / edit / upload / download another user's submission by changing the ID.
- [ ] Presenter cannot create an initial submission.
- [ ] Faculty user cannot upload student-only forms (form_a, form_b, form_d, form_e1, form_e2, form_f,
      form_g, form_i).
- [ ] Client-supplied role / owner_id is ignored (creation stores the real session owner_id).
- [ ] Invalid status transitions are rejected.

## Known limitations
- File storage follows the deployment: **Supabase Storage** (the private `SUPABASE_BUCKET`) when
  `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` and `SUPABASE_BUCKET` are set, and the **local disk** under
  `server/data/research-submissions/` otherwise. Render wipes its disk on every restart/redeploy, so
  on Render those three variables are what make uploaded manuscripts, receipts and clearances
  survive — without them the module still works, and the files simply disappear on the next deploy.
  The boot log says which one is live, and each row records the backend it used
  (`storage_backend`), so files uploaded before a switch stay readable afterwards.
- Notifications write in-app rows through the site's `notify()` and send email copies through
  `server/lib/mail.js`. Email delivery needs `BREVO_API_KEY` + `BREVO_SENDER_EMAIL`; without them
  the in-app notification still lands and the send is logged as a failure. The email copy also
  needs `APP_BASE_URL` (or it falls back to https://cpri.onrender.com) to build its link.
- The email copy is off until the recipient turns it on at `profile.html#prefs` — the admin
  **Email Notifications** page is a separate, admin-only screen whose toggles live in
  `localStorage`; it does not write `user_prefs` and does not enable these copies.
- The offline suite runs anywhere; the database suite skips itself with a clear reason when no
  database is reachable (`npm run test:research-submissions:db`).
- The module does NOT replace the existing `submissions` table or `submit.html`; it is a new module
  alongside it. The two flows are independent.
