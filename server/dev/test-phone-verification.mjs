// Tests for Contact Number (SMS) verification:
//   POST /api/profile/phone/send-code    (server/phone-verification.js)
//   POST /api/profile/phone/verify-code
//   the shared PH number rules (server/lib/phone.js)
//   the SMS wrapper + DEV mode (server/lib/sms.js)
//   the browser helpers behind the code boxes (public/assets/js/phone-field.js)
//
// Run: npm run test:phone
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import bcrypt from 'bcryptjs';
import { createPhoneVerificationRouter } from '../phone-verification.js';
import { normalizePhone, maskPhone, phoneNationalDigits } from '../lib/phone.js';
import { sendSms, smsProviderInfo } from '../lib/sms.js';
import {
  normalizePhone as clientNormalizePhone,
  phoneNationalDigits as clientNationalDigits,
  maskPhone as clientMaskPhone,
  splitCode,
  formatClock,
  describeRetry
} from '../../public/assets/js/phone-field.js';

const FIXED_CODE = '246813';

// ---------------------------------------------------------------
// Harness: an in-memory stand-in for the router's DB + SMS + clock.
// Only the statements the route actually issues are implemented.
// ---------------------------------------------------------------
async function startApi({ users = [], realHash = false, smsFails = false, sms } = {}) {
  const clock = { now: Date.parse('2026-10-08T09:00:00.000Z') };
  const userRows = new Map(users.map((user) => [user.id, { ...user }]));
  const codeRows = [];
  const sentMessages = [];
  const logs = [];
  let seq = 0;

  const matchingCodes = (userId, phone) => codeRows
    .filter((row) => row.userId === userId && (phone === undefined || row.phone === phone))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  const queries = {
    all: async (sql, params = []) => {
      if (/SHOW COLUMNS FROM users/i.test(sql)) {
        return [{ Field: 'id' }, { Field: 'contactNumber' }];
      }
      if (/FROM users[\s\S]*WHERE id <> \?/i.test(sql)) {
        // Mirrors the route's filter: only verified numbers reserve a phone.
        const verifiedOnly = /phone_verified = 1/i.test(sql);
        return [...userRows.values()].filter((user) =>
          user.id !== params[0] && (!verifiedOnly || Number(user.phone_verified) === 1)
        );
      }
      if (/FROM phone_verification_codes/i.test(sql)) return matchingCodes(params[0], params[1]);
      throw new Error(`Unhandled all(): ${sql}`);
    },
    get: async (sql, params = []) => {
      if (/FROM users WHERE id = \?/i.test(sql)) return userRows.get(params[0]) || null;
      if (/FROM phone_verification_codes/i.test(sql)) return matchingCodes(params[0], params[1])[0] || null;
      throw new Error(`Unhandled get(): ${sql}`);
    },
    run: async (sql, params = []) => {
      if (/^DELETE FROM phone_verification_codes WHERE userId = \? AND phone = \?$/i.test(sql)) {
        for (let i = codeRows.length - 1; i >= 0; i -= 1) {
          if (codeRows[i].userId === params[0] && codeRows[i].phone === params[1]) codeRows.splice(i, 1);
        }
        return { affectedRows: 1 };
      }
      if (/^DELETE FROM phone_verification_codes WHERE userId = \?$/i.test(sql)) {
        for (let i = codeRows.length - 1; i >= 0; i -= 1) {
          if (codeRows[i].userId === params[0]) codeRows.splice(i, 1);
        }
        return { affectedRows: 1 };
      }
      if (/^DELETE FROM phone_verification_codes WHERE id = \?$/i.test(sql)) {
        const index = codeRows.findIndex((row) => row.id === params[0]);
        if (index >= 0) codeRows.splice(index, 1);
        return { affectedRows: 1 };
      }
      throw new Error(`Unhandled run(): ${sql}`);
    },
    insert: async (table, obj) => {
      assert.equal(table, 'phone_verification_codes');
      codeRows.push({ ...obj });
      return 1;
    },
    update: async (table, id, obj) => {
      const row = table === 'users' ? userRows.get(id) : codeRows.find((entry) => entry.id === id);
      if (!row) return { affectedRows: 0 };
      Object.assign(row, obj);
      return { affectedRows: 1 };
    }
  };

  // The production ledger is system_logs; here it is a simple list the test can
  // inspect, driven by the same clock.
  const ledger = {
    async stats({ userId, ip, since }) {
      const rows = logs.filter((row) => row.timestamp >= since && (row.userId === userId || row.ip === ip));
      const userSends = rows.filter((row) => row.userId === userId).map((row) => row.timestamp).sort((a, b) => a - b);
      const ipSends = rows.filter((row) => row.ip === ip).map((row) => row.timestamp).sort((a, b) => a - b);
      // The production ledger answers with ages in seconds (computed in SQL on
      // the database clock), never with timestamps.
      const ago = (value) => (value === undefined ? null : Math.round((clock.now - value) / 1000));
      return {
        userCount: userSends.length,
        ipCount: ipSends.length,
        lastUserSecondsAgo: userSends.length ? ago(userSends[userSends.length - 1]) : null,
        oldestUserSecondsAgo: userSends.length ? ago(userSends[0]) : null,
        oldestIpSecondsAgo: ipSends.length ? ago(ipSends[0]) : null
      };
    },
    async record({ userId, ip, at }) {
      logs.push({ userId, ip, timestamp: at });
    }
  };

  const router = createPhoneVerificationRouter({
    requireAuth: (req, res, next) => {
      if (!req.get('x-user')) return res.status(401).json({ error: 'Not authenticated.' });
      req.session = { userId: req.get('x-user') };
      next();
    },
    all: queries.all,
    get: queries.get,
    run: queries.run,
    insert: queries.insert,
    update: queries.update,
    now: () => clock.now,
    generateCode: () => FIXED_CODE,
    ledger,
    log: async (action) => { logs.push({ action }); },
    sendSms: sms || (async (phone, message) => {
      if (smsFails) throw new Error('gateway down');
      sentMessages.push({ phone, message });
      return { provider: 'console', dev: true };
    }),
    ...(realHash ? {} : {
      hashCode: async (code) => `stub-hash:${code}`,
      compareCode: async (code, hash) => hash === `stub-hash:${code}`
    })
  });

  const app = express();
  app.use(express.json());
  app.use('/api/profile/phone', router);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  // A failed assertion skips close(); unref keeps a stray listener from holding
  // the test process open forever.
  server.unref();

  return {
    url: `http://127.0.0.1:${server.address().port}/api/profile/phone`,
    clock,
    codeRows,
    sentMessages,
    logs,
    user: (id) => userRows.get(id),
    advance(ms) { clock.now += ms; },
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
}

async function post(url, body, { user } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(user ? { 'x-user': user } : {}) },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

const student = { id: 'user-1', username: 'student', contactNumber: '', phone_verified: 0, phone_verified_at: null };

// ---------------------------------------------------------------
// Send code
// ---------------------------------------------------------------
test('send-code normalizes PH numbers, texts the code and stores only a hash', async () => {
  const api = await startApi({ users: [student] });
  const result = await post(`${api.url}/send-code`, { phone: '0917 123 4567' }, { user: 'user-1' });

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.expiresIn, 300);
  assert.equal(result.body.resendIn, 60);
  assert.equal(result.body.phone, '+639171234567');

  assert.equal(api.codeRows.length, 1);
  const stored = api.codeRows[0];
  assert.equal(stored.phone, '+639171234567');
  assert.equal(stored.userId, 'user-1');
  assert.equal(stored.attempts, 0);
  assert.notEqual(stored.codeHash, FIXED_CODE, 'the plain code is never stored');
  assert.equal(Date.parse(stored.expiresAt) - Date.parse(stored.createdAt), 5 * 60 * 1000);

  assert.equal(api.sentMessages.length, 1);
  assert.equal(api.sentMessages[0].phone, '+639171234567');
  assert.match(api.sentMessages[0].message, /Your CPRI verification code is 246813\. It expires in 5 minutes\. Don't share it with anyone\./);

  await api.close();
});

test('send-code accepts 9XXXXXXXXX and +639XXXXXXXXX too', async () => {
  for (const input of ['9171234567', '+639171234567', '639171234567', '0917-123-4567', '(0917) 123 4567']) {
    assert.equal(normalizePhone(input), '+639171234567', input);
  }
  const api = await startApi({ users: [student] });
  for (const input of ['9171234567', '+639171234567']) {
    const result = await post(`${api.url}/send-code`, { phone: input }, { user: 'user-1' });
    assert.equal(result.status, 200, input);
    api.advance(61 * 1000);
  }
  await api.close();
});

test('send-code rejects numbers that are not PH mobiles', async () => {
  const api = await startApi({ users: [student] });
  const cases = ['', '12345', '08171234567', '+1 555 010 9999', '091712345', 'telephone', '091712345678'];
  for (const phone of cases) {
    const result = await post(`${api.url}/send-code`, { phone }, { user: 'user-1' });
    assert.equal(result.status, 400, `expected 400 for ${JSON.stringify(phone)}`);
    assert.match(result.body.error, /valid Philippine mobile number/i);
  }
  assert.equal(api.codeRows.length, 0);
  assert.equal(api.sentMessages.length, 0);
  await api.close();
});

test('send-code requires login', async () => {
  const api = await startApi({ users: [student] });
  const send = await post(`${api.url}/send-code`, { phone: '09171234567' });
  assert.equal(send.status, 401);
  const verify = await post(`${api.url}/verify-code`, { phone: '09171234567', code: '123456' });
  assert.equal(verify.status, 401);
  assert.equal(api.codeRows.length, 0);
  await api.close();
});

test('send-code enforces the 60s cooldown with retryAfter', async () => {
  const api = await startApi({ users: [student] });
  const first = await post(`${api.url}/send-code`, { phone: '09171234567' }, { user: 'user-1' });
  assert.equal(first.status, 200);

  const tooSoon = await post(`${api.url}/send-code`, { phone: '09171234567' }, { user: 'user-1' });
  assert.equal(tooSoon.status, 429);
  assert.ok(tooSoon.body.retryAfter > 0 && tooSoon.body.retryAfter <= 60, `retryAfter=${tooSoon.body.retryAfter}`);
  assert.equal(tooSoon.body.resendIn, tooSoon.body.retryAfter);
  assert.equal(api.codeRows.length, 1, 'a blocked resend must not create a second code');

  api.advance(59 * 1000);
  const stillCooling = await post(`${api.url}/send-code`, { phone: '09171234567' }, { user: 'user-1' });
  assert.equal(stillCooling.status, 429);

  api.advance(2 * 1000);
  const allowed = await post(`${api.url}/send-code`, { phone: '09171234567' }, { user: 'user-1' });
  assert.equal(allowed.status, 200);
  assert.equal(api.codeRows.length, 1, 'the new code replaces the previous one');
  await api.close();
});

test('send-code caps sends per user and per IP at 5 per hour', async () => {
  const api = await startApi({ users: [student] });
  for (let i = 0; i < 5; i += 1) {
    const result = await post(`${api.url}/send-code`, { phone: '09171234567' }, { user: 'user-1' });
    assert.equal(result.status, 200, `send ${i + 1}`);
    api.advance(61 * 1000);
  }
  const sixth = await post(`${api.url}/send-code`, { phone: '09171234567' }, { user: 'user-1' });
  assert.equal(sixth.status, 429);
  assert.match(sixth.body.error, /Too many verification codes/i);
  assert.ok(sixth.body.retryAfter > 0);

  // An hour after the first send the window has moved on.
  api.advance(60 * 60 * 1000);
  const later = await post(`${api.url}/send-code`, { phone: '09171234567' }, { user: 'user-1' });
  assert.equal(later.status, 200);
  await api.close();
});

test('send-code caps sends per IP across accounts', async () => {
  const users = Array.from({ length: 6 }, (_, i) => ({
    id: `user-${i}`, username: `student${i}`, contactNumber: '', phone_verified: 0
  }));
  const api = await startApi({ users });
  for (let i = 0; i < 5; i += 1) {
    const result = await post(`${api.url}/send-code`, { phone: '09171234567' }, { user: `user-${i}` });
    assert.equal(result.status, 200, `send ${i + 1}`);
  }
  // Same IP, brand-new account — the IP cap still applies.
  const sixth = await post(`${api.url}/send-code`, { phone: '09171234567' }, { user: 'user-5' });
  assert.equal(sixth.status, 429);
  await api.close();
});

test('send-code reports an SMS gateway failure and keeps no code behind', async () => {
  const api = await startApi({ users: [student], smsFails: true });
  const result = await post(`${api.url}/send-code`, { phone: '09171234567' }, { user: 'user-1' });
  assert.equal(result.status, 502);
  assert.equal(api.codeRows.length, 0);
  await api.close();
});

// ---------------------------------------------------------------
// Verify code
// ---------------------------------------------------------------
test('verify-code saves the number as verified and clears the code', async () => {
  const api = await startApi({ users: [student] });
  await post(`${api.url}/send-code`, { phone: '09171234567' }, { user: 'user-1' });

  const wrong = await post(`${api.url}/verify-code`, { phone: '09171234567', code: '111111' }, { user: 'user-1' });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error, 'Incorrect code');
  assert.equal(wrong.body.attemptsLeft, 4);

  const ok = await post(`${api.url}/verify-code`, { phone: '09171234567', code: FIXED_CODE }, { user: 'user-1' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.success, true);
  assert.equal(ok.body.phoneVerified, true);
  assert.equal(ok.body.phone, '+639171234567');

  const saved = api.user('user-1');
  assert.equal(saved.contactNumber, '+639171234567');
  assert.equal(Number(saved.phone_verified), 1);
  assert.ok(Number.isFinite(Date.parse(saved.phone_verified_at)));
  assert.equal(api.codeRows.length, 0, 'the code is deleted once it is used');
  await api.close();
});

test('verify-code accepts the 09 form for a code sent to the +63 form', async () => {
  const api = await startApi({ users: [student] });
  await post(`${api.url}/send-code`, { phone: '+639171234567' }, { user: 'user-1' });
  const ok = await post(`${api.url}/verify-code`, { phone: '09171234567', code: FIXED_CODE }, { user: 'user-1' });
  assert.equal(ok.status, 200);
  await api.close();
});

test('verify-code counts attempts and locks the code after 5 wrong tries', async () => {
  const api = await startApi({ users: [student] });
  await post(`${api.url}/send-code`, { phone: '09171234567' }, { user: 'user-1' });

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const bad = await post(`${api.url}/verify-code`, { phone: '09171234567', code: '000000' }, { user: 'user-1' });
    assert.equal(bad.status, 400, `attempt ${attempt}`);
    assert.equal(bad.body.attemptsLeft, 5 - attempt);
    assert.equal(api.codeRows[0].attempts, attempt);
  }

  const fifth = await post(`${api.url}/verify-code`, { phone: '09171234567', code: '000000' }, { user: 'user-1' });
  assert.equal(fifth.status, 429);
  assert.match(fifth.body.error, /Too many incorrect attempts/i);
  assert.equal(fifth.body.attemptsLeft, 0);
  assert.equal(api.codeRows.length, 0, 'the code is invalidated');

  // Even the right code no longer works — a new one must be requested.
  api.advance(61 * 1000);
  const afterLock = await post(`${api.url}/verify-code`, { phone: '09171234567', code: FIXED_CODE }, { user: 'user-1' });
  assert.equal(afterLock.status, 400);
  assert.match(afterLock.body.error, /No verification code was sent/i);
  await api.close();
});

test('verify-code rejects an expired code', async () => {
  const api = await startApi({ users: [student] });
  await post(`${api.url}/send-code`, { phone: '09171234567' }, { user: 'user-1' });
  api.advance(5 * 60 * 1000 + 1000);

  const late = await post(`${api.url}/verify-code`, { phone: '09171234567', code: FIXED_CODE }, { user: 'user-1' });
  assert.equal(late.status, 400);
  assert.match(late.body.error, /expired/i);
  assert.equal(api.codeRows.length, 0);
  assert.equal(Number(api.user('user-1').phone_verified), 0);
  await api.close();
});

test('verify-code rejects a code sent to a different number', async () => {
  const api = await startApi({ users: [student] });
  await post(`${api.url}/send-code`, { phone: '09171234567' }, { user: 'user-1' });
  const other = await post(`${api.url}/verify-code`, { phone: '09181234567', code: FIXED_CODE }, { user: 'user-1' });
  assert.equal(other.status, 400);
  assert.match(other.body.error, /No verification code was sent/i);
  await api.close();
});

test('verify-code validates the code shape', async () => {
  const api = await startApi({ users: [student] });
  await post(`${api.url}/send-code`, { phone: '09171234567' }, { user: 'user-1' });
  for (const code of ['', '12345', '1234567', 'abcdef']) {
    const result = await post(`${api.url}/verify-code`, { phone: '09171234567', code }, { user: 'user-1' });
    assert.equal(result.status, 400, `code ${JSON.stringify(code)}`);
    assert.match(result.body.error, /6-digit code/i);
  }
  assert.equal(api.codeRows[0].attempts, 0, 'a malformed code does not burn an attempt');
  await api.close();
});

test('verify-code refuses a number another account already verified, with a generic error', async () => {
  const api = await startApi({
    users: [
      student,
      { id: 'user-2', username: 'other', contactNumber: '0917 555 0199', phone_verified: 1 }
    ]
  });
  await post(`${api.url}/send-code`, { phone: '09175550199' }, { user: 'user-1' });
  const taken = await post(`${api.url}/verify-code`, { phone: '09175550199', code: FIXED_CODE }, { user: 'user-1' });
  assert.equal(taken.status, 400);
  assert.match(taken.body.error, /cannot be verified for this account/i);
  assert.doesNotMatch(taken.body.error, /already|another|taken by/i);
  assert.equal(Number(api.user('user-1').phone_verified), 0);
  await api.close();
});

test('an unverified number in another profile never blocks verification', async () => {
  const api = await startApi({
    users: [
      student,
      { id: 'user-3', username: 'squatter', contactNumber: '0917 555 0188', phone_verified: 0 }
    ]
  });
  await post(`${api.url}/send-code`, { phone: '09175550188' }, { user: 'user-1' });
  const ok = await post(`${api.url}/verify-code`, { phone: '+639175550188', code: FIXED_CODE }, { user: 'user-1' });
  assert.equal(ok.status, 200, 'an unverified free-text number reserves nothing');
  assert.equal(Number(api.user('user-1').phone_verified), 1);
  await api.close();
});

test('a clock-skewed ledger row cannot lock the account out beyond the cooldown', async () => {
  const api = await startApi({ users: [student] });
  // A row stamped in the future (host/database clock skew) must not turn into a
  // multi-hour lockout.
  api.logs.push({ userId: 'user-1', ip: 'skew', timestamp: api.clock.now + 3 * 60 * 60 * 1000 });
  const result = await post(`${api.url}/send-code`, { phone: '09171234567' }, { user: 'user-1' });
  assert.equal(result.status, 429);
  assert.equal(result.body.retryAfter, 60);
  await api.close();
});

test('verification codes are hashed with bcrypt and never stored in clear', async () => {
  // This case exercises the production hashing path (no hashing stubs injected).
  const api = await startApi({ users: [student], realHash: true });
  const send = await post(`${api.url}/send-code`, { phone: '09171234567' }, { user: 'user-1' });
  assert.equal(send.status, 200);

  const stored = api.codeRows[0];
  assert.notEqual(stored.codeHash, FIXED_CODE);
  assert.doesNotMatch(stored.codeHash, /246813/);
  assert.match(stored.codeHash, /^\$2[aby]\$/, 'bcrypt hash');

  const ok = await post(`${api.url}/verify-code`, { phone: '09171234567', code: FIXED_CODE }, { user: 'user-1' });
  assert.equal(ok.status, 200);
  await api.close();
});

// ---------------------------------------------------------------
// Shared number rules + browser helpers
// ---------------------------------------------------------------
test('phone helpers normalize, mask and format consistently', () => {
  assert.equal(normalizePhone('09171234567'), '+639171234567');
  assert.equal(maskPhone('+639171234567'), '+63 917 *** 4567');
  assert.equal(phoneNationalDigits('+639171234567'), '9171234567');
  assert.equal(clientNormalizePhone('09171234567'), normalizePhone('09171234567'));
  assert.equal(clientNationalDigits('09171234567'), '9171234567');
  assert.equal(clientMaskPhone('+639171234567'), maskPhone('+639171234567'));

  assert.deepEqual(splitCode(' 12 34 56 '), ['1', '2', '3', '4', '5', '6']);
  assert.deepEqual(splitCode('1234567890'), ['1', '2', '3', '4', '5', '6']);
  assert.deepEqual(splitCode(''), []);
  assert.equal(formatClock(42), '0:42');
  assert.equal(formatClock(252), '4:12');
  assert.equal(formatClock(-5), '0:00');
  assert.equal(describeRetry(42), '42 seconds');
  assert.equal(describeRetry(60), '1 minute');
  assert.equal(describeRetry(90), '2 minutes');
  assert.equal(describeRetry(3900), '1 hour 5 minutes');
});

// ---------------------------------------------------------------
// SMS wrapper
// ---------------------------------------------------------------
test('smsProviderInfo prefers the configured provider and falls back to DEV console mode', () => {
  assert.equal(smsProviderInfo({}).id, 'console');
  assert.equal(smsProviderInfo({}).dev, true);
  assert.equal(smsProviderInfo({ SMS_DEV_MODE: '1', SEMAPHORE_API_KEY: 'k' }).dev, true, 'DEV mode wins');
  assert.equal(smsProviderInfo({ SMS_PROVIDER: 'semaphore', SEMAPHORE_API_KEY: 'k' }).configured, true);
  assert.equal(smsProviderInfo({ SEMAPHORE_API_KEY: 'k' }).id, 'semaphore', 'auto-detected');
  assert.equal(smsProviderInfo({ TWILIO_ACCOUNT_SID: 'a', TWILIO_AUTH_TOKEN: 'b', TWILIO_FROM_NUMBER: '+1' }).id, 'twilio');
  const missing = smsProviderInfo({ SMS_PROVIDER: 'twilio' });
  assert.equal(missing.configured, false);
  assert.deepEqual(missing.missing, ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER']);
  assert.equal(smsProviderInfo({ SMS_PROVIDER: 'carrier-pigeon' }).configured, false);
});

test('sendSms prints the code in DEV mode and refuses an unconfigured provider', async () => {
  const printed = [];
  const originalLog = console.log;
  console.log = (...args) => printed.push(args.join(' '));
  try {
    const result = await sendSms('+639171234567', 'Your CPRI verification code is 123456.', {});
    assert.equal(result.provider, 'console');
    assert.equal(result.dev, true);
    assert.match(printed.join('\n'), /123456/);

    await assert.rejects(
      () => sendSms('+639171234567', 'hi', { SMS_PROVIDER: 'twilio' }),
      /not configured/i
    );
  } finally {
    console.log = originalLog;
  }
});

test('bcrypt round-trips a 6-digit code', async () => {
  const hash = await bcrypt.hash(FIXED_CODE, 4);
  assert.equal(await bcrypt.compare(FIXED_CODE, hash), true);
  assert.equal(await bcrypt.compare('000000', hash), false);
});
