import { Router } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import { randomBytes, randomUUID } from 'crypto';
import { promises as fs, existsSync } from 'fs';
import { spawn } from 'child_process';
import { sendResetEmail, sendVerificationCode } from './lib/mail.js';
import { all, get, run, insert, update, remove } from './server/db/queries.js';
import { notify } from './notifications.js';
import { addLog } from './audit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const UPLOAD_DIR = join(__dirname, '..', 'public', 'assets', 'uploads', 'profiles');

const router = Router();
const SALT_ROUNDS = 10;
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

// ---------- Notification preferences (user_prefs JSON column) ----------
// inApp:    show bell notifications
// email:    also send an email copy of each notification
// quietHours: { enabled, start, end } — suppress email copies inside the window
const DEFAULT_PREFS = {
  inApp: true,
  email: false,
  quietHours: { enabled: false, start: '22:00', end: '07:00' }
};

// Accepts only well-formed HH:MM clock times (hour < 24, minute < 60).
function isValidClock(v) {
  if (typeof v !== 'string' || !/^\d{2}:\d{2}$/.test(v)) return false;
  const [h, m] = v.split(':').map(Number);
  return h >= 0 && h < 24 && m >= 0 && m < 60;
}

function normalizePrefs(input) {
  const raw = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
  // inApp only switches off for an explicit boolean false — a string "false"
  // from a naive form must not silently disable it.
  const inApp = raw.inApp === undefined ? true : raw.inApp === true || raw.inApp === false ? raw.inApp : true;
  return {
    inApp,
    email: raw.email === true,
    quietHours: {
      enabled: Boolean(raw.quietHours && raw.quietHours.enabled),
      start: (raw.quietHours && isValidClock(raw.quietHours.start)) ? raw.quietHours.start : '22:00',
      end: (raw.quietHours && isValidClock(raw.quietHours.end)) ? raw.quietHours.end : '07:00'
    }
  };
}

// ---------- Email verification (in-memory) ----------
// codeStore: email -> { code, expiresAt, verified }
// rateStore: email -> { count, windowStart }
const CODE_TTL_MS = 10 * 60 * 1000;          // 10 minutes
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = 3;                    // max sends per window
const codeStore = new Map();
const rateStore = new Map();

// ---------- External-browser Google bridge (in-memory) ----------
// Google refuses to show its OAuth consent screen inside embedded browsers
// (Electron / WebView user agents) with "This browser or app may not be
// secure.". When the app detects such a browser it hands the OAuth flow to
// the system browser with ?external=1; the callback then mints this one-time
// code (shown to the user in the system browser) instead of redirecting back,
// and the app exchanges it via POST /google/bridge to adopt the session.
// Codes are single-use and short-lived, so the code column is not persisted.
const GOOGLE_BRIDGE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const googleBridgeStore = new Map();
const BRIDGE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
function makeBridgeCode() {
  const bytes = randomBytes(6);
  let code = '';
  for (let i = 0; i < 6; i++) code += BRIDGE_ALPHABET[bytes[i] % BRIDGE_ALPHABET.length];
  return code;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function randomSixDigitCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function cleanExpiredCodes() {
  const now = Date.now();
  for (const [email, entry] of codeStore) {
    if (entry.expiresAt < now) codeStore.delete(email);
  }
  for (const [email, entry] of rateStore) {
    if (entry.windowStart + RATE_LIMIT_WINDOW_MS < now) rateStore.delete(email);
  }
}

function isRateLimited(email) {
  const now = Date.now();
  const entry = rateStore.get(email);
  if (!entry || entry.windowStart + RATE_LIMIT_WINDOW_MS < now) {
    rateStore.set(email, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

// ---------- Role-Based Access Control ----------
const ROLES = [
  'admin',
  'cpri_staff',
  'faculty_researcher',
  'student_researcher',
  'adviser',
  'ethics_reviewer',
  'public_visitor'
];

const ROLE_META = {
  admin: { label: 'Administrator', approvable: false, desc: 'Full system control and user management.' },
  cpri_staff: { label: 'CPRI Staff', approvable: false, desc: 'Center staff managing content and operations.' },
  faculty_researcher: { label: 'Faculty Researcher', approvable: false, desc: 'Faculty conducting and submitting research.' },
  student_researcher: { label: 'Student Researcher', approvable: false, desc: 'Students conducting and submitting research.' },
  adviser: { label: 'Adviser', approvable: false, desc: 'Advises and guides researchers.' },
  ethics_reviewer: { label: 'Ethics Reviewer', approvable: true, desc: 'Reviews research for ethical compliance; requires admin approval.' },
  public_visitor: { label: 'Public Visitor', approvable: false, desc: 'Anonymous public site visitor.' }
};

// Roles that can self-register through the public form
const SELF_REGISTER_ROLES = ['faculty_researcher', 'student_researcher', 'adviser', 'ethics_reviewer'];

// Permission matrix per role
const RBAC_PERMISSIONS = {
  admin: ['manage_users', 'manage_content', 'approve_reviewers', 'submit_research', 'review_ethics', 'advise', 'view_public'],
  cpri_staff: ['manage_content', 'submit_research', 'view_public'],
  faculty_researcher: ['submit_research', 'view_public'],
  student_researcher: ['submit_research', 'view_public'],
  adviser: ['advise', 'submit_research', 'view_public'],
  ethics_reviewer: ['review_ethics', 'view_public'],
  public_visitor: ['view_public']
};

// ---------- File upload config ----------
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/'))
});

// ---------- User store (MySQL) ----------
async function readUsers() {
  return await all('SELECT * FROM users ORDER BY createdAt DESC');
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    fullName: u.fullName,
    role: u.role,
    roleLabel: ROLE_META[u.role]?.label || u.role,
    status: u.status,
    // Profile photo — either a Google OAuth picture URL or a local upload path
    // (/assets/uploads/profiles/...). Exposed so the navbar can render it.
    profilePhoto: u.profilePhoto || null,
    // First-time Google sign-ins must complete profile setup (pick a role).
    needsSetup: u.setupPending === 1 || u.setupPending === '1'
  };
}

// Full profile view (includes editable profile fields + researches)
function fullProfile(u) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    fullName: u.fullName || '',
    role: u.role,
    roleLabel: ROLE_META[u.role]?.label || u.role,
    status: u.status,
    department: u.department || '',
    contactNumber: u.contactNumber || '',
    researchInterests: u.researchInterests || '',
    profilePhoto: u.profilePhoto || null,
    researches: u.researches || [],
    prefs: u.user_prefs || DEFAULT_PREFS
  };
}

async function patchUser(id, changes) {
  if (changes.researches !== undefined) {
    changes.researches = JSON.stringify(changes.researches || []);
  }
  if (changes.user_prefs !== undefined) {
    changes.user_prefs = JSON.stringify(changes.user_prefs);
  }
  await update('users', id, changes);
  return await get('SELECT * FROM users WHERE id = ?', [id]);
}

// ---------- Middleware ----------
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated.' });
  next();
}

async function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated.' });
  try {
    const user = await get('SELECT * FROM users WHERE id = ?', [req.session.userId]);
    if (!user || user.role !== 'admin' || user.status !== 'active') {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    next();
  } catch {
    res.status(500).json({ error: 'Server error.' });
  }
}

function requireRole(...roles) {
  return async (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated.' });
    try {
      const user = await get('SELECT * FROM users WHERE id = ?', [req.session.userId]);
      if (!user || !roles.includes(user.role) || user.status !== 'active') {
        return res.status(403).json({ error: 'Access denied.' });
      }
      next();
    } catch {
      res.status(500).json({ error: 'Server error.' });
    }
  };
}

// ---------- Email verification ----------
router.post('/send-verification-code', async (req, res) => {
  cleanExpiredCodes();
  const email = normalizeEmail(req.body?.email);
  console.log('📩 Attempting to send verification code to:', email || '(no email)');

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }

  if (isRateLimited(email)) {
    return res.status(429).json({ error: 'Too many verification requests. Please try again in 15 minutes.' });
  }

  // Also reject if the email is already registered
  const existing = await get('SELECT id FROM users WHERE LOWER(email) = LOWER(?)', [email]);
  if (existing) {
    return res.status(409).json({ error: 'Email already registered.' });
  }

  const code = randomSixDigitCode();
  codeStore.set(email, { code, expiresAt: Date.now() + CODE_TTL_MS, verified: false });
  console.log(`[auth] Stored verification code for ${email}: ${code} (expires in 10 min)`);

  try {
    // BLOCKING — resolves only after Gmail SMTP accepts the message
    await sendVerificationCode(email, code);
  } catch (err) {
    // Log the FULL error object so Gmail's "Invalid login" / "Application-specific
    // password required" / quota / blocked errors surface verbatim.
    console.error('❌ Send failed for', email, ':', err);
    return res.status(500).json({
      error: 'Failed to send the verification email. Please try again.',
      detail: process.env.NODE_ENV === 'production' ? undefined : (err && (err.response || err.message || String(err)))
    });
  }

  res.json({ success: true, message: 'Verification code sent.' });
});

router.post('/verify-code', async (req, res) => {
  cleanExpiredCodes();
  const email = normalizeEmail(req.body?.email);
  // Ensure both stored and submitted codes are compared as strings.
  const code = String(req.body?.code || '').trim();

  if (!email || !code) {
    return res.status(400).json({ error: 'Email and code are required.' });
  }

  const entry = codeStore.get(email);
  if (!entry) {
    console.warn(`[auth] verify-code: no code stored for ${email} (submitted code was '${code}')`);
    return res.status(400).json({ error: 'No verification code has been sent for this email.' });
  }
  if (entry.expiresAt < Date.now()) {
    codeStore.delete(email);
    console.warn(`[auth] verify-code: expired code for ${email}`);
    return res.status(400).json({ error: 'Code expired. Please request a new code.' });
  }
  if (entry.verified) {
    return res.json({ verified: true, message: 'Email already verified.' });
  }
  if (String(entry.code) !== code) {
    console.warn(
      `[auth] verify-code MISMATCH for ${email}: stored='${String(entry.code)}' submitted='${code}' (both types: ${typeof entry.code} vs ${typeof code})`
    );
    return res.status(400).json({ error: 'Invalid code.' });
  }

  entry.verified = true;
  console.log(`[auth] Email verified successfully: ${email}`);
  res.json({ verified: true, message: 'Email verified successfully.' });
});

// ---------- Registration ----------
router.post('/register', async (req, res) => {
  const { username, email, password, fullName, role } = req.body || {};
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email and password are required.' });
  }
  if (!SELF_REGISTER_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Invalid role. Choose Faculty Researcher, Student Researcher, Adviser, or Ethics Reviewer.' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  // Require email verification before allowing registration
  cleanExpiredCodes();
  const verifiedEntry = codeStore.get(normalizeEmail(email));
  if (!verifiedEntry || !verifiedEntry.verified) {
    return res.status(403).json({
      error: 'Please verify your email address before registering.'
    });
  }

  // Check for existing username or email
  const existing = await get(
    'SELECT id FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)',
    [String(username).toLowerCase(), String(email).toLowerCase()]
  );
  if (existing) {
    if (existing.username && existing.username.toLowerCase() === String(username).toLowerCase()) {
      return res.status(409).json({ error: 'Username already taken.' });
    }
    return res.status(409).json({ error: 'Email already registered.' });
  }

  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  const needsApproval = ROLE_META[role]?.approvable;
  const user = {
    id: randomUUID(),
    username: String(username).trim(),
    email: String(email).trim(),
    fullName: fullName ? String(fullName).trim() : '',
    role,
    passwordHash: hash,
    status: needsApproval ? 'pending' : 'active',
    department: '',
    contactNumber: '',
    researchInterests: '',
    profilePhoto: null,
    researches: JSON.stringify([]),
    user_prefs: JSON.stringify(DEFAULT_PREFS),
    resetToken: null,
    resetTokenExpiry: null,
    createdAt: new Date().toISOString()
  };
  await insert('users', user);

  if (needsApproval) {
    return res.status(202).json({
      message: 'Your Ethics Reviewer account is pending admin approval. You will be notified once approved.'
    });
  }
  res.status(201).json({ message: 'Registration successful. You may now log in.', user: publicUser(user) });
});

// ---------- Login ----------
router.post('/login', async (req, res) => {
  const { identifier, password } = req.body || {};
  if (!identifier || !password) {
    return res.status(400).json({ error: 'Username/email and password are required.' });
  }
  // A rejected async handler becomes an unhandled rejection in Express 4: no
  // response is ever sent, so the browser's login request hangs forever
  // ("Logging in…" never resolves) whenever the database is unreachable — the
  // query error only lands in the process-level unhandledRejection log. Catch it
  // and answer with a clear, actionable error so the form can re-enable itself
  // and tell the visitor what is wrong instead of spinning.
  let user;
  try {
    user = await get('SELECT * FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)', [String(identifier).toLowerCase(), String(identifier).toLowerCase()]);
  } catch (err) {
    console.error('[auth] login could not read users (database unavailable):', err.message);
    return res.status(503).json({ error: 'The server cannot reach its database right now. Please try again in a moment.' });
  }
  if (!user) {
    return res.status(401).json({ error: 'Invalid username/email or password.' });
  }
  if (user.status === 'pending') {
    return res.status(403).json({ error: 'Your account is pending admin approval.' });
  }
  if (user.status === 'disabled') {
    return res.status(403).json({ error: 'This account has been disabled.' });
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return res.status(401).json({ error: 'Invalid username/email or password.' });
  }
  req.session.userId = user.id;
  addLog('login', `User ${user.username} logged in`, req);
  res.json({ message: 'Logged in.', user: publicUser(user) });
});

// ---------- Google (Gmail) sign-in ----------
// OAuth 2.0 "Sign in with Google" using Node's global fetch (no extra deps).
// Credentials come from the environment: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
// (see .env.example for the setup steps). When they are missing the routes stay
// inert and the UI shows a friendly "not configured" notice instead.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
// Endpoints default to Google's production URLs; overridable via env so the
// flow can be tested against a local mock OAuth provider (see .env.example).
const GOOGLE_AUTH_URL = process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = process.env.GOOGLE_USERINFO_URL || 'https://www.googleapis.com/oauth2/v3/userinfo';

function googleConfigured() {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

function googleRedirectUri(req) {
  return `${req.protocol}://${req.get('host')}/api/auth/google/callback`;
}

// Error bounces go back to the page the visitor started from (login by
// default, register when the flow began there) with a ?google= code that the
// page renders as a friendly message.
function googleErrorRedirect(req, code) {
  const page = req.session.googleOrigin === 'register' ? 'register' : 'login';
  return `/${page}.html?google=${code}`;
}

// ---------- Installed-browser picker ----------
// A web page cannot enumerate the machine's browsers, but the server can.
// The bridge dialog calls GET /api/auth/browsers to list what's installed and
// POST /api/auth/browser-open to launch the user's chosen browser at the
// external OAuth URL (instead of always defaulting to the OS default).
const BROWSER_CANDIDATES = [
  { id: 'edge', name: 'Microsoft Edge', paths: [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
  ]},
  { id: 'chrome', name: 'Google Chrome', paths: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
  ]},
  { id: 'firefox', name: 'Mozilla Firefox', paths: [
    'C:/Program Files/Mozilla Firefox/firefox.exe',
    'C:/Program Files (x86)/Mozilla Firefox/firefox.exe'
  ]},
  { id: 'brave', name: 'Brave', paths: [
    'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
    'C:/Program Files (x86)/BraveSoftware/Brave-Browser/Application/brave.exe'
  ]},
  { id: 'opera', name: 'Opera', paths: ['C:/Program Files/Opera/launcher.exe'] },
  { id: 'vivaldi', name: 'Vivaldi', paths: ['C:/Program Files/Vivaldi/Application/vivaldi.exe'] }
];

function detectBrowsers() {
  return BROWSER_CANDIDATES
    .map((b) => {
      const found = b.paths.find((p) => existsSync(p));
      return found ? { id: b.id, name: b.name, path: found } : null;
    })
    .filter(Boolean);
}

// The external OAuth URL is built from this server's own host, so only URLs on
// the same origin may be handed to a browser (prevents the endpoint from
// becoming an open redirect-launcher).
function isSameOriginUrl(req, url) {
  try {
    return new URL(url).origin === `${req.protocol}://${req.get('host')}`;
  } catch {
    return false;
  }
}

router.get('/browsers', (req, res) => {
  res.json(detectBrowsers().map(({ id, name }) => ({ id, name })));
});

router.post('/browser-open', (req, res) => {
  const { browser, url } = req.body || {};
  if (typeof browser !== 'string' || typeof url !== 'string') {
    return res.status(400).json({ error: 'browser and url are required.' });
  }
  if (!isSameOriginUrl(req, url)) {
    return res.status(400).json({ error: 'Only this site\'s URLs can be opened.' });
  }
  const entry = detectBrowsers().find((b) => b.id === browser);
  if (!entry) {
    return res.status(404).json({ error: 'Browser not found on this machine.' });
  }
  try {
    const child = spawn(entry.path, [url], { detached: true, stdio: 'ignore' });
    child.unref();
    res.json({ ok: true, name: entry.name });
  } catch (err) {
    console.error('[browsers] launch failed:', err.message);
    res.status(500).json({ error: 'Could not launch the browser.' });
  }
});

// Lets the UI know whether the button can start the real OAuth dance.
router.get('/google/status', (req, res) => {
  res.json({ enabled: googleConfigured() });
});

// Step 1 — send the visitor to Google's consent screen.
router.get('/google', (req, res) => {
  if (!googleConfigured()) {
    return res.status(503).json({ error: 'Google sign-in is not configured on this server yet.' });
  }
  // External mode: the flow runs in the system browser (see the bridge store
  // above); the flag rides in the session so the callback — which only sees
  // Google's redirect back — still knows which landing page to use.
  if (req.query.external === '1') {
    req.session.googleExternal = true;
  }
  // Remember which page started the flow so error bounces (cancel, disabled,
  // pending, server failure) land back on that same page — a user who cancels
  // during Google sign-up should see the notice on register, not login.
  req.session.googleOrigin = req.query.from === 'register' ? 'register' : 'login';
  // CSRF guard: bind a random state to this session, verified on callback.
  const state = randomBytes(16).toString('hex');
  req.session.googleOAuthState = state;
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
    // Web server apps: 'offline' is the documented standard (returns a refresh
    // token and avoids the flaky access_type=online path in Google's newer
    // v3 sign-in flow, which has intermittently returned 500s).
    access_type: 'offline'
  });
  res.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
});

// Step 2 — Google bounces back here with a code; exchange it, find-or-create
// the user, and start a session (same session as password login).
router.get('/google/callback', async (req, res) => {
  const { code, state, error } = req.query || {};
  if (error) return res.redirect(googleErrorRedirect(req, 'denied'));
  if (!googleConfigured()) {
    return res.status(503).json({ error: 'Google sign-in is not configured on this server yet.' });
  }
  if (!code) return res.status(400).json({ error: 'Missing authorization code.' });
  if (!state || !req.session.googleOAuthState || state !== req.session.googleOAuthState) {
    return res.status(400).json({ error: 'Invalid OAuth state (possible CSRF).' });
  }
  delete req.session.googleOAuthState;

  // Exchange the code for an access token.
  let tokenRes;
  try {
    tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: googleRedirectUri(req),
        grant_type: 'authorization_code'
      })
    });
  } catch (err) {
    console.error('[google] token exchange failed:', err.message);
    return res.redirect(googleErrorRedirect(req, 'error'));
  }
  const tokenData = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenData.access_token) {
    console.error('[google] token exchange error:', tokenData);
    return res.redirect(googleErrorRedirect(req, 'error'));
  }

  // Fetch the profile with the token.
  let profileRes;
  try {
    profileRes = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
  } catch (err) {
    console.error('[google] userinfo failed:', err.message);
    return res.redirect(googleErrorRedirect(req, 'error'));
  }
  const profile = await profileRes.json().catch(() => ({}));
  if (!profileRes.ok || !profile.email || profile.email_verified !== true) {
    console.error('[google] userinfo error:', profile);
    return res.redirect(googleErrorRedirect(req, 'error'));
  }

  const email = String(profile.email).trim().toLowerCase();
  const googlePhoto = profile.picture ? String(profile.picture) : null;

  // Find an existing account by email (links the Google identity to an account
  // the visitor may already have registered with a password).
  let user = await get('SELECT * FROM users WHERE LOWER(email) = LOWER(?)', [email]);

  if (user && !user.profilePhoto && googlePhoto) {
    // Adopt the Google picture for an existing account that has no photo yet,
    // so the navbar avatar shows it after the first Google sign-in.
    await update('users', user.id, { profilePhoto: googlePhoto });
    user.profilePhoto = googlePhoto;
  }

  let isNewUser = false;
  if (!user) {
    // First-time Google sign-in — mint the account with a temporary role and a
    // setupPending flag, then send them to complete-profile.html to pick a role
    // (student / faculty / adviser) before using the site.
    isNewUser = true;
    const baseName = String(email.split('@')[0]).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 40) || 'googleuser';
    let username = baseName;
    let n = 1;
    while (await get('SELECT id FROM users WHERE LOWER(username) = LOWER(?)', [username])) {
      username = `${baseName}${n}`;
      n += 1;
    }
    user = {
      id: randomUUID(),
      username,
      email,
      fullName: profile.name ? String(profile.name).trim() : '',
      role: 'student_researcher',      // temporary until profile setup picks a role
      passwordHash: '!oauth-google!',  // never a usable password — reset via email instead
      status: 'active',
      department: '',
      contactNumber: '',
      researchInterests: '',
      profilePhoto: googlePhoto,
      researches: JSON.stringify([]),
      user_prefs: JSON.stringify(DEFAULT_PREFS),
      setupPending: 1,
      resetToken: null,
      resetTokenExpiry: null,
      createdAt: new Date().toISOString()
    };
    await insert('users', user);
    console.log(`[google] New account created via Google: ${email} — profile setup required`);

    // One-time welcome notification for the brand-new account — it lands in
    // their bell (unread) so it's the first thing they see after finishing
    // profile setup. Only ever created here, on account minting, so it can
    // never repeat for later sign-ins.
    try {
      await notify(
        user.id,
        'google_welcome',
        'Welcome to CPRI!',
        'Your account was created with Google. Finish your profile to start submitting research.',
        'profile.html'
      );
    } catch (err) {
      console.error('[google] welcome notify failed:', err.message);
    }
  } else if (user.status === 'disabled') {
    return res.redirect(googleErrorRedirect(req, 'disabled'));
  } else if (user.status === 'pending') {
    return res.redirect(googleErrorRedirect(req, 'pending'));
  }

  req.session.userId = user.id;
  // External (system-browser) flow: the session just landed in the user's
  // default browser. Hand it to the app via a one-time code instead of a
  // redirect the embedded browser could not reach anyway.
  if (req.session.googleExternal) {
    delete req.session.googleExternal;
    const code = makeBridgeCode();
    googleBridgeStore.set(code, { userId: user.id, expiresAt: Date.now() + GOOGLE_BRIDGE_TTL_MS });
    console.log(`[google] External-browser sign-in complete — bridge code ${code} minted for ${email}`);
    return res.redirect('/google-bridge.html?code=' + code);
  }
  if (isNewUser) return res.redirect('/complete-profile.html');
  res.redirect(user.role === 'admin' ? '/admin-dashboard.html' : '/account.html');
});

// Step 3 (external flow) — the app exchanges the code shown in the system
// browser for the session the callback created there, so the embedded browser
// becomes signed in without its user agent ever touching Google.
router.post('/google/bridge', (req, res) => {
  const code = String(((req.body || {}).code) || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Missing code.' });
  const entry = googleBridgeStore.get(code);
  if (!entry || entry.expiresAt < Date.now()) {
    googleBridgeStore.delete(code);
    return res.status(400).json({ error: 'Invalid or expired code. Please start Google sign-in again.' });
  }
  googleBridgeStore.delete(code);
  // Adopt the session: this request's cookie gets a fresh server-side session
  // bound to the same user, identical to any other login.
  req.session.userId = entry.userId;
  res.json({ ok: true });
});

// ---------- Demo full-access login (magic link) ----------
// Enabled only while a demo access key file exists — written by `npm run share`
// (server/data/demo-access.key, deleted when the share session ends). Visiting
// /demo-login?key=<key> logs in as admin and lands on the Admin Console, giving
// a friend a single click-to-full-access link. Without the key file this route
// is inert (403), so it is safe in normal operation.
const DEMO_KEY_FILE = join(__dirname, 'data', 'demo-access.key');
// Full-access keys self-expire server-side so a key file left behind by a
// crashed share session (SIGKILL / power loss) cannot stay live forever.
const DEMO_KEY_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

router.get('/demo-login', async (req, res) => {
  try {
    const submitted = String(req.query.key || '');
    if (!submitted) return res.status(400).json({ error: 'Missing demo access key.' });
    let entry = null;
    try {
      entry = JSON.parse(await fs.readFile(DEMO_KEY_FILE, 'utf8'));
    } catch { /* missing or malformed — treated as no key */ }
    if (!entry || typeof entry.key !== 'string' || submitted !== entry.key) {
      return res.status(403).json({ error: 'Invalid or expired demo access key.' });
    }
    if (!entry.expiresAt || Date.now() > entry.expiresAt) {
      return res.status(403).json({ error: 'Invalid or expired demo access key.' });
    }
    const admin = await get("SELECT * FROM users WHERE role = 'admin' AND status = 'active' LIMIT 1");
    if (!admin) return res.status(404).json({ error: 'No active admin account found.' });
    req.session.userId = admin.id;
    res.redirect('/admin-dashboard.html');
  } catch (err) {
    console.error('[auth] demo-login error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ---------- Logout ----------
router.post('/logout', (req, res) => {
  const userId = req.session?.userId;
  req.session.destroy(() => {
    res.clearCookie('cpri.sid');
    res.json({ message: 'Logged out.' });
  });
  if (userId) {
    get('SELECT username FROM users WHERE id = ?', [userId]).then(u => {
      addLog('logout', `User ${u?.username || userId} logged out`, req);
    }).catch(() => {});
  }
});

// ---------- Current user ----------
router.get('/me', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated.' });
  const user = await get('SELECT * FROM users WHERE id = ?', [req.session.userId]);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });
  res.json({ user: publicUser(user) });
});

// ---------- Forgot password ----------
router.post('/forgot', async (req, res) => {
  const { email } = req.body || {};
  const baseUrl = req.protocol + '://' + req.get('host');
  if (email) {
    const user = await get('SELECT * FROM users WHERE LOWER(email) = LOWER(?)', [String(email).toLowerCase()]);
    if (user) {
      const token = randomBytes(32).toString('hex');
      await update('users', user.id, { resetToken: token, resetTokenExpiry: Date.now() + RESET_TTL_MS });
      await sendResetEmail(user.email, token, baseUrl);
    }
  }
  // Always return success to avoid revealing registered emails.
  res.json({ message: 'If that email exists, a reset link has been sent.' });
});

// ---------- Reset password ----------
router.post('/reset', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) {
    return res.status(400).json({ error: 'Token and new password are required.' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  const user = await get('SELECT * FROM users WHERE resetToken = ?', [token]);
  if (!user || !user.resetTokenExpiry || user.resetTokenExpiry < Date.now()) {
    return res.status(400).json({ error: 'Invalid or expired reset token.' });
  }
  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  await update('users', user.id, { passwordHash: hash, resetToken: null, resetTokenExpiry: null });
  res.json({ message: 'Password has been reset. You may now log in.' });
});

// ---------- RBAC: roles & permission matrix ----------
router.get('/rbac', (req, res) => {
  res.json({ roles: ROLE_META, permissions: RBAC_PERMISSIONS });
});

// ---------- Notification preferences ----------
router.get('/profile/prefs', requireAuth, async (req, res) => {
  const user = await get('SELECT user_prefs FROM users WHERE id = ?', [req.session.userId]);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });
  res.json({ prefs: normalizePrefs(user.user_prefs) });
});

router.put('/profile/prefs', requireAuth, async (req, res) => {
  const user = await patchUser(req.session.userId, { user_prefs: normalizePrefs(req.body) });
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });
  res.json({ message: 'Notification preferences saved.', prefs: normalizePrefs(user.user_prefs) });
});

// ---------- First-time profile setup (Google sign-in) ----------
// Lets a brand-new Google account pick its role (student / faculty / adviser)
// and optional department/name. Only usable while setupPending is set, so a
// user can't keep self-upgrading their role afterward.
const SETUP_ROLES = ['student_researcher', 'faculty_researcher', 'adviser'];
router.put('/profile/setup', requireAuth, async (req, res) => {
  const { role, fullName, department } = req.body || {};
  if (!SETUP_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Please choose a valid account type: Student Researcher, Faculty Researcher, or Adviser.' });
  }
  const user = await get('SELECT * FROM users WHERE id = ?', [req.session.userId]);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });
  if (!(user.setupPending === 1 || user.setupPending === '1')) {
    return res.status(403).json({ error: 'Profile setup is already complete.' });
  }
  const changes = { role, setupPending: 0 };
  if (fullName !== undefined && String(fullName).trim()) changes.fullName = String(fullName).trim();
  if (department !== undefined) changes.department = String(department).trim();
  await update('users', user.id, changes);
  const updated = await get('SELECT * FROM users WHERE id = ?', [user.id]);

  // Let every active admin know a new Google account picked its role, so they
  // can review / adjust it in User Management (bell link deep-links to the
  // Users tab via admin-dashboard.html#users).
  try {
    const admins = await all("SELECT id FROM users WHERE role = 'admin' AND status = 'active'");
    const displayName = (updated.fullName || updated.username || 'A new user');
    const roleLabel = ROLE_META[role]?.label || role;
    await Promise.all(admins.map(a => notify(
      a.id,
      'google_signup',
      `New Google sign-up: ${displayName}`,
      `${displayName} completed profile setup as ${roleLabel}. Review their role in User Management.`,
      'admin-dashboard.html#users'
    )));
    if (admins.length) console.log(`[auth] setup: notified ${admins.length} admin(s) about ${displayName}`);
  } catch (err) {
    console.error('[auth] setup admin notify failed:', err.message);
  }

  res.json({ message: 'Profile completed. Welcome!', profile: fullProfile(updated) });
});

// ---------- Profile management ----------
router.get('/profile', requireAuth, async (req, res) => {
  const user = await get('SELECT * FROM users WHERE id = ?', [req.session.userId]);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });
  res.json({ profile: fullProfile(user) });
});

router.put('/profile', requireAuth, async (req, res) => {
  const { fullName, department, contactNumber, researchInterests } = req.body || {};
  const changes = {};
  if (fullName !== undefined) changes.fullName = String(fullName).trim();
  if (department !== undefined) changes.department = String(department).trim();
  if (contactNumber !== undefined) changes.contactNumber = String(contactNumber).trim();
  if (researchInterests !== undefined) changes.researchInterests = String(researchInterests).trim();
  const user = await patchUser(req.session.userId, changes);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });
  res.json({ message: 'Profile updated.', profile: fullProfile(user) });
});

// Profile photo upload (images only, max 2 MB)
router.post('/profile/photo', requireAuth, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded (images only, max 2 MB).' });
  try {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
  } catch { /* exists */ }
  const rel = `/assets/uploads/profiles/${req.file.filename}`;
  await patchUser(req.session.userId, { profilePhoto: rel });
  res.json({ message: 'Profile photo updated.', profilePhoto: rel });
});

// Remove profile photo (clears reference + deletes the file if it exists).
// Remote photos (e.g. a Google OAuth picture URL) are not files on this server,
// so only the reference is cleared for those.
router.delete('/profile/photo', requireAuth, async (req, res) => {
  const user = await get('SELECT * FROM users WHERE id = ?', [req.session.userId]);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });
  if (user.profilePhoto && !/^https?:\/\//.test(user.profilePhoto)) {
    try {
      await fs.unlink(join(UPLOAD_DIR, basename(user.profilePhoto)));
    } catch { /* file may not exist on disk */ }
  }
  await patchUser(req.session.userId, { profilePhoto: null });
  res.json({ message: 'Profile photo removed.' });
});

// ---------- Researches (submitted / completed) ----------
router.get('/researches', requireAuth, async (req, res) => {
  const user = await get('SELECT id, researches FROM users WHERE id = ?', [req.session.userId]);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });
  res.json({ researches: user.researches || [] });
});

router.post('/researches', requireAuth, async (req, res) => {
  const { title, status, year, authors } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  const user = await get('SELECT id, researches FROM users WHERE id = ?', [req.session.userId]);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });
  const researches = user.researches || [];
  const entry = {
    id: randomUUID(),
    title: String(title).trim(),
    status: status === 'completed' ? 'completed' : 'submitted',
    year: year ? String(year).trim() : '',
    authors: authors ? String(authors).trim() : '',
    createdAt: new Date().toISOString()
  };
  researches.push(entry);
  await update('users', user.id, { researches: JSON.stringify(researches) });
  res.status(201).json({ message: 'Research added.', research: entry });
});

router.delete('/researches/:id', requireAuth, async (req, res) => {
  const user = await get('SELECT id, researches FROM users WHERE id = ?', [req.session.userId]);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });
  const researches = (user.researches || []).filter(r => r.id !== req.params.id);
  await update('users', user.id, { researches: JSON.stringify(researches) });
  res.json({ message: 'Research removed.' });
});

// ---------- Admin: list pending ethics reviewers ----------
router.get('/admin/reviewers/pending', requireAdmin, async (req, res) => {
  const users = await all("SELECT * FROM users WHERE role = 'ethics_reviewer' AND status = 'pending'");
  res.json(users.map(publicUser));
});

// ---------- Admin: approve / reject ethics reviewer ----------
router.post('/admin/reviewers/:id', requireAdmin, async (req, res) => {
  const { action } = req.body || {};
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'Action must be approve or reject.' });
  }
  const user = await get("SELECT * FROM users WHERE id = ? AND role = 'ethics_reviewer'", [req.params.id]);
  if (!user) {
    return res.status(404).json({ error: 'Ethics reviewer not found.' });
  }
  const newStatus = action === 'approve' ? 'active' : 'disabled';
  await update('users', user.id, { status: newStatus });
  const updated = await get('SELECT * FROM users WHERE id = ?', [user.id]);
  res.json({ message: `Ethics reviewer ${action === 'approve' ? 'approved' : 'rejected'}.`, user: publicUser(updated) });
});

// ---------- Admin: user management (RBAC assignment) ----------
router.get('/admin/users', requireAdmin, async (req, res) => {
  const users = await all('SELECT * FROM users ORDER BY createdAt DESC');
  res.json(users.map(publicUser));
});

router.patch('/admin/users/:id', requireAdmin, async (req, res) => {
  const { role, status, department } = req.body || {};
  if (role && !ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });
  if (status && !['active', 'pending', 'disabled'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  const user = await get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const changes = {};
  if (role) changes.role = role;
  if (status) changes.status = status;
  if (department !== undefined) changes.department = String(department).trim();
  await update('users', req.params.id, changes);
  const updated = await get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  res.json({ message: 'User updated.', user: publicUser(updated) });
});

router.delete('/admin/users/:id', requireAdmin, async (req, res) => {
  const user = await get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  await remove('users', req.params.id);
  res.json({ message: 'User deleted.' });
});

// ---------- Seed default admin ----------
async function initAuth() {
  const adminUser = await get("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (!adminUser) {
    // Never boot a public deployment with a guessable admin password: when
    // ADMIN_PASSWORD is unset, generate one and print it once so the owner can
    // sign in and change it.
    const generated = !process.env.ADMIN_PASSWORD;
    const adminPassword = process.env.ADMIN_PASSWORD || randomBytes(12).toString('base64url');
    const admin = {
      id: randomUUID(),
      username: 'admin',
      email: process.env.ADMIN_EMAIL || 'admin@cpri.edu',
      fullName: 'System Administrator',
      role: 'admin',
      passwordHash: await bcrypt.hash(adminPassword, SALT_ROUNDS),
      status: 'active',
      department: '',
      contactNumber: '',
      researchInterests: '',
    profilePhoto: null,
    researches: JSON.stringify([]),
    user_prefs: JSON.stringify(DEFAULT_PREFS),
    resetToken: null,
    resetTokenExpiry: null,
    createdAt: new Date().toISOString()
  };
  await insert('users', admin);
    console.log('[seed] Default admin created — username: admin');
    if (generated) {
      console.log('[seed] ADMIN_PASSWORD was not set, so this one-time password was generated: ' + adminPassword);
      console.log('[seed] Sign in as admin and change it, or set ADMIN_PASSWORD in the environment and recreate the account.');
    }
  }
}

export { router as authRouter, initAuth, requireAuth, requireAdmin, requireRole, readUsers };

