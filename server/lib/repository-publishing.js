// ============================================================
//  CPRI — putting approved research in front of the public
//
//  An approved submission appears in two public places:
//
//    * the institutional repository (`repository`, repository.html), and
//    * the Publications page (`publications`, publications.html).
//
//  Both rows point back at the submission through `sourceSubmissionId`, which
//  is what makes this idempotent: publishing again refreshes the same two rows
//  instead of adding copies, and hiding finds them without guessing.
//
//  Hiding never deletes the repository entry — it moves it to a non-public
//  status (the repository only lists approved/published entries), so an admin
//  keeps the record and its access level / citation edits. The auto-added
//  publication IS removed, as the classic module always did.
//
//  Both submission stores use this: the classic `submissions` table and the
//  Research Submission Module's `research_submissions`. Each has its own
//  column names, so a row is first turned into a PublishSource by
//  fromClassicSubmission() / fromModuleSubmission().
//
//  The data layer is injected ({ get, all, insert, update, remove }), so the
//  same code runs against MySQL and against the offline tests' fake store.
// ============================================================
'use strict';

import { randomUUID } from 'crypto';
import { clean } from './submission-records.js';
import { isPublicStatus } from './submission-index.js';

/**
 * @typedef {object} PublishSource
 * @property {string} sourceId      the submission id (both stores share the id space)
 * @property {string} title
 * @property {string} authors
 * @property {string} adviser
 * @property {string} department
 * @property {string} abstract
 * @property {string} keywords
 * @property {string} category      a repository category key where there is one
 * @property {string} schoolYear
 * @property {string|Date|null} createdAt
 * @property {string} submitterId
 * @property {string} submitterName
 * @property {string} ownerRole     the submitter's role, when known
 * @property {boolean} hasManuscript
 */

export function fromClassicSubmission(sub) {
  const files = sub?.files && typeof sub.files === 'object' ? sub.files : {};
  return {
    sourceId: sub.id,
    title: clean(sub.title),
    authors: clean(sub.authors),
    adviser: clean(sub.adviser),
    department: clean(sub.program),
    abstract: clean(sub.abstract),
    keywords: clean(sub.keywords),
    category: clean(sub.researchType || sub.category),
    schoolYear: clean(sub.schoolYear),
    createdAt: sub.createdAt || null,
    submitterId: clean(sub.submitterId),
    submitterName: clean(sub.submitterName),
    ownerRole: '',
    hasManuscript: Boolean(files.manuscript)
  };
}

export function fromModuleSubmission(row) {
  return {
    sourceId: row.id,
    title: clean(row.title),
    authors: clean(row.authors),
    adviser: clean(row.adviser_id),
    department: clean(row.program),
    abstract: clean(row.abstract),
    keywords: clean(row.keywords),
    // research_type uses the same keys as the repository's categories
    // (student_thesis, capstone, …); the free-text category is the fallback.
    category: clean(row.research_type || row.category),
    schoolYear: clean(row.school_year),
    createdAt: row.created_at || null,
    submitterId: clean(row.owner_id),
    submitterName: clean(row.owner_name),
    ownerRole: clean(row.owner_role),
    // Module files are private uploads served only to people who may read the
    // submission, so the repository never offers them as a public download.
    hasManuscript: false
  };
}

function yearOf(source) {
  const years = source.schoolYear.match(/\d{4}/g);
  if (years) return years.pop();
  const created = new Date(source.createdAt || Date.now());
  return String(Number.isNaN(created.getTime()) ? new Date().getFullYear() : created.getFullYear());
}

function citationsFor(source, year) {
  return {
    apa: `${source.authors} (${year}). ${source.title}. ${source.department}.`,
    mla: `${source.authors}. "${source.title}." ${source.department}, ${year}.`,
    institutional: `CPRI (${year}). ${source.title}. ${source.authors}. ${source.department}.`
  };
}

function authorTypeFor(role) {
  if (['admin', 'cpri_staff', 'faculty_researcher', 'non_teaching_researcher'].includes(role)) return 'faculty';
  if (role === 'student_researcher') return 'student';
  return 'other';
}

/**
 * Show a submission in the repository and on the Publications page.
 *
 * @param {object} db         { get, insert, update }
 * @param {PublishSource} source
 * @param {object} [options]
 * @param {string} [options.status]  repository status to record; anything that
 *        is not public is stored as 'approved', because a published entry has
 *        to be visible
 * @param {string} [options.role]    used for the publication's author type
 *        when the submitter's own role is unknown
 * @param {string} [options.at]      ISO timestamp
 * @returns {Promise<{ repositoryId: string, publicationId: string, created: boolean }>}
 */
export async function publishSubmission(db, source, { status = 'approved', role = '', at } = {}) {
  const now = at || new Date().toISOString();
  const year = yearOf(source);
  const repoStatus = isPublicStatus(status) ? status : 'approved';

  const base = {
    title: source.title,
    authors: source.authors,
    adviser: source.adviser,
    department: source.department,
    abstract: source.abstract,
    keywords: source.keywords,
    category: source.category,
    yearCompleted: year,
    status: repoStatus,
    fileAvailable: source.hasManuscript ? 1 : 0
  };

  let repositoryId;
  let created = false;
  const existing = await db.get('SELECT * FROM repository WHERE sourceSubmissionId = ?', [source.sourceId]);
  if (existing) {
    repositoryId = existing.id;
    // Keep what an admin may have edited on the entry (citation, access level).
    const hasCitation = existing.citation && typeof existing.citation === 'object' && existing.citation.mla;
    await db.update('repository', existing.id, {
      ...base,
      ...(hasCitation ? {} : { citation: JSON.stringify(citationsFor(source, year)) }),
      updatedAt: now
    });
  } else {
    repositoryId = randomUUID();
    created = true;
    await db.insert('repository', {
      id: repositoryId,
      sourceSubmissionId: source.sourceId,
      ...base,
      accessLevel: 'downloadable',
      citation: JSON.stringify(citationsFor(source, year)),
      createdAt: now,
      updatedAt: now
    });
  }

  const publication = {
    title: source.title,
    authors: source.authors,
    journalOrConference: source.department || 'CPRI',
    publicationDate: now.slice(0, 10),
    pubType: 'institutional_journal',
    status: 'published',
    authorType: authorTypeFor(source.ownerRole || role),
    department: source.department,
    schoolYear: source.schoolYear,
    proofDocuments: JSON.stringify([]),
    submitterId: source.submitterId,
    submitterName: source.submitterName,
    sourceSubmissionId: source.sourceId,
    updatedAt: now
  };

  let publicationId;
  const existingPublication = await db.get('SELECT * FROM publications WHERE sourceSubmissionId = ?', [source.sourceId]);
  if (existingPublication) {
    publicationId = existingPublication.id;
    // Keep the original publication date; it is when the work first appeared.
    const { publicationDate, ...changes } = publication;
    await db.update('publications', existingPublication.id, {
      ...changes,
      publicationDate: existingPublication.publicationDate || publicationDate
    });
  } else {
    publicationId = randomUUID();
    await db.insert('publications', { id: publicationId, ...publication, createdAt: now });
  }

  return { repositoryId, publicationId, created };
}

/**
 * Take a submission off the public pages again. The repository entry stays
 * (under the given non-public status); the auto-added publication goes.
 *
 * @param {object} db         { get, all, update, remove }
 * @param {string} sourceId
 * @param {string} status     the non-public status to record, e.g. 'rejected'
 * @returns {Promise<boolean>} whether anything was hidden
 */
export async function hideSubmission(db, sourceId, status = 'rejected', { at } = {}) {
  const now = at || new Date().toISOString();
  let changed = false;

  const entry = await db.get('SELECT * FROM repository WHERE sourceSubmissionId = ?', [sourceId]);
  if (entry && isPublicStatus(entry.status)) {
    await db.update('repository', entry.id, {
      status: isPublicStatus(status) ? 'rejected' : status,
      updatedAt: now
    });
    changed = true;
  }

  const publications = await db.all('SELECT id FROM publications WHERE sourceSubmissionId = ?', [sourceId]);
  for (const publication of publications) {
    await db.remove('publications', publication.id);
    changed = true;
  }
  return changed;
}

/**
 * Bring the public pages in line with a submission's new status.
 *
 *   approved / published  -> published (when `autoPublish` allows it, or when
 *                            the submission is already in the repository)
 *   anything else         -> hidden, if it was shown
 *
 * @returns {Promise<'published'|'hidden'|'unchanged'>}
 */
export async function syncSubmissionVisibility(db, source, status, { autoPublish = true, role = '', at } = {}) {
  if (isPublicStatus(status)) {
    const existing = await db.get('SELECT id FROM repository WHERE sourceSubmissionId = ?', [source.sourceId]);
    if (!autoPublish && !existing) return 'unchanged';
    await publishSubmission(db, source, { status, role, at });
    return 'published';
  }
  return (await hideSubmission(db, source.sourceId, status, { at })) ? 'hidden' : 'unchanged';
}
