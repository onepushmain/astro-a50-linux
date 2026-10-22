// Astro A50 gen 4 base station protocol, ported from eh-fifty 0.6.0
// (https://github.com/tdryer/eh-fifty, MIT). Reports use ID 0x02 and are 63
// bytes after the ID: request [type, len, ...payload], reply [status, len, ...data].

export const VENDOR_ID = 0x9886;
export const PRODUCT_ID = 0x002c;
export const USAGE_PAGE = 0xff32;
export const REPORT_ID = 0x02;
export const REPORT_SIZE = 63;
export const TIMEOUT_MS = 3000; // SAVE_VALUES can take over 2 s.

// The only request types this app may send. Anything else (firmware update,
// the "ineffective" 0x74/0x75, unknown types) is refused before it leaves.
export const Cmd = Object.freeze({
  GET_DEVICE_INFO: 0x03,
  GET_HEADSET_STATUS: 0x54,
  GET_BASE_FIRMWARE_MINOR: 0x55,
  SAVE_VALUES: 0x61,
  SET_SLIDER_VALUE: 0x62,
  SET_EQ_PRESET_GAIN: 0x63,
  SET_NOISE_GATE_MODE: 0x64,
  SET_ACTIVE_EQ_PRESET: 0x67,
  GET_SLIDER_VALUE: 0x68,
  GET_EQ_PRESET_GAIN: 0x69,
  GET_NOISE_GATE_MODE: 0x6a,
  GET_ACTIVE_EQ_PRESET: 0x6c,
  SET_EQ_PRESET_NAME: 0x6d,
  GET_EQ_PRESET_NAME: 0x6e,
  SET_EQ_PRESET_FREQ_AND_BW: 0x6f,
  GET_EQ_PRESET_FREQ_AND_BW: 0x70,
  SET_MIC_EQ: 0x71,
  GET_BALANCE: 0x72,
  SET_DEFAULT_BALANCE: 0x73,
  SET_ALERT_VOLUME: 0x76,
  GET_DEFAULT_BALANCE: 0x77,
  GET_ALERT_VOLUME: 0x7a,
  GET_MIC_EQ: 0x7b,
  GET_BATTERY_STATUS: 0x7c,
  GET_HEADSET_INFO: 0x83,
  GET_HEADSET_FIRMWARE_MINOR: 0xd6,
  GET_HEADSET_FIRMWARE_MAJOR: 0xda,
});
const ALLOWED = new Set(Object.values(Cmd));

export const Status = Object.freeze({ NO_RESPONSE: 0, ERROR: 1, OK: 2 });

export const Slider = Object.freeze({
  STREAM_MIC: 0, STREAM_CHAT: 1, STREAM_GAME: 2, STREAM_AUX: 3, MIC: 4, SIDETONE: 5,
});

export const NoiseGate = Object.freeze({ STREAMING: 0, NIGHT: 1, HOME: 2, TOURNAMENT: 3 });

export const SLOTS = [1, 2, 3];
export const BANDS = [1, 2, 3, 4, 5];
export const DB_OFFSET = 12;
export const MIN_GAIN = -7;
export const MAX_GAIN = 7;
export const MIN_FREQ = 80;
export const MAX_FREQ = 15000;
export const MIN_BW = Math.trunc(4096 * 0.1);
export const MAX_BW = Math.trunc(4096 * 3.0);
export const SHELF_BANDS = new Set([1, 5]);
export const MAX_NAME = 11;
export const MIC_EQS = [0, 1, 2];

export class RequestFailed extends Error {
  constructor(message) { super(message); this.name = 'RequestFailed'; }
}

export class HeadsetNotConnected extends RequestFailed {
  constructor(message) { super(message); this.name = 'HeadsetNotConnected'; }
}

export class ProtocolError extends Error {
  constructor(message) { super(message); this.name = 'ProtocolError'; }
}

export function encodeRequest(type, payload = []) {
  if (!ALLOWED.has(type)) throw new Error(`0x${type.toString(16)} is not an allowed request type`);
  const out = new Uint8Array(REPORT_SIZE);
  out[0] = type;
  if (payload.length) {
    if (payload.length + 2 > REPORT_SIZE) throw new Error('payload too long for one report');
    out[1] = payload.length;
    out.set(payload, 2);
  }
  return out;
}

// `report` is the reply without its report ID.
export function decodeResponse(report) {
  const status = report[0];
  const length = Math.min(report[1], report.length - 2);
  const data = report.slice(2, 2 + length);
  if (status === Status.ERROR) {
    const bytes = data.slice(4);
    const end = bytes.indexOf(0);
    const message = new TextDecoder().decode(end < 0 ? bytes : bytes.slice(0, end));
    if (message === 'HID_ERROR_SLAVE_NO_SLAVE') throw new HeadsetNotConnected(message);
    throw new RequestFailed(message);
  }
  if (status !== Status.OK && status !== Status.NO_RESPONSE) {
    throw new ProtocolError(`unexpected reply status ${status}`);
  }
  return data;
}

function need(cond, message) {
  if (!cond) throw new ProtocolError(message);
}

export function checkSlot(slot) {
  if (!SLOTS.includes(slot)) throw new RangeError(`EQ slot must be 1-3, got ${slot}`);
}

export function checkPercent(value, what) {
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new RangeError(`${what} must be 0-100`);
}

export function parseBattery(data) {
  need(data.length >= 1, 'short battery reply');
  return { percent: data[0] & 0x7f, charging: Boolean(data[0] & 0x80) };
}

export function parseHeadsetStatus(data) {
  need(data.length >= 1, 'short status reply');
  return { on: Boolean(data[0] & 0x02), docked: Boolean(data[0] & 0x01) };
}

export function parseName(data, slot) {
  need(data.length > 2 && data[0] === Cmd.GET_EQ_PRESET_NAME, 'bad name reply');
  need(data[1] === slot, `name reply for slot ${data[1]}, asked slot ${slot}`);
  const bytes = Array.from(data.slice(2));
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(Uint8Array.from(end < 0 ? bytes : bytes.slice(0, end)));
}

export function checkName(name) {
  if (typeof name !== 'string' || name.length < 1 || name.length > MAX_NAME || !/^[\x20-\x7e]+$/.test(name)) {
    throw new RangeError(`name must be 1-${MAX_NAME} printable ASCII characters`);
  }
}

export function encodeName(slot, name) {
  checkSlot(slot);
  checkName(name);
  const bytes = [...name].map((c) => c.charCodeAt(0));
  return [slot, bytes.length + 1, ...bytes, 0];
}

export function parseGain(data, slot) {
  need(data.length >= 12 && data[0] === Cmd.GET_EQ_PRESET_GAIN && data[1] === slot, 'bad gain reply');
  const db = (i) => data[i] - DB_OFFSET;
  return { gains: [2, 3, 4, 5, 6].map(db), saved: [7, 8, 9, 10, 11].map(db) };
}

export function checkGains(gains) {
  if (!Array.isArray(gains) || gains.length !== 5 ||
      !gains.every((g) => Number.isInteger(g) && g >= MIN_GAIN && g <= MAX_GAIN)) {
    throw new RangeError(`gain needs 5 whole values from ${MIN_GAIN} to ${MAX_GAIN} dB`);
  }
}

export function encodeGain(slot, gains) {
  checkSlot(slot);
  checkGains(gains);
  return [slot, ...gains.map((g) => g + DB_OFFSET)];
}

const u16 = (data, i) => data[i] | (data[i + 1] << 8);

export function parseFreqBw(data, slot, band) {
  need(data.length >= 11 && data[0] === Cmd.GET_EQ_PRESET_FREQ_AND_BW &&
    data[1] === slot && data[2] === band, 'bad frequency reply');
  return { bw: u16(data, 3), savedBw: u16(data, 5), freq: u16(data, 7), savedFreq: u16(data, 9) };
}

export function checkFreqBw(band, freq, bw) {
  if (!BANDS.includes(band)) throw new RangeError(`band must be 1-5, got ${band}`);
  if (!Number.isInteger(freq) || freq < MIN_FREQ || freq > MAX_FREQ) {
    throw new RangeError(`center frequency must be ${MIN_FREQ}-${MAX_FREQ} Hz`);
  }
  if (SHELF_BANDS.has(band) ? bw !== 0 : !(Number.isInteger(bw) && bw >= MIN_BW && bw <= MAX_BW)) {
    throw new RangeError(SHELF_BANDS.has(band)
      ? `bandwidth of shelf band ${band} must be 0`
      : `bandwidth must be ${MIN_BW}-${MAX_BW}`);
  }
}

export function encodeFreqBw(slot, band, freq, bw) {
  checkSlot(slot);
  checkFreqBw(band, freq, bw);
  return [slot, band, bw & 0xff, bw >> 8, freq & 0xff, freq >> 8];
}

const two = (n) => String(n).padStart(2, '0');

export function parseImageHeader(data) {
  need(data.length >= 15, 'short device info reply');
  const year = u16(data, 8);
  const [mo, d, h, mi, s] = Array.from(data.slice(10, 15));
  return {
    vendorId: u16(data, 4),
    productId: u16(data, 6),
    buildTime: `${year}-${two(mo)}-${two(d)} ${two(h)}:${two(mi)}:${two(s)}`,
    fwMajor: data.length >= 25 ? (u16(data, 21) | (u16(data, 23) << 16)) >>> 0 : null,
  };
}

export function parseU32(data) {
  need(data.length >= 4, 'short firmware reply');
  return (u16(data, 0) | (u16(data, 2) << 16)) >>> 0;
}
