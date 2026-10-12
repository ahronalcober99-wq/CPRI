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

  assert.equal(queriesRun.length, 11, 'should add all 11 missing columns');
  assert.ok(queriesRun.some(sql => sql.includes('studentId')));

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
    { Field: 'setupPending' }
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
