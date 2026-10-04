function configuration(env) {
  const baseUrl = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const serviceKey = String(env.SUPABASE_SERVICE_KEY || '').trim();
  const bucket = String(env.SUPABASE_BUCKET || '').trim();
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
  const segments = String(path || '').split('/');
  if (!path || segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error('Storage path is invalid.');
  }
  return segments.map(encodeURIComponent).join('/');
}

async function responseError(response, operation) {
  if (response.ok) return;
  throw new Error(`Supabase Storage ${operation} failed with HTTP ${response.status}.`);
}

export function createSupabaseStorage({ env = process.env, fetchImpl = fetch } = {}) {
  async function request(path, init, operation) {
    const config = configuration(env);
    const response = await fetchImpl(`${config.baseUrl}/storage/v1/${path}`, {
      ...init,
      headers: {
        apikey: config.serviceKey,
        Authorization: `Bearer ${config.serviceKey}`,
        ...(init?.headers || {})
      }
    });
    return { config, response, operation };
  }

  async function uploadObject({ path, buffer, contentType }) {
    if (!Buffer.isBuffer(buffer)) throw new Error('Storage upload requires a file buffer.');
    const encodedPath = encodePath(path);
    const { response } = await request(
      `object/${encodeURIComponent(String(env.SUPABASE_BUCKET || '').trim())}/${encodedPath}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': contentType,
          'x-upsert': 'false'
        },
        body: buffer
      },
      'upload'
    );
    await responseError(response, 'upload');
    return { path };
  }

  async function createSignedDownloadUrl({ path, downloadName, expiresIn = 60 }) {
    if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 60) {
      throw new Error('Signed URL expiry must be from 1 to 60 seconds.');
    }
    const encodedPath = encodePath(path);
    const { config, response } = await request(
      `object/sign/${encodeURIComponent(String(env.SUPABASE_BUCKET || '').trim())}/${encodedPath}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn, download: String(downloadName || 'download') })
      },
      'sign'
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
    const { response } = await request(
      `object/${encodeURIComponent(String(env.SUPABASE_BUCKET || '').trim())}/${encodedPath}`,
      { method: 'HEAD' },
      'check'
    );
    if (response.status === 404) return false;
    await responseError(response, 'check');
    return true;
  }

  async function deleteObjects(paths) {
    if (!Array.isArray(paths) || paths.length === 0) return;
    const { response } = await request(
      `object/${encodeURIComponent(String(env.SUPABASE_BUCKET || '').trim())}`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: paths.map(path => String(path)) })
      },
      'delete'
    );
    await responseError(response, 'delete');
  }

  return { uploadObject, createSignedDownloadUrl, objectExists, deleteObjects };
}

export const supabaseStorage = createSupabaseStorage();
