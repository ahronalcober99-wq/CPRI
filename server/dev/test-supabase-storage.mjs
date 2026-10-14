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
      return response(200, { signedURL: '/object/sign/private-files/a/file.pdf?token=short-lived' });
    }
  });

  const url = await storage.createSignedDownloadUrl({
    path: 'a/file.pdf',
    downloadName: 'Original paper.pdf',
    expiresIn: 60
  });
  assert.equal(
    url,
    'https://project.example.test/storage/v1/object/sign/private-files/a/file.pdf?token=short-lived&download=Original+paper.pdf'
  );
  assert.equal(request.init.method, 'POST');
  assert.deepEqual(JSON.parse(request.init.body), { expiresIn: 60, download: 'Original paper.pdf' });
  assert.equal(url.includes(env.SUPABASE_SERVICE_KEY), false);
  await assert.rejects(
    storage.createSignedDownloadUrl({ path: 'a/file.pdf', downloadName: 'file.pdf', expiresIn: 61 }),
    /expiry must be from 1 to 60 seconds/
  );
});

test('normalizes all signed URL response forms without duplicating the Storage prefix', async () => {
  const cases = [
    {
      signedURL: '/object/sign/private-files/a%20folder/file.pdf?token=relative',
      expected: 'https://project.example.test/storage/v1/object/sign/private-files/a%20folder/file.pdf?token=relative&download=Report+%26+Results.pdf'
    },
    {
      signedUrl: 'https://project.example.test/storage/v1/object/sign/private-files/a/file.pdf?token=absolute',
      expected: 'https://project.example.test/storage/v1/object/sign/private-files/a/file.pdf?token=absolute&download=Report+%26+Results.pdf'
    },
    {
      signedURL: '/storage/v1/object/sign/private-files/a/file.pdf?token=full-path',
      expected: 'https://project.example.test/storage/v1/object/sign/private-files/a/file.pdf?token=full-path&download=Report+%26+Results.pdf'
    }
  ];

  for (const { signedURL, signedUrl, expected } of cases) {
    const storage = createSupabaseStorage({
      env,
      fetchImpl: async () => response(200, { signedURL, signedUrl })
    });
    assert.equal(await storage.createSignedDownloadUrl({
      path: 'a/file.pdf',
      downloadName: 'Report & Results.pdf'
    }), expected);
  }
});

test('signed URL API failures include upstream status and response body without credentials', async () => {
  const storage = createSupabaseStorage({
    env,
    fetchImpl: async () => response(502, {}, `Storage error; ${env.SUPABASE_SERVICE_KEY}`)
  });

  await assert.rejects(
    storage.createSignedDownloadUrl({ path: 'a/file.pdf', downloadName: 'file.pdf' }),
    error => error.message.includes('HTTP 502') &&
      error.message.includes('Storage error') &&
      error.message.includes('[redacted]') &&
      !error.message.includes(env.SUPABASE_SERVICE_KEY)
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

test('uses the configured public event bucket without changing the private default', async () => {
  const calls = [];
  const storage = createSupabaseStorage({
    env: { ...env, SUPABASE_EVENT_BUCKET: 'public-event-images' },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response(200);
    }
  });

  const path = 'events/id/cover image.webp'.replace(' ', '-');
  assert.deepEqual(await storage.uploadObject({
    path,
    buffer: Buffer.from('image'),
    contentType: 'image/webp',
    bucket: 'events'
  }), { path });
  assert.equal(
    calls[0].url,
    'https://project.example.test/storage/v1/object/public-event-images/events/id/cover-image.webp'
  );
  assert.equal(storage.publicObjectUrl({ path, bucket: 'events' }),
    'https://project.example.test/storage/v1/object/public/public-event-images/events/id/cover-image.webp');

  await storage.deleteObjects([path], { bucket: 'events' });
  assert.equal(calls[1].url, 'https://project.example.test/storage/v1/object/public-event-images');
  await storage.deleteObjects(['submissions/id/file.pdf']);
  assert.equal(calls[2].url, 'https://project.example.test/storage/v1/object/private-files');
});

test('event bucket configuration is required only for event operations', async () => {
  const storage = createSupabaseStorage({
    env,
    fetchImpl: async () => response(200)
  });

  assert.throws(
    () => storage.publicObjectUrl({ path: 'events/id/cover.jpg', bucket: 'events' }),
    error => error.message.includes('SUPABASE_EVENT_BUCKET') &&
      !error.message.includes(env.SUPABASE_SERVICE_KEY)
  );
  assert.equal(await storage.objectExists('submissions/id/file.pdf'), true);
});

test('rejects leading slashes, empty/dot segments, spaces, and special characters', async () => {
  const storage = createSupabaseStorage({ env, fetchImpl: async () => response(200) });
  for (const path of ['/leading.pdf', '../private.pdf', 'folder/a b.pdf', 'folder/a#b.pdf', 'folder//file.pdf']) {
    await assert.rejects(storage.objectExists(path), /Storage path is invalid/);
  }
});

test('rejects non-HTTPS project URLs', async () => {
  for (const url of ['http://project.example.test', 'http://10.0.0.5:4000', 'ftp://localhost']) {
    const insecure = createSupabaseStorage({ env: { ...env, SUPABASE_URL: url } });
    await assert.rejects(insecure.objectExists('private.pdf'), /must be a valid HTTPS URL/, url);
  }
});

test('accepts a loopback http URL so uploads can be tested against a local mock only', async () => {
  for (const url of ['http://localhost:4599', 'http://127.0.0.1:4599', 'http://[::1]:4599']) {
    const calls = [];
    const storage = createSupabaseStorage({
      env: { ...env, SUPABASE_URL: url },
      fetchImpl: async (requestUrl, init) => {
        calls.push({ url: requestUrl, init });
        return response(200);
      }
    });
    assert.equal(storage.isConfigured(), true, url);
    await storage.uploadObject({ path: 'profile-photos/u/1.webp', buffer: Buffer.from('x'), contentType: 'image/webp' });
    assert.ok(calls[0].url.startsWith(url.replace(/\/$/, '') + '/storage/v1/object/private-files/'), url);
  }
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

test('isConfigured reports each bucket separately without throwing', async () => {
  const complete = createSupabaseStorage({ env: { ...env, SUPABASE_EVENT_BUCKET: 'public-event-images' } });
  assert.equal(complete.isConfigured(), true);
  assert.equal(complete.isConfigured({ bucket: 'events' }), true);

  const noEventBucket = createSupabaseStorage({ env });
  assert.equal(noEventBucket.isConfigured(), true);
  assert.equal(noEventBucket.isConfigured({ bucket: 'events' }), false);

  const empty = createSupabaseStorage({ env: {} });
  assert.equal(empty.isConfigured(), false);
  assert.equal(empty.isConfigured({ bucket: 'events' }), false);
});

test('objectPathFromPublicUrl maps our own public URLs back to their storage path', async () => {
  const storage = createSupabaseStorage({ env: { ...env, SUPABASE_EVENT_BUCKET: 'public-event-images' } });
  const bucket = 'events';

  const path = 'profile-photos/user-1/9f8b.webp';
  assert.equal(
    storage.objectPathFromPublicUrl(storage.publicObjectUrl({ path, bucket }), { bucket }),
    path
  );
  // URL-encoded segments decode back to the stored path.
  assert.equal(
    storage.objectPathFromPublicUrl(
      'https://project.example.test/storage/v1/object/public/public-event-images/profile-photos/user-1/a%20b.webp',
      { bucket }
    ),
    null,
    'a path that could never have been uploaded (space) is not returned'
  );
  assert.equal(
    storage.objectPathFromPublicUrl(
      'https://project.example.test/storage/v1/object/public/private-files/submissions/file.pdf',
      { bucket }
    ),
    null,
    'another bucket is not ours'
  );

  for (const foreign of [
    'https://lh3.googleusercontent.com/a/photo.jpg',
    '/assets/uploads/profiles/old.jpg',
    'https://other.example.test/storage/v1/object/public/public-event-images/profile-photos/user-1/a.webp',
    'not a url',
    '',
    null
  ]) {
    assert.equal(storage.objectPathFromPublicUrl(foreign, { bucket }), null, String(foreign));
  }

  // An unconfigured bucket resolves nothing rather than throwing.
  const unconfigured = createSupabaseStorage({ env: {} });
  assert.equal(unconfigured.objectPathFromPublicUrl('https://project.example.test/storage/v1/object/public/x/a.webp', { bucket }), null);
});

test('downloadObject returns the object response and nulls a missing object', async () => {
  const calls = [];
  const storage = createSupabaseStorage({
    env,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('missing.pdf')) return response(404);
      return response(200);
    }
  });

  const found = await storage.downloadObject({ path: 'submissions/id/paper.pdf' });
  assert.equal(found.status, 200);
  assert.equal(calls[0].url, 'https://project.example.test/storage/v1/object/private-files/submissions/id/paper.pdf');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.apikey, env.SUPABASE_SERVICE_KEY);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${env.SUPABASE_SERVICE_KEY}`);

  assert.equal(await storage.downloadObject({ path: 'submissions/id/missing.pdf' }), null,
    'a missing object is null, so the caller can answer 404');
});

test('downloadObject keeps credentials out of its error and rejects unsafe paths', async () => {
  const storage = createSupabaseStorage({
    env,
    fetchImpl: async () => response(403, {}, `forbidden for ${env.SUPABASE_SERVICE_KEY}`)
  });

  await assert.rejects(
    storage.downloadObject({ path: 'submissions/id/paper.pdf' }),
    error => error.message.includes('HTTP 403') && !error.message.includes(env.SUPABASE_SERVICE_KEY)
  );

  await assert.rejects(
    storage.downloadObject({ path: '../escape.pdf' }),
    error => error.message.includes('Storage path is invalid')
  );
});
