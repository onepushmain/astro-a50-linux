// Loads the real page in headless Chromium over the DevTools protocol, in
// ?demo mode (fake headset) or without a device. Skipped when Chromium is
// not installed.
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
const skip = !hasBrowser && 'chromium not installed';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Opens a page and returns helpers that drive it like a user would. (A
// one-shot --dump-dom can snapshot before async browser calls answer.)
async function openPage(path) {
  const server = await serve();
  const profile = await mkdtemp(join(tmpdir(), 'a50-ui-'));
  const child = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`,
    '--window-size=1400,1000', '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' });
  const close = async () => {
    child.kill('SIGKILL');
    await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', resolve)));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    server.close();
  };
  try {
    let port;
    for (let i = 0; !port; i++) {
      if (i > 400) throw new Error('Chromium did not start');
      port = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').then((t) => t.split('\n')[0]).catch(() => null);
      if (!port) await sleep(50);
    }
    const url = `http://127.0.0.1:${server.address().port}${path}`;
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
    const send = (method, params = {}) => new Promise((resolve) => {
      id += 1;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value;
    const waitFor = async (expression, timeoutMs = 20000) => {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        if (await evaluate(expression)) return true;
        await sleep(50);
      }
      throw new Error(`timed out waiting for ${expression}`);
    };
    // A real press and release, a human-like 120 ms apart.
    const click = async (elementId) => {
      const { x, y } = await evaluate(`(() => { const el = document.getElementById(${JSON.stringify(elementId)});
        el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      const base = { x, y, button: 'left', clickCount: 1 };
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
      await sleep(120);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
    };
    const html = () => evaluate('document.body.innerHTML');
    return { evaluate, waitFor, click, send, html, close: async () => { ws.close(); await close(); } };
  } catch (e) {
    await close();
    throw e;
  }
}

test('the demo page renders the fake headset', { skip, timeout: 60000 }, async () => {
  const page = await openPage('/?demo');
  try {
    await page.waitFor("!!document.querySelector('[data-input=\"gain\"]')");
    const dom = await page.html();
    assert.match(dom, /DEMO · fake headset/);
    assert.match(dom, /<b>88%<\/b>/);
    assert.match(dom, />ASTRO\+</);
    assert.match(dom, /BASE STATION FW 35155\.43/);
  } finally {
    await page.close();
  }
});

test('without WebHID permission the page asks to connect', { skip, timeout: 60000 }, async () => {
  const page = await openPage('/');
  try {
    await page.waitFor("!!document.querySelector('[data-action=\"connect\"]')");
  } finally {
    await page.close();
  }
});

test('the first click after typing in a field is not lost', { skip, timeout: 60000 }, async () => {
  const page = await openPage('/?demo');
  try {
    await page.waitFor("!!document.getElementById('advanced-toggle')");
    await page.click('advanced-toggle');
    await page.waitFor("!!document.getElementById('freq-2')");
    await page.click('freq-2');
    await page.evaluate("document.getElementById('freq-2').select()");
    await page.send('Input.insertText', { text: '500' });
    await page.click('lib-add-editor');
    await page.waitFor("!!document.getElementById('lib-pick-0')", 5000);
    await page.waitFor("document.getElementById('freq-2').value === '500'", 5000);
  } finally {
    await page.close();
  }
});

test('a banner survives re-renders without being re-inserted', { skip, timeout: 60000 }, async () => {
  const page = await openPage('/?demo');
  try {
    await page.waitFor("!!document.getElementById('lib-add-editor')");
    await page.click('lib-add-editor');
    await page.waitFor("!!document.querySelector('#banner .banner')");
    await page.evaluate("window.firstBanner = document.querySelector('#banner .banner')");
    await page.click('tab-mic');
    await page.waitFor("document.getElementById('tab-mic').getAttribute('aria-selected') === 'true'");
    assert.equal(await page.evaluate("document.querySelector('#banner .banner') === window.firstBanner"), true);
  } finally {
    await page.close();
  }
});
