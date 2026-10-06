import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  validateEventImage,
  normalizeEventImage,
  isEventImageObjectId,
  cleanupEventImages,
  MAX_EVENT_IMAGE_SIZE
} from '../event-image-utils.js';

test('accepts only matching JPG, JPEG, PNG, and WebP image files', () => {
  for (const [name, mimetype, buffer] of [
    ['cover.jpg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff])],
    ['cover.JPEG', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff])],
    ['cover.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['cover.webp', 'image/webp', Buffer.from('RIFF0000WEBP')]
  ]) {
    assert.equal(validateEventImage({ originalname: name, mimetype, size: 10, buffer }), mimetype);
  }
  assert.throws(
    () => validateEventImage({ originalname: 'cover.gif', mimetype: 'image/gif' }),
    /Only JPG, JPEG, PNG, or WebP/
  );
  assert.throws(
    () => validateEventImage({ originalname: 'cover.jpg', mimetype: 'image/png' }),
    /does not match/
  );
  assert.throws(
    () => validateEventImage({ originalname: 'cover.jpg', mimetype: 'image/jpeg', buffer: Buffer.from('not an image') }),
    /not a valid image/
  );
});

test('rejects event images larger than 5 MiB', () => {
  assert.equal(MAX_EVENT_IMAGE_SIZE, 5 * 1024 * 1024);
  assert.throws(
    () => validateEventImage({
      originalname: 'large.jpg',
      mimetype: 'image/jpeg',
      size: MAX_EVENT_IMAGE_SIZE + 1
    }),
    /max 5 MB/
  );
});

test('normalizes legacy event image fields into canonical metadata', () => {
  assert.deepEqual(normalizeEventImage({ photo: '/assets/old.jpg' }), {
    imageUrl: '/assets/old.jpg',
    imagePublicId: ''
  });

  test('recognizes only event-image objects in the dedicated storage namespaces', () => {
    const id = 'events-module/123e4567-e89b-42d3-a456-426614174000/123e4567-e89b-42d3-a456-426614174001.webp';
    assert.equal(isEventImageObjectId(id), true);
    assert.equal(isEventImageObjectId(id.replace('events-module', 'submissions')), false);
    assert.equal(isEventImageObjectId('../private/file.pdf'), false);
  });

  test('cloud image cleanup ignores invalid paths and logs failures without throwing', async () => {
    const calls = [];
    const logs = [];
    const storage = {
      async deleteObjects(ids, options) {
        calls.push({ ids, options });
        throw new Error('storage unavailable');
      }
    };
    const deleted = await cleanupEventImages([
      'content-events/123e4567-e89b-42d3-a456-426614174000/123e4567-e89b-42d3-a456-426614174001.png',
      '../private/file.pdf'
    ], {
      storage,
      logger: { error: (...parts) => logs.push(parts) },
      context: '[test] cleanup failed'
    });

    assert.equal(deleted, false);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].options, { bucket: 'events' });
    assert.deepEqual(logs, [['[test] cleanup failed:', 'storage unavailable']]);
    assert.equal(await cleanupEventImages(['../private/file.pdf'], { storage }), true);
  });

  test('browser resolver prefers canonical URLs, upgrades remote HTTP, and resolves legacy paths', async () => {
    const source = await readFile(new URL('../../public/assets/js/event-image-utils.js', import.meta.url), 'utf8');
    const browser = { URL };
    vm.runInNewContext(source, browser);
    const resolve = browser.CPRIEventImages.resolveImageUrl;

    assert.equal(
      resolve({ imageUrl: 'http://cdn.example/image.jpg', photo: '/legacy.jpg' }, 'https://cpri.example'),
      'https://cdn.example/image.jpg'
    );
    assert.equal(
      resolve({ photo: '/assets/old.jpg' }, 'https://cpri.example'),
      'https://cpri.example/assets/old.jpg'
    );
    assert.equal(
      resolve({ image: 'https://cdn.example/old.webp' }, 'https://cpri.example'),
      'https://cdn.example/old.webp'
    );
    assert.equal(resolve({}, 'https://cpri.example'), '');
    assert.match(browser.CPRIEventImages.placeholderDataUrl, /^data:image\/svg\+xml/);
  });
  assert.deepEqual(normalizeEventImage({
    imageUrl: 'https://cdn.example/image.webp',
    imagePublicId: 'events/id/image.webp',
    photo: '/assets/old.jpg'
  }), {
    imageUrl: 'https://cdn.example/image.webp',
    imagePublicId: 'events/id/image.webp'
  });
  assert.deepEqual(normalizeEventImage({
    imageurl: 'https://cdn.example/legacy-case.webp',
    imagepublicid: 'events-module/id/file.webp'
  }), {
    imageUrl: 'https://cdn.example/legacy-case.webp',
    imagePublicId: 'events-module/id/file.webp'
  });
  assert.deepEqual(normalizeEventImage({}), { imageUrl: '', imagePublicId: '' });
});
