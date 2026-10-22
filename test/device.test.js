import { test } from 'node:test';
import assert from 'node:assert/strict';
import { A50, DeviceTimeout } from '../app/js/device.js';
import { FakeA50 } from '../app/js/fake-a50.js';
import { Cmd, Slider, NoiseGate, HeadsetNotConnected, RequestFailed } from '../app/js/protocol.js';

const connect = (opts) => {
  const fake = new FakeA50(opts);
  return { fake, a50: new A50(fake.transport, { timeoutMs: opts?.timeoutMs }) };
};

test('reads battery and status the way the real headset answered', async () => {
  const { a50 } = connect();
  assert.deepEqual(await a50.getBattery(), { percent: 88, charging: false });
  assert.deepEqual(await a50.getHeadsetStatus(), { on: true, docked: false });
  assert.equal(await a50.getActiveSlot(), 2);
});

test('reads the three slot names', async () => {
  const { a50 } = connect();
  assert.deepEqual(await Promise.all([1, 2, 3].map((s) => a50.getName(s))), ['ASTRO+', 'PRO', 'ASTRO']);
});

test('requests never overlap, even when issued together', async () => {
  const { fake, a50 } = connect({ latencyMs: 5 });
  await Promise.all([a50.getBattery(), a50.getActiveSlot(), a50.getName(1), a50.getGain(1)]);
  assert.equal(fake.maxInFlight, 1);
  assert.equal(fake.log.length, 4);
});

test('a reply that never comes times out and stops further requests', async () => {
  const { fake, a50 } = connect({ timeoutMs: 30 });
  fake.silent = true;
  await assert.rejects(a50.getBattery(), DeviceTimeout);
  fake.silent = false;
  await assert.rejects(a50.getBattery(), DeviceTimeout);
  assert.equal(fake.log.length, 1);
});

test('setting a gain changes the active value and leaves the saved one', async () => {
  const { a50 } = connect();
  const before = await a50.getGain(1);
  await a50.setGain(1, [1, 2, 3, 4, 5]);
  const after = await a50.getGain(1);
  assert.deepEqual(after.gains, [1, 2, 3, 4, 5]);
  assert.deepEqual(after.saved, before.saved);
});

test('save makes the active values the saved ones', async () => {
  const { a50 } = connect();
  await a50.setSlider(Slider.SIDETONE, 77);
  assert.deepEqual(await a50.getSlider(Slider.SIDETONE), { value: 77, saved: 30 });
  await a50.save();
  assert.deepEqual(await a50.getSlider(Slider.SIDETONE), { value: 77, saved: 77 });
});

test('names, bands, gate, mic eq, balance and alert round-trip', async () => {
  const { a50 } = connect();
  await a50.setName(3, 'MY MIX');
  assert.equal(await a50.getName(3), 'MY MIX');
  assert.equal(await a50.getName(3, true), 'ASTRO');
  await a50.setFreqBw(2, 3, 1000, 2048);
  assert.deepEqual(await a50.getFreqBw(2, 3), { freq: 1000, bw: 2048, savedFreq: 783, savedBw: 4096 });
  await a50.setNoiseGate(NoiseGate.TOURNAMENT);
  assert.deepEqual(await a50.getNoiseGate(), { value: 3, saved: 2 });
  await a50.setMicEq(1);
  assert.equal(await a50.getMicEq(), 1);
  assert.equal(await a50.getMicEq(true), 0);
  await a50.setDefaultBalance(200);
  assert.equal(await a50.getDefaultBalance(), 200);
  await a50.setAlertVolume(10);
  assert.equal(await a50.getAlertVolume(), 10);
  assert.equal(await a50.getAlertVolume(true), 50);
});

test('switching the active slot is echoed back', async () => {
  const { a50 } = connect();
  await a50.setActiveSlot(3);
  assert.equal(await a50.getActiveSlot(), 3);
});

test('firmware versions read as major.minor', async () => {
  const { a50 } = connect();
  assert.equal(await a50.getBaseFirmware(), '35155.43');
  assert.equal(await a50.getHeadsetFirmware(), '34843.43');
});

test('headset firmware reports headset-off when it is off and undocked', async () => {
  const { a50 } = connect({ headsetOn: false });
  await assert.rejects(a50.getHeadsetFirmware(), HeadsetNotConnected);
});

test('bad values are refused before anything is sent', async () => {
  const { fake, a50 } = connect();
  await assert.rejects(a50.setGain(1, [9, 0, 0, 0, 0]), RangeError);
  await assert.rejects(a50.setName(1, 'WAY TOO LONG NAME'), RangeError);
  await assert.rejects(a50.setSlider(Slider.MIC, 101), RangeError);
  await assert.rejects(a50.setActiveSlot(0), RangeError);
  await assert.rejects(a50.setNoiseGate(4), RangeError);
  await assert.rejects(a50.setDefaultBalance(256), RangeError);
  assert.equal(fake.log.length, 0);
});

test('the fake answers unknown request types with an error, like a cautious device', async () => {
  const fake = new FakeA50();
  const report = new Uint8Array(63);
  report[0] = 0x74;
  const reply = await new Promise((resolve) => {
    fake.transport.onInput(resolve);
    fake.transport.send(report);
  });
  assert.equal(reply[0], 1);
});

test('a reply echoing the wrong slot is a protocol error', async () => {
  const { fake, a50 } = connect();
  fake.corrupt = (type, data) => (type === Cmd.SET_EQ_PRESET_GAIN ? [data[0], 3] : data);
  await assert.rejects(a50.setGain(1, [0, 0, 0, 0, 0]), /echo/);
});

test('error replies surface as RequestFailed', async () => {
  const { fake, a50 } = connect();
  fake.failNext = 'SOMETHING_BAD';
  await assert.rejects(a50.getBattery(), (e) => e instanceof RequestFailed && e.message === 'SOMETHING_BAD');
  assert.deepEqual(await a50.getBattery(), { percent: 88, charging: false });
});
