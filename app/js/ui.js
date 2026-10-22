// Rendering: state in, HTML string out. No DOM access here, so it runs in
// tests; main.js puts the string on the page and wires the events.

import { SHELF_BANDS, MAX_NAME } from './protocol.js';

const FREQ_LABEL = (hz) => (hz >= 1000 ? `${(hz / 1000).toFixed(hz % 1000 ? 1 : 0)} kHz` : `${hz} Hz`);
const GATES = ['STREAMING', 'NIGHT', 'HOME', 'TOURNAMENT'];
const STREAM = ['MIC', 'CHAT', 'GAME', 'AUX'];
const TABS = [['eq', 'EQUALIZER PRESETS'], ['mic', 'MICROPHONE'], ['stream', 'STREAM PORT'], ['settings', 'SETTINGS']];

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const changedMark = (on) => (on ? '<span class="changed">● changed</span>' : '');
// aria-disabled rather than disabled: the button keeps focus across re-renders.
const dis = (on) => (on ? ' aria-disabled="true"' : '');
const pressed = (on) => `aria-pressed="${on ? 'true' : 'false'}"`;

const HEADPHONES = '<svg width="34" height="34" viewBox="0 0 34 34" fill="none" stroke="#ff7a4d" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 22v-5a11 11 0 0 1 22 0v5"/><rect x="4" y="20" width="6" height="9" rx="2"/><rect x="24" y="20" width="6" height="9" rx="2"/></svg>';
const HEADSET = '<svg width="76" height="76" viewBox="0 0 76 76" fill="none" stroke="#c9c9ce" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M14 44V36a24 24 0 0 1 48 0v8"/><rect x="9" y="40" width="14" height="22" rx="5"/><rect x="53" y="40" width="14" height="22" rx="5"/><path d="M16 60c0 6 6 9 14 9"/><path d="M10 72h56"/></svg>';

function brand() {
  return `<div class="brand">${HEADPHONES}<div>A50 CONTROL<small>FOR LINUX</small></div></div>`;
}

function headsetText(h) {
  if (!h) return '';
  if (!h.on && !h.docked) return 'Headset off';
  return `Headset ${h.on ? 'on' : 'off'} · ${h.docked ? 'docked' : 'not docked'}`;
}

function battery(b) {
  if (!b) return '';
  const on = Math.min(4, Math.ceil(b.percent / 25));
  const bars = [0, 1, 2, 3].map((i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('');
  const label = `Battery ${b.percent} percent${b.charging ? ', charging' : ''}`;
  return `<div class="battery${b.percent <= 15 ? ' low' : ''}" role="img" aria-label="${label}">` +
    `<b>${b.percent}%</b>${b.charging ? '<span>charging</span>' : ''}<div class="bars" aria-hidden="true">${bars}</div></div>`;
}

function top(s, demo) {
  return `<header class="top">${brand()}<div class="status">${demo ? '<span>DEMO · fake headset · <a href="./">Leave demo</a></span>' : ''}` +
    `<span>${esc(headsetText(s.headset))}</span>${battery(s.battery)}</div></header>`;
}

function device(s, busy) {
  const n = s.changeCount();
  const off = dis(!n || busy);
  return `<section class="device"><div class="device-id">${HEADSET}<div><h1>ASTRO A50 · GEN 4</h1>` +
    `<div class="fw">HEADSET FW ${esc(s.info.headsetFw ?? '— (turn the headset on)')}<br>BASE STATION FW ${esc(s.info.baseFw ?? '—')}</div></div></div>` +
    '<div class="actions">' +
    (n ? `<span class="pending">${n} unsynced change${n === 1 ? '' : 's'}</span>` : '') +
    (n ? `<button type="button" id="btn-revert-close" class="btn" data-action="revert-close"${off} title="Put back the saved settings, then close the window">REVERT &amp; CLOSE</button>` : '') +
    `<button type="button" id="btn-clear" class="btn" data-action="clear"${off}>CLEAR CHANGES</button>` +
    `<button type="button" id="btn-sync" class="btn${n ? ' primary' : ''}" data-action="sync"${off}>SYNC TO DEVICE</button>` +
    '</div></section>';
}

function tabs(view) {
  return '<nav class="tabs" role="tablist" aria-label="Sections">' + TABS.map(([id, label]) =>
    `<button type="button" role="tab" id="tab-${id}" aria-controls="tabpanel" aria-selected="${view.tab === id}" tabindex="${view.tab === id ? 0 : -1}" data-action="tab" data-value="${id}">${label}</button>`).join('') + '</nav>';
}

function libraryPanel(state) {
  const { view, library, busy } = state;
  const rows = library.length ? library.map((p, i) =>
    `<div class="lib-row${view.lib === i ? ' sel' : ''}"><button type="button" id="lib-pick-${i}" data-action="lib-pick" data-value="${i}" ${pressed(view.lib === i)}>${esc(p.name)}</button>` +
    `<button type="button" id="lib-remove-${i}" class="icon-btn bare" data-action="lib-remove" data-value="${i}" aria-label="Delete ${esc(p.name)}">✕</button></div>`).join('')
    : '<div class="empty">No presets yet. Save a slot to start your library.</div>';
  const picked = library[view.lib];
  return '<div class="panel"><div class="panel-head"><h2>PRESET LIBRARY</h2>' +
    `<button type="button" id="lib-add" class="icon-btn" data-action="lib-add" aria-label="Save EQ 0${view.sel} to the library">+</button></div>${rows}` +
    `<button type="button" id="lib-load" class="btn wide" data-action="lib-load" style="margin-top:16px"${dis(!picked || busy)}>` +
    `${picked ? `LOAD ${esc(picked.name)} INTO EQ 0${view.sel}` : 'PICK A PRESET TO LOAD'}</button>` +
    '<div class="lib-tools"><button type="button" id="lib-export" class="btn" data-action="lib-export">EXPORT</button>' +
    '<button type="button" id="lib-import" class="btn" data-action="lib-import">IMPORT</button></div></div>';
}

function slotsPanel(s, view, busy) {
  const rows = s.current.slots.map((slot, i) => {
    const n = i + 1;
    const active = s.activeSlot === n;
    return `<div class="slot${view.sel === n ? ' sel' : ''}">` +
      `<button type="button" id="slot-dot-${n}" class="dot" data-action="activate" data-slot="${n}" ${pressed(active)} aria-label="Listen to EQ 0${n}"${dis(busy)}><span></span></button>` +
      `<button type="button" id="slot-pick-${n}" class="pick" data-action="select" data-slot="${n}"><small>EQ 0${n}${active ? ' · ACTIVE' : ''}</small><span>${esc(slot.name)}</span></button>` +
      `${changedMark(s.slotChanged(n))}</div>`;
  }).join('');
  return `<div class="panel"><div class="panel-head"><h2>ON HEADSET</h2></div>${rows}` +
    '<p class="note">The dot marks the slot you hear now. The EQ button on the headset cycles through these three.</p></div>';
}

function editorPanel(s, view, busy) {
  const slot = s.current.slots[view.sel - 1];
  const live = s.activeSlot === view.sel;
  const bands = slot.gains.map((g, b) =>
    `<div class="band"><output for="band-${b}">${g > 0 ? '+' : ''}${g}</output>` +
    `<input id="band-${b}" class="vertical" type="range" min="-7" max="7" step="1" value="${g}" data-input="gain" data-band="${b}" aria-label="Band ${b + 1} gain, ${FREQ_LABEL(slot.bands[b].freq)}">` +
    `<label for="band-${b}">${FREQ_LABEL(slot.bands[b].freq)}</label></div>`).join('');
  const adv = view.adv ? '<div class="advanced">' + slot.bands.map((band, b) => {
    const width = SHELF_BANDS.has(b + 1) ? '<span>shelf</span>'
      : `<input id="width-${b}" type="number" min="0.1" max="3" step="0.05" value="${(band.bw / 4096).toFixed(2)}" data-input="width" data-band="${b}">`;
    return `<div><label for="freq-${b}">CENTER HZ</label>` +
      `<input id="freq-${b}" type="number" min="80" max="15000" step="1" value="${band.freq}" data-input="freq" data-band="${b}">` +
      `<label${SHELF_BANDS.has(b + 1) ? '' : ` for="width-${b}"`}>WIDTH × F</label>${width}</div>`;
  }).join('') + '</div>' : '';
  return '<div class="panel big"><div class="panel-head">' +
    `<div class="name-field"><h2>EQ 0${view.sel}</h2><label class="note" for="slot-name">Name</label>` +
    `<input id="slot-name" maxlength="${MAX_NAME}" value="${esc(slot.name)}" data-input="name" spellcheck="false" autocomplete="off"></div>` +
    `<span class="note">${live ? 'You are hearing this slot live' : 'Not the active slot: you hear edits once you switch to it'}</span></div>` +
    `<div class="bands">${bands}</div>` +
    `<button type="button" id="advanced-toggle" class="expander" data-action="advanced" aria-expanded="${view.adv}">${view.adv ? '▾' : '▸'} ADVANCED SETTINGS</button>${adv}` +
    '<div class="editor-actions">' +
    `<button type="button" id="btn-revert" class="btn" data-action="revert"${dis(!s.slotChanged(view.sel) || busy)}>REVERT</button>` +
    '<button type="button" id="lib-add-editor" class="btn" data-action="lib-add">SAVE TO LIBRARY</button></div></div>';
}

function slider(id, k, label, value, changed, help, vertical = false) {
  if (vertical) {
    return `<div><output for="${id}">${value}%</output>` +
      `<input id="${id}" class="vertical" type="range" min="0" max="100" value="${value}" data-input="slider" data-value="${k}">` +
      `<label for="${id}">${label}</label>${changedMark(changed)}</div>`;
  }
  return `<div><div class="slider-head"><label for="${id}">${label}</label><span>${changedMark(changed)} <output for="${id}">${value}%</output></span></div>` +
    `<input id="${id}" class="horizontal" type="range" min="0" max="100" value="${value}" data-input="slider" data-value="${k}">` +
    `<p class="note">${help}</p></div>`;
}

function micTab(s, busy) {
  const c = s.current;
  const gates = GATES.map((g, i) =>
    `<button type="button" id="gate-${i}" class="choice" data-action="gate" data-value="${i}" ${pressed(c.gate === i)}${dis(busy)}><b>${g}</b></button>`).join('');
  const eqs = [0, 1, 2].map((m) =>
    `<button type="button" id="mic-eq-${m}" class="choice" data-action="mic-eq" data-value="${m}" ${pressed(c.micEq === m)}${dis(busy)}><b>PRESET ${m + 1}</b></button>`).join('');
  return '<div class="row"><div class="panel half">' +
    slider('slider-4', 4, 'MIC LEVEL', c.sliders[4], s.sliderChanged(4), 'How loud you are to others.') +
    slider('slider-5', 5, 'SIDETONE', c.sliders[5], s.sliderChanged(5), 'How much of your own voice you hear.') +
    `</div><div class="panel half"><div><div class="panel-head"><h2>NOISE GATE</h2>${changedMark(s.fieldChanged('gate'))}</div><div class="choices">${gates}</div></div>` +
    `<div><div class="panel-head"><h2>MIC EQ</h2>${changedMark(s.fieldChanged('micEq'))}</div><div class="choices three">${eqs}</div>` +
    '<p class="note" style="margin-top:8px">Astro never documented what the three mic presets do.</p></div></div></div>';
}

function streamTab(s) {
  const c = s.current;
  return '<div class="panel"><div class="panel-head"><h2>STREAM PORT MIX</h2></div>' +
    '<p class="note" style="margin-bottom:20px">What the base station sends out of its stream port, for capture or streaming. Your own headphone mix is not affected.</p>' +
    `<div class="stream">${STREAM.map((l, k) => slider(`slider-${k}`, k, l, c.sliders[k], s.sliderChanged(k), '', true)).join('')}</div></div>`;
}

function settingsTab(s) {
  const c = s.current;
  const b = c.defaultBalance;
  const text = b === 128 ? 'Even' : b < 128 ? `${Math.round((128 - b) / 1.28)}% game` : `${Math.round((b - 128) / 1.27)}% chat`;
  return '<div class="row"><div class="panel half">' +
    `<div><div class="slider-head"><label for="balance">DEFAULT GAME / CHAT BALANCE</label><span>${changedMark(s.fieldChanged('defaultBalance'))} <output for="balance">${text}</output></span></div>` +
    `<input id="balance" class="horizontal" type="range" min="0" max="255" value="${b}" data-input="balance">` +
    '<div class="ends"><span>All game</span><span>All chat</span></div></div>' +
    `<div><div class="slider-head"><label for="alert">ALERT VOLUME</label><span>${changedMark(s.fieldChanged('alert'))} <output for="alert">${c.alert}%</output></span></div>` +
    `<input id="alert" class="horizontal" type="range" min="0" max="100" value="${c.alert}" data-input="alert">` +
    '<p class="note">Volume of the headset\'s beeps and voice prompts.</p></div></div>' +
    '<div class="panel half facts"><h2>THIS APP</h2>' +
    '<div>Waybar module: <span>astro-a50-status</span></div>' +
    '<div>Protocol: ported from <span>eh-fifty</span> (MIT)</div>' +
    '<div>Firmware updates are not supported, on purpose.</div></div></div>';
}

// The banner lives in its own container (see main.js), so a screen reader
// announces it once rather than on every re-render.
export function renderBanner(state) {
  const b = state.banner;
  if (!b) return '';
  return `<div class="banner${b.kind === 'error' ? ' error' : ''}" role="${b.kind === 'error' ? 'alert' : 'status'}"><span>${esc(b.text)}</span>` +
    '<button type="button" id="banner-dismiss" class="icon-btn bare" data-action="dismiss" aria-label="Dismiss">✕</button></div>';
}

function centerCard(title, body) {
  return `<header class="top">${brand()}</header><div class="center"><h1>${title}</h1>${body}</div>`;
}

export function render(state) {
  switch (state.screen) {
    case 'no-webhid':
      return centerCard('This browser can\'t reach USB devices', '<p class="note">A50 Control needs WebHID. Start it with <code>astro-a50</code>, which opens it in Chromium.</p>');
    case 'connect':
      return centerCard('Connect your base station',
        '<ul><li>Plug the A50 base station in with USB.</li>' +
        '<li>The <code>astro-a50</code> package installs a udev rule so you don\'t need root. Re-plug the base station once after installing.</li></ul>' +
        '<button type="button" id="btn-connect" class="btn primary" data-action="connect">CONNECT</button>' +
        '<p class="note">No headset here? <a href="?demo">Try the demo</a> with a fake one.</p>');
    case 'loading':
      return centerCard('Reading your headset…', '<p class="note">This takes a few seconds.</p>');
    case 'headset-off':
      return centerCard('Turn the headset on',
        '<p class="note">The base station is connected, but the headset is off and not docked. Turn it on or dock it.</p>' +
        '<button type="button" id="btn-retry" class="btn primary" data-action="retry">TRY AGAIN</button>');
    case 'other-window':
      return centerCard('A50 Control is already open', '<p class="note">It is already open in another window. Only one window talks to the headset at a time, so use that one.</p>');
    case 'replug':
      return centerCard('Re-plug the base station', '<p class="note">The base station stopped answering. Unplug the base station\'s USB cable, wait a moment and plug it back in. The app reconnects by itself.</p>' +
        '<p class="note">Still stuck after that? Reset the headset by holding the Game and Dolby buttons together for 15 seconds.</p>');
    default: {
      const s = state.session;
      const view = state.view;
      let body;
      const busy = Boolean(state.busy);
      if (view.tab === 'mic') body = micTab(s, busy);
      else if (view.tab === 'stream') body = streamTab(s);
      else if (view.tab === 'settings') body = settingsTab(s);
      else body = `<div class="row">${libraryPanel(state)}${slotsPanel(s, view, busy)}${editorPanel(s, view, busy)}</div>`;
      return top(s, state.demo) + device(s, busy) + tabs(view) +
        `<main id="tabpanel" role="tabpanel" aria-labelledby="tab-${view.tab}"${busy ? ' aria-busy="true"' : ''}>${body}</main>`;
    }
  }
}
