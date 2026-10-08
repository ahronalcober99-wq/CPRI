// Card markup for the Research Repository page (repository.html).
//
// It lives in its own module so the rendering rules — above all the admin-only
// Delete button — can be unit-tested with plain Node
// (server/dev/test-repository-delete.mjs) instead of a DOM harness.
//
// repository.html loads this as an ES module and passes CPRI.escapeHtml from
// main.js, so record text is never interpolated raw.

/** Shown when the list is empty (including after deleting the last record). */
export const REPOSITORY_EMPTY_STATE = '<p class="empty-state">No research records found.</p>';

const ACCESS_BADGE = {
  public_abstract: 'Abstract only',
  viewable: 'Viewable',
  downloadable: 'Downloadable',
  restricted_institutional: 'Institutional only',
  restricted_staff: 'Staff only'
};

/**
 * Render one repository record as a card.
 *
 * @param {object} record   Row from GET /api/repository (`records[]`).
 * @param {object} [options]
 * @param {boolean} [options.isAdmin]  Only a true, server-verified admin gets the
 *   Delete button — it is never built into the markup for anyone else, so it
 *   cannot be revealed by CSS. The API enforces the role regardless.
 * @param {(text: string) => string} [options.escapeHtml]
 * @returns {string} HTML for one `.card.repo-card`
 */
export function repositoryCardHtml(record, { isAdmin = false, escapeHtml } = {}) {
  const esc = typeof escapeHtml === 'function' ? escapeHtml : value => String(value ?? '');
  const id = String(record?.id ?? '');
  const safeId = esc(id);
  const title = esc(record?.title);
  const href = 'repository-detail.html?id=' + encodeURIComponent(id);
  const access = esc(ACCESS_BADGE[record?.accessLevel] || record?.accessLevel);

  const deleteButton = isAdmin
    ? `<button type="button" class="btn btn-danger btn-soft btn-sm repo-delete" data-id="${safeId}" data-title="${title}" aria-label="Delete ${title}"><i class="bi bi-trash" aria-hidden="true"></i> Delete</button>`
    : '';

  return `
        <div class="card repo-card" data-repo-id="${safeId}" style="margin-bottom:16px;">
          <div class="repo-card-head">
            <h3 style="margin:0;"><a href="${esc(href)}">${title}</a></h3>
            ${deleteButton}
          </div>
          <div class="meta">${esc(record?.authors)} · ${esc(record?.department)} · ${esc(record?.categoryLabel || record?.category)} · ${esc(record?.yearCompleted)}</div>
          <div><span class="badge">${access}</span> <span class="badge">${esc(record?.status)}</span> ${record?.fileAvailable ? '<span class="form-note">File available</span>' : ''}</div>
        </div>`;
}
