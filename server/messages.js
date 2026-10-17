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
import multer from 'multer';
import { extname, join } from 'path';
import { createResearchStorage } from './lib/research-storage.js';
import { validateSubmissionUploadFile } from './storage/submission-files.js';
import { requireAuth } from './auth.js';
import { all, get, run, insert } from './server/db/queries.js';
import { addLog } from './audit.js';
import { notify } from './notifications.js';

const router = Router();

// Roles allowed to participate in direct messaging — every registered role
// can send and receive DMs: staff, faculty, non-teaching faculty, advisers,
// ethics reviewers, students, presenters, and public-visitor accounts.
//
// DRAGONS: this list must cover every role in ROLES (auth.js). It was written
// before non_teaching_researcher and presenter existed and was never extended,
// even though the navbar has always offered Messages to them — so those two
// got a Messages link that answered 403. DM_ROLES is exported and asserted
// against ROLES by test:gap so the two can never diverge again.
const DM_ROLES = ['admin', 'cpri_staff', 'faculty_researcher', 'non_teaching_researcher', 'adviser', 'ethics_reviewer', 'student_researcher', 'presenter', 'public_visitor'];

const ROLE_LABELS = {
  admin: 'Administrator',
  cpri_staff: 'CPRI Staff',
  faculty_researcher: 'Faculty Researcher',
  non_teaching_researcher: 'Non-Teaching Researcher',
  student_researcher: 'Student Researcher',
  presenter: 'Presenter',
  // See notifications.js — "Research Advisers or Facilitators" is a single role
  // stored as `adviser`; `facilitator` is the research module's spelling.
  adviser: 'Research Adviser / Facilitator',
  facilitator: 'Research Adviser / Facilitator',
  ethics_reviewer: 'Ethics Reviewer',
  public_visitor: 'Public Visitor'
};

// ---- Schema (additive, safe on existing databases) ----
// A message may link one research submission and carry one PDF/Word
// attachment. Those columns were added later, so a database created before
// them gets them on boot (server.js calls this); every column is nullable, so
// existing messages stay valid.
const MESSAGE_COLUMNS = [
  ['relatedSubmissionId', 'VARCHAR(36) DEFAULT NULL'],
  ['relatedSubmissionTitle', 'VARCHAR(255) DEFAULT NULL'],
  ['relatedSource', 'VARCHAR(20) DEFAULT NULL'],
  ['attachmentPath', 'VARCHAR(512) DEFAULT NULL'],
  ['attachmentName', 'VARCHAR(255) DEFAULT NULL'],
  ['attachmentMime', 'VARCHAR(120) DEFAULT NULL'],
  ['attachmentSize', 'INT DEFAULT NULL'],
  ['attachmentBackend', 'VARCHAR(20) DEFAULT NULL']
];

let messagesSchemaReady = null;
async function ensureMessagesTable() {
  if (!messagesSchemaReady) {
    messagesSchemaReady = (async () => {
      await run(`CREATE TABLE IF NOT EXISTS direct_messages (
        id VARCHAR(36) NOT NULL,
        senderId VARCHAR(36) DEFAULT NULL,
        recipientId VARCHAR(36) DEFAULT NULL,
        body TEXT DEFAULT NULL,
        readAt DATETIME DEFAULT NULL,
        createdAt DATETIME DEFAULT NULL,
        PRIMARY KEY (id),
        KEY idx_dm_sender (senderId, createdAt),
        KEY idx_dm_recipient (recipientId, createdAt)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      const columns = await all('SHOW COLUMNS FROM direct_messages');
      const existing = new Set(columns.map(c => String(c.Field || c.field || '').toLowerCase()));
      const added = [];
      for (const [name, type] of MESSAGE_COLUMNS) {
        if (existing.has(name.toLowerCase())) continue;
        try {
          await run(`ALTER TABLE direct_messages ADD COLUMN ${name} ${type}`);
          added.push(name);
        } catch (err) {
          if (!String(err && err.message).includes('Duplicate column name')) throw err;
        }
      }
      console.log(added.length
        ? `[schema] added missing direct_messages columns: ${added.join(', ')}`
        : '[schema] direct_messages columns: ok');
    })().catch((err) => { messagesSchemaReady = null; throw err; });
  }
  return messagesSchemaReady;
}

// Routes re-check the schema cheaply (it is memoised); a failure there is
// logged by the boot call and must not take messaging down.
const schemaReady = () => ensureMessagesTable().catch(() => {});

// ---- Attachments ----
// One PDF or Word file per message, up to 10 MB, checked by extension, MIME
// type AND file signature. Stored privately (Supabase Storage when it is
// configured, otherwise server/data/messages/) and served only to the two
// people in the conversation — never from a public folder.
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const attachmentStore = createResearchStorage({ uploadDir: join(process.cwd(), 'server', 'data') });
const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 }
}).single('attachment');

// multer errors (too large, unexpected field) as 400 JSON, not a 500.
function handleAttachmentUpload(req, res, next) {
  attachmentUpload(req, res, (err) => {
    if (!err) return next();
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    return res.status(400).json({
      error: tooBig ? 'The attachment is larger than 10 MB.' : 'Attach a single PDF or Word file.'
    });
  });
}

// ---- Related research ----
// A message can point at one submission the SENDER may open. These are the
// same read rules the two submission routers enforce (research-submissions.js
// canReadSubmission, submissions.js canAccess); the recipient still needs
// their own access to open it.
const MODULE_MONITOR_ROLES = new Set(['admin', 'cpri_staff', 'adviser', 'facilitator']);
const CLASSIC_VIEW_ALL_ROLES = new Set(['admin', 'cpri_staff', 'ethics_reviewer', 'adviser', 'facilitator']);

async function relatedSubmissionFor(user, submissionId) {
  const refs = [user.id, user.email, user.username].filter(Boolean).map(v => String(v).toLowerCase());
  const moduleRow = await get('SELECT id, title, owner_id, stage, status FROM research_submissions WHERE id = ?', [submissionId]).catch(() => null);
  if (moduleRow) {
    const own = refs.includes(String(moduleRow.owner_id || '').toLowerCase());
    const allowed = own || MODULE_MONITOR_ROLES.has(user.role) ||
      (user.role === 'ethics_reviewer' && moduleRow.stage === 'initial' && moduleRow.status !== 'draft');
    return allowed ? { id: moduleRow.id, title: moduleRow.title || 'Untitled submission', source: 'module' } : null;
  }
  const classicRow = await get('SELECT id, title, submitterId FROM submissions WHERE id = ?', [submissionId]).catch(() => null);
  if (classicRow && (classicRow.submitterId === user.id || CLASSIC_VIEW_ALL_ROLES.has(user.role))) {
    return { id: classicRow.id, title: classicRow.title || 'Untitled submission', source: 'classic' };
  }
  return null;
}

function relatedOf(m) {
  if (!m.relatedSubmissionId) return null;
  return {
    id: m.relatedSubmissionId,
    title: m.relatedSubmissionTitle || 'Research submission',
    source: m.relatedSource || 'module',
    url: m.relatedSource === 'classic'
      ? `/submission.html?id=${encodeURIComponent(m.relatedSubmissionId)}`
      : `/research-submission-detail.html?id=${encodeURIComponent(m.relatedSubmissionId)}`
  };
}

function attachmentOf(m) {
  if (!m.attachmentName || !m.attachmentPath) return null;
  return {
    name: m.attachmentName,
    size: Number(m.attachmentSize) || 0,
    url: `/api/messages/attachment/${encodeURIComponent(m.id)}`
  };
}

// The inbox preview for a message that is only a file.
const previewOf = (m) => m.body || (m.attachmentName ? `Attachment: ${m.attachmentName}` : '');

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
    await schemaReady();
    const users = await all(
      // Built from DM_ROLES rather than a second literal copy of it: the gate
      // above and the contact list used to disagree, which is how a role could
      // be allowed in and then shown no one to message.
      `SELECT id, username, fullName, role, department, program, profilePhoto
       FROM users
       WHERE status = 'active' AND id <> ?
         AND role IN (${DM_ROLES.map(() => '?').join(',')})
       ORDER BY fullName, username`,
      [req.session.userId, ...DM_ROLES]
    );
    res.json({ contacts: users.map(u => ({
      id: u.id,
      username: u.username,
      fullName: u.fullName || u.username,
      role: u.role,
      roleLabel: ROLE_LABELS[u.role] || u.role,
      department: u.department || '',
      program: u.program || ''
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
    await schemaReady();
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
          lastMessage: previewOf(r),
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
    await schemaReady();
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
        mine: m.senderId === me,
        related: relatedOf(m),
        attachment: attachmentOf(m)
      }))
    });
  } catch (err) {
    console.error('[messages] thread error:', err);
    res.status(500).json({ error: 'Failed to load thread.' });
  }
});

// POST /api/messages — send a direct message.
// JSON { recipientId, body, relatedSubmissionId? } or multipart with the same
// fields plus one `attachment` (PDF/Word, max 10 MB). A message needs text, a
// file, or both.
router.post('/', requireDMRole, handleAttachmentUpload, async (req, res) => {
  let storedPath = null;
  let storedBackend = null;
  try {
    await schemaReady();
    const me = req.session.userId;
    const recipientId = String(req.body?.recipientId || '').trim();
    const body = String(req.body?.body || '').trim();
    const relatedId = String(req.body?.relatedSubmissionId || '').trim();
    const file = req.file || null;
    if (!recipientId) return res.status(400).json({ error: 'Choose who to send the message to.' });
    if (!body && !file) return res.status(400).json({ error: 'Write a message or attach a file.' });
    if (body.length > 2000) return res.status(400).json({ error: 'Message is too long (max 2000 characters).' });
    if (recipientId === me) return res.status(400).json({ error: 'You cannot send a message to yourself.' });
    if (file && !validateSubmissionUploadFile(file)) {
      return res.status(400).json({ error: 'Only PDF or Word (.doc, .docx) files can be attached.' });
    }

    const recipient = await get('SELECT id, role, status, fullName, username FROM users WHERE id = ?', [recipientId]);
    if (!recipient || !DM_ROLES.includes(recipient.role) || recipient.status !== 'active') {
      return res.status(403).json({ error: 'That user is not available for direct messaging.' });
    }
    const sender = await get('SELECT id, role, email, fullName, username FROM users WHERE id = ?', [me]);

    let related = null;
    if (relatedId) {
      related = await relatedSubmissionFor(sender, relatedId);
      if (!related) return res.status(400).json({ error: 'You can only link research you can open.' });
    }

    const id = randomUUID();
    const message = {
      id,
      senderId: me,
      recipientId,
      body,
      readAt: null,
      createdAt: new Date()
    };
    // The newer columns are only written when used, so a plain text message
    // still works on a database that has not been migrated yet.
    if (related) {
      message.relatedSubmissionId = related.id;
      message.relatedSubmissionTitle = String(related.title).slice(0, 255);
      message.relatedSource = related.source;
    }
    if (file) {
      storedPath = `messages/${id}/${randomUUID()}${extname(file.originalname).toLowerCase()}`;
      storedBackend = await attachmentStore.save({ path: storedPath, buffer: file.buffer, contentType: file.mimetype });
      message.attachmentPath = storedPath;
      message.attachmentName = String(file.originalname || 'attachment').slice(0, 255);
      message.attachmentMime = file.mimetype;
      message.attachmentSize = file.size;
      message.attachmentBackend = storedBackend;
    }
    await insert('direct_messages', message);

    // Audit trail (no message content — just who messaged whom).
    await addLog('message_send', `Sent a direct message to ${recipient.fullName || recipient.username}${file ? ' with an attachment' : ''}`, req).catch(() => {});

    // In-app bell notification so the recipient sees it immediately.
    await notify(
      recipientId,
      'direct_message',
      `New message from ${sender.fullName || sender.username}`,
      body ? body.slice(0, 140) : `Sent you a file: ${message.attachmentName}`,
      'messages.html'
    );

    res.status(201).json({
      message: 'Message sent.',
      dm: {
        id, senderId: me, recipientId, body, readAt: null, createdAt: message.createdAt, mine: true,
        related: relatedOf(message),
        attachment: attachmentOf(message)
      }
    });
  } catch (err) {
    if (storedPath) await attachmentStore.remove({ path: storedPath, backend: storedBackend }).catch(() => {});
    console.error('[messages] send error:', err);
    res.status(500).json({ error: 'Failed to send message.' });
  }
});

// GET /api/messages/attachment/:messageId — the file, to the sender or the
// recipient only.
router.get('/attachment/:messageId', requireDMRole, async (req, res) => {
  try {
    await schemaReady();
    const me = req.session.userId;
    const m = await get('SELECT * FROM direct_messages WHERE id = ?', [req.params.messageId]);
    if (!m || !m.attachmentPath) return res.status(404).json({ error: 'Attachment not found.' });
    if (m.senderId !== me && m.recipientId !== me) return res.status(403).json({ error: 'Access denied.' });

    const stream = await attachmentStore.open({ path: m.attachmentPath, backend: m.attachmentBackend });
    if (!stream) return res.status(404).json({ error: 'The attachment is no longer available.' });
    res.setHeader('Content-Type', m.attachmentMime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURI(m.attachmentName || 'attachment')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    stream.pipe(res);
    stream.on('error', (err) => {
      if (!res.headersSent) res.status(500).json({ error: 'Could not stream the attachment.' });
      console.error('[messages] attachment stream error:', err.message);
    });
  } catch (err) {
    console.error('[messages] attachment error:', err);
    res.status(500).json({ error: 'Failed to open the attachment.' });
  }
});

// POST /api/messages/read — mark all messages from :userId as read.
router.post('/read', requireDMRole, async (req, res) => {
  try {
    await schemaReady();
    const otherId = String(req.body?.userId || '').trim();
    if (!otherId) return res.status(400).json({ error: 'userId is required.' });
    await run('UPDATE direct_messages SET readAt = ? WHERE senderId = ? AND recipientId = ? AND readAt IS NULL', [new Date(), otherId, req.session.userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[messages] mark read error:', err);
    res.status(500).json({ error: 'Failed to mark messages as read.' });
  }
});

export { router as messagesRouter, ensureMessagesTable, DM_ROLES };
