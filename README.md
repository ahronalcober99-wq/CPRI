# CPRI Public Website Module

Public information website for the **Center for Policy and Research Innovations (CPRI)**.
Static front-end (HTML/CSS/JS) served by a lightweight Node.js/Express back end that
exposes a small content API and handles the contact inquiry form.

## Features

- **Home** – banner/carousel, CPRI description, featured announcements, research highlights, upcoming events, quick links.
- **About CPRI** – vision, mission, goals/objectives, organizational structure, functions, research agenda, policies.
- **Research Agenda** – institutional & program-based agenda, priority areas, downloadable documents.
- **Announcements** – research announcements, calls for papers, training/defense schedules, publication opportunities.
- **Events & Activities** – conferences, symposiums, trainings, capability building, gallery.
- **Contact** – contact info and inquiry form (POST to `/api/contact`).

## B. User Account & Login Module

Controls access to the system.

- **Registration** – Faculty Researcher, Student Researcher, Adviser, and Ethics Reviewer accounts. Ethics Reviewer accounts are created with `pending` status and require admin approval before they can log in.
- **Login / Logout** – secure username/email + password login (bcrypt-hashed, HTTP-only session cookie). One-click logout.
- **Forgot password** – request a reset link by email.
- **Password reset** – set a new password via the emailed token link (valid 1 hour).

Auth pages: `login.html`, `register.html`, `forgot.html`, `reset.html`, `account.html`, `profile.html`.

> **Email:** If SMTP is not configured (`SMTP_HOST` env var), reset links are printed to the
> server console in dev mode instead of being emailed. Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
> `SMTP_PASS`, and `MAIL_FROM` to enable real email delivery.

> **Default admin:** On first start a default admin is seeded (`admin` / `admin12345`, or set via
> `ADMIN_PASSWORD` / `ADMIN_EMAIL`). Use it to approve pending reviewers and assign roles via the admin API.

## 3. Role-Based Access Control (RBAC)

Seven roles govern what each account can do:

| Role | Key | Notes |
|------|-----|-------|
| Administrator | `admin` | Full control, user & role management (seeded). |
| CPRI Staff | `cpri_staff` | Center operations/content (created by admin). |
| Faculty Researcher | `faculty_researcher` | Self-registers; submits research. |
| Student Researcher | `student_researcher` | Self-registers; submits research. |
| Adviser | `adviser` | Self-registers; advises researchers. |
| Ethics Reviewer | `ethics_reviewer` | Self-registers but **pending admin approval**; reviews ethics. |
| Public Visitor | `public_visitor` | Anonymous site visitor (no account). |

- Permissions are defined per role in a matrix (see `GET /api/auth/rbac`).
- `requireRole(...)` middleware protects role-specific routes; `requireAdmin` for admin-only.
- Admin can assign/change any user's role and status via `PATCH /api/auth/admin/users/:id`.

## 4. User Profile Management

Each user can manage (`profile.html`):

- **Name**, **Department / Program**, **Email** (read-only), **Contact Number**, **Research Interests**.
- **Profile photo** – uploaded image (max 2 MB, saved to `public/assets/uploads/profiles/`).
- **Researches** – list of submitted and completed researches (add / remove, with status).

Endpoints: `GET/PUT /api/auth/profile`, `POST /api/auth/profile/photo`, `GET/POST /api/auth/researches`, `DELETE /api/auth/researches/:id`.

## 5. Research Submission Module

One of the core modules: researchers submit studies with metadata + documents, then track status through a workflow.

- **Online submission** – title, authors, program/department, adviser, category, research type (institutional, faculty, student thesis, capstone, feasibility, action research), abstract, keywords, school year, semester, plus manuscript + additional document uploads.
- **Required file uploads** – full manuscript, abstract, ethics certificate (if applicable), research approval form, similarity report, adviser endorsement, panel approval sheet, publication proof (if available). Manuscript, abstract, approval form, similarity report, adviser endorsement, and panel approval are required.
- **Status tracking** – `submitted → under_initial_checking → for_revision → under_ethics_review → approved → published`, plus `archived` and `rejected`. Each change is recorded in a status history with timestamp and actor.

**RBAC:** submission is allowed for `faculty_researcher`, `student_researcher`, `adviser`, `cpri_staff`. Listing shows only a user's own submissions, while `admin`, `cpri_staff`, and `ethics_reviewer` see all and can update status. File downloads are access-controlled (owner or reviewer).

Pages: `submit.html` (form), `submissions.html` (list + status), `submission.html` (detail, files, history, status update, comments, revisions).

**Comment & Feedback** (`submission.html`): threaded comments on a submission where **CPRI staff** leave comments, **advisers** provide feedback, **reviewers** (ethics reviewers) suggest revisions, and the **researcher** responds. Each comment is tagged by type based on the author's role.

**Revision Upload**: the **researcher** uploads a revised manuscript (+ optional docs); each resubmission is stored as a new **version** in the version history. Admins/reviewers can download any version to compare old vs revised. Uploading a revision sets status back to *Under Initial Checking* and records it in the history.

## 6. Research Repository Module

The institutional archive of research outputs.

- **Research archive** – completed faculty research, student theses/capstones, institutional research, action research, feasibility studies, extension-related research, and innovation projects.
- **Search & filter** – by title, author, department/program, year, keywords, and research category.
- **Record details** – title, authors, adviser, department/program, abstract, keywords, year completed, status, file availability, and citation.
- **Access levels** – `public_abstract` (abstract only), `viewable` (full text, logged-in), `downloadable` (full text, logged-in), `restricted_institutional` (any logged-in user), `restricted_staff` (CPRI staff/admin only). File access is enforced on the download route.
- **Downloadable citations** – APA (always), MLA and Institutional (auto-generated, editable by admin).

Records are created automatically when a submission reaches **Approved** or **Published** (see module 5), and can also be published manually or edited by CPRI staff/admin (`repository.html` admin panel).

Pages: `repository.html` (archive + search), `repository-detail.html` (details, citations, file access).

## Tech stack

- Front-end: static HTML, CSS, vanilla JS (no build step).
- Back-end: Node.js + Express, `express-session` (sessions), `bcryptjs` (password hashing), `nodemailer` (email).
- Database: **MySQL** (`mysql2/promise` driver) — all runtime data is stored in MySQL tables.
- Legacy: Static site content (profile, announcements, events listing, research highlights, agenda) is still served from JSON files in `server/data/`.

## Database Setup

The application requires a MySQL database. To set it up:

### 1. Install MySQL

Download and install MySQL Server from [mysql.com](https://dev.mysql.com/downloads/) or use a package manager.

### 2. Create the database and tables

```bash
mysql -u root -p < server/init-db.sql
```

This creates the `cpri` database and all required tables with the correct schema.

### 3. Configure environment variables

Create a `.env` file in the project root (or set system environment variables):

```env
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_mysql_password
DB_NAME=cpri
DB_POOL_LIMIT=10
```

If no `.env` file is present, the app defaults to `localhost:3306`, user `root`, no password, database `cpri`.

### 4. (Optional) Migrate existing JSON data to MySQL

If you have existing data in `server/data/*.json` files, you can migrate them to MySQL:

```bash
npm run seed
```

This reads each JSON file and inserts the records into the corresponding MySQL table.

## Project structure

```
CPRI3/
├── package.json
├── server/
│   ├── server.js            # Express app: static serving + API + sessions
│   ├── auth.js              # Auth: register/login/logout/forgot/reset + RBAC + admin
│   ├── submissions.js       # Research submission module (uploads, status, RBAC)
│   ├── repository.js        # Research repository module (archive, search, access, citations)
│   ├── lib/mail.js          # Email helper (nodemailer with dev fallback)
│   └── data/                # JSON content + users.json, submissions.json (runtime)
└── public/
    ├── index.html           # Home
    ├── about.html
    ├── research-agenda.html
    ├── announcements.html
    ├── events.html
    ├── contact.html
    ├── login.html           # Account login
    ├── register.html        # User registration
    ├── forgot.html          # Forgot password
    ├── reset.html           # Password reset (token)
    ├── account.html         # Session / account overview
    ├── profile.html         # User profile management
    ├── submit.html          # Research submission form
    ├── submissions.html     # List + status tracking
    ├── submission.html      # Submission detail + files
    ├── repository.html       # Public research archive + search/filter
    ├── repository-detail.html# Record details, citations, file access
    └── assets/
        ├── css/styles.css
        ├── js/main.js
        └── docs/            # place downloadable PDFs here
```

## Getting started

### Prerequisites
- Node.js 18+
- MySQL Server (see [Database Setup](#database-setup) below)

### Quick start

```bash
# 1. Install dependencies
npm install

# 2. Set up MySQL database
mysql -u root -p < server/init-db.sql

# 3. (Optional) Create .env file with your MySQL credentials
#    (see "Configure environment variables" above)

# 4. Start the server
npm start          # serves at http://localhost:3000
```

Use `npm run dev` for auto-restart on changes (Node 18+).

## Editing content

All site content lives in `server/data/*.json`:

- `profile.json` – name, description, contact details, quick links.
- `announcements.json` – announcements list.
- `events.json` – events and activities.
- `research.json` – research highlights.
- `agenda.json` – research agenda text, priority areas, downloadable document metadata.

Contact form submissions are appended to `server/data/inquiries.json`.

## API endpoints

| Method | Endpoint              | Description                       |
|--------|-----------------------|-----------------------------------|
| GET    | `/api/site`           | Site profile & contact info       |
| GET    | `/api/announcements`  | Announcements (newest first)      |
| GET    | `/api/events`         | Events (soonest first)            |
| GET    | `/api/research`       | Research highlights               |
| GET    | `/api/agenda`         | Research agenda                   |
| POST   | `/api/contact`        | Submit an inquiry (`name`,`email`,`message` required) |

### Auth endpoints (`/api/auth`)

| Method | Endpoint                        | Description                                              |
|--------|---------------------------------|----------------------------------------------------------|
| POST   | `/api/auth/register`            | Register (role: faculty/student/adviser/reviewer)        |
| POST   | `/api/auth/login`               | Login with `identifier` (username/email) + `password`    |
| POST   | `/api/auth/logout`              | Log out current session                                  |
| GET    | `/api/auth/me`                  | Get current authenticated user (401 if none)             |
| POST   | `/api/auth/forgot`              | Request password reset link by `email`                   |
| POST   | `/api/auth/reset`               | Reset password with `token` + `password`                 |
| GET    | `/api/auth/rbac`                | RBAC roles metadata + permission matrix               |
| GET    | `/api/auth/profile`             | Current user full profile (auth)                       |
| PUT    | `/api/auth/profile`             | Update name/department/contact/research interests (auth) |
| POST   | `/api/auth/profile/photo`       | Upload profile photo (multipart, auth)                 |
| GET    | `/api/auth/researches`          | List current user's researches (auth)                  |
| POST   | `/api/auth/researches`         | Add a research entry (auth)                             |
| DELETE | `/api/auth/researches/:id`      | Remove a research entry (auth)                          |
| GET    | `/api/auth/admin/reviewers/pending` | Admin: list pending ethics reviewers               |
| POST   | `/api/auth/admin/reviewers/:id` | Admin: approve/reject ethics reviewer                   |
| GET    | `/api/auth/admin/users`         | Admin: list all users                                   |
| PATCH  | `/api/auth/admin/users/:id`     | Admin: change role/status/department                    |
| DELETE | `/api/auth/admin/users/:id`     | Admin: delete user                                      |

### Research Submission endpoints (`/api/submissions`)

| Method | Endpoint                          | Description                                                   |
|--------|----------------------------------|---------------------------------------------------------------|
| POST   | `/api/submissions`               | Create submission (multipart: fields + files). Role-gated.    |
| GET    | `/api/submissions`               | List submissions (own, or all for reviewers/admins)           |
| GET    | `/api/submissions/:id`           | Submission detail (owner or reviewer)                         |
| PATCH  | `/api/submissions/:id/status`    | Update status (admin/cpri_staff/ethics_reviewer)              |
| GET    | `/api/submissions/:id/comments`  | List comments/feedback (owner or reviewer)                    |
| POST   | `/api/submissions/:id/comments`  | Post comment (owner, staff, adviser, or reviewer)             |
| POST   | `/api/submissions/:id/revisions` | Upload revised manuscript (researcher only, multipart)        |
| GET    | `/api/submissions/:id/file?key=` | Secure file download (`key` = doc key, `version` = N, or `additional`+`docId`) |

### Research Repository endpoints (`/api/repository`)

| Method | Endpoint                          | Description                                                   |
|--------|----------------------------------|---------------------------------------------------------------|
| GET    | `/api/repository`                | List archive (public) with filters: `title,author,department,program,year,keywords,category` |
| GET    | `/api/repository/:id`            | Record detail + citations + `canView`/`canDownload` flags     |
| GET    | `/api/repository/:id/file`       | Secure full-text file (access-level enforced; login required) |
| POST   | `/api/repository`                | Publish a submission/manual record (admin/cpri_staff)         |
| PATCH  | `/api/repository/:id`            | Update access level/citation/metadata (admin/cpri_staff)      |
| DELETE | `/api/repository/:id`            | Remove record (admin/cpri_staff)                              |
#   C P R I  
 