import { Router } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomBytes, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { sendResetEmail } from './lib/mail.js';
import { all, get, run, insert, update, remove } from './server/db/queries.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const UPLOAD_DIR = join(__dirname, '..', 'public', 'assets', 'uploads', 'profiles');

const router = Router();
const SALT_ROUNDS = 10;
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

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

// ---------- User store ----------
async function readUsers() {
  try {
    const raw = await fs.readFile(USERS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function writeUsers(users) {
  await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    fullName: u.fullName,
    role: u.role,
    roleLabel: ROLE_META[u.role]?.label || u.role,
    status: u.status
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
    researches: u.researches || []
  };
}

async function patchUser(id, changes) {
  if (changes.researches !== undefined) {
    changes.researches = JSON.stringify(changes.researches || []);
  }
  await update('users', id, changes);
  return await get('SELECT * FROM users WHERE id = ?', [id]);
}

// ---------- Middleware ----------
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated.' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated.' });
  readUsers().then(users => {
    const user = users.find(u => u.id === req.session.userId);
    if (!user || user.role !== 'admin' || user.status !== 'active') {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    next();
  }).catch(() => res.status(500).json({ error: 'Server error.' }));
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated.' });
    readUsers().then(users => {
      const user = users.find(u => u.id === req.session.userId);
      if (!user || !roles.includes(user.role) || user.status !== 'active') {
        return res.status(403).json({ error: 'Access denied.' });
      }
      next();
    }).catch(() => res.status(500).json({ error: 'Server error.' }));
  };
}

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

  const users = await readUsers();
  if (users.find(u => u.username.toLowerCase() === String(username).toLowerCase())) {
    return res.status(409).json({ error: 'Username already taken.' });
  }
  if (users.find(u => u.email.toLowerCase() === String(email).toLowerCase())) {
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
    researches: [],
    resetToken: null,
    resetTokenExpiry: null,
    createdAt: new Date().toISOString()
  };
  users.push(user);
  await writeUsers(users);

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
  const user = await get('SELECT * FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)', [String(identifier).toLowerCase(), String(identifier).toLowerCase()]);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }
  if (user.status === 'pending') {
    return res.status(403).json({ error: 'Your account is pending admin approval.' });
  }
  if (user.status === 'disabled') {
    return res.status(403).json({ error: 'This account has been disabled.' });
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }
  req.session.userId = user.id;
  res.json({ message: 'Logged in.', user: publicUser(user) });
});

// ---------- Logout ----------
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('cpri.sid');
    res.json({ message: 'Logged out.' });
  });
});

// ---------- Current user ----------
router.get('/me', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated.' });
  const users = await readUsers();
  const user = users.find(u => u.id === req.session.userId);
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
  const users = await readUsers();
  const user = users.find(u => u.resetToken === token);
  if (!user || !user.resetTokenExpiry || user.resetTokenExpiry < Date.now()) {
    return res.status(400).json({ error: 'Invalid or expired reset token.' });
  }
  user.passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  user.resetToken = null;
  user.resetTokenExpiry = null;
  await writeUsers(users);
  res.json({ message: 'Password has been reset. You may now log in.' });
});

// ---------- RBAC: roles & permission matrix ----------
router.get('/rbac', (req, res) => {
  res.json({ roles: ROLE_META, permissions: RBAC_PERMISSIONS });
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
  const user = await patchUser(req.session.userId, { profilePhoto: rel });
  res.json({ message: 'Profile photo updated.', profilePhoto: rel });
});

// ---------- Researches (submitted / completed) ----------
router.get('/researches', requireAuth, async (req, res) => {
  const users = await readUsers();
  const user = users.find(u => u.id === req.session.userId);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });
  res.json({ researches: user.researches || [] });
});

router.post('/researches', requireAuth, async (req, res) => {
  const { title, status, year, authors } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  const users = await readUsers();
  const user = users.find(u => u.id === req.session.userId);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });
  const entry = {
    id: randomUUID(),
    title: String(title).trim(),
    status: status === 'completed' ? 'completed' : 'submitted',
    year: year ? String(year).trim() : '',
    authors: authors ? String(authors).trim() : '',
    createdAt: new Date().toISOString()
  };
  user.researches = user.researches || [];
  user.researches.push(entry);
  await writeUsers(users);
  res.status(201).json({ message: 'Research added.', research: entry });
});

router.delete('/researches/:id', requireAuth, async (req, res) => {
  const users = await readUsers();
  const user = users.find(u => u.id === req.session.userId);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });
  user.researches = (user.researches || []).filter(r => r.id !== req.params.id);
  await writeUsers(users);
  res.json({ message: 'Research removed.' });
});

// ---------- Admin: list pending ethics reviewers ----------
router.get('/admin/reviewers/pending', requireAdmin, async (req, res) => {
  const users = await readUsers();
  res.json(users.filter(u => u.role === 'ethics_reviewer' && u.status === 'pending').map(publicUser));
});

// ---------- Admin: approve / reject ethics reviewer ----------
router.post('/admin/reviewers/:id', requireAdmin, async (req, res) => {
  const { action } = req.body || {};
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'Action must be approve or reject.' });
  }
  const users = await readUsers();
  const user = users.find(u => u.id === req.params.id);
  if (!user || user.role !== 'ethics_reviewer') {
    return res.status(404).json({ error: 'Ethics reviewer not found.' });
  }
  user.status = action === 'approve' ? 'active' : 'disabled';
  await writeUsers(users);
  res.json({ message: `Ethics reviewer ${action === 'approve' ? 'approved' : 'rejected'}.`, user: publicUser(user) });
});

// ---------- Admin: user management (RBAC assignment) ----------
router.get('/admin/users', requireAdmin, async (req, res) => {
  const users = await readUsers();
  res.json(users.map(publicUser));
});

router.patch('/admin/users/:id', requireAdmin, async (req, res) => {
  const { role, status, department } = req.body || {};
  if (role && !ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });
  if (status && !['active', 'pending', 'disabled'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  const users = await readUsers();
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (role) user.role = role;
  if (status) user.status = status;
  if (department !== undefined) user.department = String(department).trim();
  await writeUsers(users);
  res.json({ message: 'User updated.', user: publicUser(user) });
});

router.delete('/admin/users/:id', requireAdmin, async (req, res) => {
  const user = await get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  await remove('users', req.params.id);
  res.json({ message: 'User deleted.' });
});

// ---------- Seed default admin ----------
async function initAuth() {
  const users = await readUsers();
  const hasAdmin = users.some(u => u.role === 'admin');
  if (!hasAdmin) {
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin12345';
    const admin = {
      id: randomUUID(),
      username: 'admin',
      email: process.env.ADMIN_EMAIL || 'admin@cpri.edu',
      fullName: 'System Administrator',
      role: 'admin',
      passwordHash: await bcrypt.hash(adminPassword, SALT_ROUNDS),
      status: 'active',
      resetToken: null,
      resetTokenExpiry: null,
      researches: JSON.stringify([]),
      createdAt: new Date().toISOString()
    };
    await insert('users', admin);
    console.log('[seed] Default admin created — username: admin | password: ' + adminPassword);
  }
}

export { router as authRouter, initAuth, requireAuth, requireAdmin, requireRole, readUsers };