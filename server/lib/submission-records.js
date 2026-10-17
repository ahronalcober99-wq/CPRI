// ============================================================
//  CPRI — submission records, from either store
//
//  The site keeps research submissions in two places:
//
//    * `submissions`          — the classic module (public/submission.html),
//                               owner in `submitterId`, with files, versions,
//                               comments and status history in JSON columns.
//    * `research_submissions` — the Research Submission Module, owner in
//                               `owner_id`, with files, comments and status
//                               history in their own tables.
//
//  A monitoring dashboard (facilitator-dashboard.html) has to show every record
//  in the system, so it reads BOTH stores. That only works if a classic row and
//  a module row come back in the same shape — that shape lives here, next to the
//  status labels, so the two can never drift apart.
//
//  This module is pure: no database, no request. It is given rows and returns
//  records.
// ============================================================
'use strict';

import { extname } from 'path';
import { INITIAL_STATUSES, FINAL_STATUSES, FORM_CONFIG } from './research-config.js';

export const clean = (value) => String(value == null ? '' : value).trim();

// The ONE place a status becomes a human label. `stage` picks the list, because
// the two workflows share most statuses but not all (published/archived exist
// only in the final workflow, ethics review only in the initial one). An
// unknown status is shown as itself — never hidden, never renamed.
export function statusLabelFor(status, stage) {
  const list = stage === 'initial' ? INITIAL_STATUSES : FINAL_STATUSES;
  return list.find(s => s.value === status)?.label || status || '';
}

export const STAGE_LABELS = { initial: 'Initial Submission', final: 'Final Submission' };

// Classic `original_name` values were stored URL-encoded ("CPRI%20-%20x.docx").
export function readableName(value, fallback = 'document') {
  const raw = clean(value) || fallback;
  if (!raw.includes('%')) return raw.slice(0, 255);
  try {
    return decodeURIComponent(raw).slice(0, 255);
  } catch {
    return raw.slice(0, 255);
  }
}

// ---- Classic slot keys ----------------------------------------------------
// Classic slot keys -> module slot keys. An unknown key is kept as-is so its
// document still shows up, labelled by its own name, instead of being dropped.
const SLOT_ALIASES = {
  abstract: 'abstract',
  adviserEndorsement: 'adviser_endorsement',
  approvalForm: 'approval_sheet',
  ethicsCertificate: 'ethics_certificate',
  panelApproval: 'panel_approval',
  publicationProof: 'publication_proof',
  similarityReport: 'similarity_report',
  additionalDocs: 'additional_documents',
  additional: 'additional_documents'
};

export function legacySlotKeyFor(key, originalName) {
  const k = clean(key);
  if (k === 'manuscript' || SLOT_ALIASES[k] === 'manuscript') {
    // The classic "manuscript" slot accepted Word and PDF; the module keeps
    // them in separate slots, so pick by the file's own extension.
    return extname(readableName(originalName)).toLowerCase() === '.pdf'
      ? 'manuscript_pdf'
      : 'manuscript_docx';
  }
  return SLOT_ALIASES[k] || k.slice(0, 80) || 'additional_documents';
}

// The classic-only slots, so a reader sees "Similarity Report" and not
// "similarity_report". Keyed by the module's own slot name, which is what every
// record carries (see legacySlotKeyFor).
const SLOT_LABELS = {
  manuscript_docx: 'Manuscript (Word)',
  manuscript_pdf: 'Manuscript (PDF)',
  abstract: 'Abstract',
  adviser_endorsement: 'Adviser Endorsement',
  approval_sheet: 'Approval Sheet',
  ethics_certificate: 'Ethics Certificate',
  panel_approval: 'Panel Approval',
  publication_proof: 'Publication Proof',
  similarity_report: 'Similarity Report',
  additional_documents: 'Additional Documents'
};

export function legacySlotLabel(key) {
  return slotLabelFor(key);
}

// Module slot keys -> the label the form itself shows. Built from FORM_CONFIG so
// a renamed slot label reaches every reader at once.
const SLOT_LABEL_BY_KEY = new Map();
for (const config of Object.values(FORM_CONFIG)) {
  for (const stage of Object.values(config || {})) {
    for (const slot of stage?.slots || []) {
      if (slot?.slot_key && !SLOT_LABEL_BY_KEY.has(slot.slot_key)) {
        SLOT_LABEL_BY_KEY.set(slot.slot_key, slot.label || slot.slot_key);
      }
    }
  }
}

// One label for a document, whichever store its key came from, under either
// spelling (the classic form wrote "approvalForm", the module stores
// "approval_sheet").
export function slotLabelFor(key) {
  const k = clean(key);
  if (!k) return 'Document';
  if (SLOT_LABEL_BY_KEY.has(k)) return SLOT_LABEL_BY_KEY.get(k);
  if (SLOT_LABELS[k]) return SLOT_LABELS[k];
  // A classic key that is not a module slot name yet ("similarityReport").
  return SLOT_LABELS[legacySlotKeyFor(k, '')] || k;
}

// ---- JSON columns ---------------------------------------------------------
// The database layer parses the JSON columns it knows about, so a value here is
// normally already an object/array — but a string is still handled, because the
// classic columns are free-form and an unparsed one must not crash a dashboard.
export function readJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

export function asArray(value) {
  const parsed = readJson(value, []);
  if (Array.isArray(parsed)) return parsed;
  return parsed && typeof parsed === 'object' ? [parsed] : [];
}

export function asObject(value) {
  const parsed = readJson(value, null);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

// Classic files are a map of slot key -> file metadata, with extra documents in
// their own array. Flattened into the same list shape the module's file rows
// produce, plus the classic download URL for each one.
export function legacyFiles(row) {
  const map = asObject(row?.files) || {};
  const out = [];
  for (const [key, meta] of Object.entries(map)) {
    if (!meta || typeof meta !== 'object' || !meta.storage_path) continue;
    out.push(classicFile(row.id, key, meta));
  }
  for (const doc of asArray(row?.additionalDocs)) {
    if (!doc || typeof doc !== 'object' || !doc.storage_path) continue;
    out.push(classicFile(row.id, 'additional', doc));
  }
  return out;
}

function classicFile(submissionId, key, meta) {
  const base = `/api/submissions/${encodeURIComponent(submissionId)}/file`;
  const query = key === 'additional' && meta.id
    ? `?key=additional&docId=${encodeURIComponent(meta.id)}`
    : `?key=${encodeURIComponent(key)}`;
  const slotKey = legacySlotKeyFor(key, meta.original_name);
  return {
    // `slot_key` is the module's name for this field, so a reader that also
    // handles module records sees one consistent vocabulary.
    slot_key: slotKey,
    label: slotLabelFor(slotKey),
    original_name: readableName(meta.original_name, 'document'),
    version: null,
    url: base + query,
    // The classic route streams a preview itself; the same URL without the
    // download applies, because this route always answers as an attachment.
    source: 'classic'
  };
}

export function legacyComments(row) {
  return asArray(row?.comments).map(c => ({
    id: c.id || '',
    comment_type: c.type || c.comment_type || 'comment',
    author_id: c.authorId || '',
    author_name: c.authorName || '—',
    author_role: c.authorRole || '',
    body: c.body || '',
    created_at: c.createdAt || null
  }));
}

// When a record was first approved (or published), from its status history.
// Classic history entries are `{ status, at }`; module rows are
// `{ to_status, changed_at }`. Null when it never was.
export function firstApprovalAt(history) {
  for (const entry of asArray(history)) {
    const status = clean(entry?.status ?? entry?.to_status);
    if (status === 'approved' || status === 'published') {
      return entry?.at ?? entry?.changed_at ?? null;
    }
  }
  return null;
}

// The classic module has no stages; a status that only exists in the Final
// workflow (published, archived) means the record belongs there.
export function stageForStatus(status) {
  const value = clean(status);
  const inFinal = FINAL_STATUSES.some(s => s.value === value);
  const inInitial = INITIAL_STATUSES.some(s => s.value === value);
  return inFinal && !inInitial ? 'final' : 'initial';
}

/**
 * One classic `submissions` row -> the same record shape a module row produces.
 *
 * @param {object} row          a row from `submissions`
 * @param {object} [options]
 * @param {(ownerRef: unknown) => boolean} [options.isOwner]  does this row belong to the caller?
 * @param {{id: string, fullName?: string, username?: string, role?: string}} [options.account]
 *        the account behind `submitterId`, when it still exists
 */
export function normalizeLegacySubmission(row, { isOwner, account } = {}) {
  const status = clean(row?.status);
  const stage = stageForStatus(status);
  const files = legacyFiles(row);
  const comments = legacyComments(row);
  const createdAt = row?.createdAt || row?.updatedAt || null;
  return {
    id: row?.id,
    title: clean(row?.title) || 'Untitled submission',
    status,
    statusLabel: statusLabelFor(status, stage),
    stage,
    stageLabel: STAGE_LABELS[stage] || stage,

    // "Student name": the account behind the record when it still exists, so a
    // renamed account shows its current name; otherwise the name the classic
    // form recorded. Never blank — a card always has a name on it.
    studentName: clean(account?.fullName || account?.username || row?.submitterName) || '—',
    studentId: clean(account?.id || row?.submitterId),
    ownerRole: clean(account?.role),
    authors: clean(row?.authors),
    program: clean(row?.program),
    category: clean(row?.category),
    research_type: clean(row?.researchType),
    school_year: clean(row?.schoolYear),
    semester: clean(row?.semester),
    adviser: clean(row?.adviser),
    facilitator: '',
    abstract: clean(row?.abstract),
    keywords: clean(row?.keywords),

    fileCount: files.length,
    files,
    commentCount: comments.length,
    comments,

    created_at: createdAt,
    updated_at: row?.updatedAt || createdAt,
    approved_at: firstApprovalAt(row?.statusHistory),
    source: 'classic',
    // A record copied into the module by the migration exists in both stores;
    // the list route widens this to ['module', 'classic'] for those.
    sources: ['classic'],
    // Where "Open full page" goes for a record that only exists in the classic
    // store: the classic detail page, which takes the id as a query parameter.
    detailUrl: `/submission.html?id=${encodeURIComponent(row?.id || '')}`,
    isOwner: typeof isOwner === 'function' ? Boolean(isOwner(row?.submitterId)) : false
  };
}

const recordTime = (value) => {
  const time = new Date(value == null ? 0 : value).getTime();
  return Number.isNaN(time) ? 0 : time;
};

/**
 * Module records and classic records -> one list, one entry per id.
 *
 * A migrated record keeps its id in both tables, so one record can be stored
 * twice — and the copies can drift (a status moved on the classic page after
 * the copy was taken). `sources` names every store that holds it, and the copy
 * that was updated last wins, so nobody sees a status the record has moved
 * past. Newest first.
 */
export function mergeSubmissionRecords(moduleRecords = [], legacyRecords = []) {
  const byId = new Map();
  for (const record of moduleRecords) {
    if (record?.id) byId.set(record.id, record);
  }
  for (const record of legacyRecords) {
    if (!record?.id) continue;
    const existing = byId.get(record.id);
    if (!existing) {
      byId.set(record.id, record);
      continue;
    }
    const sources = [...new Set([...(existing.sources || [existing.source]), record.source])];
    const newest = recordTime(record.updated_at) > recordTime(existing.updated_at) ? record : existing;
    newest.sources = sources;
    byId.set(record.id, newest);
  }
  return [...byId.values()].sort((a, b) => recordTime(b.created_at) - recordTime(a.created_at));
}

/**
 * Every classic submission, newest first, in the shared record shape.
 *
 * A failure is never allowed to empty the dashboard: if this table cannot be
 * read (a fresh database without it, for instance) the caller simply gets no
 * legacy records to merge in, and the module's own records still render.
 *
 * @param {{ all: Function, isOwner?: Function, log?: Function }} deps
 */
export async function listLegacySubmissions({ all, isOwner, log = console.error } = {}) {
  let rows = [];
  try {
    rows = await all('SELECT * FROM submissions ORDER BY createdAt DESC');
  } catch (err) {
    log('[submission-records] could not read the classic submissions table:', err.message);
    return [];
  }
  if (!rows.length) return [];

  // A classic row stores the submitter's id at the time it was written, and an
  // account can be renamed afterwards. Resolving the account (by id, then by
  // email or username for rows written by another version of the form) is what
  // puts a current, readable name on the card.
  const byRef = new Map();
  try {
    const users = await all('SELECT id, username, email, fullName, role FROM users');
    for (const user of users) {
      for (const ref of [user.id, user.email, user.username]) {
        const key = clean(ref).toLowerCase();
        if (key && !byRef.has(key)) byRef.set(key, user);
      }
    }
  } catch (err) {
    log('[submission-records] could not read accounts for legacy owners:', err.message);
  }

  return rows.map(row => normalizeLegacySubmission(row, {
    isOwner,
    account: byRef.get(clean(row?.submitterId).toLowerCase()) || null
  }));
}
