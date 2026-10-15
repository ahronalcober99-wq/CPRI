# CPRI Research Submission Module — plan

Scope: build submission module for cpri.onrender.com (front + back, shared theme).
Existing site: Node/Express + MySQL + express-session only (file store), no S3,
no /api/me, no supabaseStorage route for this, existing profile.html pattern is
the layout reference. Do not change unrelated pages.

Stack as-is: plain HTML/CSS/JS, Node/Express, Express session auth (req.session.userId),
multer memory/disk storage, direct disk uploads (not Supabase — no Supabase route,
storage/submission-files.js is unused/inactive).

Deliverables:
- server/lib/research-config.js          shared role/slot/config, FE + BE use
- server/research-submissions.js        new router: /api/research-submissions/*
- server/research-submissions.test.mjs  tests (role/ID/slot/transition isolation)
- public/research-submission.html       form page
- public/research-submission-detail.html detail page
- server/research-submissions.js mounts in server/server.js

Status model (untouched submissions table):
- submissions table already exists with status VARCHAR(40) DEFAULT 'submitted'.
- Keep existing statuses unless requested: submitted/under_initial_checking/
  for_revision/under_ethics_review/approved/published/archived/rejected.
- New module reuse same table? Spec asks NEW data model. Reuse submissions table
  to avoid breaking existing submit.html? No — spec says BUILD NEW module with
  its own tables. Create new tables: research_submissions + supporting tables.
  Separately from existing submissions table (which is for the generic submit.html).

Data model (new tables):
- research_submissions(id, owner_id, stage, title, authors, program, institution,
  nationality, category, research_type, school_year, semester, adviser_id,
  facilitator_id, abstract, keywords, status, created_at, updated_at)
- research_submission_files(id, submission_id, slot_key, original_name, stored_path,
  mime, size, version, uploaded_by, uploaded_at)
- research_comments(id, submission_id, author_id, author_role, body, parent_id, created_at)
- research_status_history(id, submission_id, from_status, to_status, changed_by, changed_at)
- research_ethics_clearances(id, submission_id, reviewer_id, decision, file_path, decided_at)

Access control:
- owner-only for student/faculty/presenter researchers
- adviser/facilitator ("Research Adviser / Facilitator"): all student submissions, read-only
  (comments only; no status changes)
- ethics_reviewer: only "Under ethics review"
- cpri_staff/admin: all
- role/owner_id/status ignored from client, taken from session

Endpoints (prefix /api/research-submissions):
- GET  /api/me                         reuse? No — build /api/research-submissions/me
  returning { id, name, role }
- GET  /api/research-submissions/form-config
- POST /api/research-submissions
- GET  /api/research-submissions
- GET  /api/research-submissions/:id
- PUT  /api/research-submissions/:id
- POST /api/research-submissions/:id/files
- GET  /api/research-submissions/:id/files/:fileId
- GET  /api/research-submissions/:id/versions
- GET  /api/research-submissions/:id/compare?a=&b=
- POST /api/research-submissions/:id/comments
- PATCH /api/research-submissions/:id/status
- POST /api/research-submissions/:id/ethics

Front end:
- public/research-submission.html
- public/research-submission-detail.html
- /600px stack labels above inputs
- maroon primary button + secondary "Save as draft"
- presenters: no Initial tab

Tests:
- cannot read/edit/upload/download another's submission by ID
- presenter cannot create initial
- faculty cannot upload student-only forms (A,B,D,E,F,G,I)
- client role/owner_id ignored
- invalid status transitions rejected

Local run: node server/server.js (existing), PORT=3000.
