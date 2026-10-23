// ============================================================
//  CPRI — Repository citations
//
//  One place that builds the APA citation, so the repository form and the
//  "publish a submission" path can never disagree.
//
//  APA 7 italicises the title of a stand-alone work (a thesis, capstone or
//  report). A plain string cannot carry italics, so the title is wrapped in
//  single asterisks — `*Title*` — and the detail page turns that marker into
//  <i>…</i>. Copying strips it again (the page copies the rendered text).
// ============================================================
'use strict';

// A title that itself contains "*" would break the marker, so it is dropped.
const plainTitle = (title) => String(title ?? '').replace(/\*/g, '').trim();

/**
 * APA 7 reference for an unpublished research paper in the repository:
 *   Authors (Year). *Title* [Research paper, Department]. CPRI Repository.
 * Author names are used as entered; the title is NOT re-cased, because sentence
 * case needs a person to keep proper nouns capitalised.
 */
export function apaCitation({ authors, year, title, department }) {
  const dept = String(department ?? '').trim();
  const descriptor = dept ? `Research paper, ${dept}` : 'Research paper';
  return `${authors} (${year}). *${plainTitle(title)}* [${descriptor}]. CPRI Repository.`;
}
