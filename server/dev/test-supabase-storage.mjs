import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseStorage } from '../storage/supabase-storage.js';

const env = {
  SUPABASE_URL: 'https://project.example.test/',
  SUPABASE_SERVICE_KEY: 'test-service-secret',
  SUPABASE_BUCKET: 'private files'
};

function response(status, body = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
  };
}

test('Supabase configuration failures name missing variables without values', async () => {
  const storage = createSupabaseStorage({ env: {} });
  await assert.rejects(
    storage.objectExists('files/record.pdf'),
    error => error.message.includes('SUPABASE_URL') &&
      error.message.includes('SUPABASE_SERVICE_KEY') &&
      error.message.includes('SUPABASE_BUCKET') &&
      !error.message.includes('test-service-secret')
  );
});

test('uploads a buffer to an encoded private bucket path with server credentials', async () => {
  const calls = [];
  const storage = createSupabaseStorage({
    env,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response(200);
    }
  });
  const buffer = Buffer.from('file content');

  assert.deepEqual(await storage.uploadObject({
    path: 'submissions/id/a b.pdf',
    buffer,
    contentType: 'application/pdf'
  }), { path: 'submissions/id/a b.pdf' });
  assert.equal(calls[0].url, 'https://project.example.test/storage/v1/object/private%20files/submissions/id/a%20b.pdf');
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(calls[0].init.body, buffer);
  assert.equal(calls[0].init.headers.apikey, env.SUPABASE_SERVICE_KEY);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${env.SUPABASE_SERVICE_KEY}`);
  assert.equal(calls[0].init.headers['Content-Type'], 'application/pdf');
  assert.equal(calls[0].init.headers['x-upsert'], 'false');
});

test('creates an absolute signed URL with bounded expiry and original download name', async () => {
  let request;
  const storage = createSupabaseStorage({
    env,
    fetchImpl: async (url, init) => {
      request = { url, init };
      return response(200, { signedURL: '/storage/v1/object/sign/private%20files/a/file.pdf?token=short-lived' });
    }
  });

  const url = await storage.createSignedDownloadUrl({
    path: 'a/file.pdf',
    downloadName: 'Original paper.pdf',
    expiresIn: 60
  });
  assert.equal(url, 'https://project.example.test/storage/v1/object/sign/private%20files/a/file.pdf?token=short-lived');
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
  assert.equal(request.url, 'https://project.example.test/storage/v1/object/private%20files');
  assert.equal(request.init.method, 'DELETE');
  assert.deepEqual(JSON.parse(request.init.body), { prefixes: ['submissions/id/file.pdf'] });
});

test('rejects malformed storage paths and non-HTTPS project URLs', async () => {
  const storage = createSupabaseStorage({ env, fetchImpl: async () => response(200) });
  await assert.rejects(storage.objectExists('../private.pdf'), /Storage path is invalid/);

  const insecure = createSupabaseStorage({
    env: { ...env, SUPABASE_URL: 'http://project.example.test' }
  });
  await assert.rejects(insecure.objectExists('private.pdf'), /must be a valid HTTPS URL/);
});
