# Astro A50 Linux Control: Design

Date: 2026-10-21
Status: draft, awaiting approval

## Intent

The user owns an Astro A50 (generation 4) wireless headset whose base station
enumerates as USB `9886:002c` ("Astro Gaming Astro A50"). On Linux, audio
already works: PipeWire exposes two sinks, `...stereo-game` and
`...stereo-chat`. What is missing is everything Astro Command Center (ACC) does
on Windows: EQ presets, microphone settings, sidetone, stream port mix, battery
and firmware info. Logitech ships ACC for Windows only.

The goal is a Linux replacement for ACC that the user can manage from their
desktop (Hyprland on Wayland, CachyOS), installed like a normal app, plus a
waybar battery indicator.

## Goals

1. Feature parity with ACC's A50 screens (see "Reference UI"):
   - Header: headset image, headset and base station firmware versions,
     battery percent with bar graphic, charging state, headset docked/on.
   - **Equalizer Presets** tab: a local preset library (unlimited, stored on
     the PC), the 3 on-headset slots (EQ 01-03) with names, choosing the
     active slot, a 5-band gain editor (-7..+7 dB, 1 dB steps), and an
     "Advanced settings" section with per-band center frequency and bandwidth.
   - **Microphone** tab: mic level, mic EQ preset (0/1/2), noise gate mode
     (Streaming / Night / Home / Tournament), sidetone level.
   - **Stream Port** tab: the four stream-mix sliders (mic, chat, game, aux).
   - **Settings** tab: default game/chat balance, alert volume.
   - ACC's workflow: edits apply live; **Sync to device** saves them to the
     headset; **Revert / Clear changes** restores the saved values.
2. Installed as an app: a pacman package (PKGBUILD) that puts a launcher in the
   app menu. No terminal, no manually started web server.
3. A waybar module showing battery %, charging and the active EQ slot.

## Non-goals

- Firmware updates. Never.
- Dolby / console-side features, and anything the device protocol below does
  not cover.
- Other Astro or Logitech headsets (A20, MixAmp, A50 gen 5). The code should not
  make adding them hard, but v1 only targets `9886:002c`.
- Windows or macOS builds.
- Changing PipeWire routing or the volume of the game/chat sinks.

## Anti-goals (a failure even if it works)

- Anything that could brick the base station or headset. That rules out
  firmware writes and sending request types the protocol table doesn't list.
- Leaving the headset in a state that behaves differently on a console or on
  Windows ACC. We only write settings the device already exposes, through the
  same commands ACC uses.
- Needing root to run, or a page the user must open by hand in a browser.
- Silently persisting changes: writes to flash (`SAVE_VALUES`) happen only when
  the user presses Sync.

## Constraints and verified facts

- Machine: CachyOS (Arch-based), Hyprland/Wayland, `chromium` at
  `/usr/bin/chromium`, Node at `/usr/bin/node`. No Windows machine is
  available, so no USB capture of ACC is possible.
- HID interface (USB interface 6, interrupt EP OUT 0x05 / IN 0x85) appears as
  `/dev/hidraw0`. Report descriptor (read from sysfs):
  vendor usage page `0xFF32`, usage `0x09`, **report ID `0x02`, 63-byte input
  report, 63-byte output report**. So WebHID can drive it with
  `device.sendReport(0x02, <63 bytes>)` and `inputreport` events.
- `/dev/hidraw0` is currently `root:root 0600`, so the user can't open it.
  The package ships a udev rule (`TAG+="uaccess"` for `9886:002c` on both the
  `usb` and `hidraw` subsystems, in a file whose name sorts before
  `71-seat.rules`). Without that rule neither WebHID nor the waybar helper
  can talk to the device.
- **Verified 2026-10-21 over hidraw** (read-only probe, run as root): writing
  `[0x02, type, len?, payload?]` zero-padded to 64 bytes to `/dev/hidraw0`
  gets a 64-byte reply in eh-fifty's format, with no driver detach needed.
  Seen: `0x7C` -> `02 02 01 58` (88 %, not charging); `0x54` -> `02 02 01 02`
  (on, not docked); `0x6C` -> `02 02 01 02` (slot 2); `0x6E [n,0]` ->
  `02 02 34 6e n <name> 00 ...`, names `ASTRO+`, `PRO`, `ASTRO`. Bytes after
  the NUL are stale leftovers of an older name (`A50 MOD KIT`), so parse names
  only up to the first NUL. Fixtures for the fake A50 should use these real
  replies.
- The user's global git pre-commit hook (`~/.config/git/hooks/pre-commit`)
  rejects files over 20000 bytes, so source files must be split to stay
  under that limit.

## Protocol

Source: the MIT-licensed `eh-fifty` 0.6.0 library (tdryer/eh-fifty), which
decoded the A50 gen 4 protocol by reverse engineering and is tested on Linux.
Its `eh_fifty.py` is the reference implementation. Port it to JavaScript and
credit it in the README and LICENSE notices.

Framing (eh-fifty writes `[0x02, type, len, ...payload]` on the interrupt
endpoint; over WebHID the leading `0x02` is the report ID):

- Request: report ID `0x02`, then `type`, then (if a payload) `len`, then the
  payload, zero-padded to 63 bytes.
- Response: report ID `0x02`, then `status` (0 no-response, 1 error, 2 ok),
  then `len`, then data. Cap `len` at the actual report size. Error data:
  4 unknown bytes, then a NUL-terminated message; `HID_ERROR_SLAVE_NO_SLAVE`
  means the headset is off and undocked.
- Requests are strictly one at a time: send, wait for the response, then send
  the next. Timeout 3000 ms (`SAVE_VALUES` can take over 2 s). eh-fifty resets
  the USB device after a timeout. WebHID can't do that, so on timeout the app
  shows "device not responding, re-plug the base station" and stops sending.

Allowed request types (the only ones the code may send):

| Type | Meaning | Payload |
|---|---|---|
| 0x03 | base device info (VID/PID, build time; FW major at data[21:25] LE) | none |
| 0x54 | headset status: bit0 docked, bit1 on | none |
| 0x55 | base FW minor | none |
| 0x61 | save active values to flash | none |
| 0x62 / 0x68 | set / get slider (0 mix-mic, 1 mix-chat, 2 mix-game, 3 mix-aux, 4 mic, 5 sidetone), 0-100 | set: [slider, pct]; get: [slider] -> [type, slider, active, saved] |
| 0x63 / 0x69 | set / get EQ gain for slot 1-3; device stores dB+12 | set: [slot, 5 x (dB+12)]; get -> [type, slot, 5 active, 5 saved] |
| 0x64 / 0x6A | set / get noise gate (0 Streaming, 1 Night, 2 Home, 3 Tournament) | get -> [type, active, saved] |
| 0x67 / 0x6C | set / get active EQ slot (1-3) | |
| 0x6D / 0x6E | set / get EQ slot name (NUL-terminated) | set: [slot, n, name..., 0]; get: [slot, saved?] |
| 0x6F / 0x70 | set / get band freq and bandwidth | set: [slot, band, bw u16 LE, freq u16 LE]; get -> [type, slot, band, bw, saved bw, freq, saved freq] (u16 LE) |
| 0x71 / 0x7B | set / get mic EQ (0-2) | get: [saved?] |
| 0x72 | current balance (0 = all game .. 255 = all chat) | none |
| 0x73 / 0x77 | set / get default balance | get: [saved?] |
| 0x76 / 0x7A | set / get alert volume 0-100 | get: [saved?] |
| 0x7C | battery: bit7 charging, bits0-6 percent | none |
| 0x83 | headset device info (docked only) | [0x01] |
| 0xD6 / 0xDA | headset FW minor / major | [0x0A] |

Value limits come from eh-fifty and are enforced before sending: gain -7..+7;
center freq 80-15000 Hz; bandwidth = multiple of center freq x 4096, range
409-12288, and **0 for bands 1 and 5** (shelves). Validate every response's
echoed type, slot and band.

"Active" vs "saved": every setting has an active value (what you hear now) and
a saved value (in flash). ACC's Revert maps to writing the saved values back
as active. Sync maps to `0x61`.

## How it is built (decided with the user)

- **A web app using WebHID, opened in its own Chromium window.** No backend
  server; the page talks to `/dev/hidraw0` directly, like the user's
  `qrd-maestro-s3-ui` dashboard. Plain HTML/CSS/JS, no framework or build
  step, matching that project.
- **Packaged as a pacman package** (PKGBUILD in the repo, AUR-ready) that
  installs:
  - the app files under `/usr/share/astro-a50/`
  - a launcher `astro-a50` that runs Chromium in app mode
    (`--app=file:///usr/share/astro-a50/index.html` or a similar local URL,
    with its own `--user-data-dir` under `~/.local/share/astro-a50` so the
    WebHID permission persists and it doesn't mix with the user's browsing
    profile)
  - `astro-a50.desktop` and an icon
  - the udev rule
  - the waybar helper `astro-a50-status`
- **Waybar helper**: a small script that waybar runs on an interval (~30 s).
  It reads battery, charging and the active EQ slot over hidraw and prints
  waybar JSON (`text`, `tooltip`, `class` such as `charging`/`low`). Clicking
  the module runs `astro-a50`. It prints a "disconnected" state when the base
  station is absent and "headset off" for `HID_ERROR_SLAVE_NO_SLAVE`. It
  sends only the read requests listed above.
- **One talker at a time**: the helper skips polling (and shows its last value
  or "app open") while the app window is running, so two processes never
  interleave requests on the same hidraw node.
- **Look**: modeled on ACC (dark background, orange `#ff3c00`-like accent,
  uppercase headings, four tabs, vertical EQ sliders with dB readouts over
  the band frequencies). It does not copy Astro/Logitech logos or artwork: the
  headset image is our own simple drawing and the name is not "Astro Command
  Center".
- **Repo**: new git repo at `~/astro-a50-linux`, laid out like
  `qrd-maestro-s3-ui`. The user wants it public on GitHub like that one. It's
  created when the user approves (it's an outward-facing step). MIT license.

## Calls made by Claude (not the user; check these)

- **Library vs slots.** The library holds unlimited presets locally. Each preset
  has a name, 5 gains, 5 center freqs and 5 bandwidths. Loading a library preset
  into a slot writes that slot's gains, freqs, bandwidths and name as *active*
  values right away, and the slot becomes "changed". Any slot can be edited;
  only the active one is audible, and the editor says so. **SAVE** under the
  slots copies the selected slot into the library; it never touches flash.
  **REVERT** restores the selected slot's saved values. **SYNC TO DEVICE** sends
  `0x61`, which saves every active value to flash. **CLEAR CHANGES** writes the
  saved values back as active for every setting on every tab. A "changed"
  marker appears wherever the active value differs from the saved one.
- **Slot names**: printable ASCII only, at most 11 characters. That's the
  longest name known to have been stored on this device ("A50 MOD KIT", seen
  as stale bytes in the probe). Rejected before sending. The fake A50 enforces
  the same limit.
- **Closing with unsynced changes**: the window warns and offers to "revert
  and close", "keep live and close", or "cancel". On disconnect, it shows a
  banner and drops the pending state, because the device's active values are
  then whatever the device has.

## Testing (decided with the user)

- A **fake A50** in JavaScript that speaks the same protocol (active/saved
  state, error replies, headset-off), used to test the protocol layer and the
  UI without hardware.
- Real-hardware checks are **read-only first**. Write commands are tried on the
  real headset only after the user explicitly says so, one setting at a time,
  each followed by reading it back and reverting.
- The waybar helper is tested against a fake hidraw (e.g. a pty or socket pair
  that answers like the fake A50).

## Reference UI

Screenshots of ACC from the Microsoft Store listing (`9PFZ8RFZG5X4`), A50
screens: header with "HEADSET FW VERSION 33535.42 / BASE STATION FW VERSION
33942.42", battery "100%" with four slanted bars top-right; tabs EQUALIZER
PRESETS / MICROPHONE / STREAM PORT / SETTINGS; buttons SYNC TO DEVICE and
CLEAR CHANGES; left column PRESET LIBRARY with "+" and per-row "x"; middle
column the device slots; right panel five vertical sliders labeled about
95 / 419 / 783 / 3499 / 6100 Hz with an ADVANCED SETTINGS expander;
REVERT and SAVE under the slots.

## Approved look

The user liked the clickable mockup at
https://claude.ai/artifact/5eCyX5ptRQ6pQiSvhXn9KK (private to the user). Build
to it: the header with battery bars and status, the device row with
Clear/Sync and an unsynced-changes count, four tabs, EQ as three panels
(library / on-headset slots / 5-band editor with Advanced), a "● changed"
marker, Barlow + Barlow Condensed fonts, accent `#ff7a4d` on `#0e0e0f` /
`#1a1a1c`. Its EQ curves and noise-gate descriptions are samples, not device
facts.

## Left to the builder

- File layout, module split (under the 20000-byte limit), naming.
- The waybar helper's language (Python with only the stdlib, or a small
  shell + Node script) and its JSON fields.
- How "app is running" is detected (pid file, `pgrep` on the profile dir, etc.).
- Preset library storage format (it lives in the page's own storage inside the
  dedicated Chromium profile; import/export as JSON files is a nice extra).
- Exact visual design within the "looks like ACC, isn't ACC" brief.
- Mapping of ACC's "Advanced settings" to user-friendly controls (Q or octave
  width display for the 4096-scaled bandwidth).
