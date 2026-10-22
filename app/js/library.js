// The preset library lives on this PC (the app's own browser profile), not on
// the headset. A preset is { name, gains[5], bands[5]{freq, bw} }.

import { MAX_NAME, checkName, checkGains, checkFreqBw } from './protocol.js';

function normalize(p) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.bands) || p.bands.length !== 5) {
    throw new RangeError('a preset needs a name, 5 gains and 5 bands');
  }
  checkName(p.name);
  checkGains(p.gains);
  p.bands.forEach((b, i) => checkFreqBw(i + 1, b?.freq, b?.bw));
  return { name: p.name, gains: [...p.gains], bands: p.bands.map((b) => ({ freq: b.freq, bw: b.bw })) };
}

function parse(json) {
  let raw;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((p) => {
    try {
      return [normalize(p)];
    } catch {
      return [];
    }
  });
}

export class Library {
  static KEY = 'astro-a50.library.v1';

  constructor(storage) {
    this.storage = storage;
    const json = storage.getItem(Library.KEY);
    this.presets = json === null ? [] : parse(json);
  }

  list() { return this.presets.map(normalize); }

  save() { this.storage.setItem(Library.KEY, JSON.stringify(this.presets)); }

  uniqueName(name) {
    const taken = new Set(this.presets.map((p) => p.name));
    if (!taken.has(name)) return name;
    for (let n = 2; ; n++) {
      const suffix = ` ${n}`;
      const candidate = name.slice(0, MAX_NAME - suffix.length).trimEnd() + suffix;
      if (!taken.has(candidate)) return candidate;
    }
  }

  add(preset) {
    const p = normalize(preset);
    p.name = this.uniqueName(p.name);
    this.presets.push(p);
    this.save();
    return normalize(p);
  }

  remove(name) {
    this.presets = this.presets.filter((p) => p.name !== name);
    this.save();
  }

  exportJson() { return JSON.stringify(this.presets, null, 2); }

  // Returns how many presets were added; invalid entries are skipped.
  importJson(json) {
    const found = parse(json);
    found.forEach((p) => this.add(p));
    return found.length;
  }
}
