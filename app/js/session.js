// What the app knows about the connected headset: the active values (what
// you hear now) and the saved values (in flash). Edits go to the device at
// once as active values; sync() saves them; clearChanges() writes the saved
// ones back. Slots are numbered 1-3, bands 0-4 (device bands are 1-5).

import { HeadsetNotConnected, RequestFailed, SLOTS, BANDS, checkGains, checkName, checkFreqBw } from './protocol.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export const SLIDERS = 6; // stream mic/chat/game/aux, mic, sidetone
const FIELDS = ['gate', 'micEq', 'defaultBalance', 'alert'];

export class Session {
  constructor(a50) {
    this.a50 = a50;
    this.ops = Promise.resolve();
    this.listeners = [];
    this.info = { baseFw: null, headsetFw: null };
    this.battery = null;
    this.headset = null;
    this.activeSlot = null;
    this.current = null;
    this.saved = null;
  }

  onChange(cb) { this.listeners.push(cb); }
  emit() { this.listeners.forEach((cb) => cb(this)); }

  // Edits run one after another so each starts from the previous result.
  run(fn) {
    const result = this.ops.then(fn);
    this.ops = result.catch(() => {});
    return result.finally(() => this.emit());
  }

  load() {
    return this.run(async () => {
      const a = this.a50;
      this.info.baseFw = await a.getBaseFirmware();
      this.info.headsetFw = await optional(a.getHeadsetFirmware());
      await this.readStatus();
      const current = { slots: [], sliders: [] };
      const saved = { slots: [], sliders: [] };
      for (const slot of SLOTS) {
        const gain = await a.getGain(slot);
        const bands = [];
        const savedBands = [];
        for (const band of BANDS) {
          const fb = await a.getFreqBw(slot, band);
          bands.push({ freq: fb.freq, bw: fb.bw });
          savedBands.push({ freq: fb.savedFreq, bw: fb.savedBw });
        }
        current.slots.push({ name: await a.getName(slot), gains: gain.gains, bands });
        saved.slots.push({ name: await a.getName(slot, true), gains: gain.saved, bands: savedBands });
      }
      for (let k = 0; k < SLIDERS; k++) {
        const s = await a.getSlider(k);
        current.sliders.push(s.value);
        saved.sliders.push(s.saved);
      }
      const gate = await a.getNoiseGate();
      current.gate = gate.value;
      saved.gate = gate.saved;
      current.micEq = await a.getMicEq();
      saved.micEq = await a.getMicEq(true);
      current.defaultBalance = await a.getDefaultBalance();
      saved.defaultBalance = await a.getDefaultBalance(true);
      current.alert = await a.getAlertVolume();
      saved.alert = await a.getAlertVolume(true);
      this.current = current;
      this.saved = saved;
    });
  }

  async readStatus() {
    this.battery = await this.a50.getBattery();
    this.headset = await this.a50.getHeadsetStatus();
    this.activeSlot = await this.a50.getActiveSlot();
  }

  // Battery, power/dock state and the active slot change on the headset itself.
  refreshStatus() { return this.run(() => this.readStatus()); }

  changeCount() {
    if (!this.current) return 0;
    let n = SLOTS.filter((s) => this.slotChanged(s)).length;
    n += this.current.sliders.filter((v, k) => v !== this.saved.sliders[k]).length;
    n += FIELDS.filter((f) => this.current[f] !== this.saved[f]).length;
    return n;
  }

  slotChanged(slot) { return !same(this.current.slots[slot - 1], this.saved.slots[slot - 1]); }
  sliderChanged(k) { return this.current.sliders[k] !== this.saved.sliders[k]; }
  fieldChanged(f) { return this.current[f] !== this.saved[f]; }

  // Sends only the parts of a slot that differ from what the device has now.
  async writeSlot(slot, target) {
    const have = this.current.slots[slot - 1];
    checkName(target.name);
    checkGains(target.gains);
    target.bands.forEach((b, i) => checkFreqBw(i + 1, b.freq, b.bw));
    if (target.name !== have.name) {
      await this.a50.setName(slot, target.name);
      have.name = target.name;
    }
    if (!same(target.gains, have.gains)) {
      await this.a50.setGain(slot, target.gains);
      have.gains = [...target.gains];
    }
    for (let i = 0; i < 5; i++) {
      const b = target.bands[i];
      if (b.freq !== have.bands[i].freq || b.bw !== have.bands[i].bw) {
        await this.a50.setFreqBw(slot, i + 1, b.freq, b.bw);
        have.bands[i] = { freq: b.freq, bw: b.bw };
      }
    }
  }

  editSlot(slot, change) {
    return this.run(() => {
      const target = clone(this.current.slots[slot - 1]);
      change(target);
      return this.writeSlot(slot, target);
    });
  }

  setGain(slot, band, db) { return this.editSlot(slot, (t) => { t.gains[band] = db; }); }
  setBand(slot, band, freq, bw) { return this.editSlot(slot, (t) => { t.bands[band] = { freq, bw }; }); }
  setName(slot, name) { return this.editSlot(slot, (t) => { t.name = name; }); }

  loadPreset(slot, preset) {
    return this.editSlot(slot, (t) => {
      t.name = preset.name;
      t.gains = [...preset.gains];
      t.bands = preset.bands.map((b) => ({ freq: b.freq, bw: b.bw }));
    });
  }

  revertSlot(slot) {
    return this.run(() => this.writeSlot(slot, clone(this.saved.slots[slot - 1])));
  }

  setSlider(k, value) {
    return this.run(async () => {
      await this.a50.setSlider(k, value);
      this.current.sliders[k] = value;
    });
  }

  setField(field, value, write) {
    return this.run(async () => {
      await write(value);
      this.current[field] = value;
    });
  }

  setNoiseGate(mode) { return this.setField('gate', mode, (v) => this.a50.setNoiseGate(v)); }
  setMicEq(preset) { return this.setField('micEq', preset, (v) => this.a50.setMicEq(v)); }
  setDefaultBalance(b) { return this.setField('defaultBalance', b, (v) => this.a50.setDefaultBalance(v)); }
  setAlertVolume(p) { return this.setField('alert', p, (v) => this.a50.setAlertVolume(v)); }

  setActiveSlot(slot) {
    return this.run(async () => {
      await this.a50.setActiveSlot(slot);
      this.activeSlot = slot;
    });
  }

  sync() {
    return this.run(async () => {
      await this.a50.save();
      this.saved = clone(this.current);
    });
  }

  clearChanges() {
    return this.run(async () => {
      for (const slot of SLOTS) {
        if (this.slotChanged(slot)) await this.writeSlot(slot, clone(this.saved.slots[slot - 1]));
      }
      for (let k = 0; k < SLIDERS; k++) {
        if (this.sliderChanged(k)) {
          await this.a50.setSlider(k, this.saved.sliders[k]);
          this.current.sliders[k] = this.saved.sliders[k];
        }
      }
      const writers = {
        gate: (v) => this.a50.setNoiseGate(v),
        micEq: (v) => this.a50.setMicEq(v),
        defaultBalance: (v) => this.a50.setDefaultBalance(v),
        alert: (v) => this.a50.setAlertVolume(v),
      };
      for (const f of FIELDS) {
        if (this.fieldChanged(f)) {
          await writers[f](this.saved[f]);
          this.current[f] = this.saved[f];
        }
      }
    });
  }
}

async function optional(promise) {
  try {
    return await promise;
  } catch (e) {
    if (e instanceof HeadsetNotConnected || e instanceof RequestFailed) return null;
    throw e;
  }
}
