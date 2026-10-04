import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseStorage } from '../storage/supabase-storage.js';

const env = {
  SUPABASE_URL: 'https://project.example.test/',
  SUPABASE_SERVICE_KEY: 'test-service-secret',
  SUPABASE_BUCKET: 'private-files'
};

function response(status, body = {}, text = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 400 ? 'Bad Request' : '',
    async json() { return body; },
    async text() { return text; }
  };
}

test('configuration failures name missing variables without values', async () => {
  const storage = createSupabaseStorage({ env: {} });
  await assert.rejects(
    storage.objectExists('files/record.pdf'),
    error => error.message.includes('SUPABASE_URL') &&
      error.message.includes('SUPABASE_SERVICE_KEY') &&
      error.message.includes('SUPABASE_BUCKET') &&
      !error.message.includes(env.SUPABASE_SERVICE_KEY)
  );
});

test('uploads a buffer using POST with normalized configuration and safe paths', async () => {
  const calls = [];
  const storage = createSupabaseStorage({
    env: {
      SUPABASE_URL: ' "https://project.example.test///" ',
      SUPABASE_SERVICE_KEY: ' "test-service-secret" ',
      SUPABASE_BUCKET: ' "private-files" '
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response(200);
    }
  });
  const buffer = Buffer.from('file content');

  assert.deepEqual(await storage.uploadObject({
    path: 'submissions/id/manuscript_1-2026.pdf',
    buffer,
    contentType: 'application/pdf'
  }), { path: 'submissions/id/manuscript_1-2026.pdf' });
  assert.equal(calls[0].url, 'https://project.example.test/storage/v1/object/private-files/submissions/id/manuscript_1-2026.pdf');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, buffer);
  assert.equal(calls[0].init.headers.apikey, env.SUPABASE_SERVICE_KEY);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${env.SUPABASE_SERVICE_KEY}`);
  assert.equal(calls[0].init.headers['Content-Type'], 'application/pdf');
  assert.equal(calls[0].init.headers['x-upsert'], 'false');
});

test('upload errors include status, bucket, path, and response body without exposing credentials', async () => {
  const storage = createSupabaseStorage({
    env,
    fetchImpl: async () => response(400, {}, `Invalid object name; ${env.SUPABASE_SERVICE_KEY}`)
  });

  await assert.rejects(
    storage.uploadObject({
      path: 'submissions/id/paper.pdf',
      buffer: Buffer.from('%PDF-test'),
      contentType: 'application/pdf'
    }),
    error => error.message.includes('HTTP 400') &&
      error.message.includes('private-files') &&
      error.message.includes('submissions/id/paper.pdf') &&
      error.message.includes('Invalid object name') &&
      error.message.includes('[redacted]') &&
      !error.message.includes(env.SUPABASE_SERVICE_KEY)
  );
});

test('creates signed URLs with a bounded expiry and original download name', async () => {
  let request;
  const storage = createSupabaseStorage({
    env,
    fetchImpl: async (url, init) => {
      request = { url, init };
      return response(200, { signedURL: '/storage/v1/object/sign/private-files/a/file.pdf?token=short-lived' });
    }
  });

  const url = await storage.createSignedDownloadUrl({
    path: 'a/file.pdf',
    downloadName: 'Original paper.pdf',
    expiresIn: 60
  });
  assert.equal(url, 'https://project.example.test/storage/v1/object/sign/private-files/a/file.pdf?token=short-lived');
  assert.equal(request.init.method, 'POST');
  assert.deepEqual(JSON.parse(request.init.body), { expiresIn: 60, download: 'Original paper.pdf' });
  assert.equal(url.includes(env.SUPABASE_SERVICE_KEY), false);
  await assert.rejects(
    storage.createSignedDownloadUrl({ path: 'a/file.pdf', downloadName: 'file.pdf', expiresIn: 61 }),
    /expiry must be from 1 to 60 seconds/
  );
});

test('reports missing objects and rejects unexpected Storage errors', async () => {
  let status = 404;
  const storage = createSupabaseStorage({
    env,
    fetchImpl: async () => response(status)
  });

  assert.equal(await storage.objectExists('a/old-file.docx'), false);
  status = 200;
  assert.equal(await storage.objectExists('a/current-file.docx'), true);
  status = 503;
  await assert.rejects(storage.objectExists('a/current-file.docx'), /HTTP 503/);
});

test('deletes uploaded objects by storage path', async () => {
  let request;
  const storage = createSupabaseStorage({
    env,
    fetchImpl: async (url, init) => {
      request = { url, init };
      return response(200);
    }
  });

  await storage.deleteObjects(['submissions/id/file.pdf']);
  assert.equal(request.url, 'https://project.example.test/storage/v1/object/private-files');
  assert.equal(request.init.method, 'DELETE');
  assert.deepEqual(JSON.parse(request.init.body), { prefixes: ['submissions/id/file.pdf'] });
});

test('rejects leading slashes, empty/dot segments, spaces, and special characters', async () => {
  const storage = createSupabaseStorage({ env, fetchImpl: async () => response(200) });
  for (const path of ['/leading.pdf', '../private.pdf', 'folder/a b.pdf', 'folder/a#b.pdf', 'folder//file.pdf']) {
    await assert.rejects(storage.objectExists(path), /Storage path is invalid/);
  }
});

test('rejects non-HTTPS project URLs', async () => {
  const insecure = createSupabaseStorage({
    env: { ...env, SUPABASE_URL: 'http://project.example.test' }
  });
  await assert.rejects(insecure.objectExists('private.pdf'), /must be a valid HTTPS URL/);
});

test('startup check requests the bucket and logs only safe configuration details', async () => {
  const calls = [];
  const logs = [];
  const storage = createSupabaseStorage({
    env: {
      SUPABASE_URL: ' "https://project.example.test///" ',
      SUPABASE_SERVICE_KEY: ' "test-service-secret" ',
      SUPABASE_BUCKET: ' "private-files" '
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response(200);
    }
  });
  const logger = {
    log: (...parts) => logs.push(parts.join(' ')),
    error: (...parts) => logs.push(parts.join(' '))
  };

  await storage.verifyBucketAtStartup(logger);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://project.example.test/storage/v1/bucket/private-files');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${env.SUPABASE_SERVICE_KEY}`);
  assert.ok(logs.includes('[storage] SUPABASE_URL host: project.example.test'));
  assert.ok(logs.includes('[storage] bucket: private-files'));
  assert.ok(logs.includes('[storage] SUPABASE_SERVICE_KEY set: true (length 19)'));
  assert.ok(logs.includes('[storage] bucket OK'));
  assert.equal(logs.some(line => line.includes(env.SUPABASE_SERVICE_KEY)), false);
});

test('startup bucket failures log the response status and message', async () => {
  const logs = [];
  const storage = createSupabaseStorage({
    env,
    fetchImpl: async () => response(403, {}, 'Bucket access denied')
  });
  const logger = {
    log: (...parts) => logs.push(parts.join(' ')),
    error: (...parts) => logs.push(parts.join(' '))
  };

  await storage.verifyBucketAtStartup(logger);
  assert.ok(logs.includes('[storage] bucket check failed: HTTP 403: Bucket access denied'));
});
