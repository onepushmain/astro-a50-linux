// Page wiring: finds the base station over WebHID (or a fake one with
// ?demo), loads a Session, renders, and turns clicks into Session calls.

import { VENDOR_ID, PRODUCT_ID, USAGE_PAGE, REPORT_ID, HeadsetNotConnected } from './protocol.js';
import { A50, DeviceTimeout } from './device.js';
import { FakeA50 } from './fake-a50.js';
import { Session } from './session.js';
import { Library } from './library.js';
import { render } from './ui.js';

const STATUS_POLL_MS = 30000;
const root = document.getElementById('app');
const demo = new URLSearchParams(location.search).has('demo');

let storage;
try {
  storage = window.localStorage;
  storage.getItem(Library.KEY);
} catch {
  const m = new Map();
  storage = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
}
const library = new Library(storage);

const state = {
  screen: 'loading',
  demo,
  session: null,
  library: library.list(),
  view: { tab: 'eq', sel: 1, lib: null, adv: false },
  banner: null,
};
let hidDevice = null;
let poll = null;
let dragging = false;
let renderQueued = false;

function draw() {
  // Re-rendering replaces the inputs, so wait until a slider is let go.
  if (dragging) { renderQueued = true; return; }
  renderQueued = false;
  const focusId = document.activeElement?.id;
  root.innerHTML = render(state);
  if (focusId) document.getElementById(focusId)?.focus();
}

function show(text, kind = 'info', extra = {}) {
  state.banner = text ? { text, kind, ...extra } : null;
  draw();
}

function isA50(d) {
  return d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID && d.collections.some((c) => c.usagePage === USAGE_PAGE);
}

function hidTransport(device) {
  return {
    send: (bytes) => device.sendReport(REPORT_ID, bytes),
    onInput: (cb) => device.addEventListener('inputreport', (e) => {
      if (e.reportId === REPORT_ID) cb(new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength));
    }),
  };
}

async function start(transport) {
  const session = new Session(new A50(transport));
  state.screen = 'loading';
  state.banner = null;
  draw();
  try {
    await session.load();
  } catch (e) {
    if (e instanceof HeadsetNotConnected) {
      state.screen = 'headset-off';
      draw();
      return;
    }
    state.screen = 'connect';
    show(e.message, 'error');
    return;
  }
  session.onChange(draw);
  state.session = session;
  state.screen = 'main';
  state.view.sel = session.activeSlot;
  draw();
  clearInterval(poll);
  poll = setInterval(() => session.refreshStatus().catch(failed), STATUS_POLL_MS);
}

async function openDevice(device) {
  hidDevice = device;
  if (!device.opened) await device.open();
  await start(hidTransport(device));
}

async function boot() {
  if (demo) {
    await start(new FakeA50({ latencyMs: 2 }).transport);
    return;
  }
  if (!('hid' in navigator)) {
    state.screen = 'no-webhid';
    draw();
    return;
  }
  navigator.hid.addEventListener('disconnect', (e) => {
    if (e.device !== hidDevice) return;
    clearInterval(poll);
    hidDevice = null;
    state.session = null;
    state.screen = 'connect';
    show('The base station was unplugged. Unsaved changes on it are whatever the device kept.', 'error');
  });
  navigator.hid.addEventListener('connect', (e) => {
    if (!hidDevice && isA50(e.device)) openDevice(e.device).catch(failed);
  });
  state.screen = 'connect';
  draw();
  const known = (await navigator.hid.getDevices()).find(isA50);
  if (known) await openDevice(known).catch(failed);
}

function failed(e) {
  if (e instanceof DeviceTimeout) {
    clearInterval(poll);
    state.session = null;
    state.screen = 'connect';
  }
  show(e.message, 'error');
}

const session = () => state.session;
const slotNum = (el) => Number(el.dataset.slot);

const actions = {
  async connect() {
    const [device] = await navigator.hid.requestDevice({
      filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID, usagePage: USAGE_PAGE }],
    });
    if (device) await openDevice(device);
  },
  async retry() {
    if (demo) return boot();
    if (hidDevice) return start(hidTransport(hidDevice));
    return boot();
  },
  tab(el) { state.view.tab = el.dataset.value; draw(); },
  select(el) { state.view.sel = slotNum(el); draw(); },
  activate(el) { return session().setActiveSlot(slotNum(el)); },
  advanced() { state.view.adv = !state.view.adv; draw(); },
  sync() { return session().sync().then(() => show('Saved to the headset.')); },
  clear() { return session().clearChanges(); },
  revert() { return session().revertSlot(state.view.sel); },
  gate(el) { return session().setNoiseGate(Number(el.dataset.value)); },
  'mic-eq'(el) { return session().setMicEq(Number(el.dataset.value)); },
  'lib-pick'(el) { state.view.lib = Number(el.dataset.value); draw(); },
  'lib-remove'(el) {
    const p = state.library[Number(el.dataset.value)];
    if (!p) return;
    library.remove(p.name);
    state.library = library.list();
    state.view.lib = null;
    draw();
  },
  'lib-add'() {
    const added = library.add(session().current.slots[state.view.sel - 1]);
    state.library = library.list();
    state.view.lib = state.library.findIndex((p) => p.name === added.name);
    show(`Saved EQ 0${state.view.sel} to the library as ${added.name}.`);
  },
  'lib-load'() {
    const p = state.library[state.view.lib];
    if (p) return session().loadPreset(state.view.sel, p);
  },
  'lib-export'() {
    const url = URL.createObjectURL(new Blob([library.exportJson()], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'astro-a50-presets.json' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  'lib-import'() {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'application/json,.json' });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      const n = library.importJson(await file.text());
      state.library = library.list();
      show(n ? `Imported ${n} preset${n === 1 ? '' : 's'}.` : 'No valid presets in that file.', n ? 'info' : 'error');
    });
    input.click();
  },
};

root.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (fn) Promise.resolve().then(() => fn(el)).catch(failed);
});

// While dragging, only the number next to the control updates.
root.addEventListener('input', (e) => {
  const el = e.target;
  if (el.type !== 'range') return;
  const out = root.querySelector(`output[for="${el.id}"]`);
  if (!out) return;
  const v = Number(el.value);
  out.textContent = el.dataset.input === 'gain' ? `${v > 0 ? '+' : ''}${v}` : el.dataset.input === 'balance' ? String(v) : `${v}%`;
});

// Committed values (slider let go, field left) go to the headset.
root.addEventListener('change', (e) => {
  const el = e.target;
  const s = session();
  if (!s || !el.dataset.input) return;
  const v = Number(el.value);
  const band = Number(el.dataset.band);
  const slot = state.view.sel;
  const cur = s.current.slots[slot - 1];
  const commits = {
    gain: () => s.setGain(slot, band, v),
    freq: () => s.setBand(slot, band, Math.round(v), cur.bands[band].bw),
    width: () => s.setBand(slot, band, cur.bands[band].freq, Math.round(v * 4096)),
    name: () => s.setName(slot, el.value.trim().toUpperCase()),
    slider: () => s.setSlider(Number(el.dataset.value), v),
    balance: () => s.setDefaultBalance(v),
    alert: () => s.setAlertVolume(v),
  };
  const commit = commits[el.dataset.input];
  if (commit) commit().catch((err) => { failed(err); draw(); });
});

document.addEventListener('pointerdown', (e) => { if (e.target.type === 'range') dragging = true; });
document.addEventListener('pointerup', () => {
  if (!dragging) return;
  dragging = false;
  if (renderQueued) setTimeout(draw, 0);
});

window.addEventListener('beforeunload', (e) => {
  if (state.session?.changeCount()) e.preventDefault();
});

boot().catch(failed);
