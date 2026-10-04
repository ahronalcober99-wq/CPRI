import { randomInt } from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { all, get } from './server/db/queries.js';
import { buildUsernameCandidates, normalizeUsername, validateUsername } from './utils/username.js';

const RANDOM_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const MAX_BATCHES = 5;
const RANDOM_SUFFIXES_PER_BATCH = 4;

function createRandomSuffix() {
  return Array.from({ length: 4 }, () => RANDOM_ALPHABET[randomInt(RANDOM_ALPHABET.length)]).join('');
}

export function createUsernameRouter({
  getQuery = get,
  allQuery = all,
  randomSuffix = createRandomSuffix
} = {}) {
  const router = Router();

  router.use(rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many username checks. Please try again in a minute.' }
  }));

  router.get('/check', async (req, res) => {
    const validation = validateUsername(req.query.username);
    if (!validation.valid) {
      return res.json({ available: false, reason: 'invalid', message: validation.message });
    }

    const username = normalizeUsername(validation.username);

    try {
      const existing = await getQuery(
        'SELECT id FROM users WHERE LOWER(username) = ?',
        [username]
      );
      if (!existing) return res.json({ available: true });

      const attempted = new Set();
      const available = [];
      const occupied = new Set([username]);

      for (let batchIndex = 0; batchIndex < MAX_BATCHES && available.length < 4; batchIndex += 1) {
        const suffixes = batchIndex === 0
          ? [randomSuffix()]
          : Array.from({ length: RANDOM_SUFFIXES_PER_BATCH }, () => randomSuffix());
        const batchCandidates = buildUsernameCandidates(
          username,
          req.query.fullName,
          new Date().getFullYear(),
          suffixes
        ).filter(candidate => {
          if (attempted.has(candidate)) return false;
          attempted.add(candidate);
          return true;
        });

        if (batchCandidates.length === 0) continue;
        const placeholders = batchCandidates.map(() => '?').join(', ');
        const rows = await allQuery(
          `SELECT username FROM users WHERE LOWER(username) IN (${placeholders})`,
          batchCandidates
        );
        const taken = new Set(rows.map(row => normalizeUsername(row.username)));
        for (const candidate of batchCandidates) {
          if (!taken.has(candidate) && !occupied.has(candidate)) {
            occupied.add(candidate);
            available.push(candidate);
            if (available.length === 4) break;
          }
        }
      }

      return res.json({ available: false, reason: 'taken', suggestions: available.slice(0, 4) });
    } catch (error) {
      console.error('[username] Availability check failed:', error.message);
      return res.status(503).json({ error: 'Username availability could not be checked right now.' });
    }
  });

  return router;
}

export const usernameRouter = createUsernameRouter();
