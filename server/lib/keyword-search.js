// Quick keyword search shared by the Publications and Repository list routes.
//
// Every whitespace-separated term must match (AND), but each term may match any
// of the given columns (OR) — so "smith nursing" finds Smith's nursing paper.
// `columns` must be a hard-coded list from the caller; user text only ever
// reaches the query as a bound parameter.

export const MAX_TERMS = 6;
export const MAX_TERM_LENGTH = 100;

export function keywordTerms(raw) {
  return String(raw ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_TERMS)
    .map(term => term.slice(0, MAX_TERM_LENGTH));
}

/**
 * Append the keyword clauses to `sql` and their values to `params`.
 * @returns {string} the extended SQL (unchanged when `raw` is empty)
 */
export function appendKeywordSearch(sql, params, raw, columns) {
  for (const term of keywordTerms(raw)) {
    sql += ' AND (' + columns.map(col => `${col} LIKE ?`).join(' OR ') + ')';
    for (let i = 0; i < columns.length; i++) params.push(`%${term}%`);
  }
  return sql;
}
