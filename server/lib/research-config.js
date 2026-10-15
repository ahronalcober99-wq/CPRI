// ============================================================
//  CPRI — Research Submission Module
//  Shared config: roles, stages, fields, file slots, statuses,
//  transitions.
//  Used by BOTH the back-end router and the front-end pages, so the
//  form UI and the validation logic stay in sync from one source of
//  truth (no copy-paste of slot lists anywhere).
// ============================================================
'use strict';

// ---- Researcher roles (own submissions) ----
// `non_teaching_researcher` is the "non-teaching" faculty account the portal
// already has in its users table: it follows the faculty rules (initial +
// final, faculty file slots, faculty research types).
export const RESEARCHER_ROLES = new Set([
  'student_researcher',
  'faculty_researcher',
  'non_teaching_researcher',
  'presenter']);

export const SUBMITTER_ROLES = new Set([
  'student_researcher',
  'faculty_researcher',
  'non_teaching_researcher',
  'presenter',
  'adviser',
  'cpri_staff',
  'admin'
]);

// Roles that are treated as "faculty" everywhere (slots, research types, and
// the "cannot upload student-only forms" rule).
export const FACULTY_ROLES = new Set([
  'faculty_researcher',
  'non_teaching_researcher'
]);

export function isFacultyRole(role) {
  return FACULTY_ROLES.has(role);
}

// ---- Reviewer / staff roles (read + comments) ----
// Adviser and facilitator belong here for READING and COMMENTING only. A
// Research Adviser / Facilitator monitors student work and leaves comments or
// recommendations; approving, rejecting and every other status move are gated
// separately by STATUS_CHANGE_ROLES below.

export const REVIEWER_ROLES = new Set([
  'adviser',
  'facilitator',
  'cpri_staff',
  'ethics_reviewer',
  'admin'
]);

// Roles that may actually move a submission through its statuses. Adviser and
// facilitator are deliberately absent: their remit ends at commenting, so they
// get a 403 from PATCH /:id/status like any other outsider.

export const STATUS_CHANGE_ROLES = new Set([
  'cpri_staff',
  'ethics_reviewer',
  'admin'
]);

// ---- Settings-only roles (read submissions for the setting they own) ----
// Advisers and facilitators are assigned to submissions; an adviser that is
// not assigned to any submission still has the role but sees nothing useful
// until a submission is assigned to them.
export const ASSIGNED_ROLES = new Set(['adviser', 'facilitator']);

// ---- Stages ----
// student_researcher and faculty_researcher go through Initial → Final.
// presenter goes through Final only (Research Gala).
export const STAGES = new Set(['initial', 'final']);

export const HAS_INITIAL_STAGE = new Set([
  'student_researcher',
  'faculty_researcher',
  'non_teaching_researcher'
]);
export const HAS_FINAL_STAGE  = new Set([
  'student_researcher',
  'faculty_researcher',
  'non_teaching_researcher',
  'presenter'
]);

// ---- File-type policy ----
// Word slots accept .doc and .docx.
// PDF slots accept .pdf only.
// additional_documents (optional) accepts PDF + Word.
export const WORD_EXTENSIONS = new Set(['.doc', '.docx']);
export const PDF_EXTENSIONS  = new Set(['.pdf']);
export const OPEN_DOC_EXTENSIONS = new Set(['.pdf', '.doc', '.docx']);

// ---- File-slot definitions (used by FORM_CONFIG below) ----
// These reference makeSlot, so makeSlot is defined first.

// ---- makeSlot helper (defined before the slot lists so they can use it) ----
// `conditionKey` names the flag that decides a conditional slot, so the front
// end can render the control and can show "Conditional" instead of guessing.
// Functions cannot travel over JSON, so the key — not the predicate — is what
// /form-config publishes.
const makeSlot = (key, label, kind, required, conditional = null, conditionKey = null) => ({
  slot_key: key,
  label,
  kind,            // 'word' | 'pdf' | 'optional'
  required,         // true | false
  conditional,      // null | function({ stage, role, data }) => boolean
  condition_key: conditionKey
});

// The flags a conditional slot depends on. Add one here when a new conditional
// slot is introduced: the router and the form pages both read this list.
export const CONDITIONAL_FLAGS = [
  { key: 'adviser_changed', label: 'My adviser changed' },
  { key: 'end_of_semester', label: 'End of semester (adviser evaluation due)' }
];

// Student — Initial stage slots
const STUDENT_INITIAL_SLOTS = [
  makeSlot('manuscript_docx',  'Manuscript (Word)',  'word',     true),
  makeSlot('manuscript_pdf',   'Manuscript (PDF)',   'pdf',      true),
  makeSlot('form_a',           'Form A',              'pdf',      true),
  makeSlot('form_b',           'Form B',              'pdf',      true),
  makeSlot('form_d',           'Form D',              'pdf',      true),
  makeSlot('form_e1',          'Form E1',             'pdf',      true),
  makeSlot('form_f',           'Form F',              'pdf',      true),
  // Conditional: required only when the adviser changed / at end of semester.
  makeSlot('form_g',           'Form G',              'pdf',      true,   (ctx) => ctx.data?.adviser_changed, 'adviser_changed'),
  makeSlot('defense_photos',   'Defense Photos',      'pdf',      true),
  makeSlot('official_receipt', 'Official Receipt',   'pdf',      true),
  // The adviser evaluation is filled in through a Google Form, so what the
  // student owes at the end of the semester is its LINK (the conditional url
  // field below), not a document. A scanned copy can still be attached here.
  makeSlot('adviser_eval',     'Adviser Evaluation (optional copy)', 'pdf', false),
  makeSlot('additional_documents', 'Additional Documents', 'optional', false)
];

// Student — Final stage slots
const STUDENT_FINAL_SLOTS = [
  makeSlot('manuscript_docx',  'Manuscript (Word)',  'word',     true),
  makeSlot('manuscript_pdf',   'Manuscript (PDF)',   'pdf',      true),
  makeSlot('abstract',         'Abstract',            'pdf',      true),
  makeSlot('approval_sheet',   'Approval Sheet',      'pdf',      true),
  makeSlot('form_a',           'Form A',              'pdf',      true),
  makeSlot('form_b',           'Form B',              'pdf',      true),
  makeSlot('form_d',           'Form D',              'pdf',      true),
  makeSlot('form_e2',          'Form E2',             'pdf',      true),
  makeSlot('form_f',           'Form F',              'pdf',      true),
  makeSlot('form_g',           'Form G',              'pdf',      true,   (ctx) => ctx.data?.adviser_changed, 'adviser_changed'),
  makeSlot('form_i',           'Form I',              'pdf',      true),
  makeSlot('defense_photos',   'Defense Photos',      'pdf',      true),
  makeSlot('official_receipt', 'Official Receipt',   'pdf',      true),
  // See STUDENT_INITIAL_SLOTS: the end-of-semester requirement is the Google
  // Form LINK; this stays available as an optional attachment.
  makeSlot('adviser_eval',     'Adviser Evaluation (optional copy)', 'pdf', false),
  makeSlot('data_instruments', 'Data and Instruments (PDF)', 'pdf', true),
  makeSlot('additional_documents', 'Additional Documents', 'optional', false)
];

// Faculty — Initial stage slots
const FACULTY_INITIAL_SLOTS = [
  makeSlot('manuscript_docx',  'Manuscript (Word)',  'word',     true),
  makeSlot('manuscript_pdf',   'Manuscript (PDF)',   'pdf',      true),
  makeSlot('additional_documents', 'Additional Documents', 'optional', false)
];

// Faculty — Final stage slots
const FACULTY_FINAL_SLOTS = [
  makeSlot('manuscript_docx',  'Manuscript (Word)',  'word',     true),
  makeSlot('manuscript_pdf',   'Manuscript (PDF)',   'pdf',      true),
  makeSlot('abstract',         'Abstract',            'pdf',      true),
  makeSlot('approval_sheet',   'Approval Sheet',      'pdf',      true),
  makeSlot('data_instruments', 'Data and Instruments (PDF)', 'pdf', true),
  makeSlot('additional_documents', 'Additional Documents', 'optional', false)
];

// Presenter — Final stage slots
const PRESENTER_FINAL_SLOTS = [
  makeSlot('manuscript_docx',  'Manuscript (Word)',  'word',     true),
  makeSlot('manuscript_pdf',   'Manuscript (PDF)',   'pdf',      true),
  makeSlot('abstract',         'Abstract',            'pdf',      true),
  makeSlot('additional_documents', 'Additional Documents', 'optional', false)
];


// Word vs PDF slot membership, derived from the slot definitions above so a
// new slot only has to be declared once (in `kind`).
const ALL_SLOT_DEFS = [
  ...STUDENT_INITIAL_SLOTS,
  ...STUDENT_FINAL_SLOTS,
  ...FACULTY_INITIAL_SLOTS,
  ...FACULTY_FINAL_SLOTS,
  ...PRESENTER_FINAL_SLOTS
];

export const WORD_SLOTS = new Set(
  ALL_SLOT_DEFS.filter(s => s.kind === 'word').map(s => s.slot_key)
);
export const PDF_SLOTS = new Set(
  ALL_SLOT_DEFS.filter(s => s.kind === 'pdf').map(s => s.slot_key)
);

// Every slot key the module knows about, for "is this slot real at all?" and
// for the upload middleware's field list.
export const ALL_SLOT_KEYS = new Set(ALL_SLOT_DEFS.map(s => s.slot_key));

// Slots that only a student may upload (forms A, B, D, E1/E2, F, G, I).
// Faculty uploading one of these is rejected by the router.
export const STUDENT_ONLY_SLOTS = new Set([
  'form_a', 'form_b', 'form_d', 'form_e1', 'form_e2', 'form_f', 'form_g', 'form_i'
]);

export function slotFileExtensions(slotKey) {
  if (slotKey === 'additional_documents') return OPEN_DOC_EXTENSIONS;
  if (isWordSlot(slotKey)) return WORD_EXTENSIONS;
  if (isPdfSlot(slotKey)) return PDF_EXTENSIONS;
  return null; // unknown slot from the client
}

export function isWordSlot(slotKey) {
  return WORD_SLOTS.has(slotKey);
}
export function isPdfSlot(slotKey) {
  return PDF_SLOTS.has(slotKey);
}

// ---- Research types (configurable; by role) ----
const RESEARCH_TYPES_BY_ROLE = {
  student_researcher: [
    { value: 'student_thesis',  label: 'Student Thesis' },
    { value: 'capstone',        label: 'Capstone' },
    { value: 'feasibility',     label: 'Feasibility Study' },
    { value: 'action_research', label: 'Action Research' }
  ],
  faculty_researcher: [
    { value: 'institutional_research', label: 'Institutional Research' },
    { value: 'faculty_research',       label: 'Faculty Research' },
    { value: 'non_teaching_research',  label: 'Non-Teaching Research' },
    { value: 'action_research',        label: 'Action Research' }
  ],
  non_teaching_researcher: [
    { value: 'institutional_research', label: 'Institutional Research' },
    { value: 'non_teaching_research',  label: 'Non-Teaching Research' },
    { value: 'faculty_research',       label: 'Faculty Research' },
    { value: 'action_research',        label: 'Action Research' }
  ],
  presenter: [
    { value: 'student_thesis',        label: 'Student Thesis' },
    { value: 'capstone',              label: 'Capstone' },
    { value: 'feasibility',           label: 'Feasibility Study' },
    { value: 'action_research',       label: 'Action Research' },
    { value: 'institutional_research',label: 'Institutional Research' },
    { value: 'faculty_research',      label: 'Faculty Research' },
    { value: 'non_teaching_research', label: 'Non-Teaching Research' }
  ]
};

// ---- Shared constants ----
export const SEMESTERS = [
  { value: '1st',    label: '1st Semester' },
  { value: '2nd',    label: '2nd Semester' },
  { value: 'summer', label: 'Summer' }
];

// ---------------------------------------------------------------------------
//  Link fields
//
//  The adviser evaluation is a Google Form the researchers fill in themselves,
//  so the form collects the LINK to it rather than a file. It is a real field
//  (its own column) because a URL is not a document: nothing is uploaded, so no
//  slot or storage backend is involved. It is required at the end of the
//  semester, which is the flag that used to make the adviser_eval file slot
//  mandatory: the link IS the evidence, so a student no longer has to print an
//  online form to PDF as well. The file slot stays available as an optional
//  attachment for a scanned copy.
// ---------------------------------------------------------------------------
const adviserEvalLinkField = {
  key: 'adviser_eval_link',
  label: "Researchers' Evaluation of Adviser (Google Form link)",
  type: 'url',
  required: true,
  conditional: (ctx) => ctx.data?.end_of_semester,
  condition_key: 'end_of_semester'
};

// A link is only accepted when it really is one: javascript: and data: URLs are
// rejected, which matters because the value is rendered back as a clickable
// link on the detail page.
export function isHttpUrl(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// ---- Roles, stages, fields ----
// One source of truth for /api/research-submissions/form-config.
// The front end renders ONLY what this returns for the current caller.
export const FORM_CONFIG = {
  student_researcher: {
    initial: {
      fields: [
        { key: 'title',           label: 'Working Title',                        type: 'text',  required: true },
        { key: 'authors',         label: 'Author(s)',                              type: 'text',  required: true },
        { key: 'program',         label: 'Program or Department',                 type: 'text',  required: true },
        { key: 'category',        label: 'Research Category',                     type: 'text',  required: true },
        { key: 'research_type',   label: 'Research Type',                         type: 'select', required: true, options: RESEARCH_TYPES_BY_ROLE.student_researcher },
        { key: 'school_year',     label: 'School Year',                           type: 'text',  required: true },
        { key: 'semester',        label: 'Semester',                              type: 'select', required: true, options: SEMESTERS },
        // Student-only fields
        { key: 'adviser',         label: 'Adviser',                               type: 'text',  required: true },
        { key: 'facilitator',     label: 'Facilitator',                           type: 'text',  required: true },
        // Required only at the end of the semester (see adviserEvalLinkField).
        { ...adviserEvalLinkField }
      ],
      slots: STUDENT_INITIAL_SLOTS
    },
    final: {
      fields: [
        { key: 'title',           label: 'Title of Research',                     type: 'text',  required: true },
        { key: 'authors',         label: 'Author(s)',                              type: 'text',  required: true },
        { key: 'program',         label: 'Program or Department',                 type: 'text',  required: true },
        { key: 'category',        label: 'Research Category',                     type: 'text',  required: true },
        { key: 'research_type',   label: 'Research Type',                         type: 'select', required: true, options: RESEARCH_TYPES_BY_ROLE.student_researcher },
        { key: 'school_year',     label: 'School Year',                           type: 'text',  required: true },
        { key: 'semester',        label: 'Semester',                              type: 'select', required: true, options: SEMESTERS },
        // Student-only fields
        { key: 'adviser',         label: 'Adviser',                               type: 'text',  required: true },
        { key: 'facilitator',     label: 'Facilitator',                           type: 'text',  required: true },
        // Final-only fields
        { key: 'abstract',        label: 'Abstract',                              type: 'textarea', required: true },
        { key: 'keywords',        label: 'Keywords',                              type: 'text',  required: true },
        // Required only at the end of the semester (see adviserEvalLinkField).
        { ...adviserEvalLinkField }
      ],
      slots: STUDENT_FINAL_SLOTS
    }
  },
  faculty_researcher: {
    initial: {
      fields: [
        { key: 'title',           label: 'Working Title',                        type: 'text',  required: true },
        { key: 'authors',         label: 'Author(s)',                              type: 'text',  required: true },
        { key: 'program',         label: 'Program or Department',                 type: 'text',  required: true },
        { key: 'category',        label: 'Research Category',                     type: 'text',  required: true },
        { key: 'research_type',   label: 'Research Type',                         type: 'select', required: true, options: RESEARCH_TYPES_BY_ROLE.faculty_researcher },
        { key: 'school_year',     label: 'School Year',                           type: 'text',  required: true },
        { key: 'semester',        label: 'Semester',                              type: 'select', required: true, options: SEMESTERS }
      ],
      slots: FACULTY_INITIAL_SLOTS
    },
    final: {
      fields: [
        { key: 'title',           label: 'Title of Research',                     type: 'text',  required: true },
        { key: 'authors',         label: 'Author(s)',                              type: 'text',  required: true },
        { key: 'program',         label: 'Program or Department',                 type: 'text',  required: true },
        { key: 'category',        label: 'Research Category',                     type: 'text',  required: true },
        { key: 'research_type',   label: 'Research Type',                         type: 'select', required: true, options: RESEARCH_TYPES_BY_ROLE.faculty_researcher },
        { key: 'school_year',     label: 'School Year',                           type: 'text',  required: true },
        { key: 'semester',        label: 'Semester',                              type: 'select', required: true, options: SEMESTERS },
        { key: 'abstract',        label: 'Abstract',                              type: 'textarea', required: true },
        { key: 'keywords',        label: 'Keywords',                              type: 'text',  required: true }
      ],
      slots: FACULTY_FINAL_SLOTS
    }
  },
  // Non-teaching faculty use the faculty form and rules.
  non_teaching_researcher: {
    initial: {
      fields: [
        { key: 'title',           label: 'Working Title',                        type: 'text',  required: true },
        { key: 'authors',         label: 'Author(s)',                              type: 'text',  required: true },
        { key: 'program',         label: 'Program or Department',                 type: 'text',  required: true },
        { key: 'category',        label: 'Research Category',                     type: 'text',  required: true },
        { key: 'research_type',   label: 'Research Type',                         type: 'select', required: true, options: RESEARCH_TYPES_BY_ROLE.non_teaching_researcher },
        { key: 'school_year',     label: 'School Year',                           type: 'text',  required: true },
        { key: 'semester',        label: 'Semester',                              type: 'select', required: true, options: SEMESTERS }
      ],
      slots: FACULTY_INITIAL_SLOTS
    },
    final: {
      fields: [
        { key: 'title',           label: 'Title of Research',                     type: 'text',  required: true },
        { key: 'authors',         label: 'Author(s)',                              type: 'text',  required: true },
        { key: 'program',         label: 'Program or Department',                 type: 'text',  required: true },
        { key: 'category',        label: 'Research Category',                     type: 'text',  required: true },
        { key: 'research_type',   label: 'Research Type',                         type: 'select', required: true, options: RESEARCH_TYPES_BY_ROLE.non_teaching_researcher },
        { key: 'school_year',     label: 'School Year',                           type: 'text',  required: true },
        { key: 'semester',        label: 'Semester',                              type: 'select', required: true, options: SEMESTERS },
        { key: 'abstract',        label: 'Abstract',                              type: 'textarea', required: true },
        { key: 'keywords',        label: 'Keywords',                              type: 'text',  required: true }
      ],
      slots: FACULTY_FINAL_SLOTS
    }
  },
  presenter: {
    final: {
      fields: [
        { key: 'title',           label: 'Title of Research',                     type: 'text',  required: true },
        { key: 'authors',         label: 'Author(s)',                              type: 'text',  required: true },
        { key: 'program',         label: 'Program or Department',                 type: 'text',  required: true },
        { key: 'category',        label: 'Research Category',                     type: 'text',  required: true },
        { key: 'research_type',   label: 'Research Type',                         type: 'select', required: true, options: RESEARCH_TYPES_BY_ROLE.presenter },
        { key: 'school_year',     label: 'School Year',                           type: 'text',  required: true },
        { key: 'semester',        label: 'Semester',                              type: 'select', required: true, options: SEMESTERS },
        { key: 'institution',     label: 'Institution',                           type: 'text',  required: true },
        { key: 'nationality',     label: 'Nationality',                           type: 'text',  required: true },
        { key: 'abstract',        label: 'Abstract',                              type: 'textarea', required: true },
        { key: 'keywords',        label: 'Keywords',                              type: 'text',  required: true }
      ],
      slots: PRESENTER_FINAL_SLOTS
    }
  }
};

// ---- Statuses by stage ----
// `draft` is not a review state: it is a saved-but-not-yet-submitted record,
// which is what "Save as draft" stores. It is listed first so the tracker and
// the status pickers can render it, and it is the only status the owner can
// move themselves.
const DRAFT_STATUS = { value: 'draft', label: 'Draft' };

// Initial stage statuses (student_researcher, faculty_researcher)
export const INITIAL_STATUSES = [
  DRAFT_STATUS,
  { value: 'submitted',                label: 'Submitted' },
  { value: 'under_initial_checking',   label: 'Under Initial Checking' },
  { value: 'for_revision',             label: 'For Revision' },
  { value: 'under_ethics_review',      label: 'Under Ethics Review' },
  { value: 'approved',                 label: 'Approved' },
  { value: 'rejected',                 label: 'Rejected' }
];

// Final stage statuses (all researcher roles)
export const FINAL_STATUSES = [
  DRAFT_STATUS,
  { value: 'submitted',        label: 'Submitted' },
  { value: 'under_initial_checking', label: 'Under Initial Checking' },
  { value: 'for_revision',     label: 'For Revision' },
  { value: 'approved',         label: 'Approved' },
  { value: 'published',        label: 'Published' },
  { value: 'archived',         label: 'Archived' },
  { value: 'rejected',         label: 'Rejected' }
];

// ---- Allowed status transitions (stage-aware) ----
// A transition that isn't listed here is rejected by the router.
// from_status -> [to_status, ...]
//
// Initial workflow (student_researcher, faculty_researcher):
//   Submitted -> Under Initial Checking -> For Revision -> Under Ethics Review -> Approved | Rejected
//
// Faculty initial:
//   Submitted -> Under Ethics Review -> Approved | Rejected
//
// Final workflow (all researcher roles):
//   Submitted -> Under Initial Checking -> For Revision -> Approved -> Published -> Archived
//   Also: any non-terminal -> Rejected
//   Submitted -> Under Initial Checking -> For Revision -> Under Ethics Review
//            -> Approved | Rejected
//
// Note the only way INTO `under_ethics_review` is from the checking states:
// without those edges the ethics stage is unreachable and every student
// submission would have to be approved without a clearance. Approved is
// reached through the ethics decision (see POST /:id/ethics), not directly.
export const INITIAL_TRANSITIONS = {
  // A draft is completed by its owner, then handed to the checking step.
  draft:                    ['submitted', 'rejected'],
  submitted:                ['under_initial_checking', 'for_revision', 'rejected'],
  under_initial_checking:   ['under_ethics_review', 'for_revision', 'rejected'],
  for_revision:             ['under_initial_checking', 'under_ethics_review', 'rejected'],
  under_ethics_review:      ['approved', 'rejected'],
  approved:                 ['rejected']
};

// Faculty initial is more direct (no under_initial_checking step in the spec,
// but keep the same shape so the router can still validate transitions).
export const FACULTY_INITIAL_TRANSITIONS = {
  draft:                  ['submitted', 'rejected'],
  submitted:              ['under_ethics_review', 'rejected'],
  under_ethics_review:    ['approved', 'rejected'],
  approved:               ['rejected']
};

export const FINAL_TRANSITIONS = {
  draft:                    ['submitted', 'rejected'],
  submitted:                ['under_initial_checking', 'for_revision', 'rejected'],
  under_initial_checking:   ['for_revision', 'approved', 'rejected'],
  for_revision:             ['under_initial_checking', 'approved', 'rejected'],
  approved:                 ['published', 'rejected'],
  published:                ['archived', 'rejected'],
  archived:                 []
};

// Combine by stage so the router can pick the right table.
export function validTransitionsFor(stage, role) {
  if (stage === 'initial' && isFacultyRole(role)) return FACULTY_INITIAL_TRANSITIONS;
  if (stage === 'initial') return INITIAL_TRANSITIONS;
  return FINAL_TRANSITIONS;
}

// ---- Validation helpers ----
// Builds the set of required slot_keys for the caller's role+stage, applying
// conditional slots where indicated.
export function requiredSlotKeysFor(role, stage, data = {}) {
  const config = FORM_CONFIG[role];
  if (!config) return new Set();
  const stageConfig = config[stage];
  if (!stageConfig) return new Set();

  const required = new Set();
  for (const slot of stageConfig.slots) {
    if (slot.required && (!slot.conditional || slot.conditional({ stage, role, data }))) {
      required.add(slot.slot_key);
    }
  }
  return required;
}

// ---------------------------------------------------------------------------
//  Conditional-slot flags
//
//  The form posts multipart, so every value arrives as a string: "false" is
//  truthy in JavaScript and used to make form_g required for everyone. These
//  two flags decide whether a conditional slot is required right now, and they
//  are the ONLY client inputs allowed to influence validation — never the
//  role, the owner or the status.
// ---------------------------------------------------------------------------
const TRUTHY = new Set(['true', '1', 'yes', 'on']);

export function isTruthyFlag(value) {
  if (value === true) return true;
  if (typeof value === 'string') return TRUTHY.has(value.trim().toLowerCase());
  return false;
}

// Builds the validation context for a request body. `stage` is passed in by the
// router (already validated against the caller's role) rather than trusted here.
export function buildValidationContext(stage, role, body = {}) {
  return {
    stage,
    role,
    data: {
      adviser_changed: isTruthyFlag(body.adviser_changed),
      end_of_semester: isTruthyFlag(body.end_of_semester)
    }
  };
}

// ---------------------------------------------------------------------------
//  Completeness check — ONE implementation, used by "create and submit" and by
//  "submit an existing draft". `haveFiles` is the set of slot keys that already
//  have a file (either in the request or already stored). Returns a list of
//  problems; the first one is what the API reports.
// ---------------------------------------------------------------------------
export function missingRequirements({ role, stage, data = {}, haveFiles = new Set() }) {
  const stageConfig = FORM_CONFIG[role]?.[stage];
  if (!stageConfig) {
    return [{ error: 'Your account type cannot create a submission at this stage.' }];
  }

  const problems = [];
  // Built first: a conditional field — and a conditional slot — needs it to know
  // whether it is required right now.
  const context = buildValidationContext(stage, role, data);

  for (const field of stageConfig.fields) {
    if (field.required && (!field.conditional || field.conditional(context))) {
      const value = data[field.key];
      if (value === undefined || value === null || String(value).trim() === '') {
        problems.push({ error: `Required field is missing: ${field.label}.`, field: field.key });
      }
    }
    // A link field has to look like a link. Checked only when a value was given:
    // an optional link may be left blank, and a conditional one whose flag is off
    // was already skipped above.
    if (field.type === 'url') {
      const value = String(data[field.key] ?? '').trim();
      if (value && !isHttpUrl(value)) {
        problems.push({
          error: `"${field.label}" must be a link starting with http:// or https://.`,
          field: field.key
        });
      }
    }
  }

  for (const slot of stageConfig.slots) {
    if (!slot.required) continue;
    if (slot.conditional && !slot.conditional(context)) continue;
    if (!haveFiles.has(slot.slot_key)) {
      problems.push({ error: `Required file is missing: ${slot.label}.`, slot: slot.slot_key });
    }
  }
  return problems;
}

// Serialisable description of a field for the front ends. Mirrors describeSlot:
// functions cannot cross JSON, so `conditional` becomes a boolean and the
// deciding flag is published as `condition_key`. `options` only travels for the
// fields that have them (the selects).
export function describeField(field) {
  const described = {
    key: field.key,
    label: field.label,
    type: field.type || 'text',
    required: Boolean(field.required),
    conditional: Boolean(field.conditional),
    condition_key: field.condition_key || null
  };
  if (field.options) described.options = field.options.map(o => ({ ...o }));
  return described;
}

// Serialisable description of a slot for the front ends. Functions cannot cross
// JSON, so `conditional` becomes a boolean and the deciding flag is published
// as `condition_key`.
export function describeSlot(slot) {
  return {
    slot_key: slot.slot_key,
    label: slot.label,
    kind: slot.kind,
    required: Boolean(slot.required),
    conditional: Boolean(slot.conditional),
    condition_key: slot.condition_key || null
  };
}

// Re-export the role-scoped research types so consumers that import
// research-config and destructure RESEARCH_TYPES_BY_ROLE still get it.
export { RESEARCH_TYPES_BY_ROLE };
