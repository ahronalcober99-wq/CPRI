import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import bmp from 'bmp-js';
import sharp from 'sharp';
import {
  validateEventImage,
  normalizeEventImage,
  isEventImageObjectId,
  cleanupEventImages,
  MAX_EVENT_IMAGE_SIZE,
  EVENT_IMAGE_FORMAT_ERROR
} from '../event-image-utils.js';

const pixel = () => sharp({
  create: { width: 2, height: 2, channels: 3, background: '#336699' }
});

async function imageFixtures() {
  const avif = await pixel().avif({ effort: 0 }).toBuffer();
  const heic = Buffer.from(avif);
  heic.write('heic', 8, 4, 'ascii');
  for (let offset = 16; offset < heic.length - 4; offset += 4) {
    if (heic.toString('ascii', offset, offset + 4) === 'avif') heic.write('heic', offset, 4, 'ascii');
  }
  const heif = Buffer.from(heic);
  heif.write('mif1', 8, 4, 'ascii');
  for (let offset = 16; offset < heif.length - 4; offset += 4) {
    if (heif.toString('ascii', offset, offset + 4) === 'heic') heif.write('mif1', offset, 4, 'ascii');
  }
  const bmpImage = bmp.encode({
    data: Buffer.from([0, 0x33, 0x66, 0x99]),
    width: 1,
    height: 1
  }).data;
  return new Map([
    ['jpg', await pixel().jpeg().toBuffer()],
    ['png', await pixel().png().toBuffer()],
    ['webp', await pixel().webp().toBuffer()],
    ['gif', await pixel().gif().toBuffer()],
    ['avif', avif],
    ['bmp', bmpImage],
    ['tiff', await pixel().tiff().toBuffer()],
    ['heic', heic],
    ['heif', heif]
  ]);
}

const fixtures = await imageFixtures();
const imageNames = {
  jpg: 'cover.jpg',
  png: 'cover.png',
  webp: 'cover.webp',
  gif: 'cover.gif',
  avif: 'cover.avif',
  bmp: 'cover.bmp',
  tiff: 'cover.tiff',
  heic: 'cover.heic',
  heif: 'cover.heif'
};

test('accepts all configured formats based on content and normalizes only non-browser formats', async () => {
  assert.equal(
    EVENT_IMAGE_FORMAT_ERROR,
    'Only JPG, JPEG, PNG, WebP, GIF, AVIF, BMP, TIFF, HEIC, or HEIF images are allowed.'
  );

  for (const [format, buffer] of fixtures) {
    const result = await validateEventImage({
      originalname: imageNames[format],
      mimetype: 'application/octet-stream',
      size: buffer.length,
      buffer
    });
    if (['jpg', 'png', 'webp', 'gif'].includes(format)) {
      assert.equal(result.buffer, buffer, `${format} bytes should be preserved`);
      assert.equal(result.contentType, format === 'jpg' ? 'image/jpeg' : `image/${format}`);
      assert.equal(result.extension, format === 'jpg' ? '.jpg' : `.${format}`);
    } else {
      assert.equal(result.contentType, 'image/webp', `${format} should become WebP`);
      assert.equal(result.extension, '.webp', `${format} should use the normalized extension`);
      assert.equal((await sharp(result.buffer).metadata()).format, 'webp');
    }
  }

  const renamed = await validateEventImage({
    originalname: 'misleading.not-an-image',
    mimetype: 'image/jpeg',
    size: fixtures.get('png').length,
    buffer: fixtures.get('png')
  });
  assert.equal(renamed.contentType, 'image/png');
});

test('rejects unsupported, spoofed, and undecodable content with clear 400 errors', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  await assert.rejects(
    validateEventImage({ originalname: 'cover.jpg', mimetype: 'image/jpeg', size: svg.length, buffer: svg }),
    error => error.status === 400 && /JPG, JPEG, PNG, WebP, GIF, AVIF, BMP, TIFF, HEIC, or HEIF/.test(error.message)
  );
  await assert.rejects(
    validateEventImage({
      originalname: 'cover.jpg',
      mimetype: 'image/jpeg',
      size: Buffer.byteLength('not an image'),
      buffer: Buffer.from('not an image')
    }),
    error => error.status === 400
  );
  await assert.rejects(
    validateEventImage({ originalname: 'cover.jpg', mimetype: 'image/jpeg', size: 0 }),
    error => error.status === 400 && /empty or invalid/.test(error.message)
  );
});

test('rejects event images larger than 5 MiB', async () => {
  assert.equal(MAX_EVENT_IMAGE_SIZE, 5 * 1024 * 1024);
  await assert.rejects(
    validateEventImage({
      originalname: 'large.jpg',
      mimetype: 'image/jpeg',
      size: MAX_EVENT_IMAGE_SIZE + 1,
      buffer: Buffer.alloc(1)
    }),
    error => error.status === 400 && /max 5 MB/.test(error.message)
  );
});

test('normalizes legacy event image fields into canonical metadata', () => {
  assert.deepEqual(normalizeEventImage({ photo: '/assets/old.jpg' }), {
    imageUrl: '/assets/old.jpg',
    imagePublicId: ''
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

test('recognizes event-image objects in dedicated storage namespaces and supports GIF', () => {
  const id = 'events-module/123e4567-e89b-42d3-a456-426614174000/123e4567-e89b-42d3-a456-426614174001.gif';
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
  assert.equal(resolve({ photo: '/assets/old.jpg' }, 'https://cpri.example'), 'https://cpri.example/assets/old.jpg');
  assert.equal(resolve({ image: 'https://cdn.example/old.webp' }, 'https://cpri.example'), 'https://cdn.example/old.webp');
  assert.equal(resolve({}, 'https://cpri.example'), '');
  assert.match(browser.CPRIEventImages.placeholderDataUrl, /^data:image\/svg\+xml/);
});

test('browser upload helper builds acceptance and validation from the shared format config', async () => {
  const config = JSON.parse(await readFile(
    new URL('../../public/assets/js/event-image-formats.json', import.meta.url),
    'utf8'
  ));
  const input = { disabled: false, accept: '' };
  const errorField = { textContent: '' };
  const browser = {
    URL,
    document: {
      currentScript: { src: 'https://cpri.example/assets/js/event-image-upload.js' },
      querySelectorAll(selector) {
        return selector === '[data-event-image-upload]' ? [input] : [errorField];
      }
    },
    fetch: async () => ({ ok: true, json: async () => config }),
    console: { error() {} }
  };
  browser.globalThis = browser;
  vm.runInNewContext(
    await readFile(new URL('../../public/assets/js/event-image-upload.js', import.meta.url), 'utf8'),
    browser
  );

  assert.equal(await browser.CPRIEventUpload.ready, true);
  assert.equal(input.disabled, false);
  assert.deepEqual(
    input.accept.split(','),
    [...new Set([
      ...config.formats.flatMap(format => format.extensions),
      ...config.formats.flatMap(format => format.mimes)
    ])]
  );
  assert.deepEqual(
    ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp', '.tif', '.tiff', '.heic', '.heif']
      .map(name => browser.CPRIEventUpload.validate({ name, type: '' }).valid),
    Array(11).fill(true)
  );
  assert.equal(browser.CPRIEventUpload.validate({ name: 'vector.svg', type: 'image/svg+xml' }).valid, false);
  assert.equal(browser.CPRIEventUpload.needsPlaceholder({ name: 'phone.HEIC', type: '' }), true);
});
