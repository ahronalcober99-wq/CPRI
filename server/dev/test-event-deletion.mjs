import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteEventAcrossStores, isValidEventId } from '../event-deletion.js';

function makeTransaction({ moduleEvents = [], calls = [] } = {}) {
  return async callback => callback({
    async get(sql, params) {
      calls.push({ method: 'get', sql, params });
      return moduleEvents.find(event => event.id === params[0]) || null;
    },
    async all(sql, params) {
      calls.push({ method: 'all', sql, params });
      const title = params[0];
      return moduleEvents.filter(event => event.title.trim().toLowerCase() === title);
    },
    async run(sql, params) {
      calls.push({ method: 'run', sql, params });
    }
  });
}

test('deleting a visible content event removes same-title copies and linked module records', async () => {
  const content = [
    { id: 'content-1', title: '  Policy Forum  ' },
    { id: 'content-2', title: 'Different event' }
  ];
  const moduleEvents = [
    { id: 'module-1', title: 'policy forum', photo: '/module-photo.jpg' },
    { id: 'module-2', title: 'Policy Forum', photo: '' }
  ];
  const calls = [];
  let written;
  let cleaned;

  const deleted = await deleteEventAcrossStores('content-1', {
    readContentEvents: async () => content,
    writeContentEvents: async events => { written = events; },
    withTransaction: makeTransaction({ moduleEvents, calls }),
    cleanupFiles: async records => { cleaned = records; return []; }
  });

  assert.deepEqual(written, [{ id: 'content-2', title: 'Different event' }]);
  assert.equal(deleted.id, 'content-1');
  assert.equal(deleted.title, '  Policy Forum  ');
  assert.deepEqual(deleted.contentEvents.map(event => event.id), ['content-1']);
  assert.deepEqual(deleted.moduleEvents.map(event => event.id), ['module-1', 'module-2']);
  assert.deepEqual(cleaned.contentEvents, deleted.contentEvents);
  assert.deepEqual(cleaned.moduleEvents, deleted.moduleEvents);
  assert.deepEqual(deleted.warnings, []);
  assert.equal(calls.some(call =>
    call.method === 'run' &&
    call.sql.startsWith('DELETE FROM event_registrations') &&
    call.params.join(',') === 'module-1,module-2'
  ), true);
  assert.equal(calls.some(call => call.method === 'run' && call.sql.startsWith('DELETE FROM event_abstracts')), true);
  assert.equal(calls.some(call => call.method === 'run' && call.sql.startsWith('DELETE FROM events_module')), true);
});

test('event ids must be UUIDs', () => {
  assert.equal(isValidEventId('8f72ebb2-37e6-4388-ac87-5bf684f6c55c'), true);
  assert.equal(isValidEventId('not-an-id'), false);
  assert.equal(isValidEventId('8f72ebb2-37e6-4388-ac87-5bf684f6c55'), false);
});

test('deleting a module-only event does not change content events', async () => {
  const content = [{ id: 'content-1', title: 'Different event' }];
  let writeCount = 0;

  const deleted = await deleteEventAcrossStores('module-1', {
    readContentEvents: async () => content,
    writeContentEvents: async () => { writeCount += 1; },
    withTransaction: makeTransaction({
      moduleEvents: [{ id: 'module-1', title: 'Module-only event', photo: '' }]
    }),
    cleanupFiles: async () => []
  });

  assert.equal(deleted.moduleEvents[0].id, 'module-1');
  assert.equal(writeCount, 0);
});

test('missing events return null without writing content or cleaning files', async () => {
  let writeCount = 0;
  let cleanupCount = 0;

  const deleted = await deleteEventAcrossStores('missing', {
    readContentEvents: async () => [],
    writeContentEvents: async () => { writeCount += 1; },
    withTransaction: makeTransaction(),
    cleanupFiles: async () => { cleanupCount += 1; return []; }
  });

  assert.equal(deleted, null);
  assert.equal(writeCount, 0);
  assert.equal(cleanupCount, 0);
});

test('database failures restore the content event file and propagate', async () => {
  const content = [{ id: 'content-1', title: 'Policy Forum' }];
  const writes = [];
  const failure = new Error('commit unavailable');

  await assert.rejects(
    deleteEventAcrossStores('content-1', {
      readContentEvents: async () => content,
      writeContentEvents: async events => { writes.push(events); },
      withTransaction: async callback => {
        await callback({
          async get() { return null; },
          async all() { return []; },
          async run() {}
        });
        throw failure;
      },
      cleanupFiles: async () => []
    }),
    error => error === failure
  );
  assert.deepEqual(writes, [[], content]);
});
