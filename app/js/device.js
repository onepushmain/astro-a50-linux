// High-level access to the A50 base station over a report transport.
// A transport is { send(Uint8Array63): Promise, onInput(cb(Uint8Array63)) },
// with report IDs stripped on both sides (WebHID style).

import {
  Cmd, TIMEOUT_MS, MIC_EQS, NoiseGate, Slider, ProtocolError,
  encodeRequest, decodeResponse, checkSlot, checkPercent,
  parseBattery, parseHeadsetStatus, parseName, encodeName, parseGain, encodeGain,
  parseFreqBw, encodeFreqBw, parseImageHeader, parseU32,
} from './protocol.js';

export class DeviceTimeout extends Error {
  constructor() {
    super('The base station stopped answering. Re-plug it, then reconnect.');
    this.name = 'DeviceTimeout';
  }
}

function echo(data, ...expected) {
  if (data.length < expected.length || expected.some((b, i) => data[i] !== b)) {
    throw new ProtocolError('reply did not echo the request');
  }
}

function atLeast(data, n) {
  if (data.length < n) throw new ProtocolError('short reply');
  return data;
}

function checkInt(value, lo, hi, what) {
  if (!Number.isInteger(value) || value < lo || value > hi) throw new RangeError(`${what} must be ${lo}-${hi}`);
}

export class A50 {
  constructor(transport, { timeoutMs = TIMEOUT_MS } = {}) {
    this.transport = transport;
    this.timeoutMs = timeoutMs ?? TIMEOUT_MS;
    this.queue = Promise.resolve();
    this.pending = null;
    this.dead = null;
    this.unlisten = transport.onInput((report) => {
      const waiter = this.pending;
      if (!waiter) return; // unsolicited report: ignore
      this.pending = null;
      waiter(report);
    });
  }

  // Stops listening for replies; any later request is refused.
  close() {
    if (typeof this.unlisten === 'function') this.unlisten();
    this.unlisten = null;
    this.pending = null;
    this.dead ??= new Error('device closed');
  }

  // One request at a time: replies carry no request id, so the next reply
  // always belongs to the request in flight.
  request(type, payload = []) {
    const bytes = encodeRequest(type, payload);
    const run = async () => {
      if (this.dead) throw this.dead;
      let timer;
      const reply = new Promise((resolve, reject) => {
        this.pending = resolve;
        timer = setTimeout(() => {
          this.pending = null;
          this.dead = new DeviceTimeout();
          reject(this.dead);
        }, this.timeoutMs);
      });
      try {
        // The timer covers the write too, so a send that never settles
        // still ends the request.
        const [, report] = await Promise.all([this.transport.send(bytes), reply]);
        return decodeResponse(report);
      } finally {
        clearTimeout(timer);
        this.pending = null;
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  async getBattery() { return parseBattery(await this.request(Cmd.GET_BATTERY_STATUS)); }
  async getHeadsetStatus() { return parseHeadsetStatus(await this.request(Cmd.GET_HEADSET_STATUS)); }

  async getDeviceInfo() { return parseImageHeader(await this.request(Cmd.GET_DEVICE_INFO)); }
  async getHeadsetInfo() { return parseImageHeader(await this.request(Cmd.GET_HEADSET_INFO, [0x01])); }

  async getBaseFirmware() {
    const info = parseImageHeader(await this.request(Cmd.GET_DEVICE_INFO));
    if (info.fwMajor === null) throw new ProtocolError('short device info reply');
    const minor = atLeast(await this.request(Cmd.GET_BASE_FIRMWARE_MINOR), 1);
    return `${info.fwMajor}.${minor[0]}`;
  }

  async getHeadsetFirmware() {
    const major = parseU32(await this.request(Cmd.GET_HEADSET_FIRMWARE_MAJOR, [0x0a]));
    const minor = atLeast(await this.request(Cmd.GET_HEADSET_FIRMWARE_MINOR, [0x0a]), 1);
    return `${major}.${minor[0]}`;
  }

  async getActiveSlot() {
    const data = atLeast(await this.request(Cmd.GET_ACTIVE_EQ_PRESET), 1);
    checkSlot(data[0]);
    return data[0];
  }

  async setActiveSlot(slot) {
    checkSlot(slot);
    echo(await this.request(Cmd.SET_ACTIVE_EQ_PRESET, [slot]), Cmd.SET_ACTIVE_EQ_PRESET, slot);
  }

  async getName(slot, saved = false) {
    checkSlot(slot);
    return parseName(await this.request(Cmd.GET_EQ_PRESET_NAME, [slot, saved ? 1 : 0]), slot);
  }

  async setName(slot, name) {
    const payload = encodeName(slot, name);
    echo(await this.request(Cmd.SET_EQ_PRESET_NAME, payload), Cmd.SET_EQ_PRESET_NAME, slot);
  }

  async getGain(slot) {
    checkSlot(slot);
    return parseGain(await this.request(Cmd.GET_EQ_PRESET_GAIN, [slot]), slot);
  }

  async setGain(slot, gains) {
    const payload = encodeGain(slot, gains);
    echo(await this.request(Cmd.SET_EQ_PRESET_GAIN, payload), Cmd.SET_EQ_PRESET_GAIN, slot);
  }

  async getFreqBw(slot, band) {
    checkSlot(slot);
    return parseFreqBw(await this.request(Cmd.GET_EQ_PRESET_FREQ_AND_BW, [slot, band]), slot, band);
  }

  async setFreqBw(slot, band, freq, bw) {
    const payload = encodeFreqBw(slot, band, freq, bw);
    echo(await this.request(Cmd.SET_EQ_PRESET_FREQ_AND_BW, payload), Cmd.SET_EQ_PRESET_FREQ_AND_BW, slot, band, 0);
  }

  async getSlider(slider) {
    checkInt(slider, Slider.STREAM_MIC, Slider.SIDETONE, 'slider');
    const data = atLeast(await this.request(Cmd.GET_SLIDER_VALUE, [slider]), 4);
    echo(data, Cmd.GET_SLIDER_VALUE, slider);
    return { value: data[2], saved: data[3] };
  }

  async setSlider(slider, percent) {
    checkInt(slider, Slider.STREAM_MIC, Slider.SIDETONE, 'slider');
    checkPercent(percent, 'slider value');
    echo(await this.request(Cmd.SET_SLIDER_VALUE, [slider, percent]), Cmd.SET_SLIDER_VALUE, slider);
  }

  async getNoiseGate() {
    const data = atLeast(await this.request(Cmd.GET_NOISE_GATE_MODE), 3);
    echo(data, Cmd.GET_NOISE_GATE_MODE);
    return { value: data[1], saved: data[2] };
  }

  async setNoiseGate(mode) {
    checkInt(mode, NoiseGate.STREAMING, NoiseGate.TOURNAMENT, 'noise gate mode');
    // eh-fifty: this reply echoes the mode, not the request type.
    echo(await this.request(Cmd.SET_NOISE_GATE_MODE, [mode]), mode);
  }

  async getMicEq(saved = false) {
    const data = atLeast(await this.request(Cmd.GET_MIC_EQ, [saved ? 1 : 0]), 1);
    if (!MIC_EQS.includes(data[0])) throw new ProtocolError(`unknown mic EQ ${data[0]}`);
    return data[0];
  }

  async setMicEq(preset) {
    if (!MIC_EQS.includes(preset)) throw new RangeError('mic EQ must be 0-2');
    echo(await this.request(Cmd.SET_MIC_EQ, [preset]), Cmd.SET_MIC_EQ);
  }

  // Balance: 0 = all game .. 255 = all chat.
  async getBalance() { return atLeast(await this.request(Cmd.GET_BALANCE), 1)[0]; }

  async getDefaultBalance(saved = false) {
    return atLeast(await this.request(Cmd.GET_DEFAULT_BALANCE, [saved ? 1 : 0]), 1)[0];
  }

  async setDefaultBalance(balance) {
    checkInt(balance, 0, 255, 'balance');
    echo(await this.request(Cmd.SET_DEFAULT_BALANCE, [balance]), Cmd.SET_DEFAULT_BALANCE);
  }

  async getAlertVolume(saved = false) {
    const value = atLeast(await this.request(Cmd.GET_ALERT_VOLUME, [saved ? 1 : 0]), 1)[0];
    checkPercent(value, 'alert volume');
    return value;
  }

  async setAlertVolume(percent) {
    checkPercent(percent, 'alert volume');
    echo(await this.request(Cmd.SET_ALERT_VOLUME, [percent]), Cmd.SET_ALERT_VOLUME);
  }

  // Writes every active value to the device's flash.
  async save() {
    echo(await this.request(Cmd.SAVE_VALUES), Cmd.SAVE_VALUES, 0x00);
  }
}
