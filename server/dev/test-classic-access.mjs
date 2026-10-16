// ============================================================
//  CPRI — who may read a classic `submissions` record
//
//  The Adviser / Facilitator dashboard lists classic records and links to their
//  files, so the read rules of the classic router are part of that dashboard's
//  contract. They are pure functions of (caller, row) — no database — which is
//  exactly what makes them testable here.
//
//  (This suite exists because not testing them shipped a 500: the facade used
//  `ASSIGNED_ROLES.includes(...)` on a Set, so every facilitator opening a
//  classic record hit "ASSIGNED_ROLES.includes is not a function".)
//
//  Run: npm run test:classic-access
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';

import { canAccess, canViewFile } from '../submissions.js';

const submission = (overrides = {}) => ({
  id: 'sub-1',
  submitterId: 'u-owner',
  submitterName: 'Owner Person',
  title: 'A paper',
  adviser: 'Dr. Someone',
  status: 'submitted',
  ...overrides
});

const user = (role, extra = {}) => ({ id: `u-${role}`, role, username: `${role}-person`, ...extra });

test('the owner and the review roles may read a classic submission', () => {
  const row = submission();
  assert.equal(canAccess({ id: 'u-owner', role: 'student_researcher' }, row), true);
  for (const role of ['admin', 'cpri_staff', 'ethics_reviewer']) {
    assert.equal(canAccess(user(role), row), true, `${role} reviews every submission`);
  }
});

test('an adviser / facilitator monitors every classic submission, not only their own', () => {
  const row = submission();
  assert.equal(canAccess(user('adviser'), row), true,
    'the oversight seat reads the record it never submitted');
  assert.equal(canAccess(user('facilitator'), row), true,
    "and so does the module's spelling of the same job");
});

test('nobody else reaches a classic submission, files included', () => {
  const row = submission();
  for (const role of ['student_researcher', 'faculty_researcher', 'non_teaching_researcher', 'presenter']) {
    assert.equal(canAccess(user(role), row), false, `${role} only sees their own work`);
    assert.equal(canViewFile(user(role), row), false, `${role} cannot preview it either`);
  }
  // A stale session (deleted account) is not a caller at all.
  assert.equal(canAccess(undefined, row), false);
  assert.equal(canAccess({ id: 'u-somebody-else' }, row), false, 'a caller without a role is refused');
  assert.equal(canAccess({ id: 'u-owner' }, row), true, 'the submitter is the submitter, role or not');
});

test('inline preview keeps its narrower rule', () => {
  const row = submission({ adviser: 'Dr. Named Adviser' });
  // Downloading follows canAccess (see above). Previewing does not: an adviser
  // may preview a classic file only when the record names them, and a
  // facilitator — the module's spelling of the same job — follows that rule
  // too, so the unregistered spelling never has more power than the real role.
  assert.equal(canViewFile(user('facilitator'), row), false);
  assert.equal(canViewFile(user('adviser'), row), false, 'an adviser this record never named');
  assert.equal(canViewFile(
    { id: 'u-adviser-named', role: 'adviser', fullName: 'Dr. Named Adviser' }, row
  ), true, 'the adviser the record names');
  assert.equal(canViewFile({ id: 'u-owner', role: 'student_researcher' }, row), true, 'the submitter too');
  for (const role of ['admin', 'cpri_staff', 'ethics_reviewer']) {
    assert.equal(canViewFile(user(role), row), true, `${role} previews any file`);
  }
});
