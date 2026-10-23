// ============================================================
//  CPRI — Research Gala (final paper) shared rules
//
//  One source of truth for the Gala submission: statuses and who may move
//  between them, the document slots, field limits, and the completeness check.
//  Pure functions only (no database, no Express), so the router, the export
//  builders and the tests all use exactly the same rules — and GET
//  /api/gala/config publishes them so the form never keeps its own copy.
// ============================================================
'use strict';

import { RESEARCH_TYPES_BY_ROLE, SEMESTERS } from './research-config.js';

// ---- Statuses ----
// `draft` is a saved-but-not-submitted entry: private to the presenter, never
// shown in the admin list. The other six are the tracker the presenter sees.
export const GALA_STATUS = {
  draft: 'Draft',
  submitted: 'Submitted',
  under_checking: 'Under Checking',
  for_revision: 'For Revision',
  scheduled: 'Scheduled',
  presented: 'Presented',
  rejected: 'Rejected'
};

export const TRACKER_STATUSES = ['submitted', 'under_checking', 'for_revision', 'scheduled', 'presented', 'rejected'];

// Admin moves. A transition that is not listed is refused by the router. The
// presenter's own moves (draft -> submitted, for_revision -> submitted on
// resubmission) are made by the submit endpoint, never through this table.
export const GALA_TRANSITIONS = {
  submitted:      ['under_checking', 'for_revision', 'rejected'],
  under_checking: ['for_revision', 'scheduled', 'rejected'],
  for_revision:   ['under_checking', 'rejected'],
  scheduled:      ['presented', 'under_checking', 'for_revision', 'rejected'],
  presented:      [],
  rejected:       ['under_checking']
};

// The presenter may change their entry only in these statuses. Once an admin
// starts checking it, the entry is frozen until it is sent back For Revision.
export const EDITABLE_STATUSES = new Set(['draft', 'submitted', 'for_revision']);
// ...and may withdraw (delete) it in the same ones.
export const WITHDRAWABLE_STATUSES = EDITABLE_STATUSES;
// The schedule is shown to the presenter only once it is announced.
export const SCHEDULE_VISIBLE_STATUSES = new Set(['scheduled', 'presented']);
// Statuses that need the admin to explain themselves to the presenter.
export const REMARKS_REQUIRED_STATUSES = new Set(['for_revision', 'rejected']);

// ---- Presentation ----
export const PRESENTATION_FORMATS = {
  oral: 'Oral presentation',
  poster: 'Poster presentation'
};
// Rows saved before the final-paper form existed may still say "both".
export const LEGACY_FORMAT_LABELS = { both: 'Oral and Poster' };

export const SCHEDULE_PREFERENCES = {
  none: 'No preference',
  morning: 'Morning',
  afternoon: 'Afternoon'
};

// Research Category = the same research types the normal Presenter form offers.
export const GALA_CATEGORIES = RESEARCH_TYPES_BY_ROLE.presenter.map(t => ({ ...t }));
export const GALA_SEMESTERS = SEMESTERS.map(s => ({ ...s }));

// ---- Limits ----
export const LIMITS = Object.freeze({
  titleMax: 255,
  adviserMax: 160,
  abstractWordsMax: 250,
  abstractCharsMax: 4000,
  keywordsMin: 3,
  keywordsMax: 5,
  keywordLengthMax: 40,
  presentersMax: 10,
  coAuthorsMax: 15,
  personNameMax: 80,
  remarksMax: 1000,
  roomMax: 120,
  maxFileBytes: 20 * 1024 * 1024
});

// ---- Documents ----
// `kinds` is what the slot accepts. PDF or Word only, everywhere.
export const GALA_SLOTS = [
  { key: 'manuscript_pdf',  label: 'Final manuscript (PDF)',  kinds: ['pdf'] },
  { key: 'manuscript_docx', label: 'Final manuscript (Word)', kinds: ['word'] },
  { key: 'abstract',        label: 'Abstract',                kinds: ['pdf', 'word'] },
  { key: 'presentation',    label: 'Slides or poster',        kinds: ['pdf', 'word'] },
  { key: 'endorsement',     label: 'Adviser endorsement',     kinds: ['pdf', 'word'] },
  { key: 'ethics',          label: 'Consent / ethics clearance', kinds: ['pdf', 'word'] }
];

export const SLOT_KEYS = new Set(GALA_SLOTS.map(s => s.key));

const KIND_EXTENSIONS = {
  pdf: ['.pdf'],
  word: ['.doc', '.docx']
};

export function slotByKey(key) {
  return GALA_SLOTS.find(s => s.key === key) || null;
}

// "Slides or poster" depends on the format the presenter chose.
export function slotLabel(slot, format) {
  if (slot.key !== 'presentation') return slot.label;
  if (format === 'oral') return 'Presentation slides';
  if (format === 'poster') return 'Poster';
  return slot.label;
}

export function slotExtensions(slot) {
  return slot.kinds.flatMap(kind => KIND_EXTENSIONS[kind]);
}

export function slotAcceptText(slot) {
  const hasPdf = slot.kinds.includes('pdf');
  const hasWord = slot.kinds.includes('word');
  if (hasPdf && hasWord) return 'PDF or Word';
  return hasPdf ? 'PDF only' : 'Word only';
}

/**
 * What a file really is, from its first bytes — never from the name or the
 * MIME type the browser reported. Returns 'pdf' | 'word' | null.
 */
export function detectDocumentKind(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return null;
  // PDF readers accept the header anywhere in the first KiB.
  if (buffer.subarray(0, 1024).includes('%PDF-')) return 'pdf';
  // Legacy .doc is an OLE2 compound file.
  if (buffer.subarray(0, 8).equals(Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]))) return 'word';
  // .docx is a ZIP whose entries include word/document.xml. File names are
  // stored uncompressed in both the local headers and the central directory.
  if (buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04
    && buffer.includes('[Content_Types].xml') && buffer.includes('word/')) {
    return 'word';
  }
  return null;
}

/**
 * Is this upload acceptable for this slot? Returns an error message, or null.
 * Order matters: the cheap, specific complaints come first so the presenter
 * learns what to fix.
 */
export function checkUpload({ slot, originalName, buffer }) {
  if (!slot) return 'Unknown document type.';
  if (!buffer || buffer.length === 0) {
    return 'That file is empty (0 bytes). Choose the real document and try again.';
  }
  if (buffer.length > LIMITS.maxFileBytes) {
    return `That file is larger than ${LIMITS.maxFileBytes / (1024 * 1024)} MB.`;
  }
  const name = String(originalName || '');
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
  const allowed = slotExtensions(slot);
  if (!allowed.includes(ext)) {
    return `${slot.label} accepts ${slotAcceptText(slot)} (${allowed.join(', ')}).`;
  }
  const actual = detectDocumentKind(buffer);
  const expected = KIND_EXTENSIONS.pdf.includes(ext) ? 'pdf' : 'word';
  if (actual !== expected) {
    return `That file's contents do not match its ${ext} extension. Upload the real ${expected === 'pdf' ? 'PDF' : 'Word'} document.`;
  }
  return null;
}

// ---- Text helpers ----
export function wordCount(text) {
  return String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
}

const squash = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/**
 * A tag list from an array or a comma/newline separated string: trimmed,
 * de-duplicated (case-insensitive) and cleared of empties. `errors` reports
 * anything that had to be refused rather than silently cut.
 */
export function normalizeTags(input, { max, maxLength, label }) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[,\n;]/);
  const seen = new Set();
  const tags = [];
  const errors = [];
  for (const item of raw) {
    const tag = squash(item);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    if (tag.length > maxLength) {
      errors.push(`Each ${label} must be ${maxLength} characters or fewer.`);
      continue;
    }
    seen.add(key);
    tags.push(tag);
  }
  if (tags.length > max) {
    errors.push(`Use at most ${max} ${label}s.`);
  }
  return { tags: tags.slice(0, max), errors };
}

/**
 * Messages for any tag list that would be cut short by normalizeEntry (too many
 * tags, or a tag that is too long). The router refuses such a request outright
 * instead of silently dropping what the presenter typed.
 */
export function checkTagLists(body = {}) {
  const lists = [
    ['presenters', { max: LIMITS.presentersMax, maxLength: LIMITS.personNameMax, label: 'presenter name' }],
    ['coAuthors', { max: LIMITS.coAuthorsMax, maxLength: LIMITS.personNameMax, label: 'co-author name' }],
    ['keywords', { max: LIMITS.keywordsMax, maxLength: LIMITS.keywordLengthMax, label: 'keyword' }]
  ];
  const errors = [];
  for (const [key, opts] of lists) {
    if (body[key] !== undefined) errors.push(...normalizeTags(body[key], opts).errors);
  }
  return errors;
}

/**
 * Turn whatever the client sent into the stored shape. Never throws and never
 * trusts a type: every value is coerced, trimmed and clamped. Rule violations
 * are NOT raised here (a draft may be half-filled) — validateEntry reports them.
 */
export function normalizeEntry(body = {}) {
  const out = {};
  const has = (key) => body[key] !== undefined;

  if (has('title')) out.title = squash(body.title).slice(0, LIMITS.titleMax);
  if (has('adviser')) out.adviser = squash(body.adviser).slice(0, LIMITS.adviserMax);
  if (has('abstract')) {
    out.abstract = String(body.abstract ?? '').replace(/\r\n/g, '\n').trim().slice(0, LIMITS.abstractCharsMax);
  }
  if (has('presenters')) {
    out.presenters = normalizeTags(body.presenters, { max: LIMITS.presentersMax, maxLength: LIMITS.personNameMax, label: 'presenter name' }).tags;
  }
  if (has('coAuthors')) {
    out.coAuthors = normalizeTags(body.coAuthors, { max: LIMITS.coAuthorsMax, maxLength: LIMITS.personNameMax, label: 'co-author name' }).tags;
  }
  if (has('keywords')) {
    out.keywords = normalizeTags(body.keywords, { max: LIMITS.keywordsMax, maxLength: LIMITS.keywordLengthMax, label: 'keyword' }).tags;
  }
  if (has('program')) out.program = squash(body.program);
  if (has('category')) out.category = squash(body.category);
  if (has('presentationType')) out.presentationType = squash(body.presentationType).toLowerCase();
  if (has('schoolYear')) out.schoolYear = squash(body.schoolYear);
  if (has('semester')) out.semester = squash(body.semester).toLowerCase();
  if (has('schedulePreference')) out.schedulePreference = squash(body.schedulePreference).toLowerCase() || 'none';
  if (has('eventId')) out.eventId = squash(body.eventId);
  return out;
}

/**
 * The completeness check, run for every save (to report progress) and again,
 * authoritatively, on submit. Returns [{ step, field, message }]; empty means
 * the entry can be submitted. `entry` is the merged stored record in the
 * normalized shape; `files` the attached documents ([{ slot }]).
 */
export function validateEntry(entry, files = []) {
  const problems = [];
  const add = (step, field, message) => problems.push({ step, field, message });

  if (!entry.title) add(1, 'title', 'Title of Research is required.');

  if (!entry.presenters || entry.presenters.length === 0) {
    add(1, 'presenters', 'Add at least one presenter.');
  }

  if (!entry.program) add(1, 'program', 'Choose your Program or Department.');

  if (!entry.category) {
    add(1, 'category', 'Choose a Research Category.');
  } else if (!GALA_CATEGORIES.some(c => c.value === entry.category)) {
    add(1, 'category', 'Choose a Research Category from the list.');
  }

  if (!entry.presentationType) {
    add(1, 'presentationType', 'Choose Oral or Poster.');
  } else if (!PRESENTATION_FORMATS[entry.presentationType]) {
    add(1, 'presentationType', 'Presentation format must be Oral or Poster.');
  }

  if (!entry.adviser) add(1, 'adviser', 'Adviser is required.');

  if (!entry.schoolYear) add(1, 'schoolYear', 'Choose a School Year.');

  if (!entry.semester) {
    add(1, 'semester', 'Choose a Semester.');
  } else if (!GALA_SEMESTERS.some(s => s.value === entry.semester)) {
    add(1, 'semester', 'Choose a Semester from the list.');
  }

  if (!entry.abstract) {
    add(1, 'abstract', 'Abstract is required.');
  } else {
    const words = wordCount(entry.abstract);
    if (words > LIMITS.abstractWordsMax) {
      add(1, 'abstract', `Abstract is ${words} words. The limit is ${LIMITS.abstractWordsMax}.`);
    }
  }

  const keywordCount = (entry.keywords || []).length;
  if (keywordCount < LIMITS.keywordsMin || keywordCount > LIMITS.keywordsMax) {
    add(1, 'keywords', `Add ${LIMITS.keywordsMin} to ${LIMITS.keywordsMax} keywords (you have ${keywordCount}).`);
  }

  if (entry.schedulePreference && !SCHEDULE_PREFERENCES[entry.schedulePreference]) {
    add(1, 'schedulePreference', 'Schedule preference must be Morning, Afternoon, or No preference.');
  }

  const attached = new Set((files || []).map(f => f.slot));
  for (const slot of GALA_SLOTS) {
    if (!attached.has(slot.key)) {
      // "doc_" keeps the Abstract DOCUMENT apart from the Abstract text field.
      add(2, `doc_${slot.key}`, `Attach the ${slotLabel(slot, entry.presentationType)}.`);
    }
  }

  return problems;
}

// ---- Schedule ----
export function isValidDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

export function isValidClock(value) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(value ?? ''));
  return Boolean(m) && Number(m[1]) < 24 && Number(m[2]) < 60;
}

// "13:30" -> "1:30 PM"
export function formatClock(value) {
  if (!isValidClock(value)) return '';
  const [h, m] = value.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${suffix}`;
}

// "2026-11-20" -> "Nov 20, 2026" (no Date object, so no timezone shift)
export function formatDay(value) {
  if (!isValidDate(value)) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [y, mo, d] = value.split('-').map(Number);
  return `${months[mo - 1]} ${d}, ${y}`;
}

// JSON columns come back parsed from the driver, but a string or a null must
// not break a read.
export function parseJsonColumn(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

export function categoryLabel(value) {
  return GALA_CATEGORIES.find(c => c.value === value)?.label || value || '';
}

export function formatLabel(value) {
  return PRESENTATION_FORMATS[value] || LEGACY_FORMAT_LABELS[value] || value || '';
}
