import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Cmd, REPORT_SIZE, encodeRequest, decodeResponse, RequestFailed, HeadsetNotConnected,
  parseBattery, parseHeadsetStatus, parseName, encodeName, parseGain, encodeGain,
  parseFreqBw, encodeFreqBw, parseImageHeader,
} from '../app/js/protocol.js';

// Real replies from the user's base station (probe, 2026-10-21), report ID stripped.
const hex = (s) => Uint8Array.from(s.split(' ').map((b) => parseInt(b, 16)));
const pad = (bytes) => { const out = new Uint8Array(REPORT_SIZE); out.set(bytes); return out; };
const BATTERY_REPLY = pad(hex('02 01 58'));
const SLOT1_NAME_REPLY = pad(hex('02 34 6e 01 41 53 54 52 4f 2b 00 20 4b 49 54'));

test('a request without payload is the type byte padded with zeros', () => {
  const req = encodeRequest(Cmd.GET_BATTERY_STATUS);
  assert.equal(req.length, REPORT_SIZE);
  assert.equal(req[0], 0x7c);
  assert.ok(req.slice(1).every((b) => b === 0));
});

test('a request with payload carries its length before the payload', () => {
  const req = encodeRequest(Cmd.GET_EQ_PRESET_NAME, [1, 0]);
  assert.deepEqual([...req.slice(0, 4)], [0x6e, 2, 1, 0]);
});

test('request types outside the decoded table are refused', () => {
  assert.throws(() => encodeRequest(0x74), /not an allowed request/);
  assert.throws(() => encodeRequest(0x00), /not an allowed request/);
});

test('a payload too long for one report is refused', () => {
  assert.throws(() => encodeRequest(Cmd.SET_EQ_PRESET_NAME, new Array(62).fill(0x41)), /too long/);
});

test('an OK reply yields its data bytes', () => {
  assert.deepEqual([...decodeResponse(BATTERY_REPLY)], [0x58]);
});

test('a reply length larger than the report is capped', () => {
  const data = decodeResponse(pad(hex('02 ff 01 02')));
  assert.equal(data.length, REPORT_SIZE - 2);
});

test('an error reply raises RequestFailed with its message', () => {
  const msg = [...new TextEncoder().encode('BAD_THING'), 0];
  const reply = pad([1, 4 + msg.length, 0, 0, 0, 0, ...msg]);
  assert.throws(() => decodeResponse(reply), (e) => e instanceof RequestFailed && e.message === 'BAD_THING');
});

test('the no-slave error means the headset is off and undocked', () => {
  const msg = [...new TextEncoder().encode('HID_ERROR_SLAVE_NO_SLAVE'), 0];
  const reply = pad([1, 4 + msg.length, 9, 9, 9, 9, ...msg]);
  assert.throws(() => decodeResponse(reply), HeadsetNotConnected);
});

test('battery byte: low 7 bits are percent, top bit is charging', () => {
  assert.deepEqual(parseBattery([0x58]), { percent: 88, charging: false });
  assert.deepEqual(parseBattery([0xd8]), { percent: 88, charging: true });
});

test('headset status: bit 0 docked, bit 1 on', () => {
  assert.deepEqual(parseHeadsetStatus([0x02]), { on: true, docked: false });
  assert.deepEqual(parseHeadsetStatus([0x01]), { on: false, docked: true });
});

test('slot names stop at the first NUL, ignoring stale bytes after it', () => {
  assert.equal(parseName(decodeResponse(SLOT1_NAME_REPLY), 1), 'ASTRO+');
});

test('a name reply for the wrong slot is rejected', () => {
  assert.throws(() => parseName(decodeResponse(SLOT1_NAME_REPLY), 2), /slot/);
});

test('names are encoded with a NUL and its length', () => {
  assert.deepEqual(encodeName(2, 'PRO'), [2, 4, 0x50, 0x52, 0x4f, 0]);
});

test('names must be 1-11 printable ASCII characters', () => {
  assert.throws(() => encodeName(1, ''), /name/);
  assert.throws(() => encodeName(1, 'A50 MOD KIT2'), /name/);
  assert.throws(() => encodeName(1, 'ÁSTRO'), /name/);
  assert.doesNotThrow(() => encodeName(1, 'A50 MOD KIT'));
});

test('gains are stored as dB plus 12, active then saved', () => {
  const data = [0x69, 3, 12, 12, 12, 17, 19, 13, 12, 12, 17, 19];
  assert.deepEqual(parseGain(data, 3), { gains: [0, 0, 0, 5, 7], saved: [1, 0, 0, 5, 7] });
  assert.deepEqual(encodeGain(3, [0, 0, 0, 5, 7]), [3, 12, 12, 12, 17, 19]);
});

test('gains outside -7..+7 dB are refused', () => {
  assert.throws(() => encodeGain(1, [8, 0, 0, 0, 0]), /gain/);
  assert.throws(() => encodeGain(1, [0, 0, 0, 0]), /gain/);
  assert.throws(() => encodeGain(4, [0, 0, 0, 0, 0]), /slot/);
});

test('band frequency and bandwidth are little-endian u16, active then saved', () => {
  const data = [0x70, 1, 2, 0x00, 0x10, 0x00, 0x10, 0xa3, 0x01, 0xa3, 0x01];
  assert.deepEqual(parseFreqBw(data, 1, 2), { bw: 4096, savedBw: 4096, freq: 419, savedFreq: 419 });
  assert.deepEqual(encodeFreqBw(1, 2, 419, 4096), [1, 2, 0x00, 0x10, 0xa3, 0x01]);
});

test('shelf bands 1 and 5 must have bandwidth 0; others 409-12288', () => {
  assert.throws(() => encodeFreqBw(1, 1, 95, 4096), /bandwidth/);
  assert.doesNotThrow(() => encodeFreqBw(1, 5, 6100, 0));
  assert.throws(() => encodeFreqBw(1, 3, 783, 0), /bandwidth/);
  assert.throws(() => encodeFreqBw(1, 3, 79, 4096), /frequency/);
});

test('firmware image header gives ids and build time', () => {
  const data = new Array(25).fill(0);
  data.splice(4, 11, 0x86, 0x98, 0x2c, 0x00, 0xea, 0x07, 3, 14, 9, 30, 5);
  data.splice(21, 4, 0x46, 0x89, 0, 0);
  const info = parseImageHeader(data);
  assert.equal(info.vendorId, 0x9886);
  assert.equal(info.productId, 0x002c);
  assert.equal(info.buildTime, '2026-03-14 09:30:05');
  assert.equal(info.fwMajor, 35142);
});
