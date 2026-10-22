import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../app/js/controller.js';
import { Cmd } from '../app/js/protocol.js';
import { FakeHID, FakeHIDDevice, FakeLocks, memoryStorage, tick, until } from './helpers/fake-hid.js';

function make({ device = new FakeHIDDevice(), granted = true, locks = new FakeLocks(), demo = false, timeoutMs } = {}) {
  const hid = new FakeHID({ granted: granted ? [device] : [], chooser: device });
  const closed = [];
  const c = new Controller({
    hid, locks, storage: memoryStorage(), demo, timeoutMs,
    draw: () => {}, closeWindow: () => closed.push(true),
  });
  return { c, hid, device, locks, closed };
}

const sent = (device, type) => device.a50.log.filter((r) => r.type === type).length;

test('boots straight into the main screen when the device was allowed before', async () => {
  const { c } = make();
  await c.init();
  assert.equal(c.state.screen, 'main');
  assert.deepEqual(c.state.session.current.slots.map((s) => s.name), ['ASTRO+', 'PRO', 'ASTRO']);
  assert.equal(c.state.view.sel, 2);
});

test('without a permitted device it asks to connect, and connect loads it', async () => {
  const { c } = make({ granted: false });
  await c.init();
  assert.equal(c.state.screen, 'connect');
  await c.act('connect');
  assert.equal(c.state.screen, 'main');
});

test('a second window does not talk to the device', async () => {
  const locks = new FakeLocks();
  const device = new FakeHIDDevice();
  const first = make({ device, locks });
  await first.c.init();
  const before = device.a50.log.length;
  const second = make({ device, locks });
  await second.c.init();
  assert.equal(second.c.state.screen, 'other-window');
  assert.equal(device.a50.log.length, before);
});

test('after a timeout nothing is sent until the base station is re-plugged', async () => {
  const { c, hid, device } = make({ timeoutMs: 20 });
  await c.init();
  device.a50.silent = true;
  await c.act('gate', { value: 3 });
  assert.equal(c.state.screen, 'replug');
  assert.equal(device.opened, false);
  device.a50.silent = false;
  const count = device.a50.log.length;
  await c.act('retry');
  await c.act('connect');
  hid.emit('connect', device); // a connect event without a disconnect first is ignored
  await tick();
  assert.equal(device.a50.log.length, count);
  assert.equal(c.state.screen, 'replug');
  hid.emit('disconnect', device);
  const fresh = new FakeHIDDevice();
  hid.granted = [fresh];
  hid.emit('connect', fresh);
  await until(() => c.state.screen === 'main');
});

test('reconnecting does not stack reply listeners on the device', async () => {
  const { c, hid, device } = make();
  await c.init();
  hid.emit('disconnect', device);
  assert.equal(c.state.screen, 'connect');
  hid.emit('connect', device);
  await until(() => c.state.screen === 'main');
  assert.equal(device.listeners.size, 1);
  await c.act('retry');
  assert.equal(device.listeners.size, 1);
  assert.equal(hid.handlers.connect.length, 1);
  assert.equal(hid.handlers.disconnect.length, 1);
});

test('an error from an old session does not disturb the current one', async () => {
  const { c } = make();
  await c.init();
  const old = c.state.session;
  await c.act('retry');
  assert.notEqual(c.state.session, old);
  c.failed(new Error('late failure'), old);
  assert.equal(c.state.screen, 'main');
  assert.equal(c.state.banner, null);
});

test('a double click on sync saves once', async () => {
  const { c, device } = make();
  await c.init();
  await c.commit('slider', 70, { slider: 5 });
  await Promise.all([c.act('sync'), c.act('sync')]);
  assert.equal(sent(device, Cmd.SAVE_VALUES), 1);
});

test('device error codes are shown in plain words', async () => {
  const { c, device } = make();
  await c.init();
  device.a50.failNext = 'HID_ERROR_SLAVE_NO_SLAVE';
  await c.act('gate', { value: 1 });
  assert.match(c.state.banner.text, /headset is off/i);
  assert.doesNotMatch(c.state.banner.text, /HID_ERROR/);
  await c.act('dismiss');
  assert.equal(c.state.banner, null);
});

test('frequency then width commits keep both values', async () => {
  const { c, device } = make();
  await c.init();
  await Promise.all([c.commit('freq', 1000, { band: 2 }), c.commit('width', 2, { band: 2 })]);
  assert.deepEqual(device.a50.active.bands[1][2], { freq: 1000, bw: 8192 });
});

test('revert and close restores saved values, then closes the window', async () => {
  const { c, device, closed } = make();
  await c.init();
  await c.commit('gain', -7, { band: 0 });
  await c.act('revert-close');
  assert.deepEqual(device.a50.active.gains, device.a50.saved.gains);
  assert.equal(closed.length, 1);
});

test('the status poll keeps running against the current session only', async () => {
  const { c, device } = make();
  await c.init();
  device.a50.battery = 40;
  await c.poll();
  assert.equal(c.state.session.battery.percent, 40);
});

test('demo mode needs no WebHID or lock', async () => {
  const c = new Controller({ hid: null, locks: null, storage: memoryStorage(), demo: true, draw: () => {}, closeWindow: () => {} });
  await c.init();
  assert.equal(c.state.screen, 'main');
});

test('the library saves the selected slot and loads it into another', async () => {
  const { c, device } = make();
  await c.init();
  await c.act('select', { slot: 1 });
  await c.act('lib-add');
  assert.deepEqual(c.state.library.map((p) => p.name), ['ASTRO+']);
  await c.act('select', { slot: 3 });
  await c.act('lib-load');
  assert.deepEqual(device.a50.active.gains[2], [2, 0, 0, 5, 7]);
  assert.equal(c.importLibrary('not json'), 0);
});
