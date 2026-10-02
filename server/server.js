import './load-env.js';
import 'express-async-errors';
import { fileURLToPath } from 'url';
import { basename, dirname, join } from 'path';
import { promises as fs } from 'fs';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
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
import { insert, all, get } from './server/db/queries.js';

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
    res.status(503).json({ ok: false, db: 'down', error: err.message });
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
