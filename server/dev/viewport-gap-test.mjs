// One-off: dump exact header positions at a phone width in headless Chrome.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9224;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '../..');
const W = Number(process.argv[2]) || 390;
const sleep = ms => new Promise(r => setTimeout(r, ms));

try { spawn('taskkill', ['/PID', fs.readFileSync(path.join(ROOT, '.freebuff/chrome-gap.pid'), 'utf8').trim(), '/T', '/F']); } catch {}
try { fs.rmSync(path.join(ROOT, '.freebuff/chrome-gap-test'), { recursive: true, force: true }); } catch {}

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(ROOT, '.freebuff/chrome-gap-test').replace(/\\/g, '/')}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  `--window-size=${W},700`, 'about:blank'
], { stdio: 'ignore', detached: true });
fs.writeFileSync(path.join(ROOT, '.freebuff/chrome-gap.pid'), String(chrome.pid));

async function getTarget() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/json`);
      const t = await res.json();
      const page = t.find(x => x.type === 'page');
      if (page) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error('devtools not reachable');
}

const target = await getTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, m => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise(r => ws.onopen = r);
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: 700, deviceScaleFactor: 1, mobile: true });
const evalJS = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;

await send('Page.navigate', { url: 'http://localhost:3000/index.html' });
let ready = false;
for (let i = 0; i < 70 && !ready; i++) { await sleep(200); try { ready = await evalJS(`!!document.querySelector('.cpri-util') && document.querySelector('.cpri-util').children.length >= 3`); } catch {} }
if (!ready) { console.log(JSON.stringify({ error: 'not ready' })); process.exit(1); }

const out = await evalJS(`(() => {
  const visible = el => getComputedStyle(el).display !== 'none';
  const brand = document.querySelector('.cpri-brand').getBoundingClientRect();
  const kids = [...document.querySelectorAll('.cpri-util > *')].filter(visible).map(el => {
    const r = el.getBoundingClientRect();
    return { id: el.id || el.textContent.trim(), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) };
  });
  const gaps = [];
  let prevRight = Math.round(brand.right);
  for (const k of kids) { gaps.push({ after: k.id, px: Math.round(k.left) - prevRight }); prevRight = k.right; }
  const navInner = document.querySelector('.nav-inner');
  return {
    viewport: innerWidth,
    brand: { left: Math.round(brand.left), right: Math.round(brand.right) },
    kids,
    gaps,
    rowOverflows: navInner.scrollWidth > navInner.clientWidth,
    navInnerClientW: navInner.clientWidth, navInnerScrollW: navInner.scrollWidth
  };
})()`);
console.log(JSON.stringify(out, null, 2));
ws.close(); chrome.kill(); process.exit(0);
