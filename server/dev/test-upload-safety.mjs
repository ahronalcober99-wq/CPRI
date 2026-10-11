// Tests for the shared upload guards used by every disk-storage upload route:
//   server/lib/upload-safety.js
//     • documentFileFilter — the extension + MIME allow-list
//     • uploadErrorHandler — multer failures answered as friendly 400 JSON
//
// The HTTP half runs a real multer 2.x + Express stack so the check covers what
// a browser would actually get, not just the pure functions.
//
// Run: npm run test:uploads
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import multer from 'multer';
import {
  isAllowedUploadFile,
  documentFileFilter,
  uploadErrorHandler,
  INVALID_FILE_TYPE_MESSAGE
} from '../lib/upload-safety.js';

const file = (originalname, mimetype) => ({ originalname, mimetype });

test('the allow-list accepts the documents and images CPRI receives', () => {
  const accepted = [
    ['report.pdf', 'application/pdf'],
    ['form.doc', 'application/msword'],
    ['thesis.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['thesis.docx', 'application/zip'],           // some browsers send plain zip
    ['data.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['notes.txt', 'text/plain'],
    ['results.csv', 'text/csv'],
    ['scan.PNG', 'image/png'],                    // extension match is case-insensitive
    ['poster.jpg', 'image/jpeg'],
    ['photo.webp', 'image/webp'],
    ['archive.zip', 'application/x-zip-compressed'],
    ['report.pdf', 'application/octet-stream'],   // generic type, accepted extension
    ['report.pdf', '']                            // no type at all, accepted extension
  ];
  for (const [name, type] of accepted) {
    assert.equal(isAllowedUploadFile(file(name, type)), true, `${name} (${type})`);
  }
});

test('the allow-list refuses executables, pages and scripts', () => {
  const refused = [
    ['setup.exe', 'application/octet-stream'],
    ['index.html', 'text/html'],
    ['payload.svg', 'image/svg+xml'],
    ['shell.sh', 'application/x-sh'],
    ['app.apk', 'application/vnd.android.package-archive'],
    ['note', 'text/plain'],                        // no extension
    ['archive.tar.gz', 'application/gzip'],        // extension not on the list
    ['', 'application/pdf'],                       // no name
    ['report.pdf.exe', 'application/pdf']          // double extension ends in .exe
  ];
  for (const [name, type] of refused) {
    assert.equal(isAllowedUploadFile(file(name, type)), false, `${name} (${type})`);
  }
});

test('an extension that contradicts the reported type is refused', () => {
  assert.equal(isAllowedUploadFile(file('report.pdf', 'text/html')), false);
  assert.equal(isAllowedUploadFile(file('photo.png', 'application/pdf')), false);
});

// ---------------------------------------------------------------
// The middleware pair, exercised over real HTTP
// ---------------------------------------------------------------
async function startUploadServer({ maxBytes = 1024, maxMb = 1 } = {}) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes },
    fileFilter: documentFileFilter
  });
  const app = express();
  app.post('/doc', upload.single('file'), (req, res) => {
    res.status(201).json({ ok: true, name: req.file.originalname, bytes: req.file.size });
  });
  // Same placement as the routers: after the upload route.
  app.use(uploadErrorHandler({ label: 'Document', maxMb }));
  app.use((err, req, res, next) => res.status(500).json({ crashed: true, message: err.message }));

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  server.unref();
  return {
    url: `http://127.0.0.1:${server.address().port}/doc`,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  };
}

function multipart({ filename, type, body }) {
  const boundary = '----cpri' + Date.now();
  const parts = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${type}\r\n\r\n`),
    body,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ];
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

const send = async (url, form) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': form.contentType }, body: form.body });
  return { status: res.status, body: await res.json() };
};

test('an allowed file uploads normally', async () => {
  const api = await startUploadServer();
  const out = await send(api.url, multipart({ filename: 'report.pdf', type: 'application/pdf', body: Buffer.from('%PDF-1.7 test') }));
  assert.equal(out.status, 201);
  assert.deepEqual(out.body, { ok: true, name: 'report.pdf', bytes: 13 });
  await api.close();
});

test('a rejected file type answers a friendly 400 JSON, not a 500', async () => {
  const api = await startUploadServer();
  const out = await send(api.url, multipart({ filename: 'evil.exe', type: 'application/octet-stream', body: Buffer.from('MZ') }));
  assert.equal(out.status, 400);
  assert.equal(out.body.error, INVALID_FILE_TYPE_MESSAGE);
  assert.match(out.body.allowed, /\.pdf/);
  assert.notEqual(out.body.crashed, true, 'must not fall through to the crash handler');
  await api.close();
});

test('an oversized file answers a friendly 400 JSON, not a 500', async () => {
  const api = await startUploadServer({ maxBytes: 64, maxMb: 0.000064 });
  const out = await send(api.url, multipart({ filename: 'big.pdf', type: 'application/pdf', body: Buffer.alloc(4096) }));
  assert.equal(out.status, 400);
  assert.match(out.body.error, /too large/i);
  assert.equal(out.body.crashed, undefined, 'must not fall through to the crash handler');
  await api.close();
});

test('an unexpected field still produces JSON', async () => {
  const api = await startUploadServer();
  const boundary = '----cpri' + Date.now();
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="wrong"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\nx\r\n`),
    Buffer.from(`--${boundary}--\r\n`)
  ]);
  const res = await fetch(api.url, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body
  });
  const json = await res.json();
  assert.equal(res.status, 400);
  assert.match(json.error, /upload failed/i);
  await api.close();
});
