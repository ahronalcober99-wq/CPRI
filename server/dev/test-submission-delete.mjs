import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteSubmissionAndPublication } from '../submissions.js';

test('deleting a submission transactionally removes its linked publication first', async () => {
  const calls = [];
  const deleted = await deleteSubmissionAndPublication('submission-1', async callback => {
    return callback({
      async get(sql, params) {
        calls.push({ method: 'get', sql, params });
        return { id: params[0] };
      },
      async run(sql, params) {
        calls.push({ method: 'run', sql, params });
      }
    });
  });

  assert.equal(deleted, true);
  assert.deepEqual(calls, [
    { method: 'get', sql: 'SELECT id FROM submissions WHERE id = ?', params: ['submission-1'] },
    { method: 'run', sql: 'DELETE FROM publications WHERE sourceSubmissionId = ?', params: ['submission-1'] },
    { method: 'run', sql: 'DELETE FROM submissions WHERE id = ?', params: ['submission-1'] }
  ]);
});

test('deleting a missing submission makes no database changes', async () => {
  const calls = [];
  const deleted = await deleteSubmissionAndPublication('missing', async callback => {
    return callback({
      async get(sql, params) {
        calls.push({ method: 'get', sql, params });
        return null;
      },
      async run(sql, params) {
        calls.push({ method: 'run', sql, params });
      }
    });
  });

  assert.equal(deleted, false);
  assert.deepEqual(calls, [
    { method: 'get', sql: 'SELECT id FROM submissions WHERE id = ?', params: ['missing'] }
  ]);
});

test('submission deletion propagates transactional failures', async () => {
  const failure = new Error('database unavailable');
  await assert.rejects(
    deleteSubmissionAndPublication('submission-1', async callback => callback({
      async get() {
        return { id: 'submission-1' };
      },
      async run(sql) {
        if (sql.startsWith('DELETE FROM publications')) throw failure;
      }
    })),
    error => error === failure
  );
});
