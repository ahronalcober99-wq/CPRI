// ============================================================
//  CPRI — every submission, from both stores, for the admin dashboard
//
//  Submissions arrive through two forms that write to two tables (see
//  lib/submission-records.js). The admin dashboard's totals, status chart and
//  record lists used to count only the classic `submissions` table, so work
//  sent through the Research Submission form never showed up there.
//
//  listAllSubmissions() is the one list those figures are now built from:
//
//    * both stores, in the shared record shape;
//    * each submission once — a record migrated into the module keeps its id
//      in both tables and is merged, never double counted;
//    * drafts left out — a draft has not been submitted yet;
//    * whether the record is in the public repository (and if not, whether it
//      has an entry that is currently hidden).
//
//  Pure apart from the injected `all`, so tests can drive it with any data
//  layer. A store that cannot be read contributes nothing rather than failing
//  the whole dashboard.
// ============================================================
'use strict';

import {
  clean,
  statusLabelFor,
  STAGE_LABELS,
  firstApprovalAt,
  listLegacySubmissions,
  mergeSubmissionRecords
} from './submission-records.js';

export const PUBLIC_REPOSITORY_STATUSES = new Set(['approved', 'published']);

export function isPublicStatus(status) {
  return PUBLIC_REPOSITORY_STATUSES.has(clean(status).toLowerCase());
}

async function safeAll(all, sql, log) {
  try {
    return await all(sql);
  } catch (err) {
    log('[submission-index] read failed:', err.message);
    return [];
  }
}

// One module row -> the shared record shape, with the fields the dashboard
// needs (the module router has a fuller version that also carries files and
// comments for the monitoring dashboards).
function moduleSummary(row, approvedAt) {
  const stage = row.stage || 'initial';
  const createdAt = row.created_at || null;
  return {
    id: row.id,
    title: clean(row.title) || 'Untitled submission',
    status: clean(row.status),
    statusLabel: statusLabelFor(row.status, stage),
    stage,
    stageLabel: STAGE_LABELS[stage] || stage,
    studentName: clean(row.owner_name || row.owner_id) || '—',
    studentId: clean(row.owner_id),
    ownerRole: clean(row.owner_role),
    authors: clean(row.authors),
    program: clean(row.program),
    category: clean(row.category),
    research_type: clean(row.research_type),
    school_year: clean(row.school_year),
    semester: clean(row.semester),
    adviser: clean(row.adviser_id),
    abstract: clean(row.abstract),
    keywords: clean(row.keywords),
    created_at: createdAt,
    updated_at: row.updated_at || createdAt,
    approved_at: approvedAt || null,
    source: 'module',
    sources: ['module'],
    detailUrl: `/research-submission-detail.html?id=${encodeURIComponent(row.id)}`
  };
}

/**
 * @param {{ all: Function, includeDrafts?: boolean, log?: Function }} deps
 * @returns {Promise<object[]>} newest first
 */
export async function listAllSubmissions({ all, includeDrafts = false, log = console.error } = {}) {
  const [moduleRows, historyRows, repoRows, legacy] = await Promise.all([
    safeAll(all, 'SELECT * FROM research_submissions ORDER BY created_at DESC', log),
    safeAll(all, 'SELECT submission_id, to_status, changed_at FROM research_status_history ORDER BY changed_at ASC', log),
    safeAll(all, 'SELECT id, sourceSubmissionId, status FROM repository', log),
    listLegacySubmissions({ all, log })
  ]);

  const historyBy = new Map();
  for (const entry of historyRows) {
    if (!historyBy.has(entry.submission_id)) historyBy.set(entry.submission_id, []);
    historyBy.get(entry.submission_id).push(entry);
  }

  const moduleRecords = moduleRows.map(row => moduleSummary(row, firstApprovalAt(historyBy.get(row.id))));
  let records = mergeSubmissionRecords(moduleRecords, legacy);
  if (!includeDrafts) records = records.filter(r => r.status !== 'draft');

  const repoBySource = new Map();
  for (const entry of repoRows) {
    if (entry.sourceSubmissionId && !repoBySource.has(entry.sourceSubmissionId)) {
      repoBySource.set(entry.sourceSubmissionId, entry);
    }
  }

  return records.map(record => {
    const entry = repoBySource.get(record.id) || null;
    return {
      ...record,
      repositoryId: entry ? entry.id : null,
      repositoryStatus: entry ? clean(entry.status) : null,
      // "In the repository" means the public can find it there; an entry that
      // was hidden again (rejected later) does not count.
      inRepository: Boolean(entry && isPublicStatus(entry.status))
    };
  });
}
