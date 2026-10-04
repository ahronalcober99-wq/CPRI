// ============================================================
//  CPRI — In-app notifications (bell)
//  Role-aware: logged-in users see their personal notifications
//  with unread count + role label; public visitors get a read-only
//  feed of the latest announcements & events. Mutations are behind
//  requireAuth — guests can never change notification state.
// ============================================================
import { Router } from 'express';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { requireAuth } from './auth.js';
import { all, get, run, insert } from './server/db/queries.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, 'data');

const router = Router();

// Same labels as auth.js ROLE_META so the panel pill matches the account page.
const ROLE_LABELS = {
  admin: 'Administrator',
  cpri_staff: 'CPRI Staff',
  faculty_researcher: 'Faculty Researcher',
  student_researcher: 'Student Researcher',
  adviser: 'Adviser',
  ethics_reviewer: 'Ethics Reviewer',
  public_visitor: 'Public Visitor'
};

// Same defaults as auth.js — kept local so notify() never has to import the
// auth module (avoids a circular dependency).
const DEFAULT_PREFS = {
  inApp: true,
  email: false,
  quietHours: { enabled: false, start: '22:00', end: '07:00' }
};

// The table is created by the Netlify Database migrations in
// netlify/database/migrations; kept as a no-op so existing callers still work.
async function ensureNotificationsTable() {}

async function loadPrefs(userId) {
  if (!userId) return DEFAULT_PREFS;
  const user = await get('SELECT user_prefs FROM users WHERE id = ?', [userId]);
  const raw = user && user.user_prefs ? user.user_prefs : {};
  return { ...DEFAULT_PREFS, ...(raw || {}) };
}

/**
 * Insert an in-app notification for a user. Respects the user's preferences
 * (inApp off → no row). Email copies are intentionally NOT sent here — the
 * in-app feature is self-contained; email delivery lives in the admin
 * Email Notifications module.
 */
export async function notify(userId, action, title, message, link = '') {
  if (!userId || !title) return;
  try {
    const prefs = await loadPrefs(userId);
    if (prefs.inApp === false) return;
    await ensureNotificationsTable();
    await insert('notifications', {
      id: randomUUID(),
      userId,
      action,
      title,
      message,
      link,
      readAt: null,
      createdAt: new Date()
    });
  } catch (err) {
    console.error('[notifications] insert failed:', err.message);
  }
}

// Read-only public feed for logged-out visitors: newest announcements +
// upcoming events from the server/data JSON files.
async function publicFeed() {
  const items = [];
  try {
    const anns = JSON.parse(await fs.readFile(join(DATA_DIR, 'announcements.json'), 'utf8'));
    (Array.isArray(anns) ? anns : []).forEach(a => {
      const d = new Date(a.date);
      if (isNaN(d.getTime())) return;
      items.push({
        title: a.title || 'Announcement',
        message: (a.excerpt || a.body || '').slice(0, 140),
        link: 'announcements.html',
        createdAt: a.date
      });
    });
  } catch { /* file missing */ }
  try {
    const evts = JSON.parse(await fs.readFile(join(DATA_DIR, 'events.json'), 'utf8'));
    (Array.isArray(evts) ? evts : []).forEach(e => {
      const d = new Date(e.date);
      if (isNaN(d.getTime())) return;
      items.push({
        title: e.title || 'Event',
        message: (e.description || e.type || '').slice(0, 140),
        link: 'events.html',
        createdAt: e.date
      });
    });
  } catch { /* file missing */ }
  // Events & Conferences module events (MySQL) join the same public feed.
  try {
    const evts = await all('SELECT title, theme, dateTime, description FROM events_module');
    (Array.isArray(evts) ? evts : []).forEach(e => {
      const d = new Date(e.dateTime);
      if (isNaN(d.getTime())) return;
      items.push({
        title: e.title || 'Event',
        message: (e.description || e.theme || '').slice(0, 140),
        link: 'events-module.html',
        createdAt: e.dateTime
      });
    });
  } catch { /* table missing */ }
  return items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 8);
}

// GET /api/notifications — role-aware, works for every visitor.
router.get('/notifications', async (req, res) => {
  try {
    await ensureNotificationsTable();
    if (!req.session.userId) {
      return res.json({
        public: true,
        roleLabel: 'Public Visitor',
        notifications: await publicFeed(),
        unread: 0,
        activity: []
      });
    }
    const [user, list, unreadRows] = await Promise.all([
      get('SELECT role FROM users WHERE id = ?', [req.session.userId]),
      all('SELECT * FROM notifications WHERE userId = ? ORDER BY createdAt DESC LIMIT 25', [req.session.userId]),
      all('SELECT COUNT(*) AS c FROM notifications WHERE userId = ? AND readAt IS NULL', [req.session.userId])
    ]);
    const role = user ? user.role : 'public_visitor';
    res.json({
      public: false,
      role,
      roleLabel: ROLE_LABELS[role] || role,
      notifications: list.map(n => ({
        id: n.id,
        action: n.action,
        title: n.title,
        message: n.message,
        link: n.link,
        readAt: n.readAt,
        createdAt: n.createdAt
      })),
      unread: Number(unreadRows[0].c) || 0
    });
  } catch (err) {
    console.error('[notifications] list error:', err);
    res.status(500).json({ error: 'Failed to load notifications.' });
  }
});

// Mark all as read (authenticated only).
router.post('/notifications/read', requireAuth, async (req, res) => {
  try {
    await run('UPDATE notifications SET readAt = ? WHERE userId = ? AND readAt IS NULL', [new Date(), req.session.userId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark as read.' });
  }
});

// Mark a single notification as read (authenticated only). The id is
// ownership-checked so users can never touch another user's notifications.
router.post('/notifications/read/:id', requireAuth, async (req, res) => {
  try {
    const updated = await run(
      'UPDATE notifications SET readAt = ? WHERE id = ? AND userId = ? AND readAt IS NULL',
      [new Date(), req.params.id, req.session.userId]
    );
    if (!updated || updated.affectedRows === 0) {
      return res.status(404).json({ error: 'Notification not found or already read.' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark as read.' });
  }
});

router.delete('/notifications/:id', requireAuth, async (req, res) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) {
    return res.status(400).json({ ok: false, message: 'Invalid notification ID.' });
  }

  try {
    const result = await run(
      'DELETE FROM notifications WHERE id = ? AND userId = ?',
      [req.params.id, req.session.userId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ ok: false, message: 'Notification not found.' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[notifications] delete error:', err.message);
    res.status(500).json({ ok: false, message: 'Failed to delete notification.' });
  }
});

router.delete('/notifications', requireAuth, async (req, res) => {
  try {
    const result = await run(
      'DELETE FROM notifications WHERE userId = ?',
      [req.session.userId]
    );
    res.json({ ok: true, deleted: result.affectedRows });
  } catch (err) {
    console.error('[notifications] clear-all error:', err.message);
    res.status(500).json({ ok: false, message: 'Failed to delete notifications.' });
  }
});

export { router as notificationsRouter, ensureNotificationsTable };
