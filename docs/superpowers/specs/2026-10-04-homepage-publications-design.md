# Homepage Publications Design

## Goal

Replace the homepage's always-empty featured-research display with a secure,
responsive view of real published publication records, optionally curated by
staff, with counts, client-side faculty/student filtering, and clear loading,
empty, and error states.

## Findings

The homepage currently fetches `/api/research` and `/api/publications`, then
calls `CPRI.buildResearch(research, publications)`. `buildResearch` only renders
the research argument; it ignores the publications response and displays the
empty message when there are no research records. The publications API returns
`{ publications: [...] }` from `GET /api/publications`; its current `/stats`
endpoint calculates statistics from all publication statuses.

The MySQL/TiDB `publications` table has `id`, `title`, `authors`,
`journalOrConference`, `publicationDate`, `volume`, `issue`, `pages`, `doi`,
`publicationLink`, `indexingStatus`, `pubType`, `status`, `authorType`,
`department`, `schoolYear`, `proofDocuments`, submitter fields, and created /
updated timestamps. Year is derived from `publicationDate`; Faculty/Student is
derived from `authorType`; there is no separate level column. Local, national,
and international level labels are derived from the corresponding
`pubType` values. `publicationLink` and `doi` provide external links; proof
files are stored in `proofDocuments`.

The publication form at `public/publication-form.html` supports both create
and edit. `server/publications.js` currently permits staff/admin and record
owners to manage publication records. The active MySQL schema is
`server/init-db.sql`; `db/schema.sql` is a structure-only MySQL mirror. The
Drizzle schema/migration is PostgreSQL-style and is a distinct schema path.
Production TiDB metadata could not be inspected locally, so whether the live
table already has a `featured` column is unknown.

## Chosen approach

Add a dedicated, narrow `/api/publications/featured` endpoint rather than
loading all records and filtering them on the homepage. The endpoint lets the
server enforce published-only visibility, return only homepage fields, apply
ordering and limits, compute counts consistently, and cache the response.
Keep publication curation in the existing publication form, rather than
creating a second admin-only editor or a separate static list.

## API and publication curation

Add public `GET /api/publications/featured?limit=6` before the existing
`/:id` route. The optional limit defaults to 6 and accepts integers from 1
through 12; malformed or out-of-range values receive HTTP 400. Return:

```json
{
  "items": [
    {
      "id": "publication-id",
      "title": "Publication title",
      "authors": "Author names",
      "venue": "Journal or conference",
      "year": "2026",
      "type": "faculty",
      "level": "international",
      "link": "https://example.org/publication"
    }
  ],
  "counts": { "total": 21, "faculty": 12, "student": 9 }
}
```

Both items and counts use `status = 'published'` only. Item ordering is
`featured` descending, then extracted publication year descending, then
`createdAt` descending. The endpoint returns no internal fields or proof
metadata. `type` is derived from `authorType`; `level` maps local/national/
international journal publication types and uses an `other` value when no
level can be inferred. `link` prefers a valid publication link, then a DOI
link; convert a bare DOI identifier into an HTTPS DOI URL; if neither external
link exists, use the published-PDF proof route when a `published_pdf` proof is
present. If there is no external or PDF destination, the homepage constructs
the requested `publications.html#<id>` destination. PDF links are returned as
the relative `/api/publications/:id/file/:filename` API route and resolved
through the existing CPRI API base on the frontend.

Responses are cached in process for 60 seconds by requested limit. Publication
create, update, and delete actions invalidate the cache. Existing production
CORS already permits GET for the GitHub Pages origin with credentials, and the
Render-hosted same-origin flow needs no CORS change.

Add `featured TINYINT NOT NULL DEFAULT 0` to the canonical MySQL schema and
MySQL mirror. Do not run a production ALTER. Before deployment, inspect
`information_schema.columns`; if the column is absent, run:

```sql
ALTER TABLE publications
  ADD COLUMN featured TINYINT NOT NULL DEFAULT 0;
```

The exact conditional run sequence will be included in the implementation
report. Existing create-if-absent DDL does not alter an already-existing table,
so applying the ALTER to Render/TiDB is a separate deployment prerequisite.
Do not modify PostgreSQL migration history for this MySQL/TiDB runtime change.

Add a “Feature on homepage” checkbox to the existing publication form. It is
visible only to `admin` and `cpri_staff`; the backend independently authorizes
changes to `featured`, so record owners cannot set it by crafting a request.
Only published publications may be featured. When a featured record is changed
to another status, clear its feature flag. Reject attempts to feature a
seventh publication with an explicit conflict response and message. Enforce
the six-slot constraint under concurrent staff actions, not only in the
browser.

## Homepage rendering

Keep the existing section heading and subtitle. Replace the current research
search/topic toolbar with All, Faculty, and Student filter chips. The loaded
items are filtered locally without further requests. Show the API's published
total/faculty/student counts beneath the heading and a “View all N
publications” link.

While loading, show three skeleton cards; after five seconds show
“Waking up the server, this can take a moment...” without aborting the request.
When the API returns zero items, show “No featured research yet”. For request
or response errors, show “Couldn't load research right now.” and a Retry
button. Use the existing configured API base transport.

Render cards using DOM nodes and `textContent` for all API-controlled text.
Each card contains Faculty/Student and level badges, a title clamped to three
lines, venue, authors and year, and a “View details” link. External URLs use
new tabs with `rel="noopener noreferrer"`; without an external URL, use
`publications.html#<id>`. Use existing theme tokens and fonts, a responsive
auto-fit grid with minimum 220px cards, and a one-column layout on narrow
screens.

## Error handling and security

All database values are bound parameters. The limit is validated before query
execution. Staff authorization and the six-featured cap are enforced on the
server. External destinations must be limited to safe HTTP(S) links; render
database text with `textContent`, not raw HTML. Database/schema errors are
reported through the API error path and shown as the homepage retry state.

## Validation

Add focused tests for:

- Only published records appear and all counts include only published rows.
- Ordering puts featured items first, then newest publication year and creation
  date.
- Requested limits default to six, accept 1–12, and reject invalid values.
- API output contains only public homepage fields.
- Cached responses are reused for 60 seconds and invalidated by publication
  mutations.
- Only staff/admin can change feature flags; attempting a seventh feature
  returns a clear error, and concurrent changes cannot exceed six.
- Client checks for card rendering, All/Faculty/Student filters, true empty
  results, API retry, five-second wake-up hint, hostile title text, safe links,
  and narrow/mobile layout.

No production SQL is run, and no commit or push is made.
