// ============================================================
//  CPRI — Direct messages
//  Private messaging between registered users of every role:
//  admins, CPRI staff, faculty researchers, advisers, ethics
//  reviewers, students, and public-visitor accounts.
//  Sending a message also creates an in-app bell notification
//  for the recipient so they see it without opening the page.
// ============================================================
import { Router } from 'express';
import { randomUUID } from 'crypto';
import { requireAuth } from './auth.js';
import { all, get, run, insert } from './server/db/queries.js';
import { addLog } from './audit.js';
import { notify } from './notifications.js';

const router = Router();

// Roles allowed to participate in direct messaging — every registered role
// can send and receive DMs: staff, faculty, advisers, ethics reviewers,
// students, and public-visitor accounts.
const DM_ROLES = ['admin', 'cpri_staff', 'faculty_researcher', 'adviser', 'ethics_reviewer', 'student_researcher', 'public_visitor'];

const ROLE_LABELS = {
  admin: 'Administrator',
  cpri_staff: 'CPRI Staff',
  faculty_researcher: 'Faculty Researcher',
  student_researcher: 'Student Researcher',
  adviser: 'Adviser',
  ethics_reviewer: 'Ethics Reviewer',
  public_visitor: 'Public Visitor'
};

// The table is created by the Netlify Database migrations in
// netlify/database/migrations; kept as a no-op so existing callers still work.
async function ensureMessagesTable() {}

// Async middleware: requireAuth + the user must be active and in DM_ROLES.
function requireDMRole(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated.' });
  get('SELECT role, status FROM users WHERE id = ?', [req.session.userId])
    .then(user => {
      if (!user || !DM_ROLES.includes(user.role) || user.status !== 'active') {
        return res.status(403).json({ error: 'Direct messaging is available to registered users only.' });
      }
      next();
    })
    .catch(() => res.status(500).json({ error: 'Server error.' }));
}

// GET /api/messages/contacts — staff users I can message (excludes me).
router.get('/contacts', requireDMRole, async (req, res) => {
  try {
    await ensureMessagesTable();
    const users = await all(
      `SELECT id, username, fullName, role, department, profilePhoto
       FROM users
       WHERE status = 'active' AND id <> ?
         AND role IN ('admin','cpri_staff','faculty_researcher','adviser','ethics_reviewer','student_researcher','public_visitor')
       ORDER BY fullName, username`,
      [req.session.userId]
    );
    res.json({ contacts: users.map(u => ({
      id: u.id,
      username: u.username,
      fullName: u.fullName || u.username,
      role: u.role,
      roleLabel: ROLE_LABELS[u.role] || u.role,
      department: u.department || ''
    })) });
  } catch (err) {
    console.error('[messages] contacts error:', err);
    res.status(500).json({ error: 'Failed to load contacts.' });
  }
});

// GET /api/messages — inbox: one row per conversation with the other party,
// the latest message, unread count, and their role label.
router.get('/', requireDMRole, async (req, res) => {
  try {
    await ensureMessagesTable();
    const me = req.session.userId;
    const rows = await all(
      `SELECT m.*, u.fullName, u.username, u.role, u.profilePhoto
       FROM direct_messages m
       JOIN users u ON u.id = (CASE WHEN m.senderId = ? THEN m.recipientId ELSE m.senderId END)
       WHERE m.senderId = ? OR m.recipientId = ?
       ORDER BY m.createdAt DESC`,
      [me, me, me]
    );
    // Fold into conversations keyed by the other party.
    const convos = new Map();
    for (const r of rows) {
      const otherId = r.senderId === me ? r.recipientId : r.senderId;
      if (!convos.has(otherId)) {
        convos.set(otherId, {
          otherId,
          otherName: r.fullName || r.username,
          otherRole: r.role,
          otherRoleLabel: ROLE_LABELS[r.role] || r.role,
          otherPhoto: r.profilePhoto,
          lastMessage: r.body,
          lastAt: r.createdAt,
          lastSenderIsMe: r.senderId === me,
          unread: 0
        });
      }
      if (r.recipientId === me && !r.readAt) convos.get(otherId).unread += 1;
    }
    const inbox = Array.from(convos.values()).sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
    const unreadRows = await all(
      'SELECT COUNT(*) AS c FROM direct_messages WHERE recipientId = ? AND readAt IS NULL',
      [me]
    );
    res.json({ conversations: inbox, unread: Number(unreadRows[0].c) || 0 });
  } catch (err) {
    console.error('[messages] inbox error:', err);
    res.status(500).json({ error: 'Failed to load messages.' });
  }
});

// GET /api/messages/:userId — the full thread with one user.
router.get('/:userId', requireDMRole, async (req, res) => {
  try {
    await ensureMessagesTable();
    const me = req.session.userId;
    const otherId = req.params.userId;
    if (otherId === me) return res.status(400).json({ error: 'Cannot message yourself.' });
    const other = await get('SELECT id, username, fullName, role, department FROM users WHERE id = ? AND status = \'active\'', [otherId]);
    if (!other || !DM_ROLES.includes(other.role)) {
      return res.status(403).json({ error: 'That user is not available for direct messaging.' });
    }
    const rows = await all(
      `SELECT * FROM direct_messages
       WHERE (senderId = ? AND recipientId = ?) OR (senderId = ? AND recipientId = ?)
       ORDER BY createdAt ASC`,
      [me, otherId, otherId, me]
    );
    res.json({
      other: {
        id: other.id,
        fullName: other.fullName || other.username,
        username: other.username,
        role: other.role,
        roleLabel: ROLE_LABELS[other.role] || other.role,
        department: other.department || ''
      },
      messages: rows.map(m => ({
        id: m.id,
        senderId: m.senderId,
        body: m.body,
        readAt: m.readAt,
        createdAt: m.createdAt,
        mine: m.senderId === me
      }))
    });
  } catch (err) {
    console.error('[messages] thread error:', err);
    res.status(500).json({ error: 'Failed to load thread.' });
  }
});

// POST /api/messages — send a direct message { recipientId, body }.
router.post('/', requireDMRole, async (req, res) => {
  try {
    await ensureMessagesTable();
    const me = req.session.userId;
    const recipientId = String(req.body?.recipientId || '').trim();
    const body = String(req.body?.body || '').trim();
    if (!recipientId || !body) return res.status(400).json({ error: 'Recipient and message are required.' });
    if (body.length > 2000) return res.status(400).json({ error: 'Message is too long (max 2000 characters).' });
    if (recipientId === me) return res.status(400).json({ error: 'You cannot send a message to yourself.' });

    const recipient = await get('SELECT id, role, status, fullName, username FROM users WHERE id = ?', [recipientId]);
    if (!recipient || !DM_ROLES.includes(recipient.role) || recipient.status !== 'active') {
      return res.status(403).json({ error: 'That user is not available for direct messaging.' });
    }
    const sender = await get('SELECT fullName, username FROM users WHERE id = ?', [me]);

    const message = {
      id: randomUUID(),
      senderId: me,
      recipientId,
      body,
      readAt: null,
      createdAt: new Date()
    };
    await insert('direct_messages', message);

    // Audit trail (no message content — just who messaged whom).
    await addLog('message_send', `Sent a direct message to ${recipient.fullName || recipient.username}`, req).catch(() => {});

    // In-app bell notification so the recipient sees it immediately.
    await notify(
      recipientId,
      'direct_message',
      `New message from ${sender.fullName || sender.username}`,
      body.slice(0, 140),
      'messages.html'
    );

    res.status(201).json({ message: 'Message sent.', dm: { ...message, mine: true } });
  } catch (err) {
    console.error('[messages] send error:', err);
    res.status(500).json({ error: 'Failed to send message.' });
  }
});

// POST /api/messages/read — mark all messages from :userId as read.
router.post('/read', requireDMRole, async (req, res) => {
  try {
    await ensureMessagesTable();
    const otherId = String(req.body?.userId || '').trim();
    if (!otherId) return res.status(400).json({ error: 'userId is required.' });
    await run('UPDATE direct_messages SET readAt = ? WHERE senderId = ? AND recipientId = ? AND readAt IS NULL', [new Date(), otherId, req.session.userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[messages] mark read error:', err);
    res.status(500).json({ error: 'Failed to mark messages as read.' });
  }
});

export { router as messagesRouter, ensureMessagesTable };
