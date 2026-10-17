// ============================================================
//  CPRI — File Manager folders (lib/file-folders.js)
//
//  Pure: no database, no disk. Proves research files are grouped into one
//  folder per researcher from both submission forms, counted once, filtered
//  by stage, and that files with no submission land in "Unassigned".
//
//  Run: npm run test:file-folders
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFileFolders } from '../lib/file-folders.js';

const users = [
  { id: 'u-mary', username: 'mary', email: 'mary@x.edu', fullName: 'Songco, Mary Joy A.', role: 'student_researcher', studentId: '102' },
  { id: 'u-maria', username: 'maria', email: 'maria@x.edu', fullName: 'Dela Cruz, Maria L.', role: 'faculty_researcher', studentId: '' }
];

const moduleRows = [
  { id: 'm1', owner_id: 'u-mary', owner_name: 'Mary', owner_role: 'student_researcher', stage: 'initial', title: 'Proposal', status: 'approved', created_at: '2026-10-01 08:00:00' },
  { id: 'm2', owner_id: 'mary@x.edu', owner_name: 'Mary', owner_role: 'student_researcher', stage: 'final', title: 'Final paper', status: 'submitted', created_at: '2026-10-10 08:00:00' },
  { id: 'm3', owner_id: 'u-maria', owner_name: 'Maria', owner_role: 'faculty_researcher', stage: 'final', title: 'Faculty paper', status: 'submitted', created_at: '2026-10-05 08:00:00' }
];

const moduleFiles = [
  { id: 'f1', submission_id: 'm1', slot_key: 'manuscript_pdf', original_name: 'proposal.pdf', size: 1000, version: 1, uploaded_at: '2026-10-01 08:00:00' },
  { id: 'f2', submission_id: 'm1', slot_key: 'manuscript_pdf', original_name: 'proposal-v2.pdf', size: 1500, version: 2, uploaded_at: '2026-10-03 08:00:00' },
  { id: 'f3', submission_id: 'm2', slot_key: 'form_a', original_name: 'form-a.pdf', size: 500, version: 1, uploaded_at: '2026-10-17 09:00:00' },
  { id: 'f4', submission_id: 'm3', slot_key: 'abstract', original_name: 'abstract.pdf', size: 2048, version: 1, uploaded_at: '2026-10-15 09:00:00' },
  { id: 'f5', submission_id: 'deleted-sub', slot_key: 'manuscript_pdf', original_name: 'left-behind.pdf', size: 300, version: 1, uploaded_at: '2026-09-01 09:00:00' }
];

const classicRows = [
  {
    id: 'c1', submitterId: 'u-mary', submitterName: 'Mary', title: 'Classic paper', status: 'published',
    files: { manuscript: { storage_path: 'x/1.pdf', original_name: 'classic.pdf', size: 4096, uploaded_at: '2026-10-12T08:00:00Z' } },
    additionalDocs: [], createdAt: '2026-10-12 08:00:00', updatedAt: '2026-10-12 08:00:00'
  },
  // A migrated record: already counted from the module table.
  { id: 'm1', submitterId: 'u-mary', submitterName: 'Mary', title: 'Proposal', status: 'approved', files: { manuscript: { storage_path: 'x/2.pdf', original_name: 'dup.pdf' } }, createdAt: '2026-10-01 08:00:00' },
  // Someone with no account: still gets a folder under the recorded name.
  { id: 'c2', submitterId: 'gone@x.edu', submitterName: 'Reyes, Paolo S.', title: 'Gala paper', status: 'submitted', files: {}, createdAt: '2026-10-14 08:00:00' }
];

const build = (stage = 'all') => buildFileFolders({
  users, moduleRows, moduleFiles, classicRows, stage,
  orphanDiskFiles: [{ name: 'old.docx', size: 700, mtime: '2026-08-01T00:00:00Z', location: 'server/data/research-submissions/zzz' }]
});

test('one folder per researcher, from both forms, each submission once', () => {
  const out = build();
  const mary = out.folders.find(f => f.userId === 'u-mary');
  assert.equal(mary.name, 'Songco, Mary Joy A.');
  assert.equal(mary.displayId, '102', 'the student ID when the profile has one');
  assert.equal(mary.roleLabel, 'Student');
  assert.equal(mary.submissionCount, 3, 'm1 + m2 (owner referenced by email) + c1; the migrated copy of m1 is not counted again');
  assert.equal(mary.fileCount, 4, 'both versions of the proposal, the final form, the classic manuscript');
  assert.equal(mary.bytes, 1000 + 1500 + 500 + 4096);
  assert.equal(mary.lastUpload, new Date('2026-10-17 09:00:00').toISOString());
  assert.deepEqual(mary.submissions.map(s => s.source).sort(), ['classic', 'module', 'module']);

  const maria = out.folders.find(f => f.userId === 'u-maria');
  assert.equal(maria.roleLabel, 'Faculty');
  assert.equal(maria.displayId, 'u-maria', 'no student ID: a short form of the account id');

  const paolo = out.folders.find(f => f.name === 'Reyes, Paolo S.');
  assert.ok(paolo, 'a record whose account is gone still has a folder');
  assert.equal(paolo.fileCount, 0);

  assert.deepEqual(out.totals, { researchers: 3, submissions: 5, files: 4 + 1 + 0 + 2 });
});

test('module files link to the authorized download route', () => {
  const file = build().folders.find(f => f.userId === 'u-maria').submissions[0].files[0];
  assert.equal(file.url, '/api/research-submissions/m3/files/f4');
  assert.equal(file.label, 'Abstract');
  assert.equal(file.size, 2048);
});

test('the stage filter keeps only that stage, and drops empty folders', () => {
  const finals = build('final');
  const mary = finals.folders.find(f => f.userId === 'u-mary');
  assert.deepEqual(mary.submissions.map(s => s.id).sort(), ['c1', 'm2'], 'a published classic record counts as Final');
  const initials = build('initial');
  assert.ok(!initials.folders.some(f => f.userId === 'u-maria'), 'Maria has no Initial papers');
  assert.equal(initials.totals.researchers, 2);
});

test('files with no submission are Unassigned, never in a researcher folder', () => {
  const { unassigned, folders } = build();
  assert.equal(unassigned.fileCount, 2);
  assert.equal(unassigned.bytes, 300 + 700);
  assert.deepEqual(unassigned.files.map(f => f.name), ['left-behind.pdf', 'old.docx']);
  assert.ok(!folders.some(f => f.submissions.some(s => s.files.some(x => x.name === 'left-behind.pdf'))));
});
