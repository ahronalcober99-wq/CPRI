import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createRepositoryRouter } from '../repository.js';

const FILE_MISSING_MESSAGE = 'The file is no longer available. Please ask the author to upload it again.';

async function startApi({ records, submissions, users = {}, storage = {} }) {
  const calls = [];
  const repositoryRows = new Map(records.map(record => [record.id, { ...record }]));
  const submissionRows = new Map(submissions.map(submission => [submission.id, { ...submission }]));
  const router = createRepositoryRouter({
    optionalUser: async req => users[req.get('x-user')] || null,
    all: async (sql, params) => {
      calls.push({ method: 'all', sql, params });
      let visibleRecords = records;
      if (!/LOWER\(COALESCE\(r\.status, ''\)\) IN/.test(sql)) {
        visibleRecords = records;
      } else if (/owner_sub\.submitterId = \?/.test(sql)) {
        const ownerId = params[0];
        visibleRecords = records.filter(record =>
          ['approved', 'published'].includes(String(record.status).toLowerCase()) ||
          submissionRows.get(record.sourceSubmissionId)?.submitterId === ownerId
        );
      } else {
        visibleRecords = records.filter(record =>
          ['approved', 'published'].includes(String(record.status).toLowerCase())
        );
      }
      return visibleRecords.map(record => ({
        ...record,
        files: submissionRows.get(record.sourceSubmissionId)?.files || null
      }));
    },
    get: async (sql, params = []) => {
      calls.push({ method: 'get', sql, params });
      if (/FROM repository WHERE id = \?/.test(sql)) return repositoryRows.get(params[0]) || null;
      if (/FROM submissions WHERE id = \?/.test(sql)) return submissionRows.get(params[0]) || null;
      return null;
    },
    storage: {
      async objectExists(path) {
        calls.push({ method: 'exists', path });
        return storage.exists === undefined ? true : storage.exists;
      },
      async createSignedDownloadUrl(options) {
        calls.push({ method: 'sign', options });
        if (storage.signError) throw storage.signError;
        return storage.signedUrl || 'https://project.example.test/signed-file';
      }
    }
  });
  const app = express();
  app.use('/api/repository', router);
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/api/repository`,
    calls,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    })
  };
}

async function requestJson(url, { user, method = 'GET' } = {}) {
  const headers = user ? { 'x-user': user } : {};
  const response = await fetch(url, { method, headers });
  return { status: response.status, body: await response.json() };
}

function submission(id, ownerId, storagePath = 'submissions/s1/manuscript.pdf') {
  return {
    id,
    submitterId: ownerId,
    files: storagePath ? { manuscript: {
      storage_path: storagePath,
      original_name: 'Original paper.pdf',
      mime_type: 'application/pdf'
    } } : { manuscript: { filename: 'old-local-name.pdf', originalName: 'Old paper.pdf' } }
  };
}

function record(id, status, overrides = {}) {
  return {
    id,
    title: `Record ${id}`,
    authors: 'Author',
    department: 'Department',
    category: 'institutional',
    yearCompleted: '2026',
    status,
    accessLevel: 'downloadable',
    fileAvailable: 1,
    sourceSubmissionId: 'submission-1',
    ...overrides
  };
}

const users = {
  owner: { id: 'owner-id', role: 'student_researcher', status: 'active' },
  other: { id: 'other-id', role: 'student_researcher', status: 'active' },
  admin: { id: 'admin-id', role: 'admin', status: 'active' },
  staff: { id: 'staff-id', role: 'cpri_staff', status: 'active' }
};

test('repository list only exposes approved/published records to visitors and other users', async () => {
  const records = [
    record('approved', 'approved'),
    record('published', 'published'),
    record('pending', 'pending'),
    record('rejected', 'rejected')
  ];
  const api = await startApi({
    records,
    submissions: [submission('submission-1', 'owner-id')],
    users
  });

  try {
    const visitor = await requestJson(api.url);
    assert.deepEqual(visitor.body.records.map(item => item.id), ['approved', 'published']);
    assert.equal(visitor.body.records[0].fileAvailable, true);
    assert.equal(Object.hasOwn(visitor.body.records[0], 'files'), false);

    const other = await requestJson(api.url, { user: 'other' });
    assert.deepEqual(other.body.records.map(item => item.id), ['approved', 'published']);
    assert.match(api.calls[0].sql, /LOWER\(COALESCE\(r\.status, ''\)\) IN \('approved', 'published'\)/);
  } finally {
    await api.close();
  }
});

test('repository list lets owners see their own statuses and privileged roles see all statuses', async () => {
  const records = [
    record('mine-pending', 'pending'),
    record('others-rejected', 'rejected', { sourceSubmissionId: 'submission-2' })
  ];
  const api = await startApi({
    records,
    submissions: [
      submission('submission-1', 'owner-id'),
      submission('submission-2', 'different-owner')
    ],
    users
  });

  try {
    const owner = await requestJson(api.url, { user: 'owner' });
    assert.deepEqual(owner.body.records.map(item => item.id), ['mine-pending']);
    assert.deepEqual(owner.body.records[0].fileAvailable, true);

    for (const privileged of ['admin', 'staff']) {
      const response = await requestJson(api.url, { user: privileged });
      assert.deepEqual(response.body.records.map(item => item.id), ['mine-pending', 'others-rejected']);
    }
  } finally {
    await api.close();
  }
});

test('repository detail hides non-public statuses except from owner and privileged roles', async () => {
  const api = await startApi({
    records: [record('hidden', 'rejected')],
    submissions: [submission('submission-1', 'owner-id')],
    users
  });

  try {
    assert.equal((await requestJson(`${api.url}/hidden`)).status, 404);
    assert.equal((await requestJson(`${api.url}/hidden`, { user: 'other' })).status, 404);
    assert.equal((await requestJson(`${api.url}/hidden`, { user: 'owner' })).status, 200);
    assert.equal((await requestJson(`${api.url}/hidden`, { user: 'admin' })).status, 200);
    assert.equal((await requestJson(`${api.url}/hidden`, { user: 'staff' })).status, 200);
    const visible = await requestJson(`${api.url}/hidden`, { user: 'owner' });
    assert.equal(visible.body.record.fileAvailable, true);
    assert.equal(Object.hasOwn(visible.body.record, 'sourceSubmissionId'), false);
  } finally {
    await api.close();
  }
});

test('repository detail reports old local metadata as unavailable', async () => {
  const api = await startApi({
    records: [record('legacy', 'published', { fileAvailable: 1 })],
    submissions: [submission('submission-1', 'owner-id', null)],
    users
  });

  try {
    const detail = await requestJson(`${api.url}/legacy`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.record.fileAvailable, false);
    assert.equal(detail.body.canDownload, false);
  } finally {
    await api.close();
  }
});

test('repository download requires login and enforces status and access level', async () => {
  const api = await startApi({
    records: [record('rejected', 'rejected')],
    submissions: [submission('submission-1', 'owner-id')],
    users
  });

  try {
    assert.equal((await requestJson(`${api.url}/rejected/file`)).status, 401);
    assert.equal((await requestJson(`${api.url}/rejected/file`, { user: 'other' })).status, 403);
    assert.equal((await requestJson(`${api.url}/rejected/file`, { user: 'owner' })).status, 200);
    assert.equal((await requestJson(`${api.url}/rejected/file`, { user: 'admin' })).status, 200);
  } finally {
    await api.close();
  }
});

test('repository download returns a signed URL for an authorized published file', async () => {
  const api = await startApi({
    records: [record('published', 'published')],
    submissions: [submission('submission-1', 'owner-id', 'submissions/p1/random.pdf')],
    users
  });

  try {
    const result = await requestJson(`${api.url}/published/file`, { user: 'other' });
    assert.deepEqual(result, {
      status: 200,
      body: { ok: true, url: 'https://project.example.test/signed-file' }
    });
    const signed = api.calls.find(call => call.method === 'sign');
    assert.deepEqual(signed.options, {
      path: 'submissions/p1/random.pdf',
      downloadName: 'Original paper.pdf',
      expiresIn: 60
    });
  } finally {
    await api.close();
  }
});

test('repository download reports legacy, missing, and failed storage objects safely', async () => {
  const legacyApi = await startApi({
    records: [record('legacy', 'published')],
    submissions: [submission('submission-1', 'owner-id', null)],
    users
  });
  try {
    assert.deepEqual(await requestJson(`${legacyApi.url}/legacy/file`, { user: 'owner' }), {
      status: 404,
      body: { ok: false, message: FILE_MISSING_MESSAGE }
    });
  } finally {
    await legacyApi.close();
  }

  const missingApi = await startApi({
    records: [record('gone', 'published')],
    submissions: [submission('submission-1', 'owner-id')],
    users,
    storage: { exists: false }
  });
  try {
    assert.deepEqual(await requestJson(`${missingApi.url}/gone/file`, { user: 'owner' }), {
      status: 404,
      body: { ok: false, message: FILE_MISSING_MESSAGE }
    });
  } finally {
    await missingApi.close();
  }

  const errorApi = await startApi({
    records: [record('error', 'published')],
    submissions: [submission('submission-1', 'owner-id')],
    users,
    storage: { signError: new Error('Storage unavailable') }
  });
  try {
    assert.deepEqual(await requestJson(`${errorApi.url}/error/file`, { user: 'owner' }), {
      status: 500,
      body: { ok: false, message: 'Could not prepare the file download. Please try again.' }
    });
  } finally {
    await errorApi.close();
  }
});
