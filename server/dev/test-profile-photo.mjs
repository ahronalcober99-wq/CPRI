// Tests for the profile photo (avatar) feature:
//   POST   /api/profile/photo   (server/profile-photo.js)
//   DELETE /api/profile/photo
//   processProfilePhoto — magic-byte validation, 2 MB cap, 512×512 WebP output
//
// The router is dependency-injected (like server/phone-verification.js), so the
// whole flow runs against an in-memory user row and a fake storage backend: no
// database, no Supabase account and no network are needed.
//
// Run: npm run test:photo
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import rateLimit from 'express-rate-limit';
import sharp from 'sharp';
import {
  createProfilePhotoRouter,
  processProfilePhoto,
  ensureProfilePhotoColumn,
  MAX_PHOTO_BYTES,
  PHOTO_FORMAT_MESSAGE,
  PHOTO_SIZE_MESSAGE,
  STORAGE_UNAVAILABLE_MESSAGE
} from '../profile-photo.js';

const PUBLIC_URL_PREFIX = 'https://project.example.test/storage/v1/object/public/public-event-images/';

// ---------------------------------------------------------------
// Fixtures: real images, produced by the same library the server uses.
// ---------------------------------------------------------------
const image = (format) => sharp({
  create: { width: 1200, height: 800, channels: 3, background: '#7a0000' }
})[format]().toBuffer();

// ---------------------------------------------------------------
// Harness: in-memory user rows + a fake storage backend.
// ---------------------------------------------------------------
function fakeStorage({ configured = true, uploadFails = false } = {}) {
  const objects = new Map();
  const deleted = [];
  return {
    objects,
    deleted,
    isConfigured: () => configured,
    uploadObject: async ({ path, buffer }) => {
      if (uploadFails) throw new Error('storage is down');
      objects.set(path, buffer);
      return { path };
    },
    publicObjectUrl: ({ path }) => `${PUBLIC_URL_PREFIX}${path}`,
    objectPathFromPublicUrl: (rawUrl) => (
      typeof rawUrl === 'string' && rawUrl.startsWith(PUBLIC_URL_PREFIX)
        ? rawUrl.slice(PUBLIC_URL_PREFIX.length)
        : null
    ),
    deleteObjects: async (paths) => {
      for (const path of paths) {
        deleted.push(path);
        objects.delete(path);
      }
    }
  };
}

async function startApi({ users = [], storage = fakeStorage(), limiter } = {}) {
  const rows = new Map(users.map((user) => [user.id, { ...user }]));
  const logs = [];

  const queries = {
    get: async (sql, params) => {
      if (/FROM users WHERE id = \?/i.test(sql)) return rows.get(params[0]) || null;
      throw new Error(`Unhandled get(): ${sql}`);
    },
    update: async (table, id, changes) => {
      assert.equal(table, 'users');
      const row = rows.get(id);
      if (!row) throw new Error(`No user row for ${id}`);
      Object.assign(row, changes);
    }
  };

  const router = createProfilePhotoRouter({
    storage,
    get: queries.get,
    update: queries.update,
    logger: { error: (...parts) => logs.push(parts.join(' ')), log: () => {} },
    // A stand-in for the session middleware: the tests say who is signed in
    // with the x-user header, and the router still reads req.session.userId.
    requireAuth: (req, res, next) => {
      const userId = req.get('x-user');
      if (!userId) return res.status(401).json({ error: 'Not authenticated.' });
      req.session = { userId };
      next();
    },
    ...(limiter ? { limiter } : {})
  });

  const app = express();
  app.use('/api/profile/photo', router);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  server.unref();

  return {
    url: `http://127.0.0.1:${server.address().port}/api/profile/photo`,
    storage,
    logs,
    user: (id) => rows.get(id),
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
}

async function upload(url, { buffer, filename = 'photo.jpg', type = 'image/jpeg', user, extra = {} } = {}) {
  const form = new FormData();
  form.append('photo', new Blob([buffer], { type }), filename);
  for (const [key, value] of Object.entries(extra)) form.append(key, value);
  const res = await fetch(url, {
    method: 'POST',
    headers: user ? { 'x-user': user } : {},
    body: form
  });
  return { status: res.status, body: await res.json() };
}

const student = { id: 'user-1', username: 'student', profilePhoto: null };

// ---------------------------------------------------------------
// processProfilePhoto — no HTTP, no storage
// ---------------------------------------------------------------
test('processProfilePhoto accepts JPEG, PNG and WebP and returns a 512×512 WebP', async () => {
  for (const format of ['jpeg', 'png', 'webp']) {
    const result = await processProfilePhoto(await image(format));
    assert.equal(result.contentType, 'image/webp');
    assert.equal(result.extension, '.webp');
    const meta = await sharp(result.buffer).metadata();
    assert.equal(meta.format, 'webp', format);
    assert.equal(meta.width, 512);
    assert.equal(meta.height, 512);
    assert.ok(result.buffer.length < MAX_PHOTO_BYTES, 'the stored photo is far smaller than the upload cap');
  }
});

test('processProfilePhoto strips EXIF metadata (including GPS)', async () => {
  // A JPEG whose EXIF block carries an orientation tag and a GPS pointer.
  const withExif = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#2a0a08' } })
    .jpeg()
    .withMetadata({ exif: { IFD0: { Copyright: 'CPRI test' } } })
    .toBuffer();
  assert.ok((await sharp(withExif).metadata()).exif, 'fixture really has EXIF');

  const result = await processProfilePhoto(withExif);
  const meta = await sharp(result.buffer).metadata();
  assert.equal(meta.exif, undefined, 'EXIF must not survive the resize');
});

test('processProfilePhoto rejects a non-image that claims to be a JPEG', async () => {
  await assert.rejects(
    processProfilePhoto(Buffer.from('%PDF-1.4\nnot a photo at all')),
    (error) => error.status === 400 && error.message === PHOTO_FORMAT_MESSAGE
  );
});

test('processProfilePhoto rejects an empty file and anything over 2 MB', async () => {
  await assert.rejects(processProfilePhoto(Buffer.alloc(0)), (error) => error.status === 400);
  await assert.rejects(
    processProfilePhoto(Buffer.alloc(MAX_PHOTO_BYTES + 1, 7)),
    (error) => error.status === 400 && error.message === PHOTO_SIZE_MESSAGE
  );
});

// ---------------------------------------------------------------
// POST /api/profile/photo
// ---------------------------------------------------------------
test('upload saves a random-named object, records the URL and answers with url', async () => {
  const api = await startApi({ users: [student] });
  const { status, body } = await upload(api.url, { buffer: await image('jpeg'), user: 'user-1' });

  assert.equal(status, 200);
  assert.match(body.url, /^https:\/\/project\.example\.test\/storage\/v1\/object\/public\/public-event-images\/profile-photos\/user-1\/[0-9a-f-]{36}\.webp$/);
  assert.equal(body.profilePhoto, body.url);
  assert.equal(body.photoUrl, body.url);

  // The original filename never reaches storage, and the stored bytes are WebP.
  assert.equal([...api.storage.objects.keys()].length, 1);
  const [objectPath] = [...api.storage.objects.keys()];
  assert.match(objectPath, /^profile-photos\/user-1\/[0-9a-f-]{36}\.webp$/);
  assert.equal((await sharp(api.storage.objects.get(objectPath)).metadata()).format, 'webp');
  assert.equal(api.user('user-1').profilePhoto, body.url);

  await api.close();
});

test('upload requires login', async () => {
  const api = await startApi({ users: [student] });
  const result = await upload(api.url, { buffer: await image('jpeg') });
  assert.equal(result.status, 401);
  assert.equal(api.storage.objects.size, 0);
  await api.close();
});

test('upload ignores any user id in the request body and uses the session only', async () => {
  const api = await startApi({ users: [student, { id: 'user-2', username: 'other', profilePhoto: null }] });
  const result = await upload(api.url, {
    buffer: await image('png'),
    user: 'user-1',
    extra: { userId: 'user-2', id: 'user-2' }
  });

  assert.equal(result.status, 200);
  assert.match([...api.storage.objects.keys()][0], /^profile-photos\/user-1\//);
  assert.equal(api.user('user-1').profilePhoto, result.body.url);
  assert.equal(api.user('user-2').profilePhoto, null, 'another account is never touched');
  await api.close();
});

test('replacing a photo deletes the previous stored object', async () => {
  const api = await startApi({
    users: [{ ...student, profilePhoto: `${PUBLIC_URL_PREFIX}profile-photos/user-1/old.webp` }]
  });
  api.storage.objects.set('profile-photos/user-1/old.webp', Buffer.from('old'));

  const result = await upload(api.url, { buffer: await image('webp'), user: 'user-1' });
  assert.equal(result.status, 200);
  assert.deepEqual(api.storage.deleted, ['profile-photos/user-1/old.webp']);
  assert.equal(api.storage.objects.has('profile-photos/user-1/old.webp'), false);
  assert.equal(api.storage.objects.size, 1, 'only the new photo remains');
  await api.close();
});

test('a Google OAuth picture is replaced without trying to delete it', async () => {
  const api = await startApi({
    users: [{ ...student, profilePhoto: 'https://lh3.googleusercontent.com/a/photo.jpg' }]
  });
  const result = await upload(api.url, { buffer: await image('jpeg'), user: 'user-1' });
  assert.equal(result.status, 200);
  assert.deepEqual(api.storage.deleted, [], 'nothing of ours to delete');
  assert.equal(api.user('user-1').profilePhoto, result.body.url);
  await api.close();
});

test('upload rejects bad formats and oversized files with friendly messages', async () => {
  const api = await startApi({ users: [student] });

  const disguised = await upload(api.url, { buffer: Buffer.from('MZ not an image'), user: 'user-1' });
  assert.equal(disguised.status, 400);
  assert.equal(disguised.body.error, PHOTO_FORMAT_MESSAGE);

  // Same bytes with a correct-looking Content-Type and extension still fail:
  // the check is on magic bytes.
  const lying = await upload(api.url, {
    buffer: Buffer.from('GIF89a'), type: 'image/png', filename: 'photo.png', user: 'user-1'
  });
  assert.equal(lying.status, 400);
  assert.equal(lying.body.error, PHOTO_FORMAT_MESSAGE);

  const huge = await upload(api.url, { buffer: Buffer.alloc(MAX_PHOTO_BYTES + 1024, 3), user: 'user-1' });
  assert.equal(huge.status, 400);
  assert.equal(huge.body.error, PHOTO_SIZE_MESSAGE);

  assert.equal(api.storage.objects.size, 0, 'nothing was stored');
  assert.equal(api.user('user-1').profilePhoto, null, 'the profile was left alone');
  await api.close();
});

test('upload reports missing storage configuration as a 503, not a crash', async () => {
  const api = await startApi({ users: [student], storage: fakeStorage({ configured: false }) });
  const result = await upload(api.url, { buffer: await image('jpeg'), user: 'user-1' });

  assert.equal(result.status, 503);
  assert.equal(result.body.error, STORAGE_UNAVAILABLE_MESSAGE);
  assert.ok(api.logs.some((line) => line.includes('storage is not configured')));
  await api.close();
});

test('a storage failure answers 500 and never records a broken URL', async () => {
  const api = await startApi({ users: [student], storage: fakeStorage({ uploadFails: true }) });
  const result = await upload(api.url, { buffer: await image('jpeg'), user: 'user-1' });

  assert.equal(result.status, 500);
  assert.match(result.body.error, /Could not save your photo right now/);
  assert.equal(api.user('user-1').profilePhoto, null);
  assert.ok(api.logs.some((line) => line.includes('upload failed')), 'the real reason is logged for the admin');
  await api.close();
});

test('upload is rate limited', async () => {
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 2,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many photo uploads. Please wait a few minutes and try again.' }
  });
  const api = await startApi({ users: [student], limiter });
  const jpeg = await image('jpeg');

  assert.equal((await upload(api.url, { buffer: jpeg, user: 'user-1' })).status, 200);
  assert.equal((await upload(api.url, { buffer: jpeg, user: 'user-1' })).status, 200);
  // The two allowed uploads replace each other, leaving the current photo only.
  const storedAfterTwo = api.storage.objects.size;
  assert.equal(storedAfterTwo, 1);

  const third = await upload(api.url, { buffer: jpeg, user: 'user-1' });
  assert.equal(third.status, 429);
  assert.match(third.body.error, /Too many photo uploads/);
  assert.equal(api.storage.objects.size, storedAfterTwo, 'the blocked upload stored nothing');
  await api.close();
});

// ---------------------------------------------------------------
// DELETE /api/profile/photo
// ---------------------------------------------------------------
test('delete removes the stored object and clears the profile field', async () => {
  const api = await startApi({
    users: [{ ...student, profilePhoto: `${PUBLIC_URL_PREFIX}profile-photos/user-1/photo.webp` }]
  });
  api.storage.objects.set('profile-photos/user-1/photo.webp', Buffer.from('photo'));

  const res = await fetch(api.url, { method: 'DELETE', headers: { 'x-user': 'user-1' } });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.photoUrl, null);
  assert.deepEqual(api.storage.deleted, ['profile-photos/user-1/photo.webp']);
  assert.equal(api.user('user-1').profilePhoto, null);
  await api.close();
});

test('delete works when there is no photo, and requires login', async () => {
  const api = await startApi({ users: [{ ...student, profilePhoto: null }] });

  const anonymous = await fetch(api.url, { method: 'DELETE' });
  assert.equal(anonymous.status, 401);

  const res = await fetch(api.url, { method: 'DELETE', headers: { 'x-user': 'user-1' } });
  assert.equal(res.status, 200);
  assert.equal(api.user('user-1').profilePhoto, null);
  await api.close();
});

// ---------------------------------------------------------------
// Schema repair
// ---------------------------------------------------------------
test('ensureProfilePhotoColumn adds the column only when it is missing', async () => {
  const run = [];
  const withColumn = { all: async () => [{ Field: 'id' }, { Field: 'profilePhoto' }] };
  await ensureProfilePhotoColumn({ ...withColumn, run: async (sql) => run.push(sql) });
  assert.deepEqual(run, [], 'an existing column is never re-added');

  const without = { all: async () => [{ Field: 'id' }, { Field: 'email' }], run: async (sql) => run.push(sql) };
  await ensureProfilePhotoColumn(without);
  assert.deepEqual(run, ['ALTER TABLE users ADD COLUMN profilePhoto VARCHAR(255) DEFAULT NULL']);
});
