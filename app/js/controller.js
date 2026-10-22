// The page's behaviour without the DOM: finding and opening the base station,
// the session's lifecycle, and what each button does. main.js feeds it
// browser objects (navigator.hid, navigator.locks, localStorage); tests feed
// it fakes.

import {
  VENDOR_ID, PRODUCT_ID, USAGE_PAGE, REPORT_ID,
  HeadsetNotConnected, RequestFailed, ProtocolError,
} from './protocol.js';
import { A50, DeviceTimeout } from './device.js';
import { FakeA50 } from './fake-a50.js';
import { Session } from './session.js';
import { Library } from './library.js';

const DEVICE_LOCK = 'astro-a50-device';
const POLL_MS = 30000;

// Actions that talk to the device run one at a time; a second click while
// one runs (a double-click on Sync, say) is ignored.
const DEVICE_ACTIONS = new Set(['connect', 'retry', 'activate', 'sync', 'clear', 'revert', 'gate', 'mic-eq', 'lib-load', 'revert-close']);

export function isA50(d) {
  return d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID && d.collections.some((c) => c.usagePage === USAGE_PAGE);
}

function hidTransport(device) {
  return {
    send: (bytes) => device.sendReport(REPORT_ID, bytes),
    onInput: (cb) => {
      const handler = (e) => {
        if (e.reportId === REPORT_ID) cb(new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength));
      };
      device.addEventListener('inputreport', handler);
      return () => device.removeEventListener('inputreport', handler);
    },
  };
}

export function errorText(e) {
  if (e instanceof HeadsetNotConnected) return 'The headset is off. Turn it on or dock it, then try again.';
  if (e instanceof RangeError) return e.message.charAt(0).toUpperCase() + e.message.slice(1) + '.';
  if (e instanceof RequestFailed) return `The base station refused that (${e.message}).`;
  if (e instanceof ProtocolError) return 'The base station sent an unexpected reply. Try again; if it keeps happening, re-plug it.';
  return e?.message || String(e);
}

export class Controller {
  constructor({ hid, locks, storage, demo = false, draw = () => {}, closeWindow = () => {}, timeoutMs }) {
    this.hid = hid;
    this.locks = locks;
    this.demo = demo;
    this.draw = draw;
    this.closeWindow = closeWindow;
    this.timeoutMs = timeoutMs;
    this.library = new Library(storage);
    this.state = {
      screen: 'loading',
      demo,
      session: null,
      library: this.library.list(),
      view: { tab: 'eq', sel: 1, lib: null, adv: false },
      banner: null,
      busy: false,
    };
    this.device = null;
    this.a50 = null;
    this.timer = null;
    this.listening = false;
    // Set when the base station stops answering. Its replies can't be trusted
    // until it has been unplugged, so nothing is sent until then.
    this.needsReplug = false;
  }

  show(text, kind = 'info') {
    this.state.banner = text ? { text, kind } : null;
    this.draw();
  }

  async init() {
    if (this.demo) return this.start(new FakeA50({ latencyMs: 2 }).transport);
    if (!this.hid) {
      this.state.screen = 'no-webhid';
      return this.draw();
    }
    // Only one window may talk to the device: replies carry no request id,
    // so two talkers would read each other's replies.
    if (this.locks && !(await this.takeLock())) {
      this.state.screen = 'other-window';
      return this.draw();
    }
    this.listen();
    this.state.screen = 'connect';
    this.draw();
    const known = (await this.hid.getDevices()).find(isA50);
    if (known) await this.openDevice(known);
  }

  takeLock() {
    return new Promise((resolve) => {
      Promise.resolve(this.locks.request(DEVICE_LOCK, { ifAvailable: true }, (lock) => {
        resolve(Boolean(lock));
        // Held for the life of the page.
        return lock ? new Promise(() => {}) : undefined;
      })).catch(() => resolve(false));
    });
  }

  listen() {
    if (this.listening) return;
    this.listening = true;
    this.hid.addEventListener('disconnect', (e) => {
      if (e.device !== this.device) return;
      const replugged = this.needsReplug;
      this.stopSession();
      this.device = null;
      this.needsReplug = false;
      this.state.screen = 'connect';
      if (replugged) this.show('Base station unplugged. Plug it back in to continue.');
      else this.show('The base station was unplugged. Changes you didn\'t sync are only on the headset until it powers off.', 'error');
    });
    this.hid.addEventListener('connect', (e) => {
      if (!this.device && !this.needsReplug && isA50(e.device)) {
        this.openDevice(e.device).catch((err) => this.failed(err));
      }
    });
  }

  async openDevice(device) {
    if (this.needsReplug) {
      this.state.screen = 'replug';
      return this.draw();
    }
    this.device = device;
    if (!device.opened) await device.open();
    return this.start(hidTransport(device));
  }

  stopSession() {
    clearInterval(this.timer);
    this.timer = null;
    this.a50?.close();
    this.a50 = null;
    this.state.session = null;
  }

  async start(transport) {
    this.stopSession();
    const a50 = new A50(transport, { timeoutMs: this.timeoutMs });
    const session = new Session(a50);
    this.a50 = a50;
    this.state.screen = 'loading';
    this.state.banner = null;
    this.draw();
    try {
      await session.load();
    } catch (e) {
      if (this.a50 !== a50) return;
      if (e instanceof HeadsetNotConnected) {
        this.state.screen = 'headset-off';
        this.draw();
        return;
      }
      this.state.screen = 'connect';
      this.failed(e, session);
      return;
    }
    if (this.a50 !== a50) return;
    session.onChange(() => { if (this.state.session === session) this.draw(); });
    this.state.session = session;
    this.state.screen = 'main';
    this.state.view.sel = session.activeSlot ?? 1;
    this.draw();
    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.timer.unref?.();
  }

  poll() {
    const s = this.state.session;
    if (!s) return Promise.resolve();
    return s.refreshStatus().catch((e) => this.failed(e, s));
  }

  // Errors from a session that has since been replaced are ignored.
  failed(e, session) {
    if (session && session.a50 !== this.a50) return;
    if (e instanceof DeviceTimeout) {
      this.needsReplug = true;
      this.stopSession();
      Promise.resolve(this.device?.close()).catch(() => {});
      this.state.screen = 'replug';
      this.state.banner = null;
      this.draw();
      return;
    }
    this.show(errorText(e), 'error');
  }

  async act(name, args = {}) {
    const fn = this.actions[name];
    if (!fn) return;
    const exclusive = DEVICE_ACTIONS.has(name);
    if (exclusive) {
      if (this.state.busy) return;
      this.state.busy = true;
    }
    const session = this.state.session;
    try {
      await fn.call(this, args);
    } catch (e) {
      this.failed(e, session);
    } finally {
      if (exclusive) {
        this.state.busy = false;
        this.draw();
      }
    }
  }

  // A committed control value (slider let go, field left).
  async commit(kind, value, { band, slider } = {}) {
    const s = this.state.session;
    if (!s) return;
    const slot = this.state.view.sel;
    const ops = {
      gain: () => s.setGain(slot, band, value),
      freq: () => s.setBandFreq(slot, band, Math.round(value)),
      width: () => s.setBandWidth(slot, band, Math.round(value * 4096)),
      name: () => s.setName(slot, String(value).trim().toUpperCase()),
      slider: () => s.setSlider(slider, value),
      balance: () => s.setDefaultBalance(value),
      alert: () => s.setAlertVolume(value),
    };
    try {
      await ops[kind]?.();
    } catch (e) {
      this.failed(e, s);
      this.draw();
    }
  }

  refreshLibrary() { this.state.library = this.library.list(); }

  exportLibrary() { return this.library.exportJson(); }

  importLibrary(text) {
    const n = this.library.importJson(text);
    this.refreshLibrary();
    this.show(n ? `Imported ${n} preset${n === 1 ? '' : 's'}.` : 'No valid presets in that file.', n ? 'info' : 'error');
    return n;
  }

  actions = {
    async connect() {
      if (this.needsReplug) return this.openDevice(null);
      const [device] = await this.hid.requestDevice({
        filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID, usagePage: USAGE_PAGE }],
      });
      if (device) await this.openDevice(device);
    },
    async retry() {
      if (this.demo) return this.start(new FakeA50({ latencyMs: 2 }).transport);
      if (this.needsReplug) return undefined;
      if (this.device) return this.openDevice(this.device);
      const known = (await this.hid.getDevices()).find(isA50);
      if (known) return this.openDevice(known);
      this.state.screen = 'connect';
      return this.draw();
    },
    tab({ value }) { this.state.view.tab = value; this.draw(); },
    select({ slot }) { this.state.view.sel = slot; this.draw(); },
    advanced() { this.state.view.adv = !this.state.view.adv; this.draw(); },
    dismiss() { this.show(null); },
    activate({ slot }) { return this.state.session.setActiveSlot(slot); },
    async sync() {
      await this.state.session.sync();
      this.show('Saved to the headset.');
    },
    clear() { return this.state.session.clearChanges(); },
    revert() { return this.state.session.revertSlot(this.state.view.sel); },
    gate({ value }) { return this.state.session.setNoiseGate(value); },
    'mic-eq'({ value }) { return this.state.session.setMicEq(value); },
    async 'revert-close'() {
      await this.state.session.clearChanges();
      this.closeWindow();
    },
    'lib-pick'({ value }) { this.state.view.lib = value; this.draw(); },
    'lib-remove'({ value }) {
      const p = this.state.library[value];
      if (!p) return;
      this.library.remove(p.name);
      this.refreshLibrary();
      this.state.view.lib = null;
      this.draw();
    },
    'lib-add'() {
      const sel = this.state.view.sel;
      const added = this.library.add(this.state.session.current.slots[sel - 1]);
      this.refreshLibrary();
      this.state.view.lib = this.state.library.findIndex((p) => p.name === added.name);
      this.show(`Saved EQ 0${sel} to the library as ${added.name}.`);
    },
    'lib-load'() {
      const p = this.state.library[this.state.view.lib];
      if (p) return this.state.session.loadPreset(this.state.view.sel, p);
      return undefined;
    },
  };
}
