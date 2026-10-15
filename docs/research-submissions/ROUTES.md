# Research Submission Module — endpoint reference

Prefix: `/api/research-submissions` (paths below are relative to it).

All endpoints require a valid Express session (`req.session.userId`). The server trusts
only the session; client-supplied `role` / `owner_id` / `status` are ignored everywhere.

`npm run check:research-submissions-doc` compares the headings in this file with the
routes registered in `server/research-submissions.js` and exits non-zero if they diverge.

## Authentication & access control

- **Session only.** `req.session.userId` is the identity. The account (and its role) is
  read from the `users` table on each request; a role sent by the client is never used.
- **Researcher roles (own submissions only):** `student_researcher`, `faculty_researcher`,
  `non_teaching_researcher`, `presenter`.
- **Monitoring roles (read + comment only):** `adviser` (the portal's "Research Adviser /
  Facilitator") and `facilitator`. Both see every `student_researcher` submission, plus any
  faculty record that names them (`adviser_id` / `facilitator_id === user.id`). They may
  comment but never change a status — see `STATUS_CHANGE_ROLES`.
- **Staff / admin (all submissions):** `cpri_staff`, `admin`.
- **Reviewer-only actions:** `ethics_reviewer` can act only on submissions whose status is
  `under_ethics_review`.

## Roles, stages and statuses

| Role | Initial | Final |
|---|---|---|
| `student_researcher` | yes | yes |
| `faculty_researcher` | yes | yes |
| `non_teaching_researcher` (faculty rules) | yes | yes |
| `presenter` | **no** | yes |

Initial: `draft`, `submitted`, `under_initial_checking`, `for_revision`,
`under_ethics_review`, `approved`, `rejected`.
Final: `draft`, `submitted`, `under_initial_checking`, `for_revision`, `approved`,
`published`, `archived`, `rejected`.

Student initial workflow: `draft` → `submitted` → `under_initial_checking` →
(`for_revision` → back to checking) → `under_ethics_review` → `approved` | `rejected`.
Approval is only produced by the ethics decision, so an initial submission can never be
`approved` without a recorded Ethics Clearance.
Faculty initial skips straight to ethics: `submitted` → `under_ethics_review`.
Final papers: `submitted` → checking → `approved` → `published` → `archived`.

## Endpoints

### GET /me
- Auth: `requireAuth`.
- Returns `{ id, name, role }` for the signed-in user (the module's answer to `/api/me`).
- Used by the front end to know who is calling before fetching form-config.

### GET /form-config
- Auth: `requireAuth`.
- Returns the fields + file slots for the caller's role and stage only.
- `role` is taken from the session user. Presenters receive only the Final stage.
- Shape: `{ role, roleLabel, stages: [{ stage, stageLabel, fields, slots }], conditionalFlags, links }`.
- Each slot is published as `{ slot_key, label, kind, required, conditional, condition_key }` —
  `conditional` is a boolean and `condition_key` names the flag that turns it on, because
  functions cannot cross JSON. `conditionalFlags` lists those flags with labels.
- Each field is published as `{ key, label, type, required, conditional, condition_key }`,
  plus `options` for the selects. `type` is `text`, `textarea`, `select` or `url`; a `url`
  field is validated as an http(s) link (see `missingRequirements()`).
- A conditional **field** works like a conditional slot: it is only required while its flag
  is true. `adviser_eval_link` (students, both stages) is required at the end of the semester.
- `links` carries the buttons the page should offer, currently
  `{ adviserEvalForm }` — the value of `ADVISER_EVAL_FORM_URL`, or `null` when the deployment
  has not set one (the field is still there to paste a link into).
- No stages for the caller → 403 ("Your account type cannot submit research through this module.").

### GET /:id/form-config
- Auth: `requireAuth`, plus `canReadSubmission` → 403 if the caller cannot read it.
- Describes ONE submission's upload form: its own stage and **owner** role, so the detail
  page renders resubmission controls without hard-coding a slot list.
- Returns `{ submissionId, stage, ownerRole, editable, canUpload, slots }`.
- `canUpload` is true only for the owner while the status is `draft`, `submitted` or
  `for_revision` — the same rule `POST /:id/files` enforces.

### POST /
- Auth: `requireRoles(...SUBMITTER_ROLES)` → `student_researcher`, `faculty_researcher`,
  `non_teaching_researcher`, `presenter`, `adviser`, `cpri_staff`, `admin`.
- Body + multipart files. `stage` is required and must be `initial` or `final`.
- Presenter + `initial` → 403. A role without that stage in `FORM_CONFIG` → 403.
- `as_draft=1` stores an incomplete record under status `draft`: required fields and
  required slots are **not** enforced (slot legality, extension, MIME and size always are).
- Otherwise the shared completeness check runs: required fields (including conditional ones
  whose flag is true) → 400 with `{ error, field }`; a `url` field that is not an http(s) link
  → 400 with `{ error, field }`; required slots (including conditional ones whose flag is
  true) → 400 with `{ error, slot }`.
- A field only that role+stage declares is ever stored: the student-only
  `adviser_eval_link` is dropped from a faculty or presenter request.
- Any uploaded slot not allowed for the role+stage → 400.
- Creates the submission (`draft` or `submitted`), a status-history row, and one file row
  per uploaded slot (random name, never overwrites an older version; the row records the
  storage backend that holds it — see File storage below).
- Returns `201` with `{ message, submission, files }`.

### GET /
- Auth: `requireAuth`.
- Researchers: own submissions only.
- Advisers / facilitators: every `student_researcher` submission, plus any record that names
  them via `adviser_id` / `facilitator_id`.
- `cpri_staff` / `admin`: all submissions.
- Returns `{ submissions: [...] }` where each item includes `isOwner`.

### GET /:id
- Auth: `requireAuth`.
- Reads the submission + files + comments + versions + status history.
- Access controlled by `canReadSubmission` → 403 if not allowed, 404 if not found.

### PUT /:id
- Auth: `requireAuth`.
- Allowed only while the status is `draft`, `submitted` or `for_revision`.
- Only fields from the stage's field list are writable; everything else (including
  client-supplied `role`, `owner_id`, `status`) is ignored.
- Returns the updated submission.

### POST /:id/files
- Auth: `requireAuth` + writable status + `canReadSubmission`.
- Uploads to a single slot and stores it as the next version for that slot.
- Validates:
  - The slot is part of the module, and part of the caller's form for this stage.
  - Faculty (including non-teaching) cannot upload student-only forms (`form_a`, `form_b`,
    `form_d`, `form_e1`, `form_e2`, `form_f`, `form_g`, `form_i`) → 403.
  - Extension + MIME + content guard → 400.
- Returns `201` with `{ message, file }`.

### GET /:id/files/:fileId
- Auth: `requireAuth`.
- Access controlled (same as reading the submission). The file is looked up **within** the
  submission in the URL, so a file id from someone else's submission cannot be fetched.
- Streams the file from disk with `Content-Disposition: attachment`.
- 404 if the row or the file on disk is missing.

### GET /:id/versions
- Auth: `requireAuth`, access controlled.
- Returns `{ versions: [{ version, date, uploader, files }] }` — every version is kept.

### GET /:id/compare?a=&b=
- Auth: `requireRoles('admin')` only.
- Returns two versions side by side: `{ submissionId, title, comparing: { a, b }, versionA, versionB }`.

### POST /:id/comments
- Auth: `requireAuth`.
- Allowed commenters: the owner, anyone who can read the submission (which for an adviser or
  facilitator means every student record they monitor), `cpri_staff`, `admin`, `ethics_reviewer`.
  Commenting never implies the right to change a status.
- Comment type is inferred from the session role: adviser/facilitator → `feedback`,
  ethics_reviewer → `revision_suggestion`, owner researcher → `response`, else `comment`.
- Parent comments supported via `parent_id`.

### PATCH /:id/status
- Auth: `requireAuth`. Two ways in:
  - a reviewer/staff account (`STATUS_CHANGE_ROLES` = `cpri_staff`, `ethics_reviewer`,
    `admin`) moves a submission along, or
  - the **owner** hands in their own `draft` (`draft` → `submitted`), which runs the same
    completeness check as `POST /` against the stored fields and files, returning
    `400 { error, draftIncomplete: true }` when something is missing.
- An `adviser` / `facilitator` is refused here outright (`403`): the role monitors and
  comments, it never approves, rejects or otherwise moves a submission.
- Additional guard: `ethics_reviewer` only while `under_ethics_review`.
- The transition is validated against `validTransitionsFor(stage, ownerRole)` → 400 if invalid.
- `under_ethics_review` → `approved` is refused here (`400`): approval must come from
  `POST /:id/ethics` so an Ethics Clearance is always attached.
- Writes a status-history row with `from_status`, `to_status`, `changed_by`.
- Returns the updated submission.

### POST /:id/ethics
- Auth: `requireRoles('ethics_reviewer')` only.
- Body: `{ decision: 'approved' | 'rejected', note? }`, optional `ethics_clearance` PDF
  (multipart). Non-PDF clearance files → 400.
- Only allowed when the submission is `under_ethics_review` → 403 otherwise.
- Inserts a `research_ethics_clearances` row, moves the submission to `approved` or
  `rejected`, and writes a status-history row.

## Notifications

Every status change, comment and ethics decision writes an in-app notification through the
site's own `notify()` (`server/notifications.js`) and sends an email copy through
`sendNotificationEmail()` (`server/lib/mail.js`) — the same helper the reset and
verification mails use.

- Recipients: the submission's owner for status changes, comments and ethics decisions;
  CPRI staff / admin when a new submission arrives; a student's adviser or facilitator
  when the typed adviser/facilitator value matches exactly one active account of that role.
- Nobody is notified about their own action.
- The email copy follows the account's own preferences (`users.user_prefs`, read with
  `normalizePrefs` from `server/auth.js`): `email` is **off by default**, and quiet hours
  suppress the copy. In-app follows `inApp` (on by default).
- Users set those preferences on `profile.html#prefs` (**Notifications** card), which reads and
  writes the same column through `GET`/`PUT /api/auth/profile/prefs`. The bell's Settings
  gear deep-links there. The module never writes `user_prefs` itself — it only obeys it.
- Both writers are injected into the router factory, so tests assert on them offline.
- Notification failures are logged and swallowed — they can never fail the request that
  triggered them.

## File storage

Where the bytes live depends on the deployment, decided per file by
`server/lib/research-storage.js`:

- **Supabase Storage** — the private bucket named by `SUPABASE_BUCKET` — when
  `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` and `SUPABASE_BUCKET` are set. This is what a
  Render deployment needs: Render wipes its local disk on every deploy.
- **The local disk** under `server/data/research-submissions/<submission-id>/files/`
  otherwise, which is what development uses (no Supabase project required).

Every row records which one holds it (`research_submission_files.storage_backend`,
`research_ethics_clearances.storage_backend`; `disk` by default, which is correct for every
row written before the column existed). Switching a deployment either way therefore keeps
older uploads readable. The boot log states the live choice:

```
[research] file storage: supabase (uploads survive a redeploy)
[research] file storage: local disk under server/data — set SUPABASE_URL, ...
```

- Generated names are random UUIDs; every version is preserved — a re-upload is version N+1.
- Nothing is served from a public folder, and no public or signed URL is ever handed out:
  downloads stream through the authorized `/files/:fileId` endpoint, always as an
  attachment. A file recorded in the bucket on a server that has no bucket configured
  answers `502` with a readable message — never an empty file and never a crash.
- Max file size: 20 MB.
- Accepted types per slot: `.pdf` for PDF slots, `.doc`/`.docx` for Word slots,
  `.pdf`/`.doc`/`.docx` for `additional_documents`. Unknown extensions are rejected.

## Conditional fields and slots

One slot and one field are conditional for students (both stages):
- `form_g` (a file) → required only when `adviser_changed` is true.
- `adviser_eval_link` (a link) → required only when `end_of_semester` is true.

The adviser evaluation is filled in through a designated Google Form, so the end-of-semester
requirement is the **link**, not a document; `adviser_eval` remains available as an optional
scanned copy. Both the field and the slot read the same flag, so they cannot disagree.

The form posts the flags as multipart text fields; only the exact string values
`true` / `1` / `yes` / `on` count (`"false"` is not truthy). The server re-evaluates the
conditions with the same
[`missingRequirements()`](server/lib/research-config.js) helper that the form pages use to
tag and count slots, so the two can never disagree.
