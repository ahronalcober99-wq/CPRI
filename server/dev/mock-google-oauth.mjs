// Local mock of Google's OAuth 2.0 endpoints, for end-to-end testing of the
// "Continue with Google" flow without real Google credentials.
//
// Implements the three endpoints the app talks to (see server/auth.js):
//   GET  /o/oauth2/v2/auth   -> immediately redirects back with a ?code=+state
//   POST /token              -> exchanges the code for a fake access token
//   GET  /userinfo           -> returns the profile from the JSON file below
//
// The profile is read from server/data/mock-google-profile.json on every
// /userinfo call, so you can edit that file and restart to test different
// scenarios (new user, existing email, admin email, ...).
//
// Start it with:  node server/dev/mock-google-oauth.mjs   (port 3200)
import http from 'http';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_FILE = join(__dirname, '..', 'data', 'mock-google-profile.json');
const PORT = Number(process.env.MOCK_GOOGLE_PORT || 3200);

async function profile() {
  try {
    return JSON.parse(await fs.readFile(PROFILE_FILE, 'utf8'));
  } catch {
    return {
      sub: 'mock-google-user-001',
      name: 'Mock Google User',
      email: 'mock.google.user@example.com',
      email_verified: true,
      picture: 'https://picsum.photos/seed/mock-google/200'
    };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // 1) Consent screen -> redirect back with a code + the same state.
  if (path === '/o/oauth2/v2/auth') {
    const redirectUri = url.searchParams.get('redirect_uri') || 'http://localhost:3000/api/auth/google/callback';
    const state = url.searchParams.get('state') || '';
    const code = randomBytes(16).toString('hex');
    const sep = redirectUri.includes('?') ? '&' : '?';
    res.writeHead(302, { Location: `${redirectUri}${sep}code=${code}&state=${encodeURIComponent(state)}` });
    res.end();
    return;
  }

  // 2) Token exchange -> fake access token.
  if (path === '/token') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const params = new URLSearchParams(body);
    const code = params.get('code') || 'missing';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      access_token: `mock-token-${code}`,
      token_type: 'Bearer',
      expires_in: 3600,
      id_token: 'mock-id-token'
    }));
    return;
  }

  // 3) Userinfo -> the configured mock profile.
  if (path === '/userinfo') {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing token' }));
      return;
    }
    const p = await profile();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sub: p.sub, name: p.name, email: p.email, email_verified: p.email_verified, picture: p.picture }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => {
  console.log(`[mock-google] OAuth mock listening on http://localhost:${PORT}`);
  console.log(`[mock-google] profile file: ${PROFILE_FILE}`);
});
