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

async function dumpDom(url) {
  const profile = await mkdtemp(join(tmpdir(), 'a50-ui-'));
  try {
    const child = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`,
      '--virtual-time-budget=4000', '--dump-dom', url], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    await new Promise((resolve) => child.on('close', resolve));
    return out;
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

test('the demo page renders the fake headset', { skip: !hasBrowser && 'chromium not installed', timeout: 60000 }, async () => {
  const server = await serve();
  try {
    const dom = await dumpDom(`http://127.0.0.1:${server.address().port}/?demo`);
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
    const dom = await dumpDom(`http://127.0.0.1:${server.address().port}/`);
    assert.match(dom, /data-action="connect"/);
  } finally {
    server.close();
  }
});
