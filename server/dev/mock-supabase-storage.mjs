// Local mock of the Supabase Storage REST API (see server/storage/supabase-storage.js).
//
// Why: every upload path (repository files, event covers, profile photos) talks
// to Supabase over HTTPS. Without a Supabase project you cannot exercise those
// paths locally at all, so this mock implements just the endpoints the adapter
// uses — upload, delete, bucket check and public reads — keeping objects in
// memory. Nothing here is used in production.
//
// Usage (mock on :4599, then the app pointing at it):
//   node server/dev/mock-supabase-storage.mjs
//   SUPABASE_URL=http://localhost:4599 \
//   SUPABASE_SERVICE_KEY=local-test-service-key \
//   SUPABASE_EVENT_BUCKET=public-event-images \
//   npm start
//
// The adapter only accepts an http:// project URL for loopback hosts, which is
// exactly what this mock is.
import { createServer } from 'http';

const PORT = Number(process.env.MOCK_SUPABASE_PORT || 4599);
const SERVICE_KEY = process.env.MOCK_SUPABASE_KEY || 'local-test-service-key';

/** bucket -> Map(objectPath -> { buffer, contentType }) */
const buckets = new Map();

function send(res, status, body, contentType = 'application/json') {
  const payload = contentType === 'application/json' ? JSON.stringify(body ?? {}) : body;
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function authorized(req) {
  const key = req.headers.apikey;
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return key === SERVICE_KEY && bearer === SERVICE_KEY;
}

function objectType(path) {
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.png')) return 'image/png';
  if (/\.jpe?g$/.test(path)) return 'image/jpeg';
  if (path.endsWith('.pdf')) return 'application/pdf';
  return 'application/octet-stream';
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const segments = url.pathname.split('/').filter(Boolean);

  // /storage/v1/object/public/<bucket>/<path...> — public read (avatars load here)
  if (req.method === 'GET' && segments[1] === 'v1' && segments[2] === 'object' && segments[3] === 'public') {
    const bucket = segments[4];
    const objectPath = segments.slice(5).map(decodeURIComponent).join('/');
    const object = buckets.get(bucket)?.get(objectPath);
    if (!object) return send(res, 404, { message: 'Object not found' });
    return send(res, 200, object.buffer, object.contentType);
  }

  if (!authorized(req)) return send(res, 401, { message: 'Invalid API key' });

  // /storage/v1/bucket/<bucket> — startup bucket check
  if (req.method === 'GET' && segments[1] === 'v1' && segments[2] === 'bucket') {
    const bucket = segments[3];
    if (!buckets.has(bucket)) return send(res, 404, { message: 'Bucket not found' });
    return send(res, 200, { name: bucket });
  }

  // /storage/v1/object/<bucket>/<path...> — upload
  if (req.method === 'POST' && segments[1] === 'v1' && segments[2] === 'object') {
    const bucket = segments[3];
    const objectPath = segments.slice(4).map(decodeURIComponent).join('/');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    if (!buckets.has(bucket)) buckets.set(bucket, new Map());
    buckets.get(bucket).set(objectPath, {
      buffer,
      contentType: req.headers['content-type'] || objectType(objectPath)
    });
    console.log(`[mock-storage] stored ${bucket}/${objectPath} (${buffer.length} bytes, ${objectType(objectPath)})`);
    return send(res, 200, { Key: `${bucket}/${objectPath}` });
  }

  // /storage/v1/object/<bucket> — delete via { prefixes: [...] }
  if (req.method === 'DELETE' && segments[1] === 'v1' && segments[2] === 'object' && segments.length === 4) {
    const bucket = segments[3];
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let prefixes = [];
    try { prefixes = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}').prefixes || []; } catch { /* ignore */ }
    const store = buckets.get(bucket);
    for (const prefix of prefixes) {
      store?.delete(prefix);
      console.log(`[mock-storage] deleted ${bucket}/${prefix}`);
    }
    return send(res, 200, {});
  }

  return send(res, 404, { message: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  // A bucket has to exist before the adapter's startup check passes.
  for (const bucket of ['private-files', 'public-event-images']) buckets.set(bucket, new Map());
  console.log(`[mock-storage] listening on http://localhost:${PORT}`);
  console.log(`[mock-storage] SUPABASE_URL=http://localhost:${PORT}`);
  console.log(`[mock-storage] SUPABASE_SERVICE_KEY=${SERVICE_KEY}`);
});
