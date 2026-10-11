// ============================================================
//  CPRI — Profile photo (avatar) upload and removal
//
//    POST   /api/profile/photo   multipart, field name "photo"  → { url }
//    DELETE /api/profile/photo                                  → removes it
//
//  Design notes:
//   • The account is always taken from the session (req.session.userId) — never
//     from the request body — so a signed-in user can only ever change their
//     own photo. Every other role (Administrator, Student Researcher, staff,
//     faculty, adviser, reviewer) uses the same two routes.
//   • The file type is decided by MAGIC BYTES (file-type), not by the file
//     extension or the Content-Type header, and only JPEG, PNG and WebP pass.
//   • sharp squares the image and resizes it to 512×512 WebP. Metadata (EXIF,
//     including GPS) is dropped because withMetadata() is never called.
//   • Storage is Supabase Storage (the same adapter the rest of the site uses
//     for files and event covers), so Render's free-plan disk wipe doesn't
//     destroy photos.
//   • Photos are stored under `avatars/<userId>/<random>.webp` inside the
//     configured bucket (SUPABASE_EVENT_BUCKET by default, or SUPABASE_AVATAR_BUCKET
//     when set). The object prefix keeps them separate from the site's event
//     images while sharing the same public bucket — no new bucket is required.
//   • There is no dedicated profile-photo column: the public URL is stored in
//     the existing `profilePhoto` column, and the front end reads it as
//     `photoUrl` (server/auth.js already returns both).
// ============================================================
import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import sharp from 'sharp';
import { fileTypeFromBuffer } from 'file-type';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import { promises as fs } from 'fs';
import { requireAuth } from './auth.js';
import { get, update } from './server/db/queries.js';
import { supabaseStorage } from './storage/supabase-storage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const LEGACY_PREFIX = '/assets/uploads/profiles/';
const env = process.env;

// Bucket for profile photos. The site's uploads share one Supabase project, so
// this router reuses the same client — it never reads another bucket.
//
// On Render the public `SUPABASE_EVENT_BUCKET` is already configured and
// verified to exist (log line `[storage] bucket OK`). By default the profile
// photo router uses that same bucket, so **no new environment variable is
// required**. Photos land under `avatars/<userId>/<random>.webp` inside that
// bucket — the object *prefix* keeps them separate from the site's event images
// while sharing the same public bucket.
//
// SUGGESTED (optional, no change needed now): keep `SUPABASE_EVENT_BUCKET`
// reserved for events and put avatars in their own public bucket by setting
// `SUPABASE_AVATAR_BUCKET`. When that is set, storage paths are still
// `avatars/<userId>/<random>.webp`, just under the other bucket. See .env.example.
export const PROFILE_PHOTO_BUCKET = 'events';                 // the site's public bucket
export const PROFILE_PHOTO_PREFIX = 'avatars';               // inside whatever bucket is used

const MAX_PHOTO_BYTES = 2 * 1024 * 1024;               // 2 MB
const ALLOWED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const PHOTO_SIZE = 512;                                // 512×512 square

export const PHOTO_FORMAT_MESSAGE = 'Please choose a JPG, PNG, or WebP image.';
export const PHOTO_SIZE_MESSAGE = 'That photo is too big — the maximum size is 2 MB.';
export const STORAGE_UNAVAILABLE_MESSAGE =
  'Photo storage is not configured on the server, so photos cannot be saved right now. '
  + 'Please ask the site administrator to finish the storage setup.';

function photoError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// ---------- Validation + processing (no database, no network) ----------
// Returns the WebP buffer that should be stored, or throws a 400-flagged error
// whose message is safe to show the user.
export async function processProfilePhoto(buffer, { maxBytes = MAX_PHOTO_BYTES } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw photoError(400, 'That file is empty. Please choose a photo.');
  }
  if (buffer.length > maxBytes) {
    throw photoError(400, PHOTO_SIZE_MESSAGE);
  }

  // Magic bytes decide the format: renaming "virus.exe" to "photo.jpg" (or
  // sending a bogus Content-Type) still fails here.
  let detected = null;
  try {
    detected = await fileTypeFromBuffer(buffer);
  } catch {
    detected = null;
  }
  if (!detected || !ALLOWED_PHOTO_TYPES.includes(String(detected.mime).toLowerCase())) {
    throw photoError(400, PHOTO_FORMAT_MESSAGE);
  }

  let output;
  try {
    output = await sharp(buffer, { failOn: 'error', limitInputPixels: 40_000_000 })
      .rotate()                                            // bake in EXIF orientation
      .resize(PHOTO_SIZE, PHOTO_SIZE, { fit: 'cover', position: 'centre' })
      .webp({ quality: 88 })                               // EXIF/GPS dropped (no withMetadata)
      .toBuffer();
  } catch {
    throw photoError(400, 'That image could not be read. Please choose a different photo.');
  }
  if (!Buffer.isBuffer(output) || output.length === 0) {
    throw photoError(400, 'That image could not be processed. Please choose a different photo.');
  }

  return { buffer: output, contentType: 'image/webp', extension: '.webp', width: PHOTO_SIZE, height: PHOTO_SIZE };
}

// ---------- Old-photo cleanup ----------
// Deletes the previous avatar when it is one of ours: a Supabase object in the
// configured public bucket, or a file left on disk by the old upload route.
// External URLs (e.g. a Google OAuth picture) are left alone. Best effort —
// the caller has already stored the new photo, so a cleanup failure is logged,
// never surfaced as an upload error.
export async function removeStoredProfilePhoto(rawUrl, {
  storage = supabaseStorage,
  bucket = PROFILE_PHOTO_BUCKET,
  logger = console,
  publicDir = PUBLIC_DIR
} = {}) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;

  const objectPath = storage?.objectPathFromPublicUrl?.(rawUrl, { bucket });
  if (objectPath) {
    try {
      await storage.deleteObjects([objectPath], { bucket });
      return true;
    } catch (error) {
      logger.error('[profile-photo] stored photo cleanup failed:', error.message);
      return false;
    }
  }

  if (rawUrl.startsWith(LEGACY_PREFIX)) {
    // basename() keeps a crafted value from escaping the uploads directory.
    try {
      await fs.unlink(join(publicDir, 'assets', 'uploads', 'profiles', basename(rawUrl)));
      return true;
    } catch {
      return false;   // already gone
    }
  }

  return false;
}

// ---------- Router (dependency-injected so tests can run without a database) ----------
export function createProfilePhotoRouter(dependencies = {}) {
  const router = Router();

  const auth = dependencies.requireAuth || requireAuth;
  const storage = dependencies.storage || supabaseStorage;
  const logger = dependencies.logger || console;
  const bucket = dependencies.bucket || PROFILE_PHOTO_BUCKET;
  const maxBytes = dependencies.maxBytes ?? MAX_PHOTO_BYTES;
  const queries = {
    get: dependencies.get || get,
    update: dependencies.update || update
  };

  // Uploads are capped per IP address on top of the site-wide /api limiter: a
  // person changes their avatar a handful of times, never hundreds.
  const limiter = dependencies.limiter || rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many photo uploads. Please wait a few minutes and try again.' }
  });

  // Memory storage: the buffer is validated and re-encoded before anything is
  // written anywhere, and multer's own limit stops an oversized body early.
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxBytes } });

  function uploadErrors(err, req, res, next) {
    if (err && (err instanceof multer.MulterError || err.code === 'LIMIT_FILE_SIZE')) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? PHOTO_SIZE_MESSAGE
        : 'The upload could not be read. Please choose your photo again.';
      return res.status(400).json({ error: message });
    }
    next(err);
  }

  // POST /api/profile/photo — saves a new photo for the signed-in user.
  router.post('/', auth, limiter, upload.single('photo'), uploadErrors, async (req, res) => {
    const userId = req.session.userId;

    if (!storage.isConfigured({ bucket })) {
      logger.error('[profile-photo] storage is not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY / SUPABASE_EVENT_BUCKET).');
      return res.status(503).json({ error: STORAGE_UNAVAILABLE_MESSAGE });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Choose a photo to upload.' });
    }

    let prepared;
    try {
      prepared = await processProfilePhoto(req.file.buffer, { maxBytes });
    } catch (error) {
      return res.status(error.status || 400).json({ error: error.message });
    }

    const objectPath = `${PROFILE_PHOTO_PREFIX}/${userId}/${randomUUID()}${prepared.extension}`;
    try {
      await storage.uploadObject({
        path: objectPath,
        buffer: prepared.buffer,
        contentType: prepared.contentType,
        bucket
      });
    } catch (error) {
      logger.error('[profile-photo] upload failed:', error.message);
      return res.status(500).json({ error: 'Could not save your photo right now. Please try again.' });
    }

    const url = storage.publicObjectUrl({ path: objectPath, bucket });

    // Record the new URL first, then remove the old object — a failure between
    // the two leaves the user with a working photo, never with none.
    let previousUrl = null;
    try {
      const user = await queries.get('SELECT id, profilePhoto FROM users WHERE id = ?', [userId]);
      if (!user) {
        await removeStoredProfilePhoto(url, { storage, bucket, logger });
        return res.status(401).json({ error: 'Not authenticated.' });
      }
      previousUrl = user.profilePhoto || null;
      await queries.update('users', userId, { profilePhoto: url });
    } catch (error) {
      logger.error('[profile-photo] could not save the new URL:', error.message);
      await removeStoredProfilePhoto(url, { storage, bucket, logger });
      return res.status(500).json({ error: 'Could not save your photo right now. Please try again.' });
    }

    if (previousUrl && previousUrl !== url) {
      await removeStoredProfilePhoto(previousUrl, { storage, bucket, logger });
    }

    res.json({ message: 'Profile photo updated.', url, profilePhoto: url, photoUrl: url });
  });

  // DELETE /api/profile/photo — clears the photo and deletes the stored file.
  router.delete('/', auth, async (req, res) => {
    const userId = req.session.userId;
    try {
      const user = await queries.get('SELECT id, profilePhoto FROM users WHERE id = ?', [userId]);
      if (!user) return res.status(401).json({ error: 'Not authenticated.' });
      if (user.profilePhoto) {
        await removeStoredProfilePhoto(user.profilePhoto, { storage, bucket, logger });
      }
      await queries.update('users', userId, { profilePhoto: null });
    } catch (error) {
      logger.error('[profile-photo] remove failed:', error.message);
      return res.status(500).json({ error: 'Could not remove your photo right now. Please try again.' });
    }
    res.json({ message: 'Profile photo removed.', url: '', profilePhoto: null, photoUrl: null });
  });

  return router;
}

// ---------- Schema (additive, safe on every existing deployment) ----------
// profilePhoto already exists on every current deployment (set by the previous
// feature work). We re-check on startup anyway so the feature can never fail
// with "Unknown column" if someone reuses an older schema export.
export async function ensureProfilePhotoColumn(dependencies = {}) {
  const allQuery = dependencies.all || (await import('./server/db/queries.js')).all;
  const runQuery = dependencies.run || (await import('./server/db/queries.js')).run;
  const columns = await allQuery('SHOW COLUMNS FROM users');
  const existing = new Set(columns.map((column) => String(column.Field || column.field || '').toLowerCase()));
  if (!existing.has('profilephoto')) {
    await runQuery('ALTER TABLE users ADD COLUMN profilePhoto VARCHAR(255) DEFAULT NULL');
  }
  // The photoUrl read alias the front end prefers. It lives only on the JSON
  // response (server/auth.js), never in the database — so there is nothing to
  // migrate here. If an older deployment is missing profilePhoto, this call
  // already added it; nothing else is needed.
}

// ---------- Startup log (mirrors the existing per-bucket shape) ----------
// Own log so the admin can see at a glance whether avatars will work, even when
// the bucket is otherwise healthy for files/events. It never prints a credential.
async function logProfilePhotoStartup(logger = console) {
  try {
    const config = optionalBucketConfiguration(env, PROFILE_PHOTO_BUCKET);
    if (config) {
      const host = (() => { try { return new URL(config.baseUrl).host; } catch { return '(invalid URL)'; } })();
      logger.log(`[storage] avatars: ok, bucket '${config.bucket}' host '${host}'`);
    } else {
      logger.log('[storage] avatars: SKIP (no bucket configured)');
    }
  } catch (error) {
    logger.log(`[storage] avatars: SKIP (${error.message})`);
  }
}

// ---------- Public API ----------
// Prefer the router + startup log from the dependency-injected factory (so
// tests can substitute a fake storage + logger). The module also re-exports
// processProfilePhoto and removeStoredProfilePhoto for the existing test suite.
export const { profilePhotoRouter } = createProfilePhotoRouter();
export { logProfilePhotoStartup };
