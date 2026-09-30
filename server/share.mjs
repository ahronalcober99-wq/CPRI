// Share script — open a public tunnel to the local CPRI site so friends can
// view it from anywhere (not just your LAN).
//
//   npm run share            -> make sure the server is up, open a tunnel, print URL
//   npm run share:setup      -> download cloudflared (no account needed) into .tools/
//   npm run share -- --ngrok -> force ngrok (requires a free account + authtoken)
//   npm run share -- --port 8080 -> tunnel a different local port
//
// Two tunnel providers are supported:
//   1. cloudflared (Cloudflare Quick Tunnel) — NO account, no token. Preferred.
//   2. ngrok — needs `ngrok config add-authtoken <token>` once. Used if configured.
//
// The script keeps running for the life of the tunnel; press Ctrl+C to close it.

import { spawn, spawnSync } from 'child_process';
import { setTimeout as sleep } from 'timers/promises';
import { promises as fs, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import http from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TOOLS_DIR = join(ROOT, '.tools');
const SERVER_LOG = join(ROOT, '.freebuff', 'share-server.log');
const ACCESS_KEY_FILE = join(ROOT, 'server', 'data', 'demo-access.key');

const G = (s) => `\x1b[32m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const C = (s) => `\x1b[36m${s}\x1b[0m`;
const B = (s) => `\x1b[1m${s}\x1b[0m`;

const argv = process.argv.slice(2);
const forceNgrok = argv.includes('--ngrok');
const portIdx = argv.indexOf('--port');
// NOTE: default to 3000 and do NOT inherit ambient PORT — the Freebuff preview
// infra (and some shells) carry a random PORT var, which would tunnel the wrong
// port. Only an explicit --port flag changes the target.
const PORT = portIdx !== -1 ? argv[portIdx + 1] : '3000';
const LOCAL_URL = `http://localhost:${PORT}`;

// ---------------------------------------------------------------------------
// Server readiness
// ---------------------------------------------------------------------------

function isUp(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function ensureServer() {
  if (await isUp(LOCAL_URL)) {
    console.log(`${G('✓')} Server already running at ${C(LOCAL_URL)}`);
    return;
  }
  console.log(`${Y('…')} Server not running — starting it on port ${PORT} …`);
  const logFd = await fs.open(SERVER_LOG, 'a').catch(() => null);
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT,
    detached: true,
    stdio: logFd ? ['ignore', logFd, logFd] : 'ignore',
    windowsHide: true,
    env: { ...process.env, PORT }
  });
  child.unref();
  if (logFd) logFd.close().catch(() => {});
  // Wait up to 20s for it to answer.
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await isUp(LOCAL_URL)) {
      console.log(`${G('✓')} Server started at ${C(LOCAL_URL)}`);
      return;
    }
  }
  console.error(`${B('✗')} Server did not come up on port ${PORT}. Check the log: ${C('.freebuff/share-server.log')} (or run \`npm start\` first).`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Tunnel binary discovery
// ---------------------------------------------------------------------------

async function findBinary(names) {
  // 1) project-local .tools/ dir
  for (const n of names) {
    const local = join(TOOLS_DIR, n);
    if (existsSync(local)) return local;
  }
  // 2) PATH (spawnSync resolves it)
  for (const n of names) {
    const res = spawnSync(n, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (!res.error && (res.status === 0 || (res.stderr || '').includes('version'))) return n;
  }
  return null;
}

async function findCloudflared() {
  return findBinary(['cloudflared.exe', 'cloudflared', 'cloudflared-windows-amd64.exe']);
}
async function findNgrok() {
  return findBinary(['ngrok.exe', 'ngrok']);
}

// ---------------------------------------------------------------------------
// Tunnel launchers — each resolves with the public URL and keeps the child
// ---------------------------------------------------------------------------

function spawnTunnel(bin, args) {
  const child = spawn(bin, args, { cwd: ROOT, windowsHide: true });
  child.on('error', () => {});
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});
  return child;
}

async function startCloudflared(bin) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['tunnel', '--url', LOCAL_URL, '--no-autoupdate'], {
      cwd: ROOT, windowsHide: true
    });
    let out = '';
    let settled = false;
    const finish = (fn, ...args) => { if (!settled) { settled = true; fn(...args); } };
    const timer = setTimeout(() => {
      child.kill();
      finish(reject, new Error('cloudflared did not print a tunnel URL within 40s.\n' + out.slice(-800)));
    }, 40000);
    const onData = (chunk) => {
      out += chunk.toString();
      const m = out.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/);
      if (m) { clearTimeout(timer); finish(resolve, { child, url: m[0] }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => { clearTimeout(timer); finish(reject, err); });
    // Fail fast if the process dies before printing a URL (bad config, etc.).
    child.on('exit', (code) => {
      if (settled) return;
      clearTimeout(timer);
      finish(reject, new Error(`cloudflared exited with code ${code} before exposing a tunnel.\n` + out.slice(-800)));
    });
  });
}

async function startNgrok(bin) {
  const child = spawnTunnel(bin, ['http', PORT, '--log', 'stdout']);
  let exited = null;
  child.on('exit', (code) => { exited = code; });
  // Poll ngrok's local API for the assigned public URL.
  for (let i = 0; i < 40; i++) {
    if (exited !== null) {
      child.kill();
      throw new Error(`ngrok exited with code ${exited} before exposing a tunnel. Is it authed? Run: ngrok config add-authtoken <token>`);
    }
    await sleep(500);
    const tunnels = await new Promise((resolve) => {
      http.get('http://127.0.0.1:4040/api/tunnels', { timeout: 1000 }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try { resolve(JSON.parse(body).tunnels || []); } catch { resolve([]); }
        });
      }).on('error', () => resolve([]));
    });
    const pub = tunnels.find((t) => t.public_url && t.public_url.startsWith('https'));
    if (pub) return { child, url: pub.public_url };
  }
  child.kill();
  throw new Error('ngrok did not expose a tunnel. Is it authed? Run: ngrok config add-authtoken <token>');
}

// ---------------------------------------------------------------------------
// Nice extras
// ---------------------------------------------------------------------------

function copyToClipboard(text) {
  return new Promise((resolve) => {
    try {
      const exe = process.platform === 'win32' ? 'clip' : 'pbcopy';
      const p = spawn(exe, [], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
      p.stdin.end(text);
    } catch { resolve(false); }
  });
}

// Read a single key from .env WITHOUT printing its value (the share script does
// not load dotenv). Used to know whether real Google OAuth is configured and to
// tell the user which redirect URI to register for the current tunnel URL.
function envFromDotenv(key) {
  try {
    const txt = readFileSync(join(ROOT, '.env'), 'utf8');
    const m = txt.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)\\s*$`, 'm'));
    if (!m) return '';
    let v = m[1].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v;
  } catch { return ''; }
}

function sleepForever() {
  return new Promise(() => {});
}

// ---------------------------------------------------------------------------
// Setup: download cloudflared into .tools/ (no account required)
// ---------------------------------------------------------------------------

async function setupCloudflared() {
  if (await findCloudflared()) {
    console.log(`${G('✓')} cloudflared already available.`);
    return;
  }
  const url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
  const dest = join(TOOLS_DIR, 'cloudflared.exe');
  console.log(`${Y('…')} Downloading cloudflared (${C(url)}) …`);
  await fs.mkdir(TOOLS_DIR, { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
  console.log(`${G('✓')} Installed to ${C(dest)} (${(buf.length / 1024 / 1024).toFixed(1)} MB).`);
  console.log(`    Now run ${B('npm run share')} to open your public link.`);
}

// ---------------------------------------------------------------------------

async function main() {
  if (argv.includes('--setup')) {
    await setupCloudflared();
    return;
  }

  await ensureServer();

  const cloudflared = await findCloudflared();
  const ngrok = await findNgrok();

  let provider;
  if (forceNgrok) {
    if (!ngrok) {
      console.error(`${B('✗')} ngrok not found. Install it from https://ngrok.com/download and run \`ngrok config add-authtoken <token>\`.`);
      process.exit(1);
    }
    provider = 'ngrok';
  } else if (cloudflared) {
    provider = 'cloudflared';
  } else if (ngrok) {
    provider = 'ngrok';
  } else {
    console.error(`
${B('✗')} No tunnel tool found. Pick one:

  ${B('Option A (recommended, no account):')} cloudflared
    ${B('npm run share:setup')}   → downloads it into .tools/ automatically
    Then run ${B('npm run share')} again.

  ${B('Option B:')} ngrok (needs a free account + authtoken)
    1. Install from https://ngrok.com/download
    2. Run:  ngrok config add-authtoken <your-token>
    3. Run:  npm run share
`);
    process.exit(1);
  }

  console.log(`${Y('…')} Opening ${provider} tunnel to ${C(LOCAL_URL)} …`);
  let tunnel;
  try {
    tunnel = provider === 'cloudflared'
      ? await startCloudflared(cloudflared)
      : await startNgrok(ngrok);
  } catch (err) {
    console.error(`${B('✗')} ${err.message}`);
    process.exit(1);
  }

  // Full-access link: writes an access key + expiry the server checks; the
  // /demo-login route logs the visitor in as admin. Deleting the key file on
  // exit revokes every outstanding link (the server also self-expires keys
  // after 30 days, so a crashed session can't leave a live link forever).
  const accessKey = randomBytes(24).toString('hex');
  const keyWritten = await (async () => {
    try {
      await fs.mkdir(dirname(ACCESS_KEY_FILE), { recursive: true });
      await fs.writeFile(ACCESS_KEY_FILE, JSON.stringify({
        key: accessKey,
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000
      }), 'utf8');
      return true;
    } catch (err) {
      console.error(`${Y('!')} Could not write demo access key (${err.message}) — full-access link disabled.`);
      return false;
    }
  })();
  const fullUrl = keyWritten ? `${tunnel.url}/api/auth/demo-login?key=${accessKey}` : null;
  const copied = await copyToClipboard(tunnel.url);

  // Google OAuth: the tunnel URL changes every run, so tell the user the exact
  // redirect URI they must add to the Cloud Console client for "Continue with
  // Google" to work through the public link. Only the boolean is reported —
  // never the secret itself.
  const googleRedirect = `${tunnel.url}/api/auth/google/callback`;
  const googleConfigured = Boolean(envFromDotenv('GOOGLE_CLIENT_ID'));
  const googleLine = googleConfigured
    ? `  ${G('✓')} Google sign-in configured — add this redirect URI in Cloud Console:
  ${C(B('  ' + googleRedirect))}`
    : `  ${Y('!')} Google sign-in not configured. To enable it, add GOOGLE_CLIENT_ID/SECRET
    to .env, then register this redirect URI:
  ${C(B('  ' + googleRedirect))}`;

  console.log(`
${B('══════════════════════════════════════════════════════')}
${B('  Share this link with your friends (public site):')}
${G(B('  ' + tunnel.url))}
${keyWritten ? `${B('')}
${B('  FULL-ACCESS link (auto-login as admin):')}
${C(B('  ' + fullUrl))}` : `${B('')}
${Y('  (full-access link unavailable — access key could not be written)')}`}
${B('')}
${B('  Google sign-in redirect URI:')}
${googleLine}
${B('')}
${Y('  Lifetime: up to 30 days — links stay valid while this PC is on and this')}
${Y('  process runs. A PC restart or process restart issues a NEW url.')}
${B('══════════════════════════════════════════════════════')}
${copied ? '  ✓ Public URL copied to clipboard' : ''}
  Press ${B('Ctrl+C')} to close the tunnel.
`);
  // Keep the process alive; Ctrl+C kills the child automatically on most
  // shells, but be explicit on Windows. rmSync (not async rm) so the key file
  // is really gone before process.exit tears down pending I/O.
  const shutdown = () => {
    tunnel.child.kill();
    try { fs.rmSync(ACCESS_KEY_FILE, { force: true }); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Hard 30-day lifetime cap: cleanly stop (and revoke the key) after that,
  // so a forgotten session can't keep the admin link alive indefinitely.
  // Node's setTimeout clamps delays to a signed 32-bit int (~24.8 days), which
  // would make a 30-day timer fire instantly — re-arm in chunks until done.
  const LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
  const MAX_DELAY = 2_147_483_647;
  const armLifetimeTimer = (remaining) => {
    if (remaining <= 0) {
      console.log(`\n${Y('!')} 30-day lifetime reached — stopping tunnel and revoking the access key.`);
      shutdown();
      return;
    }
    setTimeout(() => armLifetimeTimer(remaining - MAX_DELAY), Math.min(remaining, MAX_DELAY)).unref();
  };
  armLifetimeTimer(LIFETIME_MS);
  await sleepForever();
}

main().catch((err) => {
  console.error('[share] Failed:', err.message || err);
  process.exit(1);
});
