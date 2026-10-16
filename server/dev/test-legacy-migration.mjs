// ============================================================
//  CPRI — classic `submissions` -> Research Submission Module migration
//
//  Proves the mapping WITHOUT a database: the same planSubmission() the CLI
//  calls is imported directly, so this asserts the shipped code, not a copy.
//  The fixtures mirror rows that really exist in the classic table — JSON
//  columns as text, owner in `submitterId`, files keyed by the classic slot
//  names (see server/migrate-legacy-submissions.mjs).
//
//  Run: npm run test:legacy-migration
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';

import { planSubmission, ownerIndex, slotKeyFor, stageForStatus } from '../migrate-legacy-submissions.mjs';

const USERS = [
  { id: 'u-ahron', username: 'ahron', email: 'ahronalcobercdsga@gmail.com', fullName: 'ahron alcober', role: 'student_researcher' },
  { id: 'u-adviser', username: 'ahronalcober99', email: 'ahronalcober99@gmail.com', fullName: 'Dr. Ahron Alcober', role: 'adviser' },
  { id: 'u-staff', username: 'thrix', email: 'thrixortiz08@gmail.com', fullName: 'Thrixcy G. Ortiz', role: 'cpri_staff' }
];
const INDEX = ownerIndex(USERS);

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const file = (name) => ({ mime_type: DOCX, original_name: name, storage_path: `submissions/legacy-1/${name}` });

function legacyRow(overrides = {}) {
  return {
    id: 'e696a3c2-c159-4d2f-a8cc-ae351dc47522',
    submitterId: 'u-ahron',
    submitterName: 'ahron alcober',
    title: 'CPRI',
    authors: 'A. Author',
    program: 'BSIT',
    adviser: 'Dr. Ahron Alcober',
    category: 'Life Sciences',
    researchType: 'student_thesis',
    abstract: 'An abstract.',
    keywords: 'a, b',
    schoolYear: '2026-2027',
    semester: '1st',
    status: 'published',
    createdAt: '2026-10-09T21:53:26.000Z',
    updatedAt: '2026-10-09T21:54:08.000Z',
    files: JSON.stringify({
      manuscript: file('CPRI%20-%20Manuscript.docx'),
      similarityReport: file('report.pdf'),
      panelApproval: file('panel.pdf')
    }),
    versions: JSON.stringify([
      {
        version: 1, uploadedAt: '2026-10-09T21:53:26.000Z', by: 'ahron alcober', note: 'Initial submission',
        files: { manuscript: file('CPRI%20-%20Manuscript.docx') }, additionalDocs: []
      },
      {
        version: 2, uploadedAt: '2026-10-09T22:10:00.000Z', by: 'ahron alcober',
        files: { manuscript: file('CPRI%20-%20Manuscript-v2.docx'), similarityReport: file('report.pdf') },
        additionalDocs: [{
          id: '11111111-2222-3333-4444-555555555555', mime_type: 'application/pdf',
          original_name: 'extra.pdf', storage_path: 'submissions/legacy-1/extra.pdf'
        }]
      }
    ]),
    statusHistory: JSON.stringify([
      { status: 'submitted', at: '2026-10-09T21:53:26.788Z', by: 'ahron alcober' },
      { status: 'published', at: '2026-10-09T21:54:08.563Z', by: 'System Administrator', note: '' }
    ]),
    comments: JSON.stringify([{
      id: 'c1', authorId: 'u-staff', authorName: 'Thrixcy G. Ortiz', authorRole: 'cpri_staff',
      type: 'feedback', body: 'Please revise the title.', createdAt: '2026-10-10T00:00:00.000Z'
    }]),
    additionalDocs: JSON.stringify([]),
    ...overrides
  };
}

test('a stage is inferred from the classic status, never invented', () => {
  assert.equal(stageForStatus('published'), 'final');
  assert.equal(stageForStatus('archived'), 'final');
  assert.equal(stageForStatus('submitted'), 'initial');
  assert.equal(stageForStatus('rejected'), 'initial');
  assert.equal(stageForStatus('under_initial_checking'), 'initial');
  // An unknown status is not a reason to move or hide a record.
  assert.equal(stageForStatus('legacy_pending'), 'initial');
  assert.equal(stageForStatus(''), 'initial');
});

test('classic slot names map to the module slots', () => {
  assert.equal(slotKeyFor('abstract'), 'abstract');
  assert.equal(slotKeyFor('approvalForm'), 'approval_sheet');
  assert.equal(slotKeyFor('similarityReport'), 'similarity_report');
  // The one classic slot that split in two: picked by the file's own extension.
  assert.equal(slotKeyFor('manuscript', 'CPRI%20-%20Manuscript.docx'), 'manuscript_docx');
  assert.equal(slotKeyFor('manuscript', 'manuscript.pdf'), 'manuscript_pdf');
  // An unmapped key keeps its own name rather than being dropped.
  assert.equal(slotKeyFor('panelApproval'), 'panel_approval');
  assert.equal(slotKeyFor('someNewForm'), 'someNewForm');
});

test('a classic row is copied with its own id, owner, documents and history', () => {
  const plan = planSubmission(legacyRow(), { index: INDEX, includeOrphans: false });
  assert.equal(plan.skipped, false);

  // Same id in both tables: the link is obvious and a re-run is a no-op.
  assert.equal(plan.submission.id, 'e696a3c2-c159-4d2f-a8cc-ae351dc47522');
  assert.equal(plan.submission.owner_id, 'u-ahron');
  assert.equal(plan.submission.owner_role, 'student_researcher');
  assert.equal(plan.submission.stage, 'final');
  assert.equal(plan.submission.status, 'published');
  assert.equal(plan.submission.adviser_id, 'u-adviser', 'the typed adviser name is linked to that account');
  assert.equal(plan.adviserLinked, true);
  assert.equal(plan.resolvedBy, 'submitterId');

  // v1: one manuscript. v2: a manuscript, a similarity report and an extra doc.
  assert.deepEqual(plan.files.map(f => f.version).sort(), [1, 2, 2, 2]);
  assert.equal(plan.files.filter(f => f.slot_key === 'manuscript_docx').length, 2, 'both manuscript versions are kept');
  assert.ok(plan.files.every(f => f.storage_backend === 'supabase'), 'classic uploads live in the Supabase bucket');
  assert.equal(plan.files.find(f => f.version === 1).original_name, 'CPRI - Manuscript.docx',
    'the URL-encoded name is decoded for display');
  const extra = plan.files.find(f => f.slot_key === 'additional_documents');
  assert.equal(extra.id, '11111111-2222-3333-4444-555555555555', 'an additional document keeps its classic id');
  assert.equal(extra.version, 2, 'an extra document stays in the version it was uploaded with');

  assert.deepEqual(plan.history.map(h => [h.from_status, h.to_status]),
    [[null, 'submitted'], ['submitted', 'published']]);
  assert.equal(plan.history[1].changed_by_name, 'System Administrator');

  assert.equal(plan.comments.length, 1);
  assert.equal(plan.comments[0].body, 'Please revise the title.');
  assert.equal(plan.comments[0].comment_type, 'feedback');
  assert.equal(plan.comments[0].author_name, 'Thrixcy G. Ortiz');
});

test('an ambiguous name is never guessed at', () => {
  // Two accounts can share a display name (the real deploy has one: the student
  // and the adviser both signed up as "Ahron Alcober"). A typed name that could
  // mean either of them must not be used to link a record to a reviewer.
  const ambiguousIndex = ownerIndex([
    ...USERS,
    { id: 'u-clone', username: 'clone', email: 'clone@example.org', fullName: 'Dr. Ahron Alcober', role: 'adviser' }
  ]);
  const plan = planSubmission(legacyRow(), { index: ambiguousIndex, includeOrphans: false });
  assert.equal(plan.submission.adviser_id, null, 'an ambiguous adviser name links to nobody');
  assert.equal(plan.adviserLinked, false);
});

test('a row with no version history is copied as version 1', () => {
  const plan = planSubmission(legacyRow({ versions: JSON.stringify([]) }), { index: INDEX, includeOrphans: false });
  assert.equal(plan.files.length, 3, 'the current files are the first version');
  assert.ok(plan.files.every(f => f.version === 1));
  assert.deepEqual(plan.history.map(h => [h.from_status, h.to_status]),
    [[null, 'submitted'], ['submitted', 'published']]);
});

test('an empty classic history gets one honest entry', () => {
  const plan = planSubmission(legacyRow({ statusHistory: JSON.stringify([]), status: 'submitted' }),
    { index: INDEX, includeOrphans: false });
  assert.equal(plan.history.length, 1);
  assert.equal(plan.history[0].from_status, null);
  assert.equal(plan.history[0].to_status, 'submitted');
  assert.match(plan.history[0].note, /Imported from the classic Submissions form/);
});

test("an owner recorded as an email or username is still that account's record", () => {
  const byEmail = planSubmission(legacyRow({ submitterId: 'AHRONALCOBERCDSGA@gmail.com' }),
    { index: INDEX, includeOrphans: false });
  assert.equal(byEmail.submission.owner_id, 'u-ahron');
  assert.equal(byEmail.resolvedBy, 'submitterId');

  const byUsername = planSubmission(legacyRow({ submitterId: 'ahron' }), { index: INDEX, includeOrphans: false });
  assert.equal(byUsername.submission.owner_id, 'u-ahron');

  // …and by the display name when neither the id nor the email resolves.
  const byName = planSubmission(legacyRow({ submitterId: 'gone-account', submitterName: 'Thrixcy G. Ortiz' }),
    { index: INDEX, includeOrphans: false });
  assert.equal(byName.submission.owner_id, 'u-staff');
  assert.equal(byName.resolvedBy, 'submitterName');
});

test('a re-registered account is found by name, initials and all', () => {
  // The real case: a classic row holds the OLD account id, which no longer
  // exists because the account was deleted and re-created. The names differ by
  // a middle initial and a capital letter — same person.
  const index = ownerIndex([
    { id: 'u-new-thrix', username: 'thrix', email: 'thrixortiz08@gmail.com', fullName: 'Thrixcy ortiz', role: 'cpri_staff' }
  ]);
  const row = legacyRow({ submitterId: '5e59a5b2-300d-4915-bf12-da35b62ce540', submitterName: 'Thrixcy G. Ortiz' });

  const plan = planSubmission(row, { index, includeOrphans: false });
  assert.equal(plan.skipped, false);
  assert.equal(plan.submission.owner_id, 'u-new-thrix');
  assert.equal(plan.resolvedBy, 'submitterName (name match)', 'the report says how the owner was found');
  assert.equal(plan.submission.owner_name, 'Thrixcy ortiz', "the account's own name is used, not the typed one");

  // --strict-owner turns that recovery off.
  const strict = planSubmission(row, { index, includeOrphans: false, nameMatch: false });
  assert.equal(strict.skipped, true);
  assert.match(strict.reason, /matches no account/);

  // Two accounts that reduce to the same name: never guessed at.
  const ambiguous = ownerIndex([
    { id: 'u-a', username: 'thrix', email: 'a@example.org', fullName: 'Thrixcy ortiz', role: 'cpri_staff' },
    { id: 'u-b', username: 'thrix2', email: 'b@example.org', fullName: 'Thrixcy Ortiz', role: 'faculty_researcher' }
  ]);
  const unsure = planSubmission(row, { index: ambiguous, includeOrphans: false });
  assert.equal(unsure.skipped, true);
  assert.match(unsure.reason, /more than one account/);
});

test('a record whose submitter no longer exists is skipped unless asked for', () => {
  const row = legacyRow({ submitterId: 'tmpview-owner', submitterName: 'Tmp View Owner' });

  const skipped = planSubmission(row, { index: INDEX, includeOrphans: false });
  assert.equal(skipped.skipped, true);
  assert.match(skipped.reason, /matches no account/);

  const included = planSubmission(row, { index: INDEX, includeOrphans: true });
  assert.equal(included.skipped, false);
  assert.equal(included.submission.owner_id, 'tmpview-owner', 'the stored value is kept, never invented');
  assert.equal(included.submission.owner_name, 'Tmp View Owner');
  assert.equal(included.resolvedBy, 'unresolved-owner');
});

test('values are clamped to the columns they are written into', () => {
  const plan = planSubmission(legacyRow({ title: 'x'.repeat(400), status: 'y'.repeat(60) }),
    { index: INDEX, includeOrphans: false });
  assert.equal(plan.submission.title.length, 255);
  assert.equal(plan.submission.status.length, 40);
  assert.ok(plan.files.every(f => f.original_name.length <= 255 && f.stored_path.length <= 512));
});
