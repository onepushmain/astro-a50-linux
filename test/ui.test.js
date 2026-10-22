import { test } from 'node:test';
import assert from 'node:assert/strict';
import { A50 } from '../app/js/device.js';
import { FakeA50 } from '../app/js/fake-a50.js';
import { Session } from '../app/js/session.js';
import { render } from '../app/js/ui.js';

async function mainView(view = {}, opts) {
  const fake = new FakeA50(opts);
  const session = new Session(new A50(fake.transport));
  await session.load();
  const state = { screen: 'main', session, library: [], view: { tab: 'eq', sel: 2, lib: null, adv: false, ...view } };
  return { fake, session, state };
}

const count = (html, s) => html.split(s).length - 1;

test('the main screen shows battery, status and the three slots', async () => {
  const { state } = await mainView();
  const html = render(state);
  assert.match(html, /88%/);
  assert.match(html, /Headset on · not docked/);
  for (const name of ['ASTRO+', 'PRO', 'ASTRO']) assert.match(html, new RegExp(`>${name.replace('+', '\\+')}<`));
  assert.match(html, /HEADSET FW 34843\.43/);
});

test('the active slot is marked pressed and the selected slot is in the editor', async () => {
  const { state } = await mainView({ sel: 3 });
  const html = render(state);
  assert.match(html, /data-action="activate" data-slot="2" aria-pressed="true"/);
  assert.match(html, /data-action="activate" data-slot="1" aria-pressed="false"/);
  assert.match(html, /EQ 03/);
  assert.match(html, /Not the active slot/);
});

test('text from the device or library is escaped', async () => {
  const { state } = await mainView();
  state.session.current.slots[0].name = '<img src=x>';
  state.library = [{ name: '"><u>', gains: [0, 0, 0, 0, 0], bands: [] }];
  const html = render(state);
  assert.ok(!html.includes('<img src=x>'));
  assert.ok(html.includes('&lt;img src=x&gt;'));
  assert.ok(!html.includes('"><u>'));
  assert.ok(html.includes('&quot;&gt;&lt;u&gt;'));
});

test('sync is disabled until something changed, then the count shows', async () => {
  const { state, session } = await mainView();
  assert.match(render(state), /data-action="sync"[^>]*disabled/);
  await session.setGain(1, 0, -5);
  await session.setSlider(5, 90);
  const html = render(state);
  assert.match(html, /2 unsynced changes/);
  assert.doesNotMatch(html, /data-action="sync"[^>]*disabled/);
  assert.equal(count(html, '● changed'), 1);
});

test('shelf bands have no width field in advanced settings', async () => {
  const { state } = await mainView({ adv: true });
  const html = render(state);
  assert.equal(count(html, 'data-input="freq"'), 5);
  assert.equal(count(html, 'data-input="width"'), 3);
  assert.equal(count(html, '>shelf<'), 2);
});

test('the microphone tab shows the current noise gate and mic levels', async () => {
  const { state } = await mainView({ tab: 'mic' });
  const html = render(state);
  assert.match(html, /data-action="gate" data-value="2" aria-pressed="true"/);
  assert.match(html, /id="slider-4"[^>]*value="60"/);
  assert.match(html, /id="slider-5"[^>]*value="30"/);
});

test('the stream port tab has four sliders', async () => {
  const { state } = await mainView({ tab: 'stream' });
  assert.equal(count(render(state), 'data-input="slider"'), 4);
});

test('the connect screen explains setup and offers the demo', () => {
  const html = render({ screen: 'connect' });
  assert.match(html, /data-action="connect"/);
  assert.match(html, /udev/);
  assert.match(html, /\?demo/);
});

test('a banner is shown above the main screen', async () => {
  const { state } = await mainView();
  state.banner = { kind: 'error', text: 'Base station disconnected' };
  assert.match(render(state), /class="banner error"[^]*Base station disconnected/);
});

test('low battery gets the low class', async () => {
  const { state } = await mainView({}, { battery: 12 });
  assert.match(render(state), /class="battery low"/);
});
