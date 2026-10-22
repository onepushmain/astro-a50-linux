import { test } from 'node:test';
import assert from 'node:assert/strict';
import { A50 } from '../app/js/device.js';
import { FakeA50 } from '../app/js/fake-a50.js';
import { Session } from '../app/js/session.js';
import { Cmd } from '../app/js/protocol.js';

async function open(opts) {
  const fake = new FakeA50(opts);
  const session = new Session(new A50(fake.transport));
  await session.load();
  fake.log.length = 0;
  return { fake, session };
}

const sent = (fake, type) => fake.log.filter((r) => r.type === type).length;

test('load reads device info, slots, and saved values', async () => {
  const { session } = await open();
  assert.equal(session.info.baseFw, '35155.43');
  assert.equal(session.info.headsetFw, '34843.43');
  assert.deepEqual(session.battery, { percent: 88, charging: false });
  assert.equal(session.activeSlot, 2);
  assert.deepEqual(session.current.slots.map((s) => s.name), ['ASTRO+', 'PRO', 'ASTRO']);
  assert.deepEqual(session.current.slots[0].bands[1], { freq: 419, bw: 4096 });
  assert.equal(session.current.sliders[5], 30);
  assert.deepEqual(session.current, session.saved);
  assert.equal(session.changeCount(), 0);
});

test('load copes with the headset being off', async () => {
  const { session } = await open({ headsetOn: false });
  assert.equal(session.info.headsetFw, null);
  assert.deepEqual(session.headset, { on: false, docked: false });
});

test('a gain edit is sent live and counted as one unsynced change', async () => {
  const { fake, session } = await open();
  await session.setGain(1, 4, -3);
  assert.deepEqual(fake.active.gains[0], [2, 0, 0, 5, -3]);
  assert.equal(session.changeCount(), 1);
  assert.ok(session.slotChanged(1));
  assert.ok(!session.slotChanged(2));
});

test('editing back to the saved value is no longer a change', async () => {
  const { session } = await open();
  await session.setSlider(5, 40);
  await session.setSlider(5, 30);
  assert.equal(session.changeCount(), 0);
});

test('loading a preset writes only the parts that differ', async () => {
  const { fake, session } = await open();
  const bands = session.current.slots[2].bands.map((b) => ({ ...b }));
  bands[2] = { freq: 1000, bw: 2048 };
  await session.loadPreset(3, { name: 'GAMING', gains: [0, 0, 0, 5, 7], bands });
  assert.equal(sent(fake, Cmd.SET_EQ_PRESET_NAME), 1);
  assert.equal(sent(fake, Cmd.SET_EQ_PRESET_GAIN), 0);
  assert.equal(sent(fake, Cmd.SET_EQ_PRESET_FREQ_AND_BW), 1);
  assert.deepEqual(fake.active.bands[2][2], { freq: 1000, bw: 2048 });
  assert.ok(session.slotChanged(3));
  assert.equal(sent(fake, Cmd.SAVE_VALUES), 0);
});

test('sync saves to flash and clears the change count', async () => {
  const { fake, session } = await open();
  await session.setGain(2, 0, 7);
  await session.setNoiseGate(3);
  await session.sync();
  assert.equal(sent(fake, Cmd.SAVE_VALUES), 1);
  assert.equal(session.changeCount(), 0);
  assert.equal(fake.saved.gate, 3);
  assert.deepEqual(fake.saved.gains[1], [7, -2, 1, 7, 1]);
});

test('clear changes writes the saved values back as active', async () => {
  const { fake, session } = await open();
  await session.setGain(1, 0, -7);
  await session.setName(1, 'TEMP');
  await session.setSlider(0, 5);
  await session.setAlertVolume(99);
  await session.clearChanges();
  assert.equal(session.changeCount(), 0);
  assert.deepEqual(fake.active.gains[0], fake.saved.gains[0]);
  assert.deepEqual(fake.active.names[0].slice(0, 7), fake.saved.names[0].slice(0, 7));
  assert.equal(fake.active.sliders[0], 70);
  assert.equal(fake.active.alert, 50);
  assert.equal(sent(fake, Cmd.SAVE_VALUES), 0);
});

test('revert slot touches only that slot', async () => {
  const { fake, session } = await open();
  await session.setGain(1, 0, -7);
  await session.setGain(2, 0, -7);
  await session.revertSlot(1);
  assert.ok(!session.slotChanged(1));
  assert.ok(session.slotChanged(2));
  assert.equal(fake.active.gains[1][0], -7);
});

test('switching the active slot applies at once and is not an unsynced change', async () => {
  const { fake, session } = await open();
  await session.setActiveSlot(3);
  assert.equal(fake.activeSlot, 3);
  assert.equal(session.activeSlot, 3);
  assert.equal(session.changeCount(), 0);
});

test('a rejected edit leaves the session unchanged', async () => {
  const { fake, session } = await open();
  await assert.rejects(session.setName(1, 'NAME THAT IS TOO LONG'), RangeError);
  assert.equal(session.current.slots[0].name, 'ASTRO+');
  assert.equal(fake.log.length, 0);
});

test('listeners hear about every change', async () => {
  const { session } = await open();
  let calls = 0;
  session.onChange(() => { calls += 1; });
  await session.setMicEq(2);
  await session.setDefaultBalance(10);
  assert.ok(calls >= 2);
});

test('a value on the device outside the app limits does not lock the slot', async () => {
  const { fake, session } = await open();
  // A 12-character name stored by other software, in the active and saved copies.
  const name = [...'A50 MOD KIT2'].map((c) => c.charCodeAt(0)).concat(0);
  name.forEach((b, i) => { fake.active.names[0][i] = b; fake.saved.names[0][i] = b; });
  await session.load();
  await session.setGain(1, 0, 3);
  assert.deepEqual(fake.active.gains[0].slice(0, 1), [3]);
  await session.clearChanges();
  assert.equal(session.changeCount(), 0);
});

test('a bad value in a preset is refused before anything is sent', async () => {
  const { fake, session } = await open();
  const bands = session.current.slots[0].bands.map((b) => ({ ...b }));
  bands[0] = { freq: 95, bw: 4096 }; // shelf band with a width
  await assert.rejects(session.loadPreset(1, { name: 'X', gains: [1, 1, 1, 1, 1], bands }), RangeError);
  assert.equal(fake.log.length, 0);
});

test('frequency then width edits in a row keep both', async () => {
  const { fake, session } = await open();
  await Promise.all([session.setBandFreq(1, 2, 1000), session.setBandWidth(1, 2, 8192)]);
  assert.deepEqual(fake.active.bands[0][2], { freq: 1000, bw: 8192 });
});

test('a status poll while the headset is off shows it as off instead of failing', async () => {
  const { fake, session } = await open();
  fake.headsetOn = false;
  fake.failNext = 'HID_ERROR_SLAVE_NO_SLAVE';
  await session.refreshStatus();
  assert.equal(session.battery, null);
  assert.deepEqual(session.headset, { on: false, docked: false });
});
