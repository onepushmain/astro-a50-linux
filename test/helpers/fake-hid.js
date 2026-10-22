// A fake navigator.hid / HIDDevice / navigator.locks built on FakeA50, for
// testing the page controller without a browser or hardware.
import { FakeA50 } from '../../app/js/fake-a50.js';
import { VENDOR_ID, PRODUCT_ID, USAGE_PAGE, REPORT_ID } from '../../app/js/protocol.js';

export class FakeHIDDevice {
  constructor(opts) {
    this.vendorId = VENDOR_ID;
    this.productId = PRODUCT_ID;
    this.collections = [{ usagePage: USAGE_PAGE }];
    this.opened = false;
    this.closes = 0;
    this.a50 = new FakeA50(opts);
    this.listeners = new Set();
    this.a50.transport.onInput((report) => {
      const data = new DataView(report.buffer, report.byteOffset, report.byteLength);
      this.listeners.forEach((cb) => cb({ reportId: REPORT_ID, data }));
    });
  }

  async open() { this.opened = true; }
  async close() { this.opened = false; this.closes += 1; }

  async sendReport(reportId, data) {
    if (!this.opened) throw new Error('device not open');
    if (reportId !== REPORT_ID) throw new Error('wrong report id');
    return this.a50.transport.send(data);
  }

  addEventListener(type, cb) { if (type === 'inputreport') this.listeners.add(cb); }
  removeEventListener(type, cb) { if (type === 'inputreport') this.listeners.delete(cb); }
}

export class FakeHID {
  constructor({ granted = [], chooser = null } = {}) {
    this.granted = granted;
    this.chooser = chooser;
    this.handlers = { connect: [], disconnect: [] };
  }

  async getDevices() { return [...this.granted]; }

  async requestDevice() {
    if (this.chooser && !this.granted.includes(this.chooser)) this.granted.push(this.chooser);
    return this.chooser ? [this.chooser] : [];
  }

  addEventListener(type, cb) { this.handlers[type].push(cb); }
  emit(type, device) { this.handlers[type].forEach((cb) => cb({ device })); }
}

// navigator.locks for several "windows" sharing one origin.
export class FakeLocks {
  constructor() { this.held = new Set(); }

  async request(name, opts, cb) {
    if (this.held.has(name)) {
      if (opts.ifAvailable) return cb(null);
      throw new Error('FakeLocks only supports ifAvailable');
    }
    this.held.add(name);
    const done = cb({ name });
    Promise.resolve(done).finally(() => this.held.delete(name));
    return undefined;
  }
}

export function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

export const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// Waits until check() is true, failing after timeoutMs.
export async function until(check, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not reached in time');
    await tick(2);
  }
}
