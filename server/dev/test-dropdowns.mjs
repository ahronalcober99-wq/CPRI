// ============================================================
//  Dropdown behavior regression test
//  Exercises the desktop navbar mega-menus on EVERY page that
//  injects the header (any page with #site-header):
//    • label click toggles open/close
//    • Escape closes an open dropdown
//    • clicking outside closes it
//    • clicking a submenu item closes it (navigation proceeds)
//    • hover opens, hover-leave closes (after the 250ms hold)
//
//  Uses headless Chrome via CDP — no test framework required.
//
//  Usage:
//    node server/dev/test-dropdowns.mjs                      # all pages
//    BASE_URL=http://localhost:3100 node server/dev/test-dropdowns.mjs
//    node server/dev/test-dropdowns.mjs --only=about.html    # one page
//    node server/dev/test-dropdowns.mjs --cdp-port=9333
//    CHROME_PATH=... node server/dev/test-dropdowns.mjs
//
//  Exits 0 when every check passes, 1 otherwise.
// ============================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const args = process.argv.slice(2);
const onlyPage = (args.find(a => a.startsWith('--only=')) || '').split('=')[1] || null;
const CDP_PORT = Number((args.find(a => a.startsWith('--cdp-port=')) || '').split('=')[1]) || 9333;
const VIEW_W = 1400, VIEW_H = 900;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const profileDir = path.join(os.tmpdir(), `cpri-dropdown-test-${process.pid}`);
let chrome = null;

// ---------- page discovery ----------
function pagesWithDropdowns() {
  return fs.readdirSync(PUBLIC_DIR)
    .filter(f => f.endsWith('.html'))
    .filter(f => {
      if (onlyPage && f !== onlyPage) return false;
      try {
        return fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8').includes('id="site-header"');
      } catch { return false; }
    })
    .sort();
}

// ---------- chrome + CDP ----------
async function launchChrome() {
  const exe = CHROME_CANDIDATES.find(c => c && fs.existsSync(c));
  if (!exe) throw new Error('Chrome not found — set CHROME_PATH.');
  fs.mkdirSync(profileDir, { recursive: true });
  chrome = spawn(exe, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir.replace(/\\/g, '/')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    `--window-size=${VIEW_W},${VIEW_H}`, 'about:blank'
  ], { stdio: 'ignore', detached: true });

  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
      const targets = await res.json();
      const page = targets.find(t => t.type === 'page');
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Chrome DevTools did not come up — port busy? try --cdp-port=NNNN');
}

async function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, m => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evalJS = async expression => {
    const out = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return out.result.value;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1, mobile: false });
  return { ws, send, evalJS };
}

// ---------- per-page suite ----------
async function testPage(env, page) {
  const { ws, send, evalJS } = env;
  await send('Page.navigate', { url: `${BASE}/${page}` });

  // Wait for the injected desktop nav dropdowns to render.
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await sleep(200);
    try {
      ready = await evalJS(`(() => {
        const g = document.querySelector('.cpri-group');
        return !!g && !!g.querySelector('.cpri-submenu a')
          && getComputedStyle(document.querySelector('.cpri-nav-links')).display !== 'none';
      })()`);
    } catch { /* page still loading */ }
  }
  if (!ready) return { page, checks: null, error: 'dropdowns did not render' };

  // Each check starts from a known-closed state so a failure in one check never
  // cascades into the next (keeps the ✗ marks pointing at the real offender).
  const reset = `document.querySelectorAll('.cpri-group.open').forEach(g => g.classList.remove('open')); `;

  const checks = {
    toggle:  await evalJS(`(() => {
      ${reset}
      const g = document.querySelector('.cpri-group');
      const label = g.querySelector('.cpri-group-label');
      label.click();
      const opened = g.classList.contains('open');
      label.click();
      const closed = !g.classList.contains('open');
      return { opened, closed };
    })()`),

    escape:  await evalJS(`(() => {
      ${reset}
      const g = document.querySelector('.cpri-group');
      g.querySelector('.cpri-group-label').click();
      const opened = g.classList.contains('open');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { opened, closed: !g.classList.contains('open') };
    })()`),

    outside: await evalJS(`(() => {
      ${reset}
      const g = document.querySelector('.cpri-group');
      g.querySelector('.cpri-group-label').click();
      const opened = g.classList.contains('open');
      document.body.click();
      return { opened, closed: !g.classList.contains('open') };
    })()`),

    item:    await evalJS(`(() => {
      ${reset}
      const g = document.querySelector('.cpri-group');
      const label = g.querySelector('.cpri-group-label');
      label.click();
      const opened = g.classList.contains('open');
      const item = g.querySelector('.cpri-submenu a');
      // Block the navigation so the click only exercises the close behavior.
      const blocker = e => { if (e.target.closest('.cpri-submenu a')) e.preventDefault(); };
      document.addEventListener('click', blocker, true);
      item && item.click();
      const closed = !g.classList.contains('open');
      document.removeEventListener('click', blocker, true);
      return { opened, closed, hadItem: !!item };
    })()`),

    hover:   await evalJS(`(async () => {
      ${reset}
      const g = document.querySelector('.cpri-group');
      g.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      const opened = g.classList.contains('open');
      g.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
      await new Promise(r => setTimeout(r, 450)); // 250ms hover-hold + margin
      return { opened, closed: !g.classList.contains('open') };
    })()`)
  };

  const ok = name => {
    const r = checks[name];
    if (!r) return false;
    return name === 'item' ? (r.opened && r.closed && r.hadItem) : (r.opened && r.closed);
  };
  return { page, checks, error: null, pass: ['toggle', 'escape', 'outside', 'item', 'hover'].every(ok) };
}

// ---------- runner ----------
async function main() {
  const pages = pagesWithDropdowns();
  if (!pages.length) {
    console.log(`No pages with #site-header found in ${PUBLIC_DIR}${onlyPage ? ' (--only matched nothing)' : ''}`);
    process.exit(1);
  }

  // Sanity-check the server before launching a browser.
  try {
    const res = await fetch(BASE);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error(`Server not reachable at ${BASE} (${err.message}). Start it first: npm start`);
    process.exit(1);
  }

  console.log(`Dropdown test — ${pages.length} page(s), base ${BASE}, viewport ${VIEW_W}x${VIEW_H}\n`);
  let chromeTarget;
  try { chromeTarget = await launchChrome(); }
  catch (err) { console.error(err.message); process.exit(1); }

  const env = await connect(chromeTarget);
  const results = [];
  for (const page of pages) {
    try {
      results.push(await testPage(env, page));
    } catch (err) {
      results.push({ page, checks: null, error: err.message });
    }
  }

  env.ws.close();
  await sleep(100);
  try { chrome.kill(); } catch {}
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}

  let failed = 0;
  for (const r of results) {
    if (r.error) { failed++; console.log(`✗ ${r.page} — ${r.error}`); continue; }
    const marks = ['toggle', 'escape', 'outside', 'item', 'hover']
      .map(n => (r.checks[n] && (n === 'item' ? (r.checks[n].opened && r.checks[n].closed && r.checks[n].hadItem) : (r.checks[n].opened && r.checks[n].closed)) ? '✓' : '✗'));
    const ok = marks.every(m => m === '✓');
    if (!ok) failed++;
    console.log(`${ok ? '✓' : '✗'} ${r.page} — toggle ${marks[0]} · escape ${marks[1]} · outside ${marks[2]} · item ${marks[3]} · hover ${marks[4]}`);
  }

  console.log(`\n${results.length - failed}/${results.length} pages passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); try { chrome && chrome.kill(); } catch {} process.exit(1); });
