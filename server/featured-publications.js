import { Router } from 'express';
import { all, get } from './server/db/queries.js';

const CACHE_TTL_MS = 60_000;
const productionCache = new Map();
const routerCaches = new WeakMap();

function safeHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';

  const candidate = value.trim();
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    return candidate;
  } catch {
    return '';
  }
}

function safeDoiUrl(doi) {
  const value = typeof doi === 'string' ? doi.trim() : '';
  if (!value) return '';
  const existingUrl = safeHttpUrl(value);
  if (existingUrl) return existingUrl;

  const identifier = value.replace(/^doi:\s*/i, '');
  if (!/^10\.\d{4,9}\/\S+$/i.test(identifier)) return '';
  return safeHttpUrl(`https://doi.org/${identifier}`);
}

function publicLink(publicationLink, doi, proofDocuments, id) {
  const external = safeHttpUrl(publicationLink) || safeDoiUrl(doi);
  if (external) return external;

  const pdf = Array.isArray(proofDocuments)
    ? proofDocuments.find(proof => proof?.type === 'published_pdf' && typeof proof.filename === 'string')
    : null;
  if (!pdf) return '';

  return `/api/publications/${encodeURIComponent(String(id))}/file/${encodeURIComponent(pdf.filename)}`;
}

function mapItem(row) {
  return {
    id: row.id,
    title: row.title,
    authors: row.authors,
    venue: row.venue,
    year: row.year,
    type: ['faculty', 'student'].includes(row.authorType) ? row.authorType : 'other',
    level: ({
      local_journal: 'local',
      national_journal: 'national',
      international_journal: 'international'
    })[row.pubType] || 'other',
    link: publicLink(row.publicationLink, row.doi, row.proofDocuments, row.id)
  };
}

function createRouter({ allQuery, getQuery, now, cache, logger = console }) {
  const router = Router();
  routerCaches.set(router, cache);

  router.get('/featured', async (req, res, next) => {
    const rawLimit = req.query.limit;
    let limit = 6;
    if (rawLimit !== undefined) {
      if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit)) {
        return res.status(400).json({ error: 'limit must be an integer from 1 to 12.' });
      }
      limit = Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 12) {
        return res.status(400).json({ error: 'limit must be an integer from 1 to 12.' });
      }
    }

    const cached = cache.get(limit);
    if (cached && cached.expiresAt > now()) return res.json(cached.body);

    try {
      const [counts, rows] = await Promise.all([
        getQuery(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN authorType = ? THEN 1 ELSE 0 END) AS faculty,
                  SUM(CASE WHEN authorType = ? THEN 1 ELSE 0 END) AS student
           FROM publications
           WHERE status = ?`,
          ['faculty', 'student', 'published']
        ),
        allQuery(
          `SELECT id, title, authors, journalOrConference AS venue,
                  LEFT(publicationDate, 4) AS year, authorType, pubType, doi
           FROM publications
           WHERE status = ?
           ORDER BY publicationDate DESC, createdAt DESC
           LIMIT ?`,
          ['published', limit]
        )
      ]);
      const body = {
        items: rows.map(mapItem),
        counts: {
          total: Number(counts?.total) || 0,
          faculty: Number(counts?.faculty) || 0,
          student: Number(counts?.student) || 0
        }
      };
      cache.set(limit, { expiresAt: now() + CACHE_TTL_MS, body });
      return res.json(body);
    } catch (error) {
      logger.error('[publications] featured endpoint failed:', error.code || 'unknown database error', error.message || error);
      return next(error);
    }
  });

  return router;
}

export function createFeaturedPublicationsRouter({ allQuery, getQuery, now = Date.now, logger = console }) {
  return createRouter({ allQuery, getQuery, now, logger, cache: new Map() });
}

export const featuredPublicationsRouter = createRouter({
  allQuery: all,
  getQuery: get,
  now: Date.now,
  cache: productionCache
});

export function invalidateFeaturedPublicationsCache(router = featuredPublicationsRouter) {
  routerCaches.get(router)?.clear();
}
