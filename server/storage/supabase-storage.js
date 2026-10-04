function normalizeEnvValue(value) {
  let normalized = String(value || '').trim();
  if (normalized.length >= 2 &&
      ((normalized.startsWith('"') && normalized.endsWith('"')) ||
       (normalized.startsWith("'") && normalized.endsWith("'")))) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

function configuration(env) {
  const baseUrl = normalizeEnvValue(env.SUPABASE_URL).replace(/\/+$/, '');
  const serviceKey = normalizeEnvValue(env.SUPABASE_SERVICE_KEY);
  const bucket = normalizeEnvValue(env.SUPABASE_BUCKET);
  const missing = [];
  if (!baseUrl) missing.push('SUPABASE_URL');
  if (!serviceKey) missing.push('SUPABASE_SERVICE_KEY');
  if (!bucket) missing.push('SUPABASE_BUCKET');
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

async function responseError(response, operation) {
  if (response.ok) return;
  throw new Error(`Supabase Storage ${operation} failed with HTTP ${response.status}.`);
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

  async function uploadObject({ path, buffer, contentType }) {
    if (!Buffer.isBuffer(buffer)) throw new Error('Storage upload requires a file buffer.');
    const encodedPath = encodePath(path);
    const config = configuration(env);
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
    await responseError(response, 'sign');
    const body = await response.json();
    if (typeof body.signedURL !== 'string' || !body.signedURL) {
      throw new Error('Supabase Storage did not return a signed URL.');
    }
    return new URL(body.signedURL, config.baseUrl).href;
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
    await responseError(response, 'check');
    return true;
  }

  async function deleteObjects(paths) {
    if (!Array.isArray(paths) || paths.length === 0) return;
    const config = configuration(env);
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
    await responseError(response, 'delete');
  }

  return { uploadObject, createSignedDownloadUrl, objectExists, deleteObjects, checkBucket, verifyBucketAtStartup };
}

export const supabaseStorage = createSupabaseStorage();
