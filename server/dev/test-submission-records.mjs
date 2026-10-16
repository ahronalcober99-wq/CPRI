// ============================================================
//  CPRI — shared submission records + the field-repair script
//
//  Proves the two things the facilitator dashboard depends on, without a
//  database: a classic `submissions` row becomes the same record shape a module
//  row does (same status words, same document vocabulary, a name and a link),
//  and the one-time repair fills ONLY blank fields.
//
//  Run: npm run test:submission-records
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  statusLabelFor,
  slotLabelFor,
  legacySlotKeyFor,
  normalizeLegacySubmission,
  listLegacySubmissions,
  stageForStatus
} from '../lib/submission-records.js';
import { planModuleRepair, planClassicRepair } from '../repair-submission-fields.mjs';

const legacyRow = (overrides = {}) => ({
  id: 'legacy-1',
  submitterId: 'u-1',
  submitterName: 'Typed At The Time',
  title: 'Legacy paper',
  authors: 'A. Author',
  program: 'BS Biology',
  category: 'Life Sciences',
  adviser: 'Dr. Someone',
  researchType: 'student_thesis',
  abstract: 'An abstract.',
  schoolYear: '2026-2027',
  semester: '1st',
  status: 'under_initial_checking',
  createdAt: '2026-01-01 00:00:00',
  updatedAt: '2026-01-02 00:00:00',
  files: JSON.stringify({
    manuscript: { original_name: 'CPRI%20-%20Manuscript.pdf', storage_path: 'submissions/legacy-1/m.pdf', mime_type: 'application/pdf' },
    approvalForm: { original_name: 'form-a.pdf', storage_path: 'submissions/legacy-1/a.pdf', mime_type: 'application/pdf' },
    unknownForm: { original_name: 'mystery.pdf', storage_path: 'submissions/legacy-1/u.pdf', mime_type: 'application/pdf' }
  }),
  additionalDocs: JSON.stringify([
    { id: 'doc-1', original_name: 'extra.pdf', storage_path: 'submissions/legacy-1/e.pdf', mime_type: 'application/pdf' }
  ]),
  comments: JSON.stringify([
    { id: 'c1', authorName: 'CPRI Staff', authorRole: 'cpri_staff', type: 'feedback', body: 'Please revise.', createdAt: '2026-01-03 00:00:00' }
  ]),
  ...overrides
});

test('a status is labelled by the stage it belongs to, and never renamed', () => {
  assert.equal(statusLabelFor('published', 'final'), 'Published');
  assert.equal(statusLabelFor('published', 'initial'), 'published',
    'a status outside that workflow is still shown as itself');
  assert.equal(statusLabelFor('', 'initial'), '');
  assert.equal(statusLabelFor('rejected', 'initial'), 'Rejected');
  assert.equal(stageForStatus('published'), 'final');
  assert.equal(stageForStatus('archived'), 'final');
  assert.equal(stageForStatus('under_initial_checking'), 'initial');
  assert.equal(stageForStatus('something_new'), 'initial', 'an unknown status is not moved');
});

test('a document keeps a readable label under either store spelling', () => {
  // The label comes from the form config when the module knows the slot...
  assert.equal(slotLabelFor('manuscript_docx'), 'Manuscript (Word)');
  assert.equal(slotLabelFor('form_a'), 'Form A');
  // ...and from the classic names when only that store knows it.
  assert.equal(slotLabelFor('similarity_report'), 'Similarity Report');
  assert.equal(slotLabelFor('similarityReport'), 'Similarity Report', 'the classic spelling too');
  assert.equal(slotLabelFor('approvalForm'), 'Approval Sheet');
  assert.equal(slotLabelFor('unknownForm'), 'unknownForm', 'an unknown slot is named, not dropped');
  assert.equal(legacySlotKeyFor('approvalForm'), 'approval_sheet');
  assert.equal(legacySlotKeyFor('manuscript', 'x.pdf'), 'manuscript_pdf');
});

test('a classic row becomes the same record shape a module row produces', () => {
  const record = normalizeLegacySubmission(legacyRow(), { isOwner: () => true });
  assert.equal(record.id, 'legacy-1');
  assert.equal(record.title, 'Legacy paper');
  assert.equal(record.status, 'under_initial_checking');
  assert.equal(record.statusLabel, 'Under Initial Checking');
  assert.equal(record.stage, 'initial');
  assert.equal(record.stageLabel, 'Initial Submission');
  assert.equal(record.studentName, 'Typed At The Time', 'no account means the stored name is used');
  assert.equal(record.program, 'BS Biology');
  assert.equal(record.research_type, 'student_thesis');
  assert.equal(record.detailUrl, '/submission.html?id=legacy-1');
  assert.equal(record.source, 'classic');
  assert.deepEqual(record.sources, ['classic']);
  assert.equal(record.isOwner, true);

  // Documents: three from the map plus one additional, each with a working URL.
  assert.equal(record.fileCount, 4);
  assert.equal(record.files[0].original_name, 'CPRI - Manuscript.pdf', 'the URL-encoded name is decoded');
  assert.equal(record.files[0].url, '/api/submissions/legacy-1/file?key=manuscript');
  assert.equal(record.files[1].label, 'Approval Sheet');
  assert.equal(record.files[1].url, '/api/submissions/legacy-1/file?key=approvalForm');
  const extra = record.files.find(f => f.url.includes('docId=doc-1'));
  assert.ok(extra, 'an additional document is linked by its own id');
  assert.equal(extra.label, 'Additional Documents');

  // Comments come across with their author and type.
  assert.equal(record.commentCount, 1);
  assert.equal(record.comments[0].body, 'Please revise.');
  assert.equal(record.comments[0].comment_type, 'feedback');
  assert.equal(record.comments[0].author_name, 'CPRI Staff');
});

test('the live account behind a legacy row wins over the name typed at the time', () => {
  const record = normalizeLegacySubmission(legacyRow(), {
    isOwner: () => false,
    account: { id: 'u-1', username: 'thrix', fullName: 'Thrixcy ortiz', role: 'cpri_staff' }
  });
  assert.equal(record.studentName, 'Thrixcy ortiz');
  assert.equal(record.ownerRole, 'cpri_staff');
  assert.equal(record.studentId, 'u-1');
  assert.equal(record.isOwner, false);
});

test('a classic row with broken JSON still renders instead of breaking the page', () => {
  const record = normalizeLegacySubmission(legacyRow({
    files: '{not json', comments: 'also not json', additionalDocs: null
  }));
  assert.equal(record.fileCount, 0);
  assert.equal(record.commentCount, 0);
  assert.equal(record.title, 'Legacy paper', 'the rest of the record is untouched');
});

test('reading the classic store can fail without emptying the dashboard', async () => {
  const logged = [];
  const records = await listLegacySubmissions({
    all: async () => { throw new Error('table does not exist'); },
    log: (...args) => logged.push(args.join(' '))
  });
  assert.deepEqual(records, []);
  assert.match(logged.join('\n'), /could not read the classic submissions table/,
    'the failure is reported, not swallowed silently');

  // And with a working table, the account lookup fills in the current names.
  const rows = [legacyRow(), legacyRow({ id: 'legacy-2', submitterId: 'gone' })];
  const users = [{ id: 'u-1', username: 'thrix', email: 't@example.org', fullName: 'Thrixcy ortiz', role: 'cpri_staff' }];
  const out = await listLegacySubmissions({
    all: async (sql) => (sql.includes('FROM users') ? users : rows)
  });
  assert.equal(out[0].studentName, 'Thrixcy ortiz');
  assert.equal(out[0].ownerRole, 'cpri_staff');
  assert.equal(out[1].studentName, 'Typed At The Time', 'an unresolvable owner keeps its stored name');
});

// ---- The one-time repair ---------------------------------------------------

test('the repair fills blank fields only, and never invents an owner', () => {
  const users = [{ id: 'u-1', username: 'ahron', email: 'a@example.org', fullName: 'ahron alcober', role: 'student_researcher' }];
  const byRef = new Map([['u-1', users[0]]]);

  const blank = planModuleRepair({
    id: 's-1', title: 'Nameless', owner_id: 'u-1', owner_name: '', owner_role: '',
    stage: '', status: '', created_at: '', updated_at: ''
  }, { byRef });
  assert.deepEqual(blank.changes, {
    owner_name: 'ahron alcober',
    owner_role: 'student_researcher',
    status: 'submitted',
    stage: 'initial',
    created_at: blank.changes.created_at,
    updated_at: blank.changes.created_at
  });
  assert.match(blank.notes.join(' '), /owner_name from the account/);

  // A complete row is untouched — that is what makes a second run a no-op.
  const complete = planModuleRepair({
    id: 's-2', title: 'Fine', owner_id: 'u-1', owner_name: 'ahron alcober',
    owner_role: 'student_researcher', stage: 'final', status: 'published',
    created_at: '2026-01-01 00:00:00', updated_at: '2026-01-02 00:00:00'
  }, { byRef });
  assert.deepEqual(complete.changes, {});
  assert.deepEqual(complete.notes, []);

  // An owner that matches no account is reported, not replaced.
  const orphan = planModuleRepair({
    id: 's-3', title: 'Orphan', owner_id: 'gone', owner_name: 'Someone',
    owner_role: '', stage: '', status: 'rejected', created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00'
  }, { byRef });
  assert.deepEqual(orphan.changes, { stage: 'initial' }, 'only the derived stage is filled');
  assert.match(orphan.notes.join(' '), /matches no account/);
  assert.ok(!orphan.changes.owner_role, 'no role is guessed');

  // An unexpected status is left exactly as it is.
  const odd = planModuleRepair({
    id: 's-4', title: 'Odd', owner_id: 'u-1', owner_name: 'ahron alcober', owner_role: 'student_researcher',
    stage: 'initial', status: 'legacy_pending', created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00'
  }, { byRef });
  assert.deepEqual(odd.changes, {});
});

test('the classic repair fills the name a record cannot describe itself without', () => {
  const users = [{ id: 'u-1', username: 'thrix', email: 't@example.org', fullName: 'Thrixcy ortiz', role: 'cpri_staff' }];
  const byRef = new Map([['u-1', users[0]]]);

  const plan = planClassicRepair({
    id: 'c-1', title: 'Nameless classic', submitterId: 'u-1', submitterName: '',
    status: '', createdAt: '', updatedAt: ''
  }, { byRef });
  assert.equal(plan.changes.submitterName, 'Thrixcy ortiz');
  assert.equal(plan.changes.status, 'submitted');
  assert.ok(plan.changes.createdAt && plan.changes.updatedAt);

  const fine = planClassicRepair({
    id: 'c-2', title: 'Fine', submitterId: 'u-1', submitterName: 'Thrixcy ortiz',
    status: 'published', createdAt: '2026-01-01 00:00:00', updatedAt: '2026-01-01 00:00:00'
  }, { byRef });
  assert.deepEqual(fine.changes, {});

  const orphan = planClassicRepair({
    id: 'c-3', title: 'Orphan', submitterId: 'gone', submitterName: '',
    status: 'submitted', createdAt: '2026-01-01 00:00:00', updatedAt: '2026-01-01 00:00:00'
  }, { byRef });
  assert.deepEqual(orphan.changes, {}, 'a nameless orphan is reported, never renamed by guesswork');
  assert.match(orphan.notes.join(' '), /left as it is/);
});
