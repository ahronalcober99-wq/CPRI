// ============================================================
//  CPRI — registration email verification codes (in-memory)
//
//  Backs POST /api/auth/send-verification-code and
//  POST /api/auth/verify-code (server/auth.js). Like before, the
//  store is in-memory: codes live for ten minutes, are re-issued on
//  every server start, and losing them only makes a user request a
//  new one.
//
//  Limits enforced here:
//   • a code expires 10 minutes after it is issued;
//   • a code accepts at most 5 wrong attempts, then it is dropped and
//     a fresh one must be requested (stops brute-forcing the 6 digits);
//   • 3 sends per email address per 15 minutes;
//   • 5 sends per IP address per hour (stops one host spamming codes
//     to many inboxes through the Brevo account).
//
//  Nothing here ever logs a code — only the caller's outcome.
// ============================================================

export const CODE_TTL_MS = 10 * 60 * 1000;         // 10 minutes
export const CODE_MAX_ATTEMPTS = 5;                // wrong tries per code
export const EMAIL_RATE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
export const EMAIL_RATE_MAX = 3;                   // sends per address per window
export const IP_RATE_WINDOW_MS = 60 * 60 * 1000;   // 1 hour
export const IP_RATE_MAX = 5;                      // sends per IP per window

export function randomSixDigitCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Shared counter for both rate maps: first hit opens a window, later hits
// count towards it, and the answer is "over the limit" once max is passed.
function countHit(store, key, windowMs, max, now) {
  const entry = store.get(key);
  if (!entry || entry.windowStart + windowMs < now) {
    store.set(key, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > max;
}

/**
 * @param {{ttlMs?: number, maxAttempts?: number}} [options]
 * @returns the verification-code store used by the auth router.
 *         Passing explicit options (tests) changes only this instance.
 */
export function createEmailCodeStore(options = {}) {
  const ttlMs = options.ttlMs ?? CODE_TTL_MS;
  const maxAttempts = options.maxAttempts ?? CODE_MAX_ATTEMPTS;

  const codes = new Map();  // email -> { code, expiresAt, verified, attempts }
  const byEmail = new Map(); // email -> { count, windowStart }
  const byIp = new Map();    // ip    -> { count, windowStart }

  return {
    maxAttempts,

    // Drop expired codes and finished rate windows. Called at the top of each
    // route so stale entries never keep memory (or a lockout) alive.
    clean(now = Date.now()) {
      for (const [email, entry] of codes) {
        if (entry.expiresAt < now) codes.delete(email);
      }
      for (const [store, windowMs] of [[byEmail, EMAIL_RATE_WINDOW_MS], [byIp, IP_RATE_WINDOW_MS]]) {
        for (const [key, entry] of store) {
          if (entry.windowStart + windowMs < now) store.delete(key);
        }
      }
    },

    isEmailRateLimited(email, now = Date.now()) {
      return countHit(byEmail, email, EMAIL_RATE_WINDOW_MS, EMAIL_RATE_MAX, now);
    },

    isIpRateLimited(ip, now = Date.now()) {
      if (!ip) return false;
      return countHit(byIp, String(ip), IP_RATE_WINDOW_MS, IP_RATE_MAX, now);
    },

    // Issue (or re-issue) the code for an address. Re-issuing resets both the
    // expiry and the wrong-attempt counter.
    issue(email, code, now = Date.now()) {
      codes.set(email, { code, expiresAt: now + ttlMs, verified: false, attempts: 0 });
    },

    get(email) {
      return codes.get(email);
    },

    drop(email) {
      codes.delete(email);
    },

    markVerified(email) {
      const entry = codes.get(email);
      if (entry) entry.verified = true;
    },

    /**
     * Count a wrong attempt against the code for `email`.
     * @returns how many attempts remain; 0 means the code is now dead — it is
     *          deleted, so even the correct digits no longer work.
     */
    recordWrongAttempt(email) {
      const entry = codes.get(email);
      if (!entry) return 0;
      entry.attempts = (entry.attempts || 0) + 1;
      if (entry.attempts >= maxAttempts) {
        codes.delete(email);
        return 0;
      }
      return maxAttempts - entry.attempts;
    },

    attemptsRemaining(email) {
      const entry = codes.get(email);
      if (!entry) return 0;
      return Math.max(0, maxAttempts - (entry.attempts || 0));
    }
  };
}
