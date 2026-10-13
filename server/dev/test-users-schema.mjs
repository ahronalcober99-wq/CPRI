import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureUsersSchema } from '../auth.js';

test('ensureUsersSchema adds only missing columns and does nothing when all exist', async () => {
  // Case 1: Missing all columns
  let queriesRun = [];
  let existingColumns = [{ Field: 'id' }, { Field: 'username' }, { Field: 'email' }];
  
  await ensureUsersSchema({
    all: async (sql) => {
      assert.equal(sql, 'SHOW COLUMNS FROM users');
      return existingColumns;
    },
    run: async (sql) => {
      queriesRun.push(sql);
    }
  });

  // 11 original columns + the 4 role-profile columns added with the
  // Non-Teaching Researcher / Presenter roles.
  assert.equal(queriesRun.length, 15, 'should add all 15 missing columns');
  assert.ok(queriesRun.some(sql => sql.includes('studentId')));
  assert.ok(queriesRun.some(sql => sql.includes('officeUnit')));
  assert.ok(queriesRun.some(sql => sql.includes('position')));
  assert.ok(queriesRun.some(sql => sql.includes('institution')));
  assert.ok(queriesRun.some(sql => sql.includes('nationality')));

  // Case 2: All columns already exist
  queriesRun = [];
  existingColumns = [
    { Field: 'id' },
    { Field: 'username' },
    { Field: 'email' },
    { Field: 'studentId' },
    { Field: 'yearLevel' },
    { Field: 'program' },
    { Field: 'section' },
    { Field: 'adviser' },
    { Field: 'researchTitle' },
    { Field: 'researchArea' },
    { Field: 'researches' },
    { Field: 'contactNo' },
    { Field: 'user_prefs' },
    { Field: 'setupPending' },
    { Field: 'officeUnit' },
    { Field: 'position' },
    { Field: 'institution' },
    { Field: 'nationality' }
  ];

  await ensureUsersSchema({
    all: async (sql) => {
      assert.equal(sql, 'SHOW COLUMNS FROM users');
      return existingColumns;
    },
    run: async (sql) => {
      queriesRun.push(sql);
    }
  });

  assert.equal(queriesRun.length, 0, 'should add zero columns when all exist');
});
