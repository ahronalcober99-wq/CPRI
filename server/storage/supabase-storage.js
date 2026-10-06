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
  if (projectUrl.protocol !== 'https:') {
    throw new Error('SUPABASE_URL must be a valid HTTPS URL.');
  }

  return { baseUrl, serviceKey, bucket };
}

function bucketConfiguration(env, bucket) {
  if (bucket === undefined || bucket === 'private') return configuration(env);
  if (bucket === 'events') return configuration(env, 'SUPABASE_EVENT_BUCKET');
  throw new Error('Storage bucket is invalid.');
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

  return { uploadObject, publicObjectUrl, createSignedDownloadUrl, objectExists, deleteObjects, checkBucket, verifyBucketAtStartup };
}

export const supabaseStorage = createSupabaseStorage();
