// ============================================================
//  CPRI — Contact-number (SMS) verification
//
//  POST /api/profile/phone/send-code    { phone }         → texts a 6-digit code
//  POST /api/profile/phone/verify-code  { phone, code }   → marks the number verified
//
//  Design notes:
//   • Only a bcrypt hash of the code is stored — never the plain code, and the
//     code is never written to any log.
//   • Codes live 5 minutes, allow 5 attempts, then must be re-requested.
//   • Sends are capped at 1/60s and 5/hour per user and per IP. The counter
//     ledger is the audit trail (system_logs, action 'phone_code_sent'), so the
//     limits survive the code row being deleted on success.
//   • One verified number belongs to one account; that is checked at verify
//     time only, with a generic error, so the endpoint can never be used to
//     discover which numbers are registered.
// ============================================================
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { randomInt, randomUUID } from 'crypto';
import { requireAuth } from './auth.js';
import { all, get, run, insert, update } from './server/db/queries.js';
import { addLog } from './audit.js';
import { sendSms } from './lib/sms.js';
import { normalizePhone, maskPhone } from './lib/phone.js';

const SALT_ROUNDS = 10;

export const CODE_TTL_MS = 5 * 60 * 1000;          // 5 minutes
export const RESEND_COOLDOWN_MS = 60 * 1000;       // 60 seconds between sends
export const SEND_WINDOW_MS = 60 * 60 * 1000;      // 1 hour
export const MAX_SENDS_PER_WINDOW = 5;             // per user AND per IP
export const MAX_ATTEMPTS = 5;
export const CODE_LENGTH = 6;

// system_logs action used as the send ledger (also the audit trail).
export const SEND_LOG_ACTION = 'phone_code_sent';

export const INVALID_NUMBER_MESSAGE =
  'Enter a valid Philippine mobile number, e.g. 09171234567.';
export const GENERIC_PHONE_ERROR =
  'That phone number cannot be verified for this account.';

function generateCode() {
  // Cryptographically secure: randomInt uses the CSPRNG.
  return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
}

function toMillis(value) {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isNaN(num) ? null : num;
}

// The 60s/hourly counters live in system_logs so they outlive the code row.
//
// All age math happens in SQL, on the database clock: rows are written as UTC
// wall-clock strings (see server/db/queries.js toDbValue), so mixing them with
// a JS Date read back through mysql2 would drift by the host's UTC offset. The
// query therefore answers with "seconds ago" numbers instead of timestamps.
function createAuditLedger(queries) {
  return {
    async stats({ userId, ip, since }) {
      const row = await queries.get(
        `SELECT
           COALESCE(SUM(CASE WHEN userId = ? THEN 1 ELSE 0 END), 0) AS userCount,
           COALESCE(SUM(CASE WHEN ip = ? THEN 1 ELSE 0 END), 0) AS ipCount,
           TIMESTAMPDIFF(SECOND, MAX(CASE WHEN userId = ? THEN timestamp END), UTC_TIMESTAMP()) AS lastUserSecondsAgo,
           TIMESTAMPDIFF(SECOND, MIN(CASE WHEN userId = ? THEN timestamp END), UTC_TIMESTAMP()) AS oldestUserSecondsAgo,
           TIMESTAMPDIFF(SECOND, MIN(CASE WHEN ip = ? THEN timestamp END), UTC_TIMESTAMP()) AS oldestIpSecondsAgo
         FROM system_logs
         WHERE action = ? AND timestamp >= ?`,
        [userId, ip, userId, userId, ip, SEND_LOG_ACTION, new Date(since).toISOString()]
      ).catch(() => null) || {};
      return {
        userCount: toNumber(row.userCount) || 0,
        ipCount: toNumber(row.ipCount) || 0,
        lastUserSecondsAgo: toNumber(row.lastUserSecondsAgo),
        oldestUserSecondsAgo: toNumber(row.oldestUserSecondsAgo),
        oldestIpSecondsAgo: toNumber(row.oldestIpSecondsAgo)
      };
    },
    async record({ userId, ip, phone, at, req }) {
      await queries.run(
        'INSERT INTO system_logs (id, action, details, userId, ip, userAgent, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          randomUUID(),
          SEND_LOG_ACTION,
          `Verification code sent to ${maskPhone(phone)}`,
          userId,
          ip,
          req?.get?.('user-agent') || null,
          new Date(at).toISOString()
        ]
      );
    }
  };
}

export function createPhoneVerificationRouter(dependencies = {}) {
  const router = Router();

  const queries = {
    all: dependencies.all || all,
    get: dependencies.get || get,
    run: dependencies.run || run,
    insert: dependencies.insert || insert,
    update: dependencies.update || update
  };
  const auth = dependencies.requireAuth || requireAuth;
  const now = dependencies.now || (() => Date.now());
  const smsSend = dependencies.sendSms || sendSms;
  const log = dependencies.log || addLog;
  const hashCode = dependencies.hashCode || ((code) => bcrypt.hash(code, SALT_ROUNDS));
  const compareCode = dependencies.compareCode || ((code, hash) => bcrypt.compare(code, hash));
  const nextCode = dependencies.generateCode || generateCode;
  const ledger = dependencies.ledger || createAuditLedger(queries);
  const codeTtlMs = dependencies.codeTtlMs || CODE_TTL_MS;
  const cooldownMs = dependencies.cooldownMs ?? RESEND_COOLDOWN_MS;
  const maxSends = dependencies.maxSends ?? MAX_SENDS_PER_WINDOW;
  const maxAttempts = dependencies.maxAttempts ?? MAX_ATTEMPTS;
  const cooldownSeconds = Math.max(0, Math.round(cooldownMs / 1000));
  const windowSeconds = Math.max(1, Math.round(SEND_WINDOW_MS / 1000));

  // What (if anything) currently blocks a send? Shared by the send route and
  // the 429 answers of the verify route.
  function activeSendBlock(stats = {}) {
    const lastAgo = stats.lastUserSecondsAgo ?? null;
    if (cooldownSeconds > 0 && lastAgo !== null && lastAgo < cooldownSeconds) {
      const retryAfter = Math.min(cooldownSeconds, Math.max(1, cooldownSeconds - lastAgo));
      return {
        error: `Please wait ${retryAfter} second${retryAfter === 1 ? '' : 's'} before requesting another code.`,
        retryAfter
      };
    }
    if (stats.userCount >= maxSends || stats.ipCount >= maxSends) {
      const oldestAgo = stats.userCount >= maxSends ? stats.oldestUserSecondsAgo : stats.oldestIpSecondsAgo;
      const retryAfter = oldestAgo === null || oldestAgo === undefined
        ? windowSeconds
        : Math.min(windowSeconds, Math.max(1, windowSeconds - oldestAgo));
      return { error: 'Too many verification codes requested. Please try again later.', retryAfter };
    }
    return null;
  }

  // ---------- POST /send-code ----------
  router.post('/send-code', auth, async (req, res) => {
    const userId = req.session.userId;
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: INVALID_NUMBER_MESSAGE });

    const at = now();
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const stats = await ledger.stats({ userId, ip, since: at - SEND_WINDOW_MS });

    const block = activeSendBlock(stats);
    if (block) {
      return res.status(429).json({ error: block.error, retryAfter: block.retryAfter, resendIn: block.retryAfter });
    }

    const code = nextCode();
    const codeHash = await hashCode(code);
    // Only the newest code is ever valid: replacing the previous one also means
    // a resend cannot be answered with an older code.
    await queries.run('DELETE FROM phone_verification_codes WHERE userId = ?', [userId]);

    await queries.insert('phone_verification_codes', {
      id: randomUUID(),
      userId,
      phone,
      codeHash,
      attempts: 0,
      ip,
      expiresAt: new Date(at + codeTtlMs).toISOString(),
      createdAt: new Date(at).toISOString()
    });

    const message = `Your CPRI verification code is ${code}. It expires in ${Math.round(codeTtlMs / 60000)} minutes. Don't share it with anyone.`;
    try {
      await smsSend(phone, message);
    } catch (err) {
      // Nothing was delivered — drop the code so no request can match it.
      await queries
        .run('DELETE FROM phone_verification_codes WHERE userId = ? AND phone = ?', [userId, phone])
        .catch(() => {});
      console.error('[phone] SMS delivery failed:', err.message);
      return res.status(502).json({ error: 'We could not send the SMS right now. Please try again in a moment.' });
    }

    await ledger.record({ userId, ip, phone, at, req });
    await log('phone_code_sent', `Phone verification code sent to ${maskPhone(phone)}`, req);

    res.json({
      success: true,
      expiresIn: Math.round(codeTtlMs / 1000),
      resendIn: Math.round(cooldownMs / 1000),
      phone,
      masked: maskPhone(phone)
    });
  });

  // ---------- POST /verify-code ----------
  router.post('/verify-code', auth, async (req, res) => {
    const userId = req.session.userId;
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: INVALID_NUMBER_MESSAGE });

    const code = String(req.body?.code ?? '').trim();
    if (!new RegExp(`^\\d{${CODE_LENGTH}}$`).test(code)) {
      return res.status(400).json({
        error: `Enter the ${CODE_LENGTH}-digit code we sent you.`,
        codeLength: CODE_LENGTH
      });
    }

    const user = await queries.get('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(401).json({ error: 'Not authenticated.' });

    const entry = await queries.get(
      'SELECT * FROM phone_verification_codes WHERE userId = ? AND phone = ? ORDER BY createdAt DESC LIMIT 1',
      [userId, phone]
    );
    if (!entry) {
      return res.status(400).json({ error: 'No verification code was sent to this number. Request a new code.' });
    }

    const at = now();
    const attempts = Number(entry.attempts) || 0;

    if (toMillis(entry.expiresAt) !== null && toMillis(entry.expiresAt) < at) {
      await dropCode(entry.id);
      return res.status(400).json({ error: 'That code has expired. Please request a new code.' });
    }
    if (attempts >= maxAttempts) {
      await dropCode(entry.id);
      return res.status(429).json({
        error: 'Too many incorrect attempts. Please request a new code.',
        attemptsLeft: 0,
        retryAfter: await retryAfterFor(userId, req)
      });
    }

    const matches = await compareCode(code, entry.codeHash);
    if (!matches) {
      const used = attempts + 1;
      if (used >= maxAttempts) {
        await dropCode(entry.id);
        return res.status(429).json({
          error: 'Too many incorrect attempts. Please request a new code.',
          attemptsLeft: 0,
          retryAfter: await retryAfterFor(userId, req)
        });
      }
      await queries.update('phone_verification_codes', entry.id, { attempts: used });
      return res.status(400).json({
        error: 'Incorrect code',
        attemptsLeft: maxAttempts - used
      });
    }

    // One number belongs to one account. Checked here (never at send time) and
    // answered generically, so a caller cannot probe which numbers are taken.
    const owner = await numberOwner(userId, phone);
    if (owner) {
      await dropCode(entry.id);
      return res.status(400).json({ error: GENERIC_PHONE_ERROR });
    }

    const verifiedAt = new Date(at).toISOString();
    await queries.update('users', userId, {
      contactNumber: phone,
      phone_verified: 1,
      phone_verified_at: verifiedAt
    });
    await dropCode(entry.id);
    await log('phone_verified', `Phone number verified: ${maskPhone(phone)}`, req);

    res.json({
      success: true,
      message: 'Phone number verified.',
      phone,
      masked: maskPhone(phone),
      phoneVerified: true,
      phoneVerifiedAt: verifiedAt
    });
  });

  async function dropCode(id) {
    await queries.run('DELETE FROM phone_verification_codes WHERE id = ?', [id]);
  }

  // Seconds left before a new code may be requested (used by the 429 paths).
  async function retryAfterFor(userId, req) {
    const at = now();
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const stats = await ledger.stats({ userId, ip, since: at - SEND_WINDOW_MS });
    return activeSendBlock(stats)?.retryAfter || 0;
  }

  // Another account already verified this number?
  //
  // Only *verified* numbers reserve a phone: an unverified free-text entry in
  // someone else's profile must not be able to lock a number away from its
  // owner. Numbers are stored in several shapes (legacy free text, spaces), so
  // the match is done on the normalized form.
  async function numberOwner(userId, phone) {
    const rows = await queries
      .all(
        `SELECT id, contactNumber FROM users
          WHERE id <> ? AND phone_verified = 1
            AND contactNumber IS NOT NULL AND TRIM(contactNumber) <> ''`,
        [userId]
      )
      .catch(() => []);
    return rows.find((row) => normalizePhone(row.contactNumber) === phone) || null;
  }

  return router;
}

// ---------- Schema (additive, safe on existing databases) ----------
export async function ensurePhoneSchema(dependencies = {}) {
  const queries = {
    all: dependencies.all || all,
    run: dependencies.run || run
  };
  const columns = await queries.all('SHOW COLUMNS FROM users');
  const existing = new Set(columns.map((column) => String(column.Field || column.field || '').toLowerCase()));
  if (!existing.has('phone_verified')) {
    await queries.run('ALTER TABLE users ADD COLUMN phone_verified TINYINT(1) NOT NULL DEFAULT 0');
  }
  if (!existing.has('phone_verified_at')) {
    await queries.run('ALTER TABLE users ADD COLUMN phone_verified_at DATETIME NULL');
  }
  await queries.run(`CREATE TABLE IF NOT EXISTS phone_verification_codes (
    id VARCHAR(36) PRIMARY KEY,
    userId VARCHAR(36) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    codeHash VARCHAR(120) NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    ip VARCHAR(64) DEFAULT NULL,
    expiresAt DATETIME NOT NULL,
    createdAt DATETIME NOT NULL,
    KEY idx_phone_codes_user (userId, createdAt),
    KEY idx_phone_codes_ip (ip, createdAt)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

export const phoneVerificationRouter = createPhoneVerificationRouter();
