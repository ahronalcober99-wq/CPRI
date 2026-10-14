function normalizeEnvValue(value) {
  let normalized = String(value || '').trim();
  if (normalized.length >= 2 &&
      ((normalized.startsWith('"') && normalized.endsWith('"')) ||
       (normalized.startsWith("'") && normalized.endsWith("'")))) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

function configuration(env, bucketVariable = 'SUPABASE_BUCKET') {
  const baseUrl = normalizeEnvValue(env.SUPABASE_URL).replace(/\/+$/, '');
  const serviceKey = normalizeEnvValue(env.SUPABASE_SERVICE_KEY);
  const bucket = normalizeEnvValue(env[bucketVariable]);
  const missing = [];
  if (!baseUrl) missing.push('SUPABASE_URL');
  if (!serviceKey) missing.push('SUPABASE_SERVICE_KEY');
  if (!bucket) missing.push(bucketVariable);
  if (missing.length) {
    throw new Error(`Supabase Storage is not configured: ${missing.join(', ')}.`);
  }

  let projectUrl;
  try {
    projectUrl = new URL(baseUrl);
  } catch {
    throw new Error('SUPABASE_URL must be a valid HTTPS URL.');
  }
  // HTTPS is required everywhere except an explicit loopback host, so the
  // upload paths can be exercised locally against server/dev/mock-supabase-storage.mjs
  // (the same affordance the database layer gives with DB_SSL_MODE for localhost).
  if (projectUrl.protocol !== 'https:' && !isLoopbackUrl(projectUrl)) {
    throw new Error('SUPABASE_URL must be a valid HTTPS URL.');
  }

  return { baseUrl, serviceKey, bucket };
}

// http://localhost, http://127.0.0.1 and http://[::1] are the only non-HTTPS
// project URLs accepted (local development only).
function isLoopbackUrl(projectUrl) {
  if (projectUrl.protocol !== 'http:') return false;
  const host = projectUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function bucketConfiguration(env, bucket) {
  if (bucket === undefined || bucket === 'private') return configuration(env);
  if (bucket === 'events') return configuration(env, 'SUPABASE_EVENT_BUCKET');
  throw new Error('Storage bucket is invalid.');
}

// Storage is optional in local development: a missing Supabase setup must not
// stop the server from booting, so callers ask first and report one clean
// message instead of a crash. (Login, profile editing and every other feature
// keep working without it.)
function optionalBucketConfiguration(env, bucket) {
  try {
    return bucketConfiguration(env, bucket);
  } catch {
    return null;
  }
}

// The storage path inside `bucket` for one of this project's own public object
// URLs (`.../storage/v1/object/public/<bucket>/<path>`). Returns null when the
// URL belongs somewhere else — a Google OAuth picture, or a legacy file left
// under /assets/uploads/profiles. Callers use this to delete a replaced photo
// without storing the object path a second time in the database.
function pathFromPublicObjectUrl(rawUrl, { bucket, env = process.env } = {}) {
  const config = optionalBucketConfiguration(env, bucket);
  if (!config || typeof rawUrl !== 'string' || !rawUrl) return null;

  let url;
  let projectOrigin;
  try {
    url = new URL(rawUrl);
    projectOrigin = new URL(config.baseUrl).origin;
  } catch {
    return null;
  }
  if (url.origin !== projectOrigin) return null;

  const prefix = `/storage/v1/object/public/${encodeURIComponent(config.bucket)}/`;
  if (!url.pathname.startsWith(prefix)) return null;
  const encoded = url.pathname.slice(prefix.length);
  if (!encoded) return null;

  try {
    const objectPath = encoded.split('/').map(decodeURIComponent).join('/');
    encodePath(objectPath); // reuse the shared path validation
    return objectPath;
  } catch {
    return null;
  }
}

function encodePath(path) {
  const objectPath = String(path || '');
  const segments = objectPath.split('/');
  if (!objectPath || objectPath.startsWith('/') || segments.some(segment =>
    !segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/.test(segment)
  )) {
    throw new Error('Storage path is invalid.');
  }
  return segments.map(encodeURIComponent).join('/');
}

async function responseError(response, operation, serviceKey) {
  if (response.ok) return;
  const body = await response.text();
  const safeBody = serviceKey ? body.split(serviceKey).join('[redacted]') : body;
  throw new Error(
    `Supabase Storage ${operation} failed with HTTP ${response.status}: ` +
    `${safeBody || response.statusText || 'Unknown error'}`
  );
}

export function createSupabaseStorage({ env = process.env, fetchImpl = fetch } = {}) {
  async function request(config, path, init) {
    const response = await fetchImpl(`${config.baseUrl}/storage/v1/${path}`, {
      ...init,
      headers: {
        apikey: config.serviceKey,
        Authorization: `Bearer ${config.serviceKey}`,
        ...(init?.headers || {})
      }
    });
    return response;
  }

  function signedDownloadUrl(rawSignedUrl, config, downloadName) {
    if (typeof rawSignedUrl !== 'string' || !rawSignedUrl.trim()) {
      throw new Error('Supabase Storage did not return a signed URL.');
    }
    const returnedUrl = rawSignedUrl.trim();
    let url;
    if (/^https?:\/\//i.test(returnedUrl)) {
      url = new URL(returnedUrl);
    } else if (returnedUrl.includes('/storage/v1')) {
      url = new URL(returnedUrl, `${config.baseUrl}/`);
    } else {
      const relativePath = returnedUrl.startsWith('/') ? returnedUrl : `/${returnedUrl}`;
      url = new URL(`${config.baseUrl}/storage/v1${relativePath}`);
    }
    url.searchParams.set('download', String(downloadName || 'download'));
    return url.href;
  }

  async function logStartupConfiguration(logger = console) {
    const config = (() => {
      try { return configuration(env); }
      catch { return null; }
    })();
    let host = '(not configured)';
    if (config) {
      try { host = new URL(config.baseUrl).host; }
      catch { host = '(invalid URL)'; }
    }
    const serviceKey = normalizeEnvValue(env.SUPABASE_SERVICE_KEY);
    logger.log('[storage] SUPABASE_URL host:', host);
    logger.log('[storage] bucket:', config?.bucket || '(not configured)');
    logger.log(`[storage] SUPABASE_SERVICE_KEY set: ${Boolean(serviceKey)} (length ${serviceKey.length})`);
  }

  async function checkBucket() {
    const config = configuration(env);
    const response = await request(
      config,
      `bucket/${encodeURIComponent(config.bucket)}`,
      { method: 'GET' }
    );
    if (response.ok) return { ok: true };
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${body || response.statusText || 'Unknown error'}`);
  }

  async function verifyBucketAtStartup(logger = console) {
    await logStartupConfiguration(logger);
    try {
      await checkBucket();
      logger.log('[storage] bucket OK');
    } catch (error) {
      logger.error('[storage] bucket check failed:', error.message);
    }
  }

  /**
   * Log the configured state of the profile-photo bucket for this deployment.
   * Mirrors the existing per-bucket startup log, so the admin can see at a
   * glance whether avatars will work without touching another Supabase project.
   */
  async function logProfilePhotoStartup(logger = console) {
    try {
      const config = optionalBucketConfiguration(env, PROFILE_PHOTO_BUCKET);
      if (config) {
        const host = (() => { try { return new URL(config.baseUrl).host; } catch { return '(invalid URL)'; } })();
        logger.log(`[storage] avatars: ok, bucket '${config.bucket}' host '${host}'`);
      } else {
        logger.log(`[storage] avatars: SKIP (no bucket configured)`);
      }
    } catch (error) {
      logger.log(`[storage] avatars: SKIP (${error.message})`);
    }
  }


  /**
   * Log the configured state of the profile-photo bucket for this deployment.
   * Mirrors the existing per-bucket startup log, so the admin can see at a
   * glance whether avatars will work without touching another Supabase project.
   */
  async function logProfilePhotoStartup(logger = console) {
    try {
      const config = optionalBucketConfiguration(env, PROFILE_PHOTO_BUCKET);
      if (config) {
        const host = (() => { try { return new URL(config.baseUrl).host; } catch { return '(invalid URL)'; } })();
        logger.log(`[storage] avatars: ok, bucket '${config.bucket}' host '${host}'`);
      } else {
        logger.log(`[storage] avatars: SKIP (no bucket configured)`);
      }
    } catch (error) {
      logger.log(`[storage] avatars: SKIP (${error.message})`);
    }
  }


  async function uploadObject({ path, buffer, contentType, bucket }) {
    if (!Buffer.isBuffer(buffer)) throw new Error('Storage upload requires a file buffer.');
    const encodedPath = encodePath(path);
    const config = bucketConfiguration(env, bucket);
    const response = await request(
      config,
      `object/${encodeURIComponent(config.bucket)}/${encodedPath}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'x-upsert': 'false'
        },
        body: buffer
      }
    );
    if (!response.ok) {
      const body = await response.text();
      const safeBody = body.split(config.serviceKey).join('[redacted]');
      throw new Error(
        `Supabase Storage upload failed with HTTP ${response.status} ` +
        `(bucket "${config.bucket}", path "${path}"): ${safeBody || response.statusText || 'Unknown error'}`
      );
    }
    return { path };
  }

  function publicObjectUrl({ path, bucket }) {
    const encodedPath = encodePath(path);
    const config = bucketConfiguration(env, bucket);
    return `${config.baseUrl}/storage/v1/object/public/${encodeURIComponent(config.bucket)}/${encodedPath}`;
  }

  async function createSignedDownloadUrl({ path, downloadName, expiresIn = 60 }) {
    if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 60) {
      throw new Error('Signed URL expiry must be from 1 to 60 seconds.');
    }
    const encodedPath = encodePath(path);
    const config = configuration(env);
    const response = await request(
      config,
      `object/sign/${encodeURIComponent(config.bucket)}/${encodedPath}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn, download: String(downloadName || 'download') })
      }
    );
    await responseError(response, 'sign', config.serviceKey);
    const body = await response.json();
    return signedDownloadUrl(body.signedURL || body.signedUrl, config, downloadName);
  }

  // The bytes of one object, streamed back to the caller. Authorization is the
  // caller's job (the research module only asks after it has checked the
  // session and the submission), which is why this returns the raw Response and
  // never a public or signed URL: nothing here is reachable without the service
  // key. Resolves to null when the object does not exist.
  async function downloadObject({ path, bucket }) {
    const encodedPath = encodePath(path);
    const config = bucketConfiguration(env, bucket);
    const response = await request(
      config,
      `object/${encodeURIComponent(config.bucket)}/${encodedPath}`,
      { method: 'GET' }
    );
    if (response.status === 404) return null;
    await responseError(response, 'download', config.serviceKey);
    return response;
  }

  async function objectExists(path) {
    const encodedPath = encodePath(path);
    const config = configuration(env);
    const response = await request(
      config,
      `object/${encodeURIComponent(config.bucket)}/${encodedPath}`,
      { method: 'HEAD' }
    );
    if (response.status === 404) return false;
    await responseError(response, 'check', config.serviceKey);
    return true;
  }

  async function deleteObjects(paths, { bucket } = {}) {
    if (!Array.isArray(paths) || paths.length === 0) return;
    const config = bucketConfiguration(env, bucket);
    const safePaths = paths.map(path => {
      const objectPath = String(path);
      encodePath(objectPath);
      return objectPath;
    });
    const response = await request(
      config,
      `object/${encodeURIComponent(config.bucket)}`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: safePaths })
      }
    );
    await responseError(response, 'delete', config.serviceKey);
  }

  return {
    uploadObject,
    downloadObject,
    publicObjectUrl,
    createSignedDownloadUrl,
    objectExists,
    deleteObjects,
    checkBucket,
    verifyBucketAtStartup,
    // True when this bucket has a complete Supabase configuration (URL, service
    // key and bucket name) — used to answer with one friendly message instead
    // of a stack trace when a deployment has not set the variables yet.
    isConfigured: ({ bucket } = {}) => Boolean(optionalBucketConfiguration(env, bucket)),
    // Public URL → storage path for this bucket (null when it is not ours).
    objectPathFromPublicUrl: (rawUrl, { bucket } = {}) => pathFromPublicObjectUrl(rawUrl, { bucket, env })
  };
};

export const supabaseStorage = createSupabaseStorage();


