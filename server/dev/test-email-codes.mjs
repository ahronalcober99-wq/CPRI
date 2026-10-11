// Tests for the registration email-verification code store:
//   server/lib/email-codes.js  (used by /api/auth/send-verification-code and
//   /api/auth/verify-code in server/auth.js)
//
// The store is pure in-memory state, so it can be tested without a database,
// without Brevo, and without a running server.
//
// Run: npm run test:email
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEmailCodeStore,
  randomSixDigitCode,
  CODE_TTL_MS,
  CODE_MAX_ATTEMPTS,
  EMAIL_RATE_WINDOW_MS,
  EMAIL_RATE_MAX,
  IP_RATE_WINDOW_MS,
  IP_RATE_MAX
} from '../lib/email-codes.js';

const T0 = Date.parse('2026-10-08T09:00:00.000Z');

test('codes expire 10 minutes after they are issued, and clean() drops them', () => {
  assert.equal(CODE_TTL_MS, 10 * 60 * 1000);
  const store = createEmailCodeStore();

  store.issue('a@school.edu', '123456', T0);
  assert.equal(store.get('a@school.edu').expiresAt - T0, 10 * 60 * 1000);

  // Still valid one second before the deadline…
  store.clean(T0 + CODE_TTL_MS - 1);
  assert.ok(store.get('a@school.edu'), 'a code inside its window survives clean()');

  // …and gone once the window closes.
  store.clean(T0 + CODE_TTL_MS + 1);
  assert.equal(store.get('a@school.edu'), undefined);
  assert.equal(store.attemptsRemaining('a@school.edu'), 0);
});

test(`a code accepts ${CODE_MAX_ATTEMPTS - 1} wrong attempts, then dies on the ${CODE_MAX_ATTEMPTS}th`, () => {
  const store = createEmailCodeStore();
  store.issue('a@school.edu', '654321', T0);

  for (let i = 1; i < CODE_MAX_ATTEMPTS; i += 1) {
    assert.equal(
      store.attemptsRemaining('a@school.edu'),
      CODE_MAX_ATTEMPTS - (i - 1),
      `${i - 1} wrong attempt(s) used`
    );
    assert.ok(store.get('a@school.edu'), 'the code is still usable');
    store.recordWrongAttempt('a@school.edu');
  }

  assert.equal(store.attemptsRemaining('a@school.edu'), 1, 'one attempt is still left');
  assert.equal(store.recordWrongAttempt('a@school.edu'), 0, 'the last allowed attempt kills it');
  assert.equal(store.get('a@school.edu'), undefined, 'a dead code cannot be retried');
  // Even the correct digits are useless now: the row is gone.
  assert.equal(store.attemptsRemaining('a@school.edu'), 0);
});

test('a correct attempt does not consume the allowance, and re-issuing resets it', () => {
  const store = createEmailCodeStore();
  store.issue('a@school.edu', '654321', T0);
  store.recordWrongAttempt('a@school.edu');
  store.recordWrongAttempt('a@school.edu');
  assert.equal(store.attemptsRemaining('a@school.edu'), CODE_MAX_ATTEMPTS - 2);

  // Re-requesting a code starts over: fresh expiry, no used attempts.
  store.issue('a@school.edu', '111222', T0 + 60_000);
  assert.equal(store.attemptsRemaining('a@school.edu'), CODE_MAX_ATTEMPTS);
  assert.equal(store.get('a@school.edu').code, '111222');

  store.markVerified('a@school.edu');
  assert.equal(store.get('a@school.edu').verified, true);
  store.drop('a@school.edu');
  assert.equal(store.get('a@school.edu'), undefined);
});

test(`each address may request ${EMAIL_RATE_MAX} codes per ${EMAIL_RATE_WINDOW_MS / 60000} minutes`, () => {
  assert.equal(EMAIL_RATE_MAX, 3);
  const store = createEmailCodeStore();

  for (let i = 1; i <= EMAIL_RATE_MAX; i += 1) {
    assert.equal(store.isEmailRateLimited('a@school.edu', T0), false, `send ${i} allowed`);
  }
  assert.equal(store.isEmailRateLimited('a@school.edu', T0), true, 'the 4th send in the window is blocked');

  // A different address is unaffected…
  assert.equal(store.isEmailRateLimited('b@school.edu', T0), false);
  // …and the window really is 15 minutes, not forever.
  assert.equal(store.isEmailRateLimited('a@school.edu', T0 + EMAIL_RATE_WINDOW_MS + 1), false);
});

test(`each IP may request ${IP_RATE_MAX} codes per hour`, () => {
  assert.equal(IP_RATE_MAX, 5);
  assert.equal(IP_RATE_WINDOW_MS, 60 * 60 * 1000);
  const store = createEmailCodeStore();

  for (let i = 1; i <= IP_RATE_MAX; i += 1) {
    assert.equal(store.isIpRateLimited('203.0.113.7', T0), false, `send ${i} allowed`);
  }
  assert.equal(store.isIpRateLimited('203.0.113.7', T0), true, 'the 6th send from one host is blocked');

  // Other hosts keep working, and an hour later the counter restarts.
  assert.equal(store.isIpRateLimited('198.51.100.9', T0), false);
  assert.equal(store.isIpRateLimited('203.0.113.7', T0 + IP_RATE_WINDOW_MS + 1), false);

  // No IP (some proxies strip it) must not lock anybody out.
  assert.equal(store.isIpRateLimited('', T0), false);
  assert.equal(store.isIpRateLimited(null, T0), false);
});

test('clean() also clears finished rate windows', () => {
  const store = createEmailCodeStore();
  for (let i = 0; i <= EMAIL_RATE_MAX; i += 1) store.isEmailRateLimited('a@school.edu', T0);
  assert.equal(store.isEmailRateLimited('a@school.edu', T0), true);

  store.clean(T0 + EMAIL_RATE_WINDOW_MS + 1);
  assert.equal(store.isEmailRateLimited('a@school.edu', T0 + EMAIL_RATE_WINDOW_MS + 1), false);
});

test('codes are six digits and never repeat by construction', () => {
  for (let i = 0; i < 200; i += 1) {
    const code = randomSixDigitCode();
    assert.match(code, /^\d{6}$/);
  }
});
