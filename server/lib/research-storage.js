// ============================================================
//  CPRI — Research Submission Module: file storage
//
//  Where the uploaded manuscripts, forms and clearances actually live.
//
//  Supabase Storage (the project's private bucket) when SUPABASE_URL,
//  SUPABASE_SERVICE_KEY and SUPABASE_BUCKET are set, and the local disk under
//  UPLOAD_DIR otherwise. This is the same either/or the backup service already
//  makes (see db/migrations/README.md): Supabase on Render, whose disk is wiped
//  on every restart, and the disk in development where Supabase is not
//  configured at all.
//
//  Which backend holds a file is recorded per row (`storage_backend`), so
//  switching a deployment either way never orphans what was uploaded before the
//  switch: a file written to disk stays readable after Supabase is switched on,
//  and a file written to Supabase stays readable if it is switched off again.
//
//  Nothing here decides WHO may read a file. Callers check the session, the
//  submission and the caller's role first, then ask this module for the bytes.
// ============================================================
'use strict';

import { createReadStream } from 'fs';
import { mkdir, rm, stat, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { Readable } from 'stream';

import { supabaseStorage } from '../storage/supabase-storage.js';

export const DISK_BACKEND = 'disk';
export const SUPABASE_BACKEND = 'supabase';

export function createResearchStorage({ uploadDir, storage = supabaseStorage, logger = console } = {}) {
  if (!uploadDir) throw new Error('Research file storage needs an upload directory.');

  // Supabase is optional: a deployment without it keeps working on the local
  // disk — only the durability guarantee changes. Reported once at boot by the
  // caller, the same way the backup service reports where it writes.
  function supabaseReady() {
    try {
      return Boolean(storage && typeof storage.isConfigured === 'function' && storage.isConfigured());
    } catch {
      return false;
    }
  }

  return {
    uploadDir,
    isSupabase: supabaseReady,
    // The backend a NEW file would go to right now.
    backend: () => (supabaseReady() ? SUPABASE_BACKEND : DISK_BACKEND),

    // Store one file. Resolves to the backend that holds it so the caller can
    // persist that next to the row. Throws when the write fails, which is what
    // the upload routes turn into a 500 rather than a silent half-save.
    async save({ path, buffer, contentType }) {
      if (!Buffer.isBuffer(buffer)) throw new Error('Saving a research file requires a file buffer.');
      if (supabaseReady()) {
        await storage.uploadObject({
          path,
          buffer,
          contentType: contentType || 'application/octet-stream'
        });
        return SUPABASE_BACKEND;
      }
      const absolutePath = join(uploadDir, path);
      await mkdir(dirname(absolutePath), { recursive: true }).catch(() => {});
      await writeFile(absolutePath, buffer);
      return DISK_BACKEND;
    },

    // Read one stored file back for an authorized download. Resolves to a Node
    // readable stream, or null when the file is gone — the caller answers 404
    // and never has to leak whether the database row exists.
    async open({ path, backend }) {
      if (backend === SUPABASE_BACKEND) {
        if (!supabaseReady()) {
          throw new Error('This file is stored in Supabase Storage, which is not configured on this server.');
        }
        const response = await storage.downloadObject({ path });
        if (!response) return null;
        return response.body ? Readable.fromWeb(response.body) : Readable.from([]);
      }
      const absolutePath = join(uploadDir, path);
      try {
        await stat(absolutePath);
      } catch {
        return null;
      }
      return createReadStream(absolutePath);
    },

    // Best-effort delete, used when a write succeeded but the row could not be
    // saved. Never throws: the caller is already reporting a failure.
    async remove({ path, backend }) {
      try {
        if (backend === SUPABASE_BACKEND) {
          if (!supabaseReady()) return;
          await storage.deleteObjects([path]);
          return;
        }
        await rm(join(uploadDir, path), { force: true });
      } catch (error) {
        logger.error('[research-storage] could not remove a file:', error.message);
      }
    }
  };
}
