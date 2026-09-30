#!/usr/bin/env node
// ============================================================
//  CPRI API smoke test — checks that the back end really answers
//  every endpoint the front end depends on.
//
//  Usage:
//    npm run check:api                       # against http://localhost:3000
//    CPRI_BASE=https://my-api.example.com npm run check:api
//
//  Admin endpoints are only exercised when ADMIN_EMAIL and ADMIN_PASSWORD are
//  set (they live in `.env`, which `npm run check:api` loads via dotenv).
//  Exit code is 0 when everything passed, 1 otherwise — usable in CI.
// ============================================================
import 'dotenv/config';

// `.env` sets PORT=3000, but a PORT inherited from the shell wins over dotenv —
// this machine exports PORT=0, which would point the checker at localhost:0.
// Only a real, positive port is used; anything else falls back to 3000.
function resolvePort() {
  const fromEnv = Number(process.env.PORT);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : 3000;
}

const BASE = (process.env.CPRI_BASE || `http://localhost:${resolvePort()}`).replace(/\/+$/, '');

const PUBLIC_ENDPOINTS = [
  '/api/site', '/api/announcements', '/api/events', '/api/research', '/api/agenda',
  '/api/researchers', '/api/publications', '/api/events-module',
  '/api/repository', '/api/innovation-extension', '/api/notifications',
  // Read-only aggregates the public home page renders; deliberately open.
  '/api/admin/hero-stats', '/api/admin/public-summary'
];

const PROTECTED_ENDPOINTS = [
  '/api/auth/me', '/api/submissions', '/api/ethics', '/api/messages',
  '/api/admin/summary', '/api/admin/analytics', '/api/admin/users',
  '/api/admin/impact-dashboard'
];

const results = [];
function record(ok, label, detail) {
  results.push({ ok, label, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ' — ' + detail : ''}`);
}

function looksJson(res) {
  return /application\/json/i.test(res.headers.get('content-type') || '');
}

async function getJson(path, cookie) {
  const res = await fetch(BASE + path, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep raw text */ }
  return { res, text, body, json: looksJson(res) };
}

console.log(`CPRI API check against ${BASE}\n`);

// ---- 1. health -------------------------------------------------------------
try {
  const { res, body, json } = await getJson('/healthz');
  const ok = res.status === 200 && json && body?.ok === true && body?.db === 'up';
  record(ok, 'GET /healthz', `status ${res.status}, db ${body?.db ?? 'unknown'}${json ? '' : ', NOT JSON'}`);
  if (!ok && res.status !== 200) {
    console.log('\nThe server is not reachable. Start MySQL, then `PORT=3000 npm start`.\n');
    process.exit(1);
  }
} catch (err) {
  record(false, 'GET /healthz', err.message);
  console.log('\nThe server is not reachable. Start MySQL, then `PORT=3000 npm start`.\n');
  process.exit(1);
}

// ---- 2. public endpoints: must be JSON -------------------------------------
for (const path of PUBLIC_ENDPOINTS) {
  try {
    const { res, body, json } = await getJson(path);
    const count = Array.isArray(body) ? `${body.length} items` : 'object';
    record(res.status === 200 && json, `GET ${path}`, `status ${res.status}, ${json ? 'JSON' : 'NOT JSON'}, ${count}`);
  } catch (err) {
    record(false, `GET ${path}`, err.message);
  }
}

// ---- 3. protected endpoints: 401 JSON, never HTML --------------------------
for (const path of PROTECTED_ENDPOINTS) {
  try {
    const { res, json } = await getJson(path);
    record(res.status === 401 && json, `GET ${path} (anonymous)`, `status ${res.status}, ${json ? 'JSON' : 'NOT JSON — an HTML page leaked through'}`);
  } catch (err) {
    record(false, `GET ${path} (anonymous)`, err.message);
  }
}

// ---- 4. unknown API route: JSON 404 ---------------------------------------
{
  const { res, json, body } = await getJson('/api/definitely-not-a-route');
  record(res.status === 404 && json, 'GET /api/unknown-route', `status ${res.status}, ${json ? 'JSON' : 'NOT JSON'}, body ${JSON.stringify(body)}`);
}

// ---- 5. contact form writes a row -----------------------------------------
{
  const res = await fetch(BASE + '/api/contact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'API check', email: 'api-check@example.com', subject: 'self test', message: 'posted by npm run check:api' })
  });
  const body = await res.json().catch(() => null);
  record(res.status === 201 && looksJson(res), 'POST /api/contact', `status ${res.status}, ${body?.message || ''}`);
  console.log('   (this wrote one row to `inquiries`; delete it with:');
  console.log("    mysql -u root cpri -e \"DELETE FROM inquiries WHERE email='api-check@example.com';\" )");
}

// ---- 6. login rejects a wrong password with JSON ---------------------------
{
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'no-such-account@example.com', password: 'wrong-password' })
  });
  const body = await res.json().catch(() => null);
  record(res.status === 401 && looksJson(res), 'POST /api/auth/login (bad credentials)', `status ${res.status}, ${body?.error || 'no error field'}`);
}

// ---- 7. login as admin, then the admin surface ----------------------------
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.log('\n  skip  admin endpoints — set ADMIN_EMAIL and ADMIN_PASSWORD in .env to check them');
} else {
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: ADMIN_EMAIL, password: ADMIN_PASSWORD })
  });
  const body = await res.json().catch(() => null);
  const setCookie = res.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  const loggedIn = res.status === 200 && cookie;
  record(loggedIn, 'POST /api/auth/login (admin)', `status ${res.status}, ${body?.user?.role || 'no user'}, cookie ${cookie ? 'issued' : 'MISSING'}`);

  if (loggedIn) {
    for (const path of PROTECTED_ENDPOINTS) {
      const { res: r, json } = await getJson(path, cookie);
      record(r.status === 200 && json, `GET ${path} (admin)`, `status ${r.status}, ${json ? 'JSON' : 'NOT JSON'}`);
    }
    const me = await getJson('/api/auth/me', cookie);
    record(me.res.status === 200, 'GET /api/auth/me (admin)', `status ${me.res.status}`);

    const out = await fetch(BASE + '/api/auth/logout', { method: 'POST', headers: { cookie } });
    const after = await getJson('/api/auth/me', cookie);
    record(out.status === 200 && after.res.status === 401, 'POST /api/auth/logout then GET /api/auth/me', `logout ${out.status}, session after logout ${after.res.status} (401 expected)`);
  }
}

// ---- summary ---------------------------------------------------------------
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  - ${f.label}: ${f.detail}`);
  process.exit(1);
}
