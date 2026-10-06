import './load-env.js';
import 'express-async-errors';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { basename, dirname, join } from 'path';
import { promises as fs } from 'fs';
import express from 'express';
import mysql from 'mysql2/promise';
import session from 'express-session';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { authRouter, initAuth, requireAdmin } from './auth.js';
import { usernameRouter } from './username.js';
import { submissionsRouter } from './submissions.js';
import { repositoryRouter } from './repository.js';
import { featuredPublicationsRouter } from './featured-publications.js';
import { publicationsRouter } from './publications.js';
import { ethicsRouter } from './ethics.js';
import { researchersRouter } from './researchers.js';
import { eventsModuleRouter, ensureEventsSchema } from './events-module.js';
import { innovationExtensionRouter } from './innovation-extension.js';
import { adminDashboardRouter } from './admin-dashboard.js';
import { adminInsightsRouter } from './admin-insights.js';
import { reportsRouter } from './reports.js';
import { notificationsRouter, ensureNotificationsTable } from './notifications.js';
import { messagesRouter, ensureMessagesTable } from './messages.js';
import { supabaseStorage } from './storage/supabase-storage.js';
import { testConnection, explainDbError, connectionOptions } from './db.js';
import { insert, all, get, withTransaction } from './server/db/queries.js';
import {
  deleteEventAcrossStores,
  isValidEventId,
  resolveContentEventPhotoPath
} from './event-deletion.js';
import { cleanupEventImages, isEventImageObjectId, normalizeEventImage } from './event-image-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, 'data');
const PUBLIC_DIR = join(__dirname, '..', 'public');
// A stray PORT in the shell environment (this machine exports PORT=0, and
// dotenv never overwrites an existing variable) used to win over .env and bind
// the server to a random port, so every http://localhost:3000 request failed
// with a connection error. Only a real, positive port number is honoured.
const REQUESTED_PORT = Number(process.env.PORT);
const PORT = Number.isInteger(REQUESTED_PORT) && REQUESTED_PORT > 0 ? REQUESTED_PORT : 3000;

// ---- Process-level crash guards ----------------------------------------
// One uncaught error used to take the whole server down (e.g. the MariaDB
// datetime rejection). Log these instead of letting the process exit, so the
// site keeps serving. Tradeoff: an uncaughtException can leave a request in a
// broken state, but for this app keeping the server alive beats a full outage.
process.on('uncaughtException', (err) => {
  console.error('[process] Uncaught exception (server keeps running):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[process] Unhandled promise rejection (server keeps running):', reason);
});

// ---- Persistent sessions (survive server restarts) ----------------------
// The default in-memory MemoryStore logs everyone out on every restart. A
// file-backed store also works when MySQL is down (file-only mode).
//
// We deliberately do NOT use session-file-store's write-file-atomic: on
// Windows its temp-file-then-rename pattern intermittently fails with EPERM
// (antivirus / open-handle race), and the error was being swallowed — the
// session write silently never landed, so logins (especially the Google OAuth
// callback) randomly "didn't stick". This store writes each session directly
// to its own file (no rename), which sidesteps that failure mode entirely.
const SESSIONS_DIR = join(__dirname, 'data', 'sessions');
await fs.mkdir(SESSIONS_DIR, { recursive: true });

const SESSION_TTL_MS = 1000 * 60 * 60 * 8; // 8h, matches the cookie maxAge

class DirectFileStore extends session.Store {
  constructor(dir) {
    super();
    this.dir = dir;
  }
  _file(sid) {
    // session IDs are URL-safe base64; strip any residual unsafe chars
    return join(this.dir, String(sid).replace(/[^A-Za-z0-9_-]/g, '') + '.json');
  }
  get(sid, cb) {
    fs.readFile(this._file(sid), 'utf8')
      .then((raw) => {
        let data;
        try { data = JSON.parse(raw); } catch { return cb(null, null); }
        if (data.cookie && data.cookie.expires && new Date(data.cookie.expires).getTime() < Date.now()) {
          return fs.unlink(this._file(sid)).catch(() => {}).then(() => cb(null, null));
        }
        cb(null, data);
      })
      .catch(() => cb(null, null)); // missing file = no session, not an error
  }
  set(sid, sess, cb) {
    const write = () => fs.writeFile(this._file(sid), JSON.stringify(sess), 'utf8');
    // Transient write errors (AV scan, handle race) — retry briefly before
    // giving up, but direct write has no rename step to fail on.
    write().catch(() => write()).then(() => cb && cb()).catch((err) => cb && cb(err));
  }
  touch(sid, sess, cb) {
    this.set(sid, sess, cb);
  }
  destroy(sid, cb) {
    fs.unlink(this._file(sid)).catch(() => {}).then(() => cb && cb());
  }
}

// ---- Cross-origin front end (the GitHub Pages copy) ----------------------
// The static site can be hosted apart from this API. CORS_ORIGINS is a
// comma-separated allowlist of front-end origins. In production, always allow
// the canonical Pages origin; it is an origin, not the repository's /CPRI path.
const PAGES_ORIGIN = 'https://ahronalcober99-wq.github.io';
const CORS_ORIGINS = [...new Set([
  ...(process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),
  ...(process.env.NODE_ENV === 'production' ? [PAGES_ORIGIN] : [])
])];
const CROSS_SITE = CORS_ORIGINS.length > 0;

const app = express();

// Render (and every other hosting proxy) sets X-Forwarded-For/-Proto. Without
// this, express-rate-limit answers ERR_ERL_UNEXPECTED_X_FORWARDED_FOR and the
// session cookie never looks Secure. One trusted hop = the platform's proxy.
app.set('trust proxy', 1);

// Security HTTP headers
app.use(helmet({
  contentSecurityPolicy: false
}));

// Gzip/Brotli response compression
app.use(compression());

// Rate limiters
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication or contact attempts, please try again later.' }
});

app.use('/api/', apiLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/forgot', authLimiter);
app.use('/api/contact', authLimiter);

// Hosting platforms (Render, Railway, Fly, nginx, the cloudflared share tunnel)
// terminate TLS and forward X-Forwarded-For / X-Forwarded-Proto. `trust proxy`
// is set to 1 right after `express()` above, so those headers are honoured:
// express-rate-limit no longer rejects requests with
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR, and the session cookie is marked Secure.
// TRUST_PROXY may override the hop count for other topologies.
const TRUST_PROXY = (process.env.TRUST_PROXY || '').trim();
const TRUST_PROXY_ENABLED = TRUST_PROXY !== '' && TRUST_PROXY !== '0' && TRUST_PROXY.toLowerCase() !== 'false';
if (TRUST_PROXY_ENABLED) {
  app.set('trust proxy', Number(TRUST_PROXY) || true);
}

// Requests are credentialed (the session cookie is what keeps a user logged in),
// so the allowed origin is echoed back exactly rather than answering '*'.
if (CROSS_SITE) {
  if (CORS_ORIGINS.includes('*')) {
    console.warn('[cors] CORS_ORIGINS=* reflects any origin; combined with credentialed requests that lets any website act as a signed-in user. List exact origins instead.');
  }
  console.log('[cors] cross-origin front end allowed for:', CORS_ORIGINS.join(', '));
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const allowed = Boolean(origin) && (CORS_ORIGINS.includes('*') || CORS_ORIGINS.includes(origin));
    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      if (allowed) {
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type');
        res.setHeader('Access-Control-Max-Age', '600');
      }
      return res.sendStatus(204);
    }
    next();
  });
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  name: 'cpri.sid',
  secret: process.env.SESSION_SECRET || 'cpri-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  store: new DirectFileStore(SESSIONS_DIR),
  cookie: {
    httpOnly: true,
    // SameSite=None is required for a cross-site front end: a Lax cookie is not
    // sent on requests originating from the Pages site, so the visitor would
    // look signed out. None also requires Secure, hence the API must be reached
    // over HTTPS in that setup. 'auto' emits Secure only for requests Express can
    // tell arrived over TLS — with a literal `true`, express-session silently
    // omits the cookie entirely on a non-HTTPS connection instead. Without
    // CORS_ORIGINS nothing changes here (the same-origin dev flow is untouched).
    sameSite: CROSS_SITE ? 'none' : 'lax',
    secure: CROSS_SITE ? 'auto' : process.env.NODE_ENV === 'production',
    maxAge: SESSION_TTL_MS
  }
}));

app.use('/api/auth', authRouter);
app.use('/api/username', usernameRouter);
app.use('/api/submissions', submissionsRouter);
app.use('/api/repository', repositoryRouter);
app.use('/api/publications', featuredPublicationsRouter);
app.use('/api/publications', publicationsRouter);
app.use('/api/ethics', ethicsRouter);
app.use('/api/researchers', researchersRouter);
app.use('/api/events-module', eventsModuleRouter);
app.use('/api/innovation-extension', innovationExtensionRouter);
app.use('/api/admin', adminDashboardRouter);
app.use('/api/admin', adminInsightsRouter);
app.use('/api/reports', reportsRouter);
app.use('/api', notificationsRouter);
app.use('/api/messages', messagesRouter);

// ---- Page access control --------------------------------------------------
// The API already refuses anonymous calls with JSON 401s, but the page shells
// for member and admin screens were downloadable by anyone. Those pages have
// nothing to show a signed-out visitor, so gate them here and send the visitor
// to the login form with a ?next= link back. Server-side, so it does not depend
// on any page's JavaScript. (A statically hosted copy of the front end — GitHub
// Pages — has no server to run this; there the API guard is what protects data.)
const ADMIN_ONLY_PAGES = new Set([
  'admin-dashboard.html', 'research-impact-dashboard.html', 'audit-logs.html',
  'calendar.html', 'file-manager.html', 'email-notifications.html', 'reports.html'
]);
const MEMBER_ONLY_PAGES = new Set([
  'account.html', 'profile.html', 'messages.html',
  'submissions.html', 'submission.html', 'submit.html',
  'ethics.html', 'ethics-detail.html', 'ethics-form.html',
  'researcher-form.html', 'publication-form.html', 'innovation-extension-form.html',
  'event-abstract.html', 'event-registration.html'
]);

app.use(async (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const page = basename(req.path);
  if (!page.endsWith('.html')) return next();
  const adminOnly = ADMIN_ONLY_PAGES.has(page);
  if (!adminOnly && !MEMBER_ONLY_PAGES.has(page)) return next();

  let user = null;
  if (req.session?.userId) {
    user = await get('SELECT id, role, status FROM users WHERE id = ?', [req.session.userId]).catch(() => null);
  }
  if (!user || user.status === 'disabled') {
    const next = encodeURIComponent(req.originalUrl);
    return res.redirect(302, `/login.html?next=${next}`);
  }
  if (adminOnly && user.role !== 'admin') {
    return res.redirect(302, '/account.html');
  }
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Serve static assets with `Cache-Control: no-cache` (revalidate every load via
// ETag/Last-Modified) instead of default heuristic caching. In-app browsers
// (Messenger, Facebook, etc.) cache aggressively and were serving stale
// styles.css — e.g. the old wide Login/Register pills — making the mobile
// header look broken after CSS changes. no-cache means unchanged files still
// get a fast 304; changed files are fetched fresh immediately.
//
// These mounts MUST stay above the catch-all route further down: existing CSS,
// JS, image and font files are answered here, and only genuinely unmatched
// paths reach the fallback. If a mount moved below the catch-all, every asset
// request would receive index.html (HTTP 200) and pages would render unstyled.
const STATIC_OPTIONS = {
  etag: true,
  lastModified: true,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-cache');
  }
};
app.use(express.static(PUBLIC_DIR, STATIC_OPTIONS));
// The GitHub Pages copy is published from the repository ROOT, so its links read
// /CPRI/public/login.html — i.e. the URL path contains a "public/" segment. This
// server serves PUBLIC_DIR itself at the root (so /login.html works), which left
// /public/login.html unmatched and it fell through to the home page instead.
// Alias /public/* onto PUBLIC_DIR too, so both URL shapes resolve to the same
// files (a relative "assets/..." inside them then resolves under /public/...).
app.use('/public', express.static(PUBLIC_DIR, STATIC_OPTIONS));

// Liveness probe for hosting platforms (Render/Railway/Fly, Docker, k8s).
// Always JSON, so a monitor can distinguish "API up" from "database down".
app.get('/healthz', async (req, res) => {
  try {
    await all('SELECT 1 AS ok');
    res.json({ ok: true, db: 'up', uptime: Math.round(process.uptime()) });
  } catch (err) {
    const diagnosis = explainDbError(err);
    res.status(503).json({
      ok: false,
      db: 'down',
      error: err.message,
      ...(diagnosis ? { diagnosis } : {})
    });
  }
});

// Content APIs (switch from readJson to SQL)
app.get('/api/site', async (req, res) => {
  const row = await fs.readFile(join(DATA_DIR, 'profile.json'), 'utf8').catch(() => '{}');
  res.json(JSON.parse(row));
});

app.get('/api/announcements', async (req, res) => {
  const items = await fs.readFile(join(DATA_DIR, 'announcements.json'), 'utf8').catch(() => '[]');
  res.json(JSON.parse(items).sort((a, b) => new Date(b.date) - new Date(a.date)));
});

app.get('/api/events', async (req, res) => {
  // Unified events feed: content events (events.json, from the Admin Console
  // Content tab) PLUS module events (events_module table, from the Events &
  // Conferences page). Each row is tagged with a `source` field so pages can
  // route links to the right detail view.
  const content = JSON.parse(await fs.readFile(join(DATA_DIR, 'events.json'), 'utf8').catch(() => '[]'));
  let moduleEvents = [];
  try {
    moduleEvents = await all('SELECT * FROM events_module');
  } catch (err) {
    console.error('[events] module read failed:', err.message);
  }
  // Merge both stores, deduped by title (the seed mirrors the same events in
  // both stores). For this public feed, the content copy wins because it can
  // carry a hero image; module-only events still appear.
  const merged = [
    ...(Array.isArray(content) ? content : []).map(e => {
      const { photo, imageurl, imagepublicid, ...record } = e;
      return { ...record, ...normalizeEventImage(e), source: 'content' };
    }),
    ...(Array.isArray(moduleEvents) ? moduleEvents : []).map(e => ({
      id: e.id,
      title: e.title,
      type: e.theme || 'Event',
      date: e.dateTime || '',
      location: e.venue || '',
      description: e.description || '',
      ...normalizeEventImage(e),
      registrationLink: e.registrationLink || '',
      source: 'module'
    }))
  ];
  const seen = new Set();
  const items = merged.filter(e => {
    const key = String(e.title || '').trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  res.json(items.sort((a, b) => new Date(a.date) - new Date(b.date)));
});

const EVENT_CONTENT_UPLOAD_DIR = join(PUBLIC_DIR, 'assets', 'uploads', 'events');
const EVENT_MODULE_UPLOAD_DIR = join(PUBLIC_DIR, 'assets', 'uploads', 'events-module');

async function readContentEvents() {
  let raw;
  try {
    raw = await fs.readFile(join(DATA_DIR, 'events.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const events = JSON.parse(raw);
  if (!Array.isArray(events)) throw new Error('Event content must be a JSON array.');
  return events;
}

async function writeContentEvents(events) {
  const filePath = join(DATA_DIR, 'events.json');
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, JSON.stringify(events, null, 2) + '\n', 'utf8');
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(cleanupError => {
      console.error('[events] failed to clean temporary event file:', cleanupError.message);
    });
    throw error;
  }
}

function contentEventPhotoPath(photo) {
  return resolveContentEventPhotoPath(photo, EVENT_CONTENT_UPLOAD_DIR);
}

async function cleanupDeletedEventFiles({ contentEvents, moduleEvents }) {
  const warnings = [];
  const photoPaths = new Set();
  const eventDirectories = new Set();
  const imageObjectIds = new Set();

  for (const event of contentEvents) {
    const photoPath = contentEventPhotoPath(event.photo || event.imageUrl);
    if (photoPath) photoPaths.add(photoPath);
    if (isEventImageObjectId(event.imagePublicId)) imageObjectIds.add(event.imagePublicId);
  }
  for (const event of moduleEvents) {
    if (isEventImageObjectId(event.imagePublicId)) imageObjectIds.add(event.imagePublicId);
    const id = String(event.id);
    if (id && id !== '.' && id !== '..' && !id.includes('/') && !id.includes('\\')) {
      eventDirectories.add(join(EVENT_MODULE_UPLOAD_DIR, id));
    }
  }

  for (const path of photoPaths) {
    try {
      await fs.unlink(path);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('[events] uploaded photo cleanup failed:', error.message);
        warnings.push('One or more uploaded event files could not be removed.');
      }
    }
  }
  for (const path of eventDirectories) {
    try {
      await fs.rm(path, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('[events] uploaded file cleanup failed:', error.message);
        warnings.push('One or more uploaded event files could not be removed.');
      }
    }
  }
  if (imageObjectIds.size) {
    const imageCleanupSucceeded = await cleanupEventImages([...imageObjectIds], {
      storage: supabaseStorage,
      context: '[events] stored image cleanup failed'
    });
    if (!imageCleanupSucceeded) {
      warnings.push('One or more event images could not be removed from storage.');
    }
  }
  return [...new Set(warnings)];
}

app.delete('/api/events/:id', requireAdmin, async (req, res) => {
  if (!isValidEventId(req.params.id)) {
    return res.status(400).json({ error: 'Invalid event id.' });
  }

  try {
    const deleted = await deleteEventAcrossStores(req.params.id, {
      readContentEvents,
      writeContentEvents,
      withTransaction,
      cleanupFiles: cleanupDeletedEventFiles
    });
    if (!deleted) return res.status(404).json({ error: 'Event not found.' });
    res.json({ message: 'Event deleted.', id: deleted.id, title: deleted.title });
  } catch (error) {
    console.error(`[events] deletion failed for ${req.params.id}:`, error.message);
    res.status(500).json({ error: 'Could not delete the event. Please try again.' });
  }
});

app.get('/api/research', async (req, res) => {
  const items = await fs.readFile(join(DATA_DIR, 'research.json'), 'utf8').catch(() => '[]');
  res.json(JSON.parse(items));
});

app.get('/api/agenda', async (req, res) => {
  const items = await fs.readFile(join(DATA_DIR, 'agenda.json'), 'utf8').catch(() => '[]');
  res.json(JSON.parse(items));
});

app.get('/api/captcha', (req, res) => {
  const num1 = Math.floor(Math.random() * 10) + 1;
  const num2 = Math.floor(Math.random() * 10) + 1;
  req.session.captchaAnswer = num1 + num2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="130" height="38" viewBox="0 0 130 38"><rect width="100%" height="100%" fill="#0f172a" rx="6"/><text x="50%" y="55%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="18" font-weight="bold" fill="#38bdf8">${num1} + ${num2} = ?</text></svg>`;
  res.json({ question: `${num1} + ${num2} = ?`, svg });
});

app.post('/api/contact', async (req, res) => {
  const { name, email, subject, message, captchaAnswer } = req.body || {};
  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email and message are required.' });
  }
  if (req.session && req.session.captchaAnswer !== undefined && captchaAnswer !== undefined) {
    if (Number(captchaAnswer) !== Number(req.session.captchaAnswer)) {
      return res.status(400).json({ error: 'Incorrect CAPTCHA answer.' });
    }
  }
  let saved = false;
  try {
    await insert('inquiries', {
      name: String(name).trim(),
      email: String(email).trim(),
      subject: subject ? String(subject).trim() : '',
      message: String(message).trim(),
      receivedAt: new Date().toISOString()
    });
    saved = true;
  } catch (err) {
    console.error('Could not persist inquiry:', err);
  }
  if (!saved) {
    return res.status(500).json({
      error: 'Could not save your inquiry. The server could not reach its database. Please try again in a moment.'
    });
  }
  res.status(201).json({ ok: true, message: 'Thank you. Your inquiry has been received.' });
});

// Fallback for client-side / extension-less routes (e.g. /login, /about): send
// the home page shell. Requests for a real file (anything ending in an
// extension) are deliberately NOT answered with index.html — a missing
// styles.css / main.js / image must return a real 404 so the browser reports the
// missing file instead of quietly receiving an HTML page under a CSS/JS URL.
app.get(/^\/(?!api).*/, (req, res, next) => {
  if (/\.[a-z0-9]+$/i.test(req.path)) return next();
  res.sendFile(join(PUBLIC_DIR, 'index.html'));
});

// JSON 404 for unknown API routes (instead of the Express HTML default)
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// Real 404 for anything else (a missing asset or unknown path). No HTML fallback
// here, so /missing.css is a 404 rather than the home page with status 200.
app.use((req, res) => {
  res.status(404).type('text/plain').send('Not found');
});

// Central error handler — log the failure, return JSON, keep serving.
// (Async handler rejections in Express 4 fall through to the
// unhandledRejection guard above; this catches sync/next(err) errors.)
app.use((err, req, res, next) => {
  console.error(`[error] ${req.method} ${req.originalUrl}:`, err && (err.message || err));
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: status >= 500 ? 'Internal server error.' : (err.message || 'Request failed.') });
});


// ---- Schema auto-setup (idempotent) --------------------------------------
// server/init-db.sql creates every table the API queries, with
// CREATE TABLE IF NOT EXISTS, so applying it on every boot is safe. It is run
// against the database named by DB_NAME — never a hardcoded name — and the
// CREATE DATABASE / USE statements are generated from DB_NAME here. (A
// hardcoded `USE cpri` would point the tables at the wrong database whenever
// DB_NAME differs.)
const INIT_SQL_PATH = join(__dirname, 'init-db.sql');

async function loadSchema() {
  let raw;
  try {
    raw = await fs.readFile(INIT_SQL_PATH, 'utf8');
  } catch (err) {
    console.error('[schema] could not read ' + INIT_SQL_PATH + ': ' + err.message);
    return;
  }

  const dbName = connectionOptions.database;
  if (!dbName) {
    console.error('[schema] DB_NAME is not set, so there is no database to create tables in.');
    return;
  }
  const quoted = '`' + String(dbName).replace(/`/g, '``') + '`';
  // Drop any database directives the file carries, then add ones that target
  // this deployment's DB_NAME. The rest of the file is executed verbatim with
  // multipleStatements enabled.
  const body = raw
    .replace(/^\s*CREATE\s+DATABASE\b[^;]*;\s*/gim, '')
    .replace(/^\s*USE\b[^;]*;\s*/gim, '');
  const sql = `CREATE DATABASE IF NOT EXISTS ${quoted} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n`
    + `USE ${quoted};\n`
    + body;

  let conn;
  try {
    conn = await mysql.createConnection({ ...connectionOptions, multipleStatements: true });
  } catch (err) {
    if (err && err.code === 'ER_BAD_DB_ERROR') {
      // First run against a host where the database has not been created yet:
      // connect without selecting a database, create it from DB_NAME, then
      // apply the schema there.
      console.warn(`[schema] database "${dbName}" does not exist yet — creating it.`);
      const withoutDatabase = { ...connectionOptions };
      delete withoutDatabase.database;
      conn = await mysql.createConnection({ ...withoutDatabase, multipleStatements: true });
    } else {
      throw err;
    }
  }

  try {
    await conn.query(sql);
    console.log('[schema] ready.');
  } finally {
    await conn.end().catch(() => {});
  }
}

try {
  await loadSchema();
} catch (err) {
  console.error('[schema] initialising database failed:', err.message);
  const hint = explainDbError(err);
  if (hint) console.error('[schema] ' + hint.replace(/\n/g, '\n[schema] '));
  console.error('[schema] Check DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME.');
}

try {
  await ensureEventsSchema();
} catch (err) {
  console.error('[events] schema ensure failed:', err.message);
}

const server = app.listen(PORT, async () => {
  void supabaseStorage.verifyBucketAtStartup();
  let dbUp = true;
  try {
    await testConnection();
  } catch (err) {
    dbUp = false;
    const diagnosis = explainDbError(err);
    console.error('');
    console.error('┌──────────────────────────────────────────────┐');
    console.error('│  DATABASE UNREACHABLE');
    console.error('├──────────────────────────────────────────────┤');
    console.error('│  Login, registration, and every');
    console.error('│  database-backed API endpoint will fail');
    console.error('│  until this is fixed in Render:');
    console.error('│  https://render.com/docs/setting-env-variables');
    console.error('│  ');
    console.error('│  ' + (diagnosis || err.message));
    console.error('└──────────────────────────────────────────────┘');
    console.error('');
  }
  await initAuth();
  await ensureNotificationsTable().catch(err => console.error('[notifications] table ensure failed:', err.message));
  await ensureMessagesTable().catch(err => console.error('[messages] table ensure failed:', err.message));

  console.log('[mail] BREVO_API_KEY set:', Boolean(process.env.BREVO_API_KEY));
  console.log('[mail] BREVO_SENDER_EMAIL set:', Boolean(process.env.BREVO_SENDER_EMAIL));

  console.log(`CPRI public website running at http://localhost:${PORT}`);
  if (!dbUp) {
    console.warn('[boot] Running WITHOUT a database — login, registration, contact, and all database-backed endpoints are broken. Visit /healthz for the diagnosis.');
  }
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. The server may already be running.`);
    console.log(`Try opening http://localhost:${PORT} in your browser.`);
  } else {
    console.error('Server failed to start:', err.message);
  }
  process.exit(1);
});
