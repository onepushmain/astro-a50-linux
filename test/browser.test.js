// Loads the real page in headless Chromium in ?demo mode (fake headset) and
// checks what it rendered. Skipped when Chromium is not installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('../app/', import.meta.url));
const BROWSER = process.env.CHROMIUM || 'chromium';
const hasBrowser = spawnSync(BROWSER, ['--version']).status === 0;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function serve() {
  const server = createServer(async (req, res) => {
    const path = normalize(join(APP, new URL(req.url, 'http://x').pathname));
    if (!path.startsWith(APP)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(path.endsWith('/') ? join(path, 'index.html') : path);
      res.writeHead(200, { 'content-type': TYPES[extname(path) || '.html'] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Opens url in headless Chromium and polls #app over the DevTools protocol
// until check(html) passes. (A one-shot --dump-dom can snapshot the page
// before async browser calls such as navigator.locks have answered.)
async function waitForApp(url, check, timeoutMs = 20000) {
  const profile = await mkdtemp(join(tmpdir(), 'a50-ui-'));
  const child = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`,
    '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' });
  let html = '';
  try {
    const end = Date.now() + timeoutMs;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let port;
    while (!port) {
      if (Date.now() > end) throw new Error('Chromium did not start');
      port = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').then((t) => t.split('\n')[0]).catch(() => null);
      if (!port) await sleep(50);
    }
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    };
    const evaluate = (expression) => new Promise((resolve) => {
      id += 1;
      pending.set(id, (msg) => resolve(msg.result?.result?.value));
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression } }));
    });
    while (Date.now() < end) {
      html = (await evaluate("document.getElementById('app')?.innerHTML ?? ''")) ?? '';
      if (check(html)) break;
      await sleep(100);
    }
    ws.close();
    return html;
  } finally {
    child.kill('SIGKILL');
    await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', resolve)));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test('the demo page renders the fake headset', { skip: !hasBrowser && 'chromium not installed', timeout: 60000 }, async () => {
  const server = await serve();
  try {
    const dom = await waitForApp(`http://127.0.0.1:${server.address().port}/?demo`, (h) => h.includes('data-input="gain"'));
    assert.match(dom, /DEMO · fake headset/);
    assert.match(dom, /<b>88%<\/b>/);
    assert.match(dom, />ASTRO\+</);
    assert.match(dom, /BASE STATION FW 35155\.43/);
    assert.match(dom, /data-input="gain"/);
  } finally {
    server.close();
  }
});

test('without WebHID permission the page asks to connect', { skip: !hasBrowser && 'chromium not installed', timeout: 60000 }, async () => {
  const server = await serve();
  try {
    const dom = await waitForApp(`http://127.0.0.1:${server.address().port}/`, (h) => h.includes('data-action="connect"'));
    assert.match(dom, /data-action="connect"/);
  } finally {
    server.close();
  }
});
