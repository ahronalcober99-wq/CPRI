import { randomUUID } from 'crypto';
import { extname } from 'path';
import { supabaseStorage } from './supabase-storage.js';

export const MAX_SUBMISSION_FILE_BYTES = 15 * 1024 * 1024;

const ALLOWED_UPLOADS = new Map([
  ['.pdf', { mimeTypes: new Set(['application/pdf']), signature: Buffer.from('%PDF-') }],
  ['.doc', { mimeTypes: new Set(['application/msword']), signature: Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]) }],
  ['.docx', {
    mimeTypes: new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
    signature: Buffer.from([0x50, 0x4B, 0x03, 0x04])
  }]
]);

export function validateSubmissionUploadFile(file) {
  const extension = extname(String(file?.originalname || '')).toLowerCase();
  const rule = ALLOWED_UPLOADS.get(extension);
  if (!rule || !rule.mimeTypes.has(file?.mimetype)) return false;
  return !file.buffer || file.buffer.subarray(0, rule.signature.length).equals(rule.signature);
}

export function createSubmissionFileStore({ storage = supabaseStorage, logger = console } = {}) {
  async function cleanupUploadedFiles(paths) {
    try {
      await storage.deleteObjects(paths);
    } catch (error) {
      logger.error('[storage] failed to remove incomplete upload:', error.message);
    }
  }

  async function storeUploadedFiles(fileGroups, prefix) {
    const files = {};
    const additionalDocs = [];
    const uploadedPaths = [];

    try {
      for (const field of fileGroups ? Object.keys(fileGroups) : []) {
        if (field === 'additional') continue;
        const file = fileGroups[field]?.[0];
        if (!file) continue;
        if (!validateSubmissionUploadFile(file)) {
          const error = new Error('Only valid PDF, DOC, and DOCX files are allowed.');
          error.code = 'INVALID_FILE_CONTENT';
          throw error;
        }
        const extension = extname(file.originalname).toLowerCase();
        const storagePath = `${prefix}/${randomUUID()}${extension}`;
        await storage.uploadObject({
          path: storagePath,
          buffer: file.buffer,
          contentType: file.mimetype
        });
        uploadedPaths.push(storagePath);
        files[field] = {
          storage_path: storagePath,
          original_name: file.originalname,
          mime_type: file.mimetype
        };
      }

      for (const file of fileGroups?.additional || []) {
        if (!validateSubmissionUploadFile(file)) {
          const error = new Error('Only valid PDF, DOC, and DOCX files are allowed.');
          error.code = 'INVALID_FILE_CONTENT';
          throw error;
        }
        const extension = extname(file.originalname).toLowerCase();
        const storagePath = `${prefix}/${randomUUID()}${extension}`;
        await storage.uploadObject({
          path: storagePath,
          buffer: file.buffer,
          contentType: file.mimetype
        });
        uploadedPaths.push(storagePath);
        additionalDocs.push({
          id: randomUUID(),
          storage_path: storagePath,
          original_name: file.originalname,
          mime_type: file.mimetype
        });
      }
    } catch (error) {
      await cleanupUploadedFiles(uploadedPaths);
      throw error;
    }

    return { files, additionalDocs, uploadedPaths };
  }

  async function rollback(paths) {
    await cleanupUploadedFiles(paths);
  }

  return { storeUploadedFiles, rollback };
}
