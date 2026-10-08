// Tests for the admin-only repository delete feature:
//   DELETE /api/repository/:id   (server/repository.js)
//   the card renderer behind the Delete button (public/assets/js/repository-cards.js)
//
// Run: npm run test:repository
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createRepositoryRouter } from '../repository.js';
import { repositoryCardHtml, REPOSITORY_EMPTY_STATE } from '../../public/assets/js/repository-cards.js';

// Minimal in-memory stand-in for the repository router's dependencies. The
// transaction stub applies the same statements the route issues, so the test
// sees exactly the effect production code has.
async function startApi({ records, submissions = [], users = {}, storage = {} } = {}) {
  const calls = [];
  const repositoryRows = new Map(records.map(record => [record.id, { ...record }]));
  const submissionRows = new Map(submissions.map(submission => [submission.id, { ...submission }]));

  const siblingsOf = (submissionId, excludedId) => [...repositoryRows.values()]
    .filter(record => record.sourceSubmissionId === submissionId && record.id !== excludedId)
    .map(record => ({ id: record.id }));

  const router = createRepositoryRouter({
    optionalUser: async req => users[req.get('x-user')] || null,
    // Production uses requireAuth + requireAdmin; the handler re-checks the role
    // itself, which is what these tests exercise.
    adminGuard: (req, res, next) => next(),
    all: async () => [...repositoryRows.values()],
    get: async (sql, params = []) => {
      if (/FROM repository WHERE id = \?/.test(sql)) return repositoryRows.get(params[0]) || null;
      if (/FROM submissions WHERE id = \?/.test(sql)) return submissionRows.get(params[0]) || null;
      return null;
    },
    withTransaction: async (callback) => {
      calls.push({ method: 'transaction' });
      const tx = {
        all: async (sql, params = []) => {
          if (/sourceSubmissionId = \? AND id <> \?/.test(sql)) {
            return siblingsOf(params[0], params[1]);
          }
          return [...repositoryRows.values()];
        },
        run: async (sql, params = []) => {
          calls.push({ method: 'run', sql });
          if (/^DELETE FROM repository WHERE id = \?/.test(sql)) {
            repositoryRows.delete(params[0]);
            return { affectedRows: 1 };
          }
          if (/^UPDATE submissions SET files = \?/.test(sql)) {
            const row = submissionRows.get(params[2]);
            if (row) row.files = JSON.parse(params[0]);
            return { affectedRows: 1 };
          }
          throw new Error('Unexpected transaction statement: ' + sql);
        }
      };
      return callback(tx);
    },
    storage: {
      async deleteObjects(paths) {
        calls.push({ method: 'deleteObjects', paths });
        if (storage.deleteError) throw storage.deleteError;
      }
    },
    log: async (action, details, req) => {
      calls.push({ method: 'log', action, details, userId: req?.get('x-user') });
    }
  });

  const app = express();
  app.use(express.json());
  app.use('/api/repository', router);
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });

  return {
    url: `http://127.0.0.1:${server.address().port}/api/repository`,
    calls,
    repositoryRows,
    submissionRows,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    })
  };
}

async function deleteJson(url, { user } = {}) {
  const response = await fetch(url, {
    method: 'DELETE',
    headers: user ? { 'x-user': user } : {}
  });
  return { status: response.status, body: await response.json() };
}

function submission(id, ownerId, files = {
  manuscript: {
    storage_path: 'submissions/s1/manuscript.pdf',
    original_name: 'Original paper.pdf',
    mime_type: 'application/pdf'
  },
  additionalDocs: ['consent-form.pdf']
}) {
  return { id, submitterId: ownerId, files };
}

function record(id, overrides = {}) {
  return {
    id,
    title: `Record ${id}`,
    authors: 'Author',
    department: 'Governance & Public Policy',
    category: 'institutional',
    yearCompleted: '2026',
    status: 'approved',
    accessLevel: 'downloadable',
    fileAvailable: 1,
    sourceSubmissionId: 'submission-1',
    ...overrides
  };
}

const users = {
  admin: { id: 'admin-id', role: 'admin', status: 'active' },
  staff: { id: 'staff-id', role: 'cpri_staff', status: 'active' },
  student: { id: 'student-id', role: 'student_researcher', status: 'active' }
};

test('admin deletes a repository entry: row, stored file, file pointer, audit log', async () => {
  const api = await startApi({
    records: [record('entry-1')],
    submissions: [submission('submission-1', 'student-id')],
    users
  });

  try {
    const result = await deleteJson(`${api.url}/entry-1`, { user: 'admin' });
    assert.deepEqual(result, {
      status: 200,
      body: { success: true, message: 'Repository entry deleted' }
    });

    assert.equal(api.repositoryRows.has('entry-1'), false, 'repository row is gone');
    assert.deepEqual(
      api.calls.filter(call => call.method === 'deleteObjects').map(call => call.paths),
      [['submissions/s1/manuscript.pdf']],
      'the uploaded manuscript object is removed from storage'
    );

    const files = api.submissionRows.get('submission-1').files;
    assert.equal(files.manuscript, undefined, 'submission no longer points at the deleted file');
    assert.deepEqual(files.additionalDocs, ['consent-form.pdf'], 'sibling files are kept');
    assert.equal(api.submissionRows.has('submission-1'), true, 'the submission itself is kept');

    assert.ok(api.calls.some(call => call.method === 'transaction'), 'the DB work runs in a transaction');
    const log = api.calls.find(call => call.method === 'log');
    assert.equal(log.action, 'repository_delete');
    assert.match(log.details, /Record entry-1/);
    assert.match(log.details, /entry-1/);
    assert.equal(log.userId, 'admin', 'the log records who deleted the entry');
  } finally {
    await api.close();
  }
});

test('non-admin roles get 403 and nothing is deleted', async () => {
  for (const who of ['staff', 'student']) {
    const api = await startApi({
      records: [record('entry-1')],
      submissions: [submission('submission-1', 'student-id')],
      users
    });
    try {
      const result = await deleteJson(`${api.url}/entry-1`, { user: who });
      assert.equal(result.status, 403, `${who} must not delete`);
      assert.equal(api.repositoryRows.has('entry-1'), true);
      assert.equal(api.calls.some(call => call.method === 'transaction'), false);
      assert.equal(api.calls.some(call => call.method === 'deleteObjects'), false);
    } finally {
      await api.close();
    }
  }
});

test('anonymous callers get 401 and nothing is deleted', async () => {
  const api = await startApi({
    records: [record('entry-1')],
    submissions: [submission('submission-1', 'student-id')],
    users
  });

  try {
    const result = await deleteJson(`${api.url}/entry-1`);
    assert.equal(result.status, 401);
    assert.equal(api.repositoryRows.has('entry-1'), true);
    assert.equal(api.calls.some(call => call.method === 'deleteObjects'), false);
  } finally {
    await api.close();
  }
});

test('unknown and malformed ids get 404', async () => {
  const api = await startApi({
    records: [record('entry-1')],
    submissions: [submission('submission-1', 'student-id')],
    users
  });

  try {
    assert.equal((await deleteJson(`${api.url}/does-not-exist`, { user: 'admin' })).status, 404);
    assert.equal((await deleteJson(`${api.url}/..%2Fsecret`, { user: 'admin' })).status, 404);
    assert.equal((await deleteJson(`${api.url}/${'x'.repeat(80)}`, { user: 'admin' })).status, 404);
    assert.equal(api.repositoryRows.has('entry-1'), true);
    assert.equal(api.calls.some(call => call.method === 'deleteObjects'), false);
  } finally {
    await api.close();
  }
});

test('a file still used by another repository record is neither unlinked nor deleted', async () => {
  const api = await startApi({
    records: [
      record('entry-1'),
      record('entry-2', { sourceSubmissionId: 'submission-1' })
    ],
    submissions: [submission('submission-1', 'student-id')],
    users
  });

  try {
    const result = await deleteJson(`${api.url}/entry-1`, { user: 'admin' });
    assert.equal(result.status, 200);
    assert.equal(api.repositoryRows.has('entry-1'), false);
    assert.equal(api.repositoryRows.has('entry-2'), true);
    assert.ok(api.submissionRows.get('submission-1').files.manuscript, 'the shared file pointer is kept');
    assert.equal(api.calls.some(call => call.method === 'deleteObjects'), false);
  } finally {
    await api.close();
  }
});

test('a stored-file failure does not undo the deletion', async () => {
  const api = await startApi({
    records: [record('entry-1')],
    submissions: [submission('submission-1', 'student-id')],
    users,
    storage: { deleteError: new Error('storage offline') }
  });

  try {
    const result = await deleteJson(`${api.url}/entry-1`, { user: 'admin' });
    assert.equal(result.status, 200);
    assert.equal(api.repositoryRows.has('entry-1'), false, 'the row is still deleted');
  } finally {
    await api.close();
  }
});

// ---- Frontend: the Delete button must only exist for admins ----
const escape = text => String(text == null ? '' : text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

test('repository cards render a Delete button for admins and none for everyone else', () => {
  const item = record('entry-1', { title: 'Barangay Budget Transparency' });

  const adminCard = repositoryCardHtml(item, { isAdmin: true, escapeHtml: escape });
  assert.match(adminCard, /class="btn btn-danger btn-soft btn-sm repo-delete"/);
  assert.match(adminCard, /aria-label="Delete Barangay Budget Transparency"/);
  assert.match(adminCard, /<i class="bi bi-trash" aria-hidden="true"><\/i> Delete/);
  assert.match(adminCard, /data-id="entry-1"/);
  assert.match(adminCard, /data-title="Barangay Budget Transparency"/);

  for (const isAdmin of [false, undefined]) {
    const card = repositoryCardHtml(item, { isAdmin, escapeHtml: escape });
    assert.equal(/repo-delete/.test(card), false, 'no delete button markup exists for non-admins');
    assert.equal(card.includes('Delete'), false, 'no delete affordance at all for non-admins');
  }
});

test('repository card text is escaped, including the delete button attributes', () => {
  const nasty = record('entry"2', { title: '"><img src=x onerror=alert(1)>' });
  const card = repositoryCardHtml(nasty, { isAdmin: true, escapeHtml: escape });
  assert.equal(card.includes('<img'), false, 'record text cannot inject a raw tag');
  assert.match(card, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(card, /aria-label="Delete &quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;"/);
  assert.equal(card.includes('data-id="entry"2"'), false, 'the id attribute cannot be broken out of');
});

test('empty state is available for the last card removed', () => {
  assert.match(REPOSITORY_EMPTY_STATE, /empty-state/);
  assert.match(REPOSITORY_EMPTY_STATE, /No research records found/);
});
