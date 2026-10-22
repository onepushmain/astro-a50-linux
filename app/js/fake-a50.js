// A fake A50 base station that speaks the same protocol, for tests and the
// ?demo mode of the app. Its starting values match the user's headset where
// they were read (probe 2026-10-21: battery, status, slot, names); the rest
// are plausible samples.

import { Cmd, Status, REPORT_SIZE, MAX_NAME, DB_OFFSET } from './protocol.js';

const KNOWN = new Set(Object.values(Cmd));
const NEEDS_HEADSET = new Set([Cmd.GET_HEADSET_INFO, Cmd.GET_HEADSET_FIRMWARE_MAJOR, Cmd.GET_HEADSET_FIRMWARE_MINOR]);

function initialValues() {
  const bands = () => [95, 419, 783, 3499, 6100].map((freq, i) => ({ freq, bw: i === 0 || i === 4 ? 0 : 4096 }));
  return {
    gains: [[2, 0, 0, 5, 7], [5, -2, 1, 7, 1], [0, 0, 0, 5, 7]],
    bands: [bands(), bands(), bands()],
    names: ['ASTRO+', 'PRO', 'ASTRO'].map(nameBuffer),
    sliders: [70, 50, 80, 50, 60, 30], // stream mic/chat/game/aux, mic, sidetone
    gate: 2,
    micEq: 0,
    defaultBalance: 128,
    alert: 50,
  };
}

// Name buffers keep stale bytes after the NUL, as the real device does.
function nameBuffer(name) {
  const buf = new Array(50).fill(0);
  writeName(buf, 'A50 MOD KIT');
  writeName(buf, name);
  return buf;
}

function writeName(buf, name) {
  [...name, '\0'].forEach((c, i) => { buf[i] = c.charCodeAt(0); });
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const u16 = (n) => [n & 0xff, (n >> 8) & 0xff];
const u32 = (n) => [...u16(n & 0xffff), ...u16(n >>> 16)];

export class FakeA50 {
  constructor({ latencyMs = 0, headsetOn = true, docked = false, battery = 88, charging = false } = {}) {
    this.latencyMs = latencyMs;
    this.headsetOn = headsetOn;
    this.docked = docked;
    this.battery = battery;
    this.charging = charging;
    this.activeSlot = 2;
    this.active = initialValues();
    this.saved = clone(this.active);
    this.balance = 128;
    this.log = [];
    this.inFlight = 0;
    this.maxInFlight = 0;
    this.silent = false;
    this.failNext = null;
    this.corrupt = null;
    this.listeners = [];
    this.transport = {
      send: async (report) => this.receive(report),
      onInput: (cb) => {
        this.listeners.push(cb);
        return () => { this.listeners = this.listeners.filter((l) => l !== cb); };
      },
    };
  }

  receive(report) {
    const type = report[0];
    const payload = Array.from(report.slice(2, 2 + report[1]));
    this.log.push({ type, payload });
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    if (this.silent) return;
    const reply = this.reply(type, payload);
    setTimeout(() => {
      this.inFlight -= 1;
      this.listeners.forEach((cb) => cb(reply));
    }, this.latencyMs);
  }

  reply(type, payload) {
    let result;
    if (this.failNext) {
      result = this.error(this.failNext);
      this.failNext = null;
    } else {
      try {
        result = this.ok(this.handle(type, payload));
      } catch (e) {
        result = this.error(e.message);
      }
    }
    const out = new Uint8Array(REPORT_SIZE);
    out.set(result.slice(0, REPORT_SIZE));
    return out;
  }

  ok(data) {
    const body = this.corrupt ? this.corrupt(this.lastType, data) : data;
    return [Status.OK, body.length, ...body];
  }

  error(message) {
    const msg = [...message].map((c) => c.charCodeAt(0));
    return [Status.ERROR, 4 + msg.length + 1, 0, 0, 0, 0, ...msg, 0];
  }

  handle(type, p) {
    this.lastType = type;
    const a = this.active;
    const s = this.saved;
    const slot = (i) => {
      if (![1, 2, 3].includes(p[i])) throw new Error('BAD_SLOT');
      return p[i] - 1;
    };
    const range = (v, lo, hi) => { if (!(v >= lo && v <= hi)) throw new Error('BAD_VALUE'); return v; };
    if (!KNOWN.has(type)) throw new Error('UNKNOWN_REQUEST');
    if (NEEDS_HEADSET.has(type) && !this.headsetOn && !this.docked) throw new Error('HID_ERROR_SLAVE_NO_SLAVE');
    switch (type) {
      case Cmd.GET_DEVICE_INFO:
        return [0, 0, 0, 0, ...u16(0x9886), ...u16(0x002c), ...u16(2026), 3, 14, 9, 30, 5, 0, 0, 0, 0, 0, 0, ...u32(35155)];
      case Cmd.GET_BASE_FIRMWARE_MINOR: return [43];
      case Cmd.GET_HEADSET_INFO:
        if (!this.docked) throw new Error('FAKE_HEADSET_NOT_DOCKED');
        return [0, 0, 0, 0, ...u16(0x9886), ...u16(0x002d), ...u16(2026), 2, 1, 8, 0, 0];
      case Cmd.GET_HEADSET_FIRMWARE_MAJOR: return u32(34843);
      case Cmd.GET_HEADSET_FIRMWARE_MINOR: return [43];
      case Cmd.GET_HEADSET_STATUS: return [(this.headsetOn ? 2 : 0) | (this.docked ? 1 : 0)];
      case Cmd.GET_BATTERY_STATUS: return [(this.charging ? 0x80 : 0) | this.battery];
      case Cmd.GET_ACTIVE_EQ_PRESET: return [this.activeSlot];
      case Cmd.SET_ACTIVE_EQ_PRESET: this.activeSlot = slot(0) + 1; return [type, this.activeSlot];
      case Cmd.GET_EQ_PRESET_NAME: {
        const i = slot(0);
        return [type, i + 1, ...(p[1] ? s : a).names[i]];
      }
      case Cmd.SET_EQ_PRESET_NAME: {
        const i = slot(0);
        const bytes = p.slice(2, 2 + p[1]);
        if (p[1] < 2 || p[1] - 1 > MAX_NAME || bytes[bytes.length - 1] !== 0) throw new Error('BAD_NAME');
        bytes.forEach((b, k) => { a.names[i][k] = b; });
        return [type, i + 1];
      }
      case Cmd.GET_EQ_PRESET_GAIN: {
        const i = slot(0);
        return [type, i + 1, ...a.gains[i].map((g) => g + DB_OFFSET), ...s.gains[i].map((g) => g + DB_OFFSET)];
      }
      case Cmd.SET_EQ_PRESET_GAIN: {
        const i = slot(0);
        a.gains[i] = p.slice(1, 6).map((v) => range(v, 5, 19) - DB_OFFSET);
        return [type, i + 1];
      }
      case Cmd.GET_EQ_PRESET_FREQ_AND_BW: {
        const i = slot(0);
        const b = range(p[1], 1, 5) - 1;
        const [x, y] = [a.bands[i][b], s.bands[i][b]];
        return [type, i + 1, b + 1, ...u16(x.bw), ...u16(y.bw), ...u16(x.freq), ...u16(y.freq)];
      }
      case Cmd.SET_EQ_PRESET_FREQ_AND_BW: {
        const i = slot(0);
        const b = range(p[1], 1, 5) - 1;
        a.bands[i][b] = { bw: p[2] | (p[3] << 8), freq: range(p[4] | (p[5] << 8), 80, 15000) };
        return [type, i + 1, b + 1, 0];
      }
      case Cmd.GET_SLIDER_VALUE: {
        const k = range(p[0], 0, 5);
        return [type, k, a.sliders[k], s.sliders[k]];
      }
      case Cmd.SET_SLIDER_VALUE: {
        const k = range(p[0], 0, 5);
        a.sliders[k] = range(p[1], 0, 100);
        return [type, k];
      }
      case Cmd.GET_NOISE_GATE_MODE: return [type, a.gate, s.gate];
      case Cmd.SET_NOISE_GATE_MODE: a.gate = range(p[0], 0, 3); return [a.gate];
      case Cmd.GET_MIC_EQ: return [(p[0] ? s : a).micEq];
      case Cmd.SET_MIC_EQ: a.micEq = range(p[0], 0, 2); return [type];
      case Cmd.GET_BALANCE: return [this.balance];
      case Cmd.GET_DEFAULT_BALANCE: return [(p[0] ? s : a).defaultBalance];
      case Cmd.SET_DEFAULT_BALANCE: a.defaultBalance = range(p[0], 0, 255); this.balance = a.defaultBalance; return [type];
      case Cmd.GET_ALERT_VOLUME: return [(p[0] ? s : a).alert];
      case Cmd.SET_ALERT_VOLUME: a.alert = range(p[0], 0, 100); return [type];
      case Cmd.SAVE_VALUES: this.saved = clone(this.active); return [type, 0];
      default: throw new Error('UNKNOWN_REQUEST');
    }
  }
}
