// Browser glue: puts the rendered page on screen and turns DOM events into
// Controller calls. Behaviour lives in controller.js.

import { Controller } from './controller.js';
import { render, renderBanner } from './ui.js';

const root = document.getElementById('app');
const bannerRoot = document.getElementById('banner');

let storage;
try {
  storage = window.localStorage;
  storage.getItem('astro-a50.probe');
} catch {
  const m = new Map();
  storage = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
}

let pointerDown = false;
let renderQueued = false;
let bannerHtml = '';

const isTextField = (el) => el?.tagName === 'INPUT' && el.type !== 'range';

// Re-rendering replaces every control. It waits while a mouse button or
// finger is down, so a drag or a click (press, release) always ends on the
// element it started on. A text field being typed in keeps its text and
// caret across a re-render.
function draw() {
  if (pointerDown) {
    renderQueued = true;
    return;
  }
  renderQueued = false;
  const banner = renderBanner(controller.state);
  if (banner !== bannerHtml) {
    bannerRoot.innerHTML = banner;
    bannerHtml = banner;
  }
  const active = document.activeElement;
  const focusId = root.contains(active) ? active.id : null;
  const typing = isTextField(active) && root.contains(active)
    ? { value: active.value, start: active.selectionStart, end: active.selectionEnd } : null;
  root.innerHTML = render(controller.state);
  const el = focusId ? document.getElementById(focusId) : null;
  if (!el) return;
  if (typing && isTextField(el)) {
    el.value = typing.value;
    try { el.setSelectionRange(typing.start, typing.end); } catch { /* number fields have no caret API */ }
  }
  el.focus();
}

function flush() {
  if (renderQueued) setTimeout(draw, 0);
}

const controller = new Controller({
  hid: 'hid' in navigator ? navigator.hid : null,
  locks: navigator.locks ?? null,
  storage,
  demo: new URLSearchParams(location.search).has('demo'),
  draw,
  closeWindow: () => window.close(),
});

const NUMERIC = /^-?\d+$/;

function exportLibrary() {
  const url = URL.createObjectURL(new Blob([controller.exportLibrary()], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'astro-a50-presets.json' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importLibrary() {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'application/json,.json' });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (file) controller.importLibrary(await file.text());
  });
  input.click();
}

function onClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
  const action = el.dataset.action;
  if (action === 'lib-export') return exportLibrary();
  if (action === 'lib-import') return importLibrary();
  const value = el.dataset.value;
  controller.act(action, {
    value: value !== undefined && NUMERIC.test(value) ? Number(value) : value,
    slot: el.dataset.slot ? Number(el.dataset.slot) : undefined,
  });
  return undefined;
}
root.addEventListener('click', onClick);
bannerRoot.addEventListener('click', onClick);

// While dragging, only the number next to the control updates.
root.addEventListener('input', (e) => {
  const el = e.target;
  if (el.type !== 'range') return;
  const out = root.querySelector(`output[for="${el.id}"]`);
  if (!out) return;
  const v = Number(el.value);
  out.textContent = el.dataset.input === 'gain' ? `${v > 0 ? '+' : ''}${v}` : el.dataset.input === 'balance' ? String(v) : `${v}%`;
});

// Committed values (slider let go, field left or Enter) go to the headset.
root.addEventListener('change', (e) => {
  const el = e.target;
  const kind = el.dataset.input;
  if (!kind) return;
  const value = kind === 'name' ? el.value : Number(el.value);
  controller.commit(kind, value, { band: Number(el.dataset.band), slider: Number(el.dataset.value) });
});

// Arrow keys move between tabs, as in any tab list.
root.addEventListener('keydown', (e) => {
  const tab = e.target.closest('[role="tab"]');
  if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const tabs = [...root.querySelectorAll('[role="tab"]')];
  const i = tabs.indexOf(tab);
  const next = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: tabs.length - 1 }[e.key];
  const target = tabs[(next + tabs.length) % tabs.length];
  e.preventDefault();
  controller.act('tab', { value: target.dataset.value }).then(() => document.getElementById(target.id)?.focus());
});

document.addEventListener('pointerdown', () => { pointerDown = true; }, true);
for (const type of ['pointerup', 'pointercancel']) {
  // The click event follows pointerup in the same task; flush() waits a tick.
  document.addEventListener(type, () => {
    pointerDown = false;
    flush();
  }, true);
}

window.addEventListener('beforeunload', (e) => {
  if (controller.state.session?.changeCount()) e.preventDefault();
});

controller.init().catch((e) => controller.failed(e));
