import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../app/js/library.js';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}

const bands = [95, 419, 783, 3499, 6100].map((freq, i) => ({ freq, bw: i % 4 === 0 ? 0 : 4096 }));
const preset = (name, gains = [0, 0, 0, 5, 7]) => ({ name, gains, bands });

test('a new library is empty', () => {
  assert.deepEqual(new Library(memoryStorage()).list(), []);
});

test('presets persist across instances', () => {
  const storage = memoryStorage();
  new Library(storage).add(preset('ASTRO'));
  assert.deepEqual(new Library(storage).list().map((p) => p.name), ['ASTRO']);
});

test('adding a name that exists gets a numbered copy within 11 characters', () => {
  const lib = new Library(memoryStorage());
  lib.add(preset('A50 MOD KIT'));
  const second = lib.add(preset('A50 MOD KIT'));
  assert.equal(second.name, 'A50 MOD K 2');
  assert.equal(lib.add(preset('PRO')).name, 'PRO');
  assert.equal(lib.add(preset('PRO')).name, 'PRO 2');
  assert.equal(lib.add(preset('PRO')).name, 'PRO 3');
});

test('remove deletes by name', () => {
  const lib = new Library(memoryStorage());
  lib.add(preset('A'));
  lib.add(preset('B'));
  lib.remove('A');
  assert.deepEqual(lib.list().map((p) => p.name), ['B']);
});

test('invalid presets are refused', () => {
  const lib = new Library(memoryStorage());
  assert.throws(() => lib.add(preset('BAD', [9, 0, 0, 0, 0])), RangeError);
  assert.throws(() => lib.add({ name: 'X', gains: [0, 0, 0, 0, 0], bands: bands.slice(0, 4) }), RangeError);
});

test('corrupt or tampered storage is ignored entry by entry', () => {
  const storage = memoryStorage();
  storage.setItem(Library.KEY, JSON.stringify([preset('GOOD'), { name: 'EVIL', gains: 'x' }, 7]));
  assert.deepEqual(new Library(storage).list().map((p) => p.name), ['GOOD']);
  storage.setItem(Library.KEY, '{not json');
  assert.deepEqual(new Library(storage).list(), []);
});

test('list returns copies, so callers cannot edit the stored presets', () => {
  const lib = new Library(memoryStorage());
  lib.add(preset('A'));
  lib.list()[0].gains[0] = 7;
  assert.equal(lib.list()[0].gains[0], 0);
});

test('export and import round-trip as JSON', () => {
  const a = new Library(memoryStorage());
  a.add(preset('ONE'));
  a.add(preset('TWO', [1, 1, 1, 1, 1]));
  const b = new Library(memoryStorage());
  assert.equal(b.importJson(a.exportJson()), 2);
  assert.deepEqual(b.list(), a.list());
});
