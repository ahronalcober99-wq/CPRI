import 'dotenv/config';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { promises as fs } from 'fs';
import express from 'express';
import session from 'express-session';
import { authRouter, initAuth } from './auth.js';
import { submissionsRouter } from './submissions.js';
import { repositoryRouter } from './repository.js';
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
import { testConnection } from './db.js';
import { insert, all } from './server/db/queries.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, 'data');
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;

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
// comma-separated allowlist of front-end origins, e.g.
//   CORS_ORIGINS=https://ahronalcober99-wq.github.io
// Leaving it empty keeps the API same-origin only — the default, and the safest
// option for local development.
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);
const CROSS_SITE = CORS_ORIGINS.length > 0;

const app = express();

// Hosting platforms (Render, Railway, Fly, nginx, the cloudflared share tunnel)
// terminate TLS and forward X-Forwarded-Proto, so Express must be told to trust
// that header or it never sees the request as secure — and a session cookie
// marked Secure is then either omitted (express-session) or rejected by the
// browser. Set TRUST_PROXY=1 (or a hop count) on those hosts; leave it unset
// when the API is exposed directly, since the header is otherwise spoofable.
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
  if (!TRUST_PROXY_ENABLED) {
    console.warn('[cors] TRUST_PROXY is not set. Behind a TLS-terminating host the request never looks secure, so the session cookie will be sent without the Secure flag and browsers will reject the SameSite=None cookie — sign-in then silently fails cross-site. Set TRUST_PROXY=1 on such hosts.');
  }
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
app.use('/api/submissions', submissionsRouter);
app.use('/api/repository', repositoryRouter);
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

// Serve static assets with `Cache-Control: no-cache` (revalidate every load via
// ETag/Last-Modified) instead of default heuristic caching. In-app browsers
// (Messenger, Facebook, etc.) cache aggressively and were serving stale
// styles.css — e.g. the old wide Login/Register pills — making the mobile
// header look broken after CSS changes. no-cache means unchanged files still
// get a fast 304; changed files are fetched fresh immediately.
app.use(express.static(PUBLIC_DIR, {
  etag: true,
  lastModified: true,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-cache');
  }
}));

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
  // carry a hero photo; module-only events still appear.
  const merged = [
    ...(Array.isArray(content) ? content : []).map(e => ({ ...e, source: 'content' })),
    ...(Array.isArray(moduleEvents) ? moduleEvents : []).map(e => ({
      id: e.id,
      title: e.title,
      type: e.theme || 'Event',
      date: e.dateTime || '',
      location: e.venue || '',
      description: e.description || '',
      photo: e.photo || '',
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

app.get('/api/research', async (req, res) => {
  const items = await fs.readFile(join(DATA_DIR, 'research.json'), 'utf8').catch(() => '[]');
  res.json(JSON.parse(items));
});

app.get('/api/agenda', async (req, res) => {
  const items = await fs.readFile(join(DATA_DIR, 'agenda.json'), 'utf8').catch(() => '[]');
  res.json(JSON.parse(items));
});

app.post('/api/contact', async (req, res) => {
  const { name, email, subject, message } = req.body || {};
  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email and message are required.' });
  }
  try {
    await insert('inquiries', {
      name: String(name).trim(),
      email: String(email).trim(),
      subject: subject ? String(subject).trim() : '',
      message: String(message).trim(),
      receivedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('Could not persist inquiry:', err);
  }
  res.status(201).json({ ok: true, message: 'Thank you. Your inquiry has been received.' });
});

app.get(/^\/(?!api).*/, (req, res) => {
  res.sendFile(join(PUBLIC_DIR, 'index.html'));
});

// JSON 404 for unknown API routes (instead of the Express HTML default)
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found.' });
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

const server = app.listen(PORT, async () => {
  await testConnection();
  await initAuth();
  await ensureNotificationsTable().catch(err => console.error('[notifications] table ensure failed:', err.message));
  await ensureMessagesTable().catch(err => console.error('[messages] table ensure failed:', err.message));
  await ensureEventsSchema().catch(err => console.error('[events] schema ensure failed:', err.message));

  // Startup diagnostics for the email verification flow
  // (booleans only — never print the actual password)
  const hasUser = Boolean(process.env.GMAIL_USER);
  const hasPass = Boolean(process.env.GMAIL_APP_PASSWORD);
  console.log('[mail] GMAIL_USER set:', hasUser);
  console.log('[mail] GMAIL_APP_PASSWORD set:', hasPass);
  if (!hasUser || !hasPass) {
    console.log('[mail] Gmail not fully configured — verification codes will be logged to the server console (DEV fallback) instead of emailed.');
  }
  try {
    const { verifyGmailTransporter } = await import('./lib/mail.js');
    await verifyGmailTransporter();
  } catch (err) {
    console.error('[mail] Gmail SMTP auth check failed:', err && (err.response || err.message || err));
  }

  console.log(`CPRI public website running at http://localhost:${PORT}`);
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. The server may already be running.`);
    console.log(`Try opening http://localhost:${PORT} in your browser.`);
  } else {
    console.error('Server failed to start:', err.message);
  }
  process.exit(1);
});
