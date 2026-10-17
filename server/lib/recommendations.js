// ============================================================
//  CPRI — "Recommended Research"
//
//  Given one piece of research (a repository entry or a submission) and the
//  public repository, pick the related work and say why each one matches.
//
//  Ranking, strongest signal first:
//    1. more shared keywords
//    2. same category (research type)
//    3. same department / program
//  then the newer entry, then the title, so the order is stable.
//
//  Only entries that share at least one of those three are recommended — a
//  list padded with unrelated work would make the explanations meaningless.
//
//  Pure: no database, no request. The routes give it rows and it returns
//  plain objects, which is what makes the ranking testable on its own.
// ============================================================
'use strict';

import { clean } from './submission-records.js';

export const DEFAULT_LIMIT = 5;

const norm = (value) => clean(value).toLowerCase().replace(/\s+/g, ' ');

/**
 * "Climate, water; Flooding" -> [{ key: 'climate', label: 'Climate' }, …]
 * Commas, semicolons and line breaks separate keywords; a leading '#' is
 * dropped, and repeats are kept once.
 */
export function parseKeywords(value) {
  const seen = new Set();
  const out = [];
  for (const part of clean(value).split(/[,;\n]+/)) {
    const label = part.trim().replace(/^#+/, '').trim();
    const key = norm(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label });
  }
  return out;
}

/**
 * The fields the ranking compares. `categories` is a list because a module
 * submission has both a research type (the repository's category keys) and a
 * free-text category, and either may be what a repository entry holds.
 *
 * @typedef {object} Profile
 * @property {{key: string, label: string}[]} keywords
 * @property {string[]} categories   normalised
 * @property {string} department     normalised
 */
export function profileOf({ keywords, categories = [], department } = {}) {
  return {
    keywords: parseKeywords(keywords),
    categories: [...new Set(categories.map(norm).filter(Boolean))],
    department: norm(department)
  };
}

// "student_thesis" -> "Student thesis", for a category with no label of its own.
export function humanizeCategory(value) {
  const text = clean(value).replace(/[_-]+/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

function yearNumber(value) {
  const years = clean(value).match(/\d{4}/g);
  return years ? Number(years.pop()) : 0;
}

/**
 * @param {Profile} target
 * @param {object[]} candidates  repository rows (id, title, authors, keywords,
 *        category, department, yearCompleted)
 * @param {object} [options]
 * @param {number} [options.limit]
 * @param {(category: string) => string} [options.categoryLabel]
 * @param {Set<string>} [options.excludeIds]  repository ids that are the target itself
 */
export function recommend(target, candidates, { limit = DEFAULT_LIMIT, categoryLabel = () => '', excludeIds = new Set() } = {}) {
  const labelOf = (category) => categoryLabel(category) || humanizeCategory(category);
  const targetKeywords = new Set(target.keywords.map(k => k.key));
  const targetCategories = new Set(target.categories);
  const scored = [];

  for (const candidate of candidates) {
    if (!candidate || excludeIds.has(candidate.id)) continue;

    const sharedKeywords = parseKeywords(candidate.keywords).filter(k => targetKeywords.has(k.key));
    const sameCategory = Boolean(norm(candidate.category)) && targetCategories.has(norm(candidate.category));
    const sameDepartment = Boolean(target.department) && norm(candidate.department) === target.department;
    if (!sharedKeywords.length && !sameCategory && !sameDepartment) continue;

    const reasons = [];
    if (sharedKeywords.length) {
      const list = sharedKeywords.map(k => k.label).join(', ');
      reasons.push(sharedKeywords.length === 1
        ? `Shares the keyword "${list}"`
        : `Shares ${sharedKeywords.length} keywords: ${list}`);
    }
    if (sameCategory) reasons.push(`Same category: ${labelOf(candidate.category)}`);
    if (sameDepartment) reasons.push(`Same department: ${clean(candidate.department)}`);

    scored.push({
      id: candidate.id,
      title: clean(candidate.title) || 'Untitled research',
      authors: clean(candidate.authors),
      department: clean(candidate.department),
      category: clean(candidate.category),
      categoryLabel: labelOf(candidate.category),
      yearCompleted: clean(candidate.yearCompleted),
      url: `/repository-detail.html?id=${encodeURIComponent(candidate.id)}`,
      sharedKeywords: sharedKeywords.map(k => k.label),
      sameCategory,
      sameDepartment,
      reasons,
      reason: reasons.join(' · ')
    });
  }

  scored.sort((a, b) =>
    (b.sharedKeywords.length - a.sharedKeywords.length) ||
    (Number(b.sameCategory) - Number(a.sameCategory)) ||
    (Number(b.sameDepartment) - Number(a.sameDepartment)) ||
    (yearNumber(b.yearCompleted) - yearNumber(a.yearCompleted)) ||
    a.title.localeCompare(b.title)
  );

  return scored.slice(0, Math.max(0, limit));
}

// The public repository: the only pool recommendations are drawn from, so a
// recommendation can never reveal a submission the viewer may not read.
export const PUBLIC_CANDIDATES_SQL =
  "SELECT id, sourceSubmissionId, title, authors, keywords, category, department, yearCompleted, status " +
  "FROM repository WHERE LOWER(COALESCE(status, '')) IN ('approved', 'published')";

/**
 * Recommendations for one target, read from the database.
 *
 * @param {object} deps
 * @param {Function} deps.all
 * @param {Profile} deps.profile
 * @param {string} [deps.repositoryId]   the target's own repository entry, if any
 * @param {string} [deps.sourceId]       the target's submission id, if any
 */
export async function recommendationsFor({ all, profile, repositoryId = null, sourceId = null, limit, categoryLabel }) {
  const rows = await all(PUBLIC_CANDIDATES_SQL);
  const publicRows = rows.filter(r => ['approved', 'published'].includes(norm(r.status)));
  const excludeIds = new Set();
  for (const row of publicRows) {
    if ((repositoryId && row.id === repositoryId) || (sourceId && row.sourceSubmissionId === sourceId)) {
      excludeIds.add(row.id);
    }
  }
  return recommend(profile, publicRows, { limit, categoryLabel, excludeIds });
}
