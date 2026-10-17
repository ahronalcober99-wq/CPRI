// ============================================================
//  CPRI — File Manager folders: research files grouped by researcher
//
//  The File Manager shows one folder per researcher holding the files of all
//  their submissions, from BOTH submission forms:
//
//    * Research Submission module — `research_submission_files` rows (every
//      version, with its size and upload time);
//    * classic form — the `files` / `additionalDocs` JSON of `submissions`.
//
//  Files that no longer belong to any submission (a file row or an upload
//  folder whose submission was deleted) go to one "Unassigned" folder, so an
//  admin can see and review them instead of having them silently vanish.
//
//  Pure: it is given rows and returns folders. The route reads the database
//  and the disk; tests call this directly.
// ============================================================
'use strict';

import { clean, legacyFiles, asObject, slotLabelFor, stageForStatus, statusLabelFor } from './submission-records.js';

export const ROLE_LABELS = {
  student_researcher: 'Student',
  faculty_researcher: 'Faculty',
  non_teaching_researcher: 'Non-Teaching',
  presenter: 'Presenter',
  adviser: 'Adviser',
  cpri_staff: 'CPRI Staff',
  admin: 'Admin'
};

const timeOf = (value) => {
  const t = new Date(value == null ? 0 : value).getTime();
  return Number.isNaN(t) ? 0 : t;
};

const isoOrNull = (value) => (timeOf(value) ? new Date(value).toISOString() : null);

/**
 * @param {object} input
 * @param {object[]} input.users           id, username, email, fullName, role, studentId
 * @param {object[]} input.moduleRows      research_submissions rows
 * @param {object[]} input.moduleFiles     research_submission_files rows
 * @param {object[]} input.classicRows     submissions rows
 * @param {object[]} [input.orphanDiskFiles]  { name, size, mtime, location } found on disk
 * @param {'all'|'initial'|'final'} [input.stage]
 */
export function buildFileFolders({ users = [], moduleRows = [], moduleFiles = [], classicRows = [], orphanDiskFiles = [], stage = 'all' }) {
  // Accounts by every reference a submission may hold (id, email, username).
  const byRef = new Map();
  for (const u of users) {
    for (const ref of [u.id, u.email, u.username]) {
      const key = clean(ref).toLowerCase();
      if (key && !byRef.has(key)) byRef.set(key, u);
    }
  }

  const folders = new Map();
  const folderFor = (ownerRef, fallbackName, fallbackRole) => {
    const account = byRef.get(clean(ownerRef).toLowerCase()) || null;
    const key = account ? `user:${account.id}` : `ref:${clean(ownerRef).toLowerCase() || clean(fallbackName).toLowerCase()}`;
    if (!folders.has(key)) {
      const role = clean(account?.role || fallbackRole);
      const id = clean(account?.id || ownerRef);
      folders.set(key, {
        key,
        userId: account ? account.id : null,
        name: clean(account?.fullName || account?.username || fallbackName) || 'Unknown researcher',
        // A student ID when the profile has one; otherwise a short form of the
        // account id, enough to tell two people with the same name apart.
        displayId: clean(account?.studentId) || (id ? id.slice(0, 8) : '—'),
        role,
        roleLabel: ROLE_LABELS[role] || (role ? role.replace(/_/g, ' ') : 'Unknown'),
        submissions: [],
        submissionCount: 0,
        fileCount: 0,
        bytes: 0,
        lastUpload: null
      });
    }
    return folders.get(key);
  };

  const wantStage = (s) => stage === 'all' || !stage || s === stage;
  const filesBySubmission = new Map();
  for (const f of moduleFiles) {
    if (!filesBySubmission.has(f.submission_id)) filesBySubmission.set(f.submission_id, []);
    filesBySubmission.get(f.submission_id).push(f);
  }

  // ---- Research Submission module ----
  const moduleIds = new Set();
  for (const row of moduleRows) {
    moduleIds.add(row.id);
    const rowStage = row.stage || 'initial';
    if (!wantStage(rowStage)) continue;
    const files = (filesBySubmission.get(row.id) || []).map(f => ({
      name: clean(f.original_name) || 'document',
      label: slotLabelFor(f.slot_key),
      version: f.version == null ? null : Number(f.version),
      size: Number(f.size) || 0,
      uploadedAt: isoOrNull(f.uploaded_at),
      url: `/api/research-submissions/${encodeURIComponent(row.id)}/files/${encodeURIComponent(f.id)}`
    }));
    addSubmission(folderFor(row.owner_id, row.owner_name, row.owner_role), {
      id: row.id,
      title: clean(row.title) || 'Untitled submission',
      stage: rowStage,
      status: clean(row.status),
      statusLabel: statusLabelFor(row.status, rowStage),
      source: 'module',
      detailUrl: `/research-submission-detail.html?id=${encodeURIComponent(row.id)}`,
      createdAt: isoOrNull(row.created_at),
      files
    });
  }

  // ---- Classic form ---- (a migrated record already counted above is skipped)
  for (const row of classicRows) {
    if (moduleIds.has(row.id)) continue;
    const rowStage = stageForStatus(row.status);
    if (!wantStage(rowStage)) continue;
    const metaByUrl = new Map();
    for (const [key, meta] of Object.entries(asObject(row.files) || {})) {
      if (meta) metaByUrl.set(key, meta);
    }
    const files = legacyFiles(row).map(f => {
      const key = new URL(f.url, 'http://x').searchParams.get('key');
      const meta = metaByUrl.get(key) || {};
      return {
        name: f.original_name,
        label: f.label,
        version: null,
        size: Number(meta.size) || 0,
        uploadedAt: isoOrNull(meta.uploaded_at || row.updatedAt || row.createdAt),
        url: f.url
      };
    });
    const owner = byRef.get(clean(row.submitterId).toLowerCase());
    addSubmission(folderFor(row.submitterId, row.submitterName, owner?.role || ''), {
      id: row.id,
      title: clean(row.title) || 'Untitled submission',
      stage: rowStage,
      status: clean(row.status),
      statusLabel: statusLabelFor(row.status, rowStage),
      source: 'classic',
      detailUrl: `/submission.html?id=${encodeURIComponent(row.id)}`,
      createdAt: isoOrNull(row.createdAt),
      files
    });
  }

  // ---- Unassigned: files whose submission no longer exists ----
  const unassigned = [];
  for (const f of moduleFiles) {
    if (moduleIds.has(f.submission_id)) continue;
    unassigned.push({
      name: clean(f.original_name) || 'document',
      label: slotLabelFor(f.slot_key),
      size: Number(f.size) || 0,
      uploadedAt: isoOrNull(f.uploaded_at),
      location: `File record for missing submission ${f.submission_id}`
    });
  }
  for (const f of orphanDiskFiles) {
    unassigned.push({
      name: clean(f.name) || 'file',
      label: 'Upload folder without a submission',
      size: Number(f.size) || 0,
      uploadedAt: isoOrNull(f.mtime),
      location: clean(f.location)
    });
  }

  const list = [...folders.values()]
    .filter(f => f.submissionCount > 0)
    .map(f => ({ ...f, submissions: f.submissions.sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt)) }))
    .sort((a, b) => timeOf(b.lastUpload) - timeOf(a.lastUpload) || a.name.localeCompare(b.name));

  return {
    stage: stage || 'all',
    totals: {
      researchers: list.length,
      submissions: list.reduce((n, f) => n + f.submissionCount, 0),
      files: list.reduce((n, f) => n + f.fileCount, 0) + unassigned.length
    },
    folders: list,
    unassigned: {
      fileCount: unassigned.length,
      bytes: unassigned.reduce((n, f) => n + f.size, 0),
      files: unassigned.sort((a, b) => timeOf(b.uploadedAt) - timeOf(a.uploadedAt))
    }
  };
}

function addSubmission(folder, submission) {
  folder.submissions.push(submission);
  folder.submissionCount += 1;
  folder.fileCount += submission.files.length;
  for (const f of submission.files) {
    folder.bytes += f.size;
    if (timeOf(f.uploadedAt) > timeOf(folder.lastUpload)) folder.lastUpload = f.uploadedAt;
  }
  // A submission without files still dates the folder.
  if (!folder.lastUpload && submission.createdAt) folder.lastUpload = submission.createdAt;
}
