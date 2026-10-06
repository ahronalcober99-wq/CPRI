import { extname } from 'path';

const IMAGE_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
};
export const MAX_EVENT_IMAGE_SIZE = 5 * 1024 * 1024;

export function validateEventImage(file) {
  const extension = extname(String(file?.originalname || '')).toLowerCase();
  const expectedType = IMAGE_TYPES[extension];
  if (!expectedType) {
    const error = new Error('Only JPG, JPEG, PNG, or WebP images are allowed.');
    error.status = 400;
    throw error;
  }
  if (file.mimetype !== expectedType) {
    const error = new Error('The image file type does not match its extension.');
    error.status = 400;
    throw error;
  }
  if (Number(file.size || 0) > MAX_EVENT_IMAGE_SIZE) {
    const error = new Error('Photo is too large (max 5 MB).');
    error.status = 400;
    throw error;
  }
  if (Buffer.isBuffer(file.buffer)) {
    const validSignature = expectedType === 'image/jpeg'
      ? file.buffer.length >= 3 && file.buffer[0] === 0xff && file.buffer[1] === 0xd8 && file.buffer[2] === 0xff
      : expectedType === 'image/png'
        ? file.buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        : file.buffer.length >= 12 &&
          file.buffer.toString('ascii', 0, 4) === 'RIFF' &&
          file.buffer.toString('ascii', 8, 12) === 'WEBP';
    if (!validSignature) {
      const error = new Error('The uploaded file is not a valid image of the declared type.');
      error.status = 400;
      throw error;
    }
  }
  return expectedType;
}

export function normalizeEventImage(event = {}) {
  return {
    imageUrl: String(event.imageUrl || event.imageurl || event.photo || event.image || ''),
    imagePublicId: String(event.imagePublicId || event.imagepublicid || '')
  };
}

export function isEventImageObjectId(value) {
  return typeof value === 'string' &&
    /^(content-events|events-module)\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|jpeg|png|webp)$/i.test(value);
}

export async function cleanupEventImages(objectIds, {
  storage,
  logger = console,
  context = '[events] stored image cleanup failed'
}) {
  const safeIds = [...new Set((objectIds || []).filter(isEventImageObjectId))];
  if (!safeIds.length) return true;
  try {
    await storage.deleteObjects(safeIds, { bucket: 'events' });
    return true;
  } catch (error) {
    logger.error(context + ':', error.message);
    return false;
  }
}
