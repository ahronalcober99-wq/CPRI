// ============================================================
//  CPRI — shared upload safety for the disk-storage routers
//
//  Every document upload in the app (ethics, publications,
//  innovation & extension, admin insights, event gallery) is written
//  to disk by multer, so it needs the same two guards the submission
//  and profile-photo routes already have:
//
//   1. documentFileFilter — an extension + MIME allow-list applied
//      before a single byte is written, so executables, HTML, SVG and
//      scripts never reach the upload folder;
//   2. uploadErrorHandler — turns multer's failures (file too large,
//      rejected type, too many parts) into a friendly 400 JSON answer
//      instead of the generic 500 the global handler would produce.
//
//  Size limits stay where they have always been: `limits: { fileSize }`
//  on each multer instance (15 MB for documents, 5 MB for covers).
//  Files are only ever handed back with res.download(), i.e. as an
//  attachment, never rendered inline.
// ============================================================
import multer from 'multer';
import { extname } from 'path';

// Extension -> MIME types a browser may legitimately report for it.
// Deliberately generous (documents, images, archives, plain data), and
// deliberately closed: anything not listed here is refused.
const ALLOWED_UPLOADS = new Map(Object.entries({
  '.pdf': ['application/pdf'],
  '.doc': ['application/msword'],
  // OOXML and OpenDocument files are ZIP containers; some browsers report
  // either the specific type or plain zip, so both are accepted.
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip'],
  '.xls': ['application/vnd.ms-excel'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip'],
  '.ppt': ['application/vnd.ms-powerpoint'],
  '.pptx': ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/zip'],
  '.odt': ['application/vnd.oasis.opendocument.text', 'application/zip'],
  '.ods': ['application/vnd.oasis.opendocument.spreadsheet', 'application/zip'],
  '.odp': ['application/vnd.oasis.opendocument.presentation', 'application/zip'],
  '.rtf': ['application/rtf', 'text/rtf'],
  '.txt': ['text/plain'],
  '.md': ['text/plain', 'text/markdown'],
  '.csv': ['text/csv', 'application/csv', 'application/vnd.ms-excel', 'text/plain'],
  '.json': ['application/json', 'text/plain'],
  '.xml': ['application/xml', 'text/xml', 'text/plain'],
  '.png': ['image/png'],
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.gif': ['image/gif'],
  '.webp': ['image/webp'],
  '.bmp': ['image/bmp'],
  '.heic': ['image/heic'],
  '.heif': ['image/heif'],
  '.zip': ['application/zip', 'application/x-zip-compressed']
}));

export const INVALID_FILE_TYPE_MESSAGE =
  'That file type is not allowed. Upload a PDF, Word, Excel, PowerPoint, text, image or ZIP file.';

export const ALLOWED_UPLOAD_HINT = [...ALLOWED_UPLOADS.keys()].join(', ');

// Is `file` one of the accepted document/image types?
// The extension must be on the list, and a reported MIME type must agree
// with it (browsers sometimes send an empty or generic type, which is fine —
// the extension still has to be one we accept).
export function isAllowedUploadFile(file) {
  const extension = extname(String(file?.originalname || '')).toLowerCase();
  const accepted = ALLOWED_UPLOADS.get(extension);
  if (!accepted) return false;
  const mime = String(file?.mimetype || '').toLowerCase().split(';')[0].trim();
  if (!mime || mime === 'application/octet-stream') return true;
  return accepted.includes(mime);
}

// multer fileFilter: reject with an error the route's error handler can show.
export function documentFileFilter(req, file, callback) {
  if (!isAllowedUploadFile(file)) {
    const error = new Error(INVALID_FILE_TYPE_MESSAGE);
    error.code = 'INVALID_FILE_TYPE';
    return callback(error);
  }
  return callback(null, true);
}

/**
 * Error-handling middleware for multer failures. Place it on the router with
 * `router.use(uploadErrorHandler({...}))` **after** the upload routes, so an
 * oversized or disallowed file answers 400 with JSON instead of a 500.
 *
 * @param {{label?: string, maxMb?: number | ((req) => number)}} [options]
 *        maxMb may be a function when one router serves uploads with
 *        different limits (e.g. a 5 MB cover and 15 MB gallery files).
 */
export function uploadErrorHandler(options = {}) {
  const label = options.label || 'File';
  const resolveMaxMb = typeof options.maxMb === 'function'
    ? options.maxMb
    : () => options.maxMb || 15;

  return function uploadErrorHandlerMiddleware(err, req, res, next) {
    if (!err) return next();
    if (err instanceof multer.MulterError || err.code === 'LIMIT_FILE_SIZE') {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: `${label} is too large (max ${resolveMaxMb(req)} MB).` });
      }
      return res.status(400).json({ error: `${label} upload failed: ${err.message || 'invalid file.'}` });
    }
    if (err.code === 'INVALID_FILE_TYPE') {
      return res.status(400).json({ error: err.message, allowed: ALLOWED_UPLOAD_HINT });
    }
    if (err.status === 400 || err.statusCode === 400) {
      return res.status(400).json({ error: err.message || 'Request failed.' });
    }
    return next(err);
  };
}
