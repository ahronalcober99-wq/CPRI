# Publication Detail Access Design

## Goal

Ensure publication links open the canonical detail page and enforce public-versus-admin visibility consistently in the detail UI and API.

## Design

Homepage card titles and “View details” links, plus links on `publications.html`, navigate in the same tab to `publication-detail.html?id=<encoded id>`. DOI links are displayed only on the detail page.

The existing `GET /api/publications/:id` route remains. Active administrators (`role === 'admin'`) may retrieve full record details. Other visitors may retrieve only published publications and receive an explicit public-field projection; unpublished or missing records return 404. Public responses exclude submitter identifiers, proof document metadata and paths, and other internal fields. Proof-file downloads also require an active administrator.

The existing PATCH and DELETE routes remain at their current URLs but become administrator-only. Authentication is required and the server returns 401 for unauthenticated callers and 403 for authenticated non-admin callers.

The detail page renders read-only record fields safely with `textContent`. The DOI is linked to `https://doi.org/<DOI>` in a new tab with `rel="noopener noreferrer"` and is not shown on the homepage or publication list. Proof Documents and Manage Publication are hidden by default and shown only for admins. Missing or unavailable records produce a friendly message and a publications-page link. Back navigation uses `history.back()` only when the referrer has the same origin; otherwise it links to `publications.html`.

## Validation

Focused tests cover the public/admin response fields, unpublished and missing record behavior, PATCH/DELETE and proof-download status-code enforcement. Syntax checks and `git diff --check` are run. Manually verify the listing links, anonymous detail view, admin controls, and missing-ID state.

## Constraints

- Do not commit or push changes.
- Do not expose private publication metadata to public API responses.
- Preserve the existing publication detail route and API base URL setup.
