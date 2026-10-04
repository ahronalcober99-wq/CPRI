import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { runTransaction } from '../server/db/queries.js';
import { createPublicationsRouter } from '../publications.js';
import { createPublicationFeatureService } from '../publication-feature-service.js';
import {
  createFeaturedPublicationsRouter,
  invalidateFeaturedPublicationsCache
} from '../featured-publications.js';

async function startFeaturedApi(options) {
  const app = express();
  const router = createFeaturedPublicationsRouter(options);
  app.use('/api/publications', router);
  app.use((error, req, res, next) => {
    res.status(500).json({ error: error.message });
  });
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/api/publications`,
    router,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    })
  };
}

async function getJson(url) {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}

async function getJsonWithHeaders(url, headers) {
  const response = await fetch(url, { headers });
  return { status: response.status, body: await response.json() };
}

async function requestJson(url, method, body, headers = {}) {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function startManagementApi(router) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const userId = req.get('x-test-user-id');
    if (userId) req.session = { userId };
    next();
  });
  app.use('/api/publications', router);
  app.use((error, req, res, next) => {
    res.status(500).json({ error: error.message });
  });
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/api/publications`,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    })
  };
}

function fakeFeatureTransactions(initialRecords = []) {
  const records = new Map(initialRecords.map(record => [record.id, { ...record }]));
  const calls = [];
  let queue = Promise.resolve();
  let active = 0;
  let maximumActive = 0;
  let nextTransactionId = 0;

  async function withTransaction(callback) {
    let release;
    const previous = queue;
    queue = new Promise(resolve => { release = resolve; });
    await previous;
    active++;
    const transactionId = ++nextTransactionId;
    maximumActive = Math.max(maximumActive, active);
    const snapshot = new Map([...records].map(([id, record]) => [id, { ...record }]));
    const tx = {
      async all(sql, params) {
        calls.push({ transactionId, method: 'all', sql, params });
        assert.equal(sql, 'SELECT id FROM publications FOR UPDATE');
        return [...records.values()].map(record => ({ id: record.id }));
      },
      async get(sql, params = []) {
        calls.push({ transactionId, method: 'get', sql, params });
        if (sql === 'SELECT * FROM publications WHERE id = ?') {
          const record = records.get(params[0]);
          return record ? { ...record } : null;
        }
        if (/SELECT COUNT\(\*\) AS total FROM publications WHERE featured = \?/.test(sql)) {
          const excludesId = /AND id <> \?/.test(sql) ? params[1] : null;
          const total = [...records.values()].filter(record =>
            Number(record.featured) === Number(params[0]) &&
            (excludesId === null || record.id !== excludesId)
          ).length;
          return { total };
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
      async run(sql, params = []) {
        calls.push({ transactionId, method: 'run', sql, params });
        if (sql.startsWith('INSERT INTO publications')) {
          const columns = [...sql.matchAll(/`([^`]+)`/g)].map(match => match[1]);
          records.set(params[columns.indexOf('id')], Object.fromEntries(
            columns.map((column, index) => [column, params[index]])
          ));
          return { affectedRows: 1 };
        }
        if (sql.startsWith('UPDATE publications SET')) {
          const columns = [...sql.matchAll(/`([^`]+)` = \?/g)].map(match => match[1]);
          const id = params.at(-1);
          const record = records.get(id);
          if (record) columns.forEach((column, index) => { record[column] = params[index]; });
          return { affectedRows: record ? 1 : 0 };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }
    };
    try {
      return await callback(tx);
    } catch (error) {
      records.clear();
      snapshot.forEach((record, id) => records.set(id, record));
      throw error;
    } finally {
      active--;
      release();
    }
  }

  return { records, calls, withTransaction, get maximumActive() { return maximumActive; } };
}

function publication(id, overrides = {}) {
  return {
    id,
    title: `Publication ${id}`,
    status: 'published',
    featured: 0,
    submitterId: 'owner',
    ...overrides
  };
}

function fakePool(calls, { query, rollback } = {}) {
  return {
    async getConnection() {
      return {
        async beginTransaction() {
          calls.push('begin');
        },
        async query(sql, params) {
          calls.push(['query', sql, params]);
          if (query) return query(sql, params);
          if (sql.startsWith('UPDATE')) throw new Error('database failure');
          return [[{ id: 'pub-1' }], []];
        },
        async commit() {
          calls.push('commit');
        },
        async rollback() {
          calls.push('rollback');
          if (rollback) throw rollback;
        },
        release() {
          calls.push('release');
        }
      };
    }
  };
}

test('transaction commits successful work and always releases its connection', async () => {
  const calls = [];
  const result = await runTransaction(fakePool(calls), async ({ get }) => {
    await get('SELECT id FROM publications WHERE id = ?', ['pub-1']);
    return 'saved';
  });

  assert.equal(result, 'saved');
  assert.deepEqual(calls, [
    'begin',
    ['query', 'SELECT id FROM publications WHERE id = ?', ['pub-1']],
    'commit',
    'release'
  ]);
});

test('transaction rolls back and rethrows a query failure', async () => {
  const calls = [];
  await assert.rejects(
    runTransaction(fakePool(calls), async ({ run }) =>
      run('UPDATE publications SET featured = ? WHERE id = ?', [1, 'pub-1'])),
    /database failure/
  );
  assert.ok(calls.includes('rollback'));
  assert.ok(calls.includes('release'));
  assert.equal(calls.includes('commit'), false);
});

test('rollback failure does not mask the operation error and the connection is released', async () => {
  const calls = [];
  const originalError = new Error('database failure');
  await assert.rejects(
    runTransaction(fakePool(calls, {
      query: async () => { throw originalError; },
      rollback: new Error('rollback failure')
    }), async ({ run }) => run('UPDATE publications SET featured = ?', [1])),
    error => error === originalError
  );
  assert.ok(calls.includes('release'));
});

test('transaction helpers preserve JSON parsing and database parameter normalization', async () => {
  const calls = [];
  const pool = fakePool(calls, {
    query: async () => [[{ data: '{"ok":true}' }], []]
  });
  const date = '2026-10-04T14:25:38.228Z';

  const result = await runTransaction(pool, async ({ all, get, run }) => {
    const rows = await all('SELECT data FROM records WHERE createdAt = ?', [date]);
    const row = await get('SELECT data FROM records WHERE createdAt = ?', [date]);
    const writeResult = await run('UPDATE records SET createdAt = ?', [date]);
    return { rows, row, writeResult };
  });

  assert.deepEqual(result.rows, [{ data: { ok: true } }]);
  assert.deepEqual(result.row, { data: { ok: true } });
  assert.deepEqual(calls[1][2], ['2026-10-04 14:25:38']);
  assert.deepEqual(calls[2][2], ['2026-10-04 14:25:38']);
  assert.deepEqual(calls[3][2], ['2026-10-04 14:25:38']);
});

test('featured endpoint validates limits and returns the public response shape with bound queries', async () => {
  const queries = [];
  const api = await startFeaturedApi({
    now: () => 1_000,
    getQuery: async (sql, params) => {
      queries.push({ kind: 'count', sql, params });
      return { total: 2, faculty: 1, student: 1 };
    },
    allQuery: async (sql, params) => {
      queries.push({ kind: 'items', sql, params });
      return [{
        id: 'p1',
        title: 'Study',
        authors: 'A. Author',
        venue: 'Journal',
        year: '2026',
        authorType: 'faculty',
        pubType: 'international_journal',
        publicationLink: 'https://example.org/paper',
        doi: 'https://doi.org/10.1234/example',
        featured: 1,
        status: 'published',
        proofDocuments: [{ secret: true }],
        submitterName: 'Private submitter',
        volume: '99'
      }];
    }
  });

  try {
    assert.deepEqual(await getJson(`${api.url}/featured`), {
      status: 200,
      body: {
        items: [{
          id: 'p1',
          title: 'Study',
          authors: 'A. Author',
          venue: 'Journal',
          year: '2026',
          type: 'faculty',
          level: 'international',
          link: 'https://example.org/paper'
        }],
        counts: { total: 2, faculty: 1, student: 1 }
      }
    });

    const countQuery = queries.find(query => query.kind === 'count');
    const itemQuery = queries.find(query => query.kind === 'items');
    assert.match(countQuery.sql, /WHERE status = \?/);
    assert.deepEqual(countQuery.params, ['faculty', 'student', 'published']);
    assert.match(itemQuery.sql, /WHERE status = \?/);
    assert.deepEqual(itemQuery.params, ['published', 6]);
    assert.match(itemQuery.sql, /ORDER BY publicationDate DESC, createdAt DESC/);
    assert.doesNotMatch(itemQuery.sql, /\bfeatured\b/);
    assert.ok(queries.every(query => !query.sql.includes('p1')));
    assert.deepEqual(Object.keys((await getJson(`${api.url}/featured`)).body.items[0]), [
      'id', 'title', 'authors', 'venue', 'year', 'type', 'level', 'link'
    ]);

    for (const invalid of ['0', '-1', '13', '1.5', '1e0', 'abc']) {
      assert.deepEqual(await getJson(`${api.url}/featured?limit=${encodeURIComponent(invalid)}`), {
        status: 400,
        body: { error: 'limit must be an integer from 1 to 12.' }
      });
    }
    assert.deepEqual(await getJson(`${api.url}/featured?limit=1&limit=2`), {
      status: 400,
      body: { error: 'limit must be an integer from 1 to 12.' }
    });
    assert.equal(queries.length, 2);

    await getJson(`${api.url}/featured?limit=1`);
    await getJson(`${api.url}/featured?limit=12`);
    assert.deepEqual(queries.filter(query => query.kind === 'items').map(query => query.params.at(-1)), [
      6, 1, 12
    ]);
  } finally {
    await api.close();
  }
});

test('featured endpoint does not depend on homepage-only or optional publication columns', async () => {
  const queries = [];
  const api = await startFeaturedApi({
    getQuery: async () => ({ total: 1, faculty: 1, student: 0 }),
    allQuery: async (sql, params) => {
      queries.push({ sql, params });
      assert.doesNotMatch(sql, /\b(featured|publicationLink|proofDocuments)\b/);
      return [{
        id: 'p2',
        title: 'Recent study',
        authors: 'B. Author',
        venue: 'Research Journal',
        year: '2026',
        authorType: 'faculty',
        pubType: 'local_journal',
        doi: '10.1234/recent-study'
      }];
    }
  });

  try {
    assert.deepEqual(await getJson(`${api.url}/featured?limit=4`), {
      status: 200,
      body: {
        items: [{
          id: 'p2',
          title: 'Recent study',
          authors: 'B. Author',
          venue: 'Research Journal',
          year: '2026',
          type: 'faculty',
          level: 'local',
          link: 'https://doi.org/10.1234/recent-study'
        }],
        counts: { total: 1, faculty: 1, student: 0 }
      }
    });
    const itemQuery = queries.find(query => /LIMIT \?/.test(query.sql));
    assert.deepEqual(itemQuery.params, ['published', 4]);
    assert.match(itemQuery.sql, /ORDER BY publicationDate DESC, createdAt DESC/);
  } finally {
    await api.close();
  }
});

test('featured endpoint logs unexpected database errors before returning a server error', async () => {
  const errors = [];
  const databaseError = Object.assign(new Error('connection unavailable'), { code: 'ECONNREFUSED' });
  const api = await startFeaturedApi({
    logger: { error: (...args) => errors.push(args) },
    getQuery: async () => { throw databaseError; },
    allQuery: async () => []
  });

  try {
    assert.deepEqual(await getJson(`${api.url}/featured`), {
      status: 500,
      body: { error: databaseError.message }
    });
    assert.ok(errors.some(args => args.includes(databaseError.message)));
  } finally {
    await api.close();
  }
});

test('featured endpoint uses a 60-second cache and supports invalidation', async () => {
  let time = 10_000;
  let readCount = 0;
  const api = await startFeaturedApi({
    now: () => time,
    getQuery: async () => {
      readCount++;
      return { total: readCount, faculty: readCount, student: 0 };
    },
    allQuery: async () => {
      readCount++;
      return [{
        id: `p${readCount}`,
        title: 'Cached study',
        authors: 'A. Author',
        venue: 'Journal',
        year: '2026',
        authorType: 'unknown',
        pubType: 'other',
        publicationLink: 'javascript:alert(1)',
        doi: 'https://doi.org/10.1234/valid'
      }];
    }
  });

  try {
    const first = await getJson(`${api.url}/featured`);
    const cached = await getJson(`${api.url}/featured`);
    assert.deepEqual(cached, first);
    assert.equal(readCount, 2);
    assert.equal(first.body.items[0].type, 'other');
    assert.equal(first.body.items[0].level, 'other');
    assert.equal(first.body.items[0].link, 'https://doi.org/10.1234/valid');

    time += 60_001;
    const expired = await getJson(`${api.url}/featured`);
    assert.equal(readCount, 4);
    assert.notDeepEqual(expired, first);

    invalidateFeaturedPublicationsCache(api.router);
    await getJson(`${api.url}/featured`);
    assert.equal(readCount, 6);
  } finally {
    await api.close();
  }
});

test('featured endpoint rejects unsafe links and falls back to empty link', async () => {
  const api = await startFeaturedApi({
    getQuery: async () => ({ total: 1, faculty: 0, student: 0 }),
    allQuery: async () => [{
      id: 'p1',
      title: 'Study',
      authors: 'A. Author',
      venue: 'Journal',
      year: '2026',
      authorType: 'student',
      pubType: 'local_journal',
      publicationLink: 'javascript:alert(1)',
      doi: 'ftp://example.org/paper'
    }]
  });

  try {
    const response = await getJson(`${api.url}/featured`);
    assert.equal(response.status, 200);
    assert.equal(response.body.items[0].link, '');
    assert.equal(response.body.items[0].type, 'student');
    assert.equal(response.body.items[0].level, 'local');
  } finally {
    await api.close();
  }
});

test('featured endpoint links bare DOI identifiers and published PDF proofs', async () => {
  const api = await startFeaturedApi({
    getQuery: async () => ({ total: 2, faculty: 1, student: 1 }),
    allQuery: async () => [
      {
        id: 'doi-id',
        title: 'DOI study',
        authors: 'A. Author',
        venue: 'Journal',
        year: '2026',
        authorType: 'faculty',
        pubType: 'international_journal',
        doi: '10.1234/example.paper'
      },
      {
        id: 'pdf-id',
        title: 'PDF study',
        authors: 'B. Author',
        venue: 'Proceedings',
        year: '2025',
        authorType: 'student',
        pubType: 'conference_paper',
        proofDocuments: [
          { type: 'acceptance_letter', filename: 'acceptance.pdf' },
          { type: 'published_pdf', filename: 'published article.pdf' }
        ]
      }
    ]
  });

  try {
    const response = await getJson(`${api.url}/featured`);
    assert.equal(response.body.items[0].link, 'https://doi.org/10.1234/example.paper');
    assert.equal(
      response.body.items[1].link,
      '/api/publications/pdf-id/file/published%20article.pdf'
    );
    assert.deepEqual(Object.keys(response.body.items[1]), [
      'id', 'title', 'authors', 'venue', 'year', 'type', 'level', 'link'
    ]);
  } finally {
    await api.close();
  }
});

test('feature service enforces the six-item limit while allowing disable and edits at capacity', async () => {
  const store = fakeFeatureTransactions(
    Array.from({ length: 7 }, (_, index) => publication(`pub-${index + 1}`, {
      featured: index < 6 ? 1 : 0
    }))
  );
  const service = createPublicationFeatureService({ withTransaction: store.withTransaction });

  assert.deepEqual(await service.update('pub-7', { featured: 1 }), {
    ok: false,
    reason: 'limit'
  });
  const edited = await service.update('pub-1', { title: 'Updated at capacity' });
  assert.equal(edited.ok, true);
  assert.equal(edited.publication.title, 'Updated at capacity');
  assert.equal(Number(edited.publication.featured), 1);

  const disabled = await service.update('pub-2', { featured: 0 });
  assert.equal(disabled.ok, true);
  assert.equal(Number(store.records.get('pub-2').featured), 0);
  const enabled = await service.update('pub-7', { featured: 1 });
  assert.equal(enabled.ok, true);
  assert.equal([...store.records.values()].filter(row => Number(row.featured) === 1).length, 6);

  const created = await service.create(publication('pub-new', { featured: 1 }));
  assert.deepEqual(created, { ok: false, reason: 'limit' });
  assert.equal(store.calls.filter(call => call.sql === 'SELECT id FROM publications FOR UPDATE').length, 5);
});

test('feature service rejects unpublished features and clears a feature when unpublishing', async () => {
  const store = fakeFeatureTransactions([
    publication('published', { featured: 1 }),
    publication('draft', { status: 'submitted' })
  ]);
  const service = createPublicationFeatureService({ withTransaction: store.withTransaction });

  assert.deepEqual(await service.create(publication('new-draft', {
    status: 'submitted',
    featured: 1
  })), { ok: false, reason: 'unpublished' });
  assert.deepEqual(await service.update('draft', { featured: 1 }), {
    ok: false,
    reason: 'unpublished'
  });

  const unpublished = await service.update('published', { status: 'submitted' });
  assert.equal(unpublished.ok, true);
  assert.equal(unpublished.publication.status, 'submitted');
  assert.equal(Number(unpublished.publication.featured), 0);
  assert.equal(Number(store.records.get('published').featured), 0);
});

test('feature service creates a published featured publication within capacity', async () => {
  const store = fakeFeatureTransactions([
    publication('existing-1', { featured: 1 }),
    publication('existing-2', { featured: 1 }),
    publication('existing-3', { featured: 1 }),
    publication('existing-4', { featured: 1 }),
    publication('existing-5', { featured: 1 })
  ]);
  const service = createPublicationFeatureService({ withTransaction: store.withTransaction });
  const result = await service.create(publication('new', { featured: 1 }));

  assert.equal(result.ok, true);
  assert.equal(Number(result.publication.featured), 1);
  assert.equal(Number(store.records.get('new').featured), 1);
});

test('serialized transactions prevent concurrent updates from exceeding six featured records', async () => {
  const store = fakeFeatureTransactions(
    Array.from({ length: 12 }, (_, index) => publication(`pub-${index + 1}`))
  );
  const service = createPublicationFeatureService({ withTransaction: store.withTransaction });
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    service.update(`pub-${index + 1}`, { featured: 1 })
  ));

  assert.equal(results.filter(result => result.ok).length, 6);
  assert.equal(results.filter(result => result.reason === 'limit').length, 6);
  assert.equal(store.maximumActive, 1);
  assert.equal([...store.records.values()].filter(row => Number(row.featured) === 1).length, 6);
  const groupedCalls = store.calls.reduce((groups, call) => {
    const group = groups.get(call.transactionId) || [];
    group.push(call);
    groups.set(call.transactionId, group);
    return groups;
  }, new Map());
  assert.equal(groupedCalls.size, 12);
  for (const calls of groupedCalls.values()) {
    assert.equal(calls[0].sql, 'SELECT id FROM publications FOR UPDATE');
  }
});

test('publication detail is public-safe, hides unpublished records, and grants full data only to admins', async () => {
  const record = publication('pub-detail', {
    title: 'Public paper',
    volume: '12',
    doi: '10.1234/public',
    submitterId: 'private-user-id',
    submitterEmail: 'private@example.org',
    submitterName: 'Private Submitter',
    sourceSubmissionId: 'private-submission-id',
    proofDocuments: [{ filename: 'private/path.pdf' }]
  });
  let status = 'published';
  const router = createPublicationsRouter({
    requireAuth(req, res, next) {
      const userId = req.get('x-test-user-id');
      if (userId) req.session = { userId };
      next();
    },
    caller: async req => ({
      admin: { id: 'admin', role: 'admin', status: 'active' },
      member: { id: 'member', role: 'cpri_staff' }
    })[req.session?.userId] || null,
    get: async () => ({ ...record, status }),
    invalidateCache() {}
  });
  const api = await startManagementApi(router);

  try {
    const publicResponse = await getJson(`${api.url}/pub-detail`);
    assert.equal(publicResponse.status, 200);
    assert.equal(publicResponse.body.publication.title, 'Public paper');
    assert.equal(publicResponse.body.publication.doi, '10.1234/public');
    for (const privateField of ['submitterId', 'submitterEmail', 'submitterName', 'sourceSubmissionId', 'proofDocuments']) {
      assert.equal(Object.hasOwn(publicResponse.body.publication, privateField), false);
    }

    status = 'submitted';
    assert.deepEqual(await getJson(`${api.url}/pub-detail`), {
      status: 404,
      body: { error: 'Publication not found.' }
    });
    const adminResponse = await getJsonWithHeaders(`${api.url}/pub-detail`, { 'x-test-user-id': 'admin' });
    assert.equal(adminResponse.status, 200);
    assert.equal(adminResponse.body.publication.submitterId, 'private-user-id');
    assert.deepEqual(await getJson(`${api.url}/missing-publication`), {
      status: 404,
      body: { error: 'Publication not found.' }
    });
  } finally {
    await api.close();
  }
});

test('publication PATCH and DELETE require an authenticated administrator', async () => {
  const record = publication('pub-managed');
  const mutations = [];
  const router = createPublicationsRouter({
    requireAuth(req, res, next) {
      const userId = req.get('x-test-user-id');
      if (!userId) return res.status(401).json({ error: 'Not authenticated.' });
      req.session = { userId };
      next();
    },
    caller: async req => ({
      admin: { id: 'admin', role: 'admin', status: 'active' },
      member: { id: 'member', role: 'cpri_staff' }
    })[req.session.userId] || null,
    get: async () => record,
    featureService: {
      async update(id, changes) {
        mutations.push({ type: 'update', id, changes });
        return { ok: true, publication: { ...record, ...changes } };
      }
    },
    remove: async (table, id) => mutations.push({ type: 'delete', table, id }),
    invalidateCache() {}
  });
  const api = await startManagementApi(router);

  try {
    for (const method of ['PATCH', 'DELETE']) {
      assert.equal((await requestJson(`${api.url}/pub-managed`, method, {})).status, 401);
      assert.equal((await requestJson(`${api.url}/pub-managed`, method, {}, {
        'x-test-user-id': 'member'
      })).status, 403);
    }
    assert.equal(mutations.length, 0);

    assert.equal((await requestJson(`${api.url}/pub-managed`, 'PATCH', {
      status: 'published',
      pubType: 'national_journal'
    }, { 'x-test-user-id': 'admin' })).status, 200);
    assert.equal((await requestJson(`${api.url}/pub-managed`, 'DELETE', {}, {
      'x-test-user-id': 'admin'
    })).status, 200);
    assert.deepEqual(mutations.map(mutation => mutation.type), ['update', 'delete']);
  } finally {
    await api.close();
  }
});

test('publication proof downloads require an authenticated administrator', async () => {
  let databaseReads = 0;
  const router = createPublicationsRouter({
    requireAuth(req, res, next) {
      const userId = req.get('x-test-user-id');
      if (!userId) return res.status(401).json({ error: 'Not authenticated.' });
      req.session = { userId };
      next();
    },
    caller: async req => ({
      admin: { id: 'admin', role: 'admin', status: 'active' },
      staff: { id: 'staff', role: 'cpri_staff', status: 'active' }
    })[req.session.userId] || null,
    get: async () => {
      databaseReads++;
      return publication('pub-file', {
        proofDocuments: [{ filename: 'proof.pdf', originalName: 'proof.pdf' }]
      });
    }
  });
  const api = await startManagementApi(router);

  try {
    const path = `${api.url}/pub-file/file/proof.pdf`;
    assert.equal((await getJson(path)).status, 401);
    assert.equal((await getJsonWithHeaders(path, { 'x-test-user-id': 'staff' })).status, 403);
    assert.equal(databaseReads, 0);
  } finally {
    await api.close();
  }
});

test('publication routes reject owner feature attempts and non-admin edits with HTTP 403', async () => {
  const store = fakeFeatureTransactions([publication('pub-1')]);
  const router = createPublicationsRouter({
    requireAuth(req, res, next) {
      req.session = { userId: 'owner' };
      next();
    },
    caller: async () => ({ id: 'owner', role: 'faculty', username: 'owner' }),
    get: async () => publication('pub-1'),
    withTransaction: store.withTransaction,
    invalidateCache() {}
  });
  const api = await startManagementApi(router);

  try {
    const body = {
      title: 'New publication',
      authors: 'A. Author',
      journalOrConference: 'Journal',
      publicationDate: '2026-01-01',
      pubType: 'local_journal',
      status: 'published',
      featured: true
    };
    assert.deepEqual(await requestJson(api.url, 'POST', body), {
      status: 403,
      body: { error: 'Only staff can feature publications.' }
    });
    assert.deepEqual(await requestJson(`${api.url}/pub-1`, 'PATCH', { featured: true }), {
      status: 403,
      body: { error: 'Admin access required.' }
    });
    assert.equal(store.calls.length, 0);
  } finally {
    await api.close();
  }
});

test('admin mutations map the cap response and invalidate the featured cache on success', async () => {
  const initial = Array.from({ length: 7 }, (_, index) => publication(`pub-${index + 1}`, {
    featured: index < 6 ? 1 : 0
  }));
  const store = fakeFeatureTransactions(initial);
  let invalidations = 0;
  const router = createPublicationsRouter({
    requireAuth(req, res, next) {
      req.session = { userId: 'admin' };
      next();
    },
    caller: async () => ({ id: 'admin', role: 'admin', status: 'active', username: 'admin' }),
    get: async (sql, params) => store.records.get(params[0]) || null,
    remove: async (table, id) => store.records.delete(id),
    withTransaction: store.withTransaction,
    invalidateCache() { invalidations++; }
  });
  const api = await startManagementApi(router);

  try {
    const cap = await requestJson(`${api.url}/pub-7`, 'PATCH', { featured: true });
    assert.deepEqual(cap, {
      status: 409,
      body: { error: 'Only six publications can be featured on the homepage.' }
    });
    assert.equal(invalidations, 0);

    const created = await requestJson(api.url, 'POST', {
      title: 'New publication',
      authors: 'A. Author',
      journalOrConference: 'Journal',
      publicationDate: '2026-01-01',
      pubType: 'local_journal',
      status: 'published',
      featured: false
    });
    assert.equal(created.status, 201);
    assert.equal(Number(created.body.publication.featured), 0);
    assert.equal(invalidations, 1);

    const updated = await requestJson(`${api.url}/pub-7`, 'PATCH', { title: 'Edited' });
    assert.equal(updated.status, 200);
    assert.equal(invalidations, 2);

    const removed = await requestJson(`${api.url}/pub-7`, 'DELETE');
    assert.equal(removed.status, 200);
    assert.equal(invalidations, 3);
  } finally {
    await api.close();
  }
});
