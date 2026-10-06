import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import bmp from 'bmp-js';
import { fileTypeFromBuffer } from 'file-type';
import convertHeic from 'heic-convert';
import sharp from 'sharp';

const imageConfig = JSON.parse(readFileSync(
  fileURLToPath(new URL('../public/assets/js/event-image-formats.json', import.meta.url)),
  'utf8'
));
const formatsBySignature = new Map(
  imageConfig.formats.flatMap(format => format.signatures.map(signature => [signature, format]))
);
const formatLabels = imageConfig.formats.flatMap(format => format.labels);

export const MAX_EVENT_IMAGE_SIZE = imageConfig.maxSizeBytes;
export const EVENT_IMAGE_FORMAT_ERROR =
  `Only ${formatLabels.join(', ').replace(/, ([^,]*)$/, ', or $1')} images are allowed.`;

function invalidImageError(message = EVENT_IMAGE_FORMAT_ERROR) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

export async function validateEventImage(file) {
  const buffer = file?.buffer;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw invalidImageError('The uploaded file is empty or invalid.');
  }
  if (Number(file.size || buffer.length) > MAX_EVENT_IMAGE_SIZE || buffer.length > MAX_EVENT_IMAGE_SIZE) {
    throw invalidImageError('Photo is too large (max 5 MB).');
  }

  let detected;
  try {
    detected = await fileTypeFromBuffer(buffer);
  } catch {
    throw invalidImageError('The uploaded file is not a supported image.');
  }
  const format = detected && formatsBySignature.get(detected.ext.toLowerCase());
  if (!format) {
    throw invalidImageError();
  }

  if (format.preserve) {
    try {
      const dimensions = await sharp(buffer, { failOn: 'error' }).metadata();
      const pixels = (dimensions.width || 0) * (dimensions.height || 0);
      if (!dimensions.width || !dimensions.height || pixels > 40_000_000) {
        throw new Error('Image dimensions exceed the processing limit.');
      }
    } catch {
      throw invalidImageError('The uploaded image could not be decoded or has unsupported dimensions.');
    }
    return {
      buffer,
      contentType: format.outputMime,
      extension: format.outputExtension
    };
  }

  try {
    let input = buffer;
    if (format.id === 'bmp') {
      if (buffer.length < 54) throw new Error('Invalid BMP header.');
      const dataOffset = buffer.readUInt32LE(10);
      const headerSize = buffer.readUInt32LE(14);
      const width = buffer.readInt32LE(18);
      const height = Math.abs(buffer.readInt32LE(22));
      const planes = buffer.readUInt16LE(26);
      const bitsPerPixel = buffer.readUInt16LE(28);
      const compression = buffer.readUInt32LE(30);
      if (
        dataOffset < 54 || dataOffset >= buffer.length || headerSize !== 40 || planes !== 1 ||
        width < 1 || height < 1 || width * height > 20_000_000 ||
        ![1, 4, 8, 16, 24, 32].includes(bitsPerPixel) ||
        ![0, 1, 2, 3].includes(compression)
      ) {
        throw new Error('Unsupported BMP dimensions or encoding.');
      }
      const decoded = bmp.decode(buffer);
      const rgba = Buffer.alloc(width * height * 4);
      if (decoded.width !== width || decoded.height !== height || decoded.data.length !== rgba.length) {
        throw new Error('Invalid BMP pixel data.');
      }
      for (let offset = 0; offset < decoded.data.length; offset += 4) {
        rgba[offset] = decoded.data[offset + 3];
        rgba[offset + 1] = decoded.data[offset + 2];
        rgba[offset + 2] = decoded.data[offset + 1];
        rgba[offset + 3] = bitsPerPixel === 32 ? decoded.data[offset] : 255;
      }
      input = sharp(rgba, { raw: { width, height, channels: 4 } });
    }

    let convertedBuffer;
    if (['heic', 'heif'].includes(format.id)) {
      try {
        const dimensions = await sharp(buffer, { failOn: 'error' }).metadata();
        if ((dimensions.width || 0) * (dimensions.height || 0) > 40_000_000) {
          throw new Error('Image dimensions exceed the processing limit.');
        }
        convertedBuffer = await sharp(buffer, { failOn: 'error' }).webp({ quality: 85 }).toBuffer();
      } catch (error) {
        if (error.message === 'Image dimensions exceed the processing limit.') throw error;
        const jpeg = await convertHeic({ buffer, format: 'JPEG', quality: 0.95 });
        convertedBuffer = await sharp(Buffer.from(jpeg), { failOn: 'error' }).webp({ quality: 85 }).toBuffer();
      }
    } else {
      if (Buffer.isBuffer(input)) {
        const dimensions = await sharp(input, { failOn: 'error' }).metadata();
        const pixels = (dimensions.width || 0) * (dimensions.height || 0);
        if (!dimensions.width || !dimensions.height || pixels > 40_000_000) {
          throw new Error('Image dimensions exceed the processing limit.');
        }
        input = sharp(input, { failOn: 'error' });
      }
      convertedBuffer = await input.webp({ quality: 85 }).toBuffer();
    }
    return {
      buffer: convertedBuffer,
      contentType: 'image/webp',
      extension: '.webp'
    };
  } catch {
    throw invalidImageError('The uploaded image could not be decoded or converted.');
  }
}

export function normalizeEventImage(event = {}) {
  return {
    imageUrl: String(event.imageUrl || event.imageurl || event.photo || event.image || ''),
    imagePublicId: String(event.imagePublicId || event.imagepublicid || '')
  };
}

export function isEventImageObjectId(value) {
  return typeof value === 'string' &&
    /^(content-events|events-module)\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|gif)$/i.test(value);
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
