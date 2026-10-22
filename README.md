# A50 Control for Linux

A Linux replacement for Astro Command Center for the **Astro A50 gen 4**
wireless headset (base station USB ID `9886:002c`). It runs as its own app
window, and a waybar module shows the headset's battery.

Audio already works on Linux without it: PipeWire shows the base station as
two outputs, game and chat. This app adds the settings the Windows software
handles:

- **Equalizer:** the three EQ slots stored on the headset (names, 5-band gain
  from -7 to +7 dB, and per-band center frequency and width), choosing which
  slot you hear, and a preset library on your PC with import and export
- **Microphone:** mic level, sidetone, noise gate (Streaming, Night, Home,
  Tournament) and the three mic EQ presets
- **Stream port:** the mic, chat, game and aux levels sent out of the stream port
- **Settings:** default game/chat balance and alert volume
- **Status:** battery, charging, headset on/docked, firmware versions
- **Sync / Clear changes:** edits apply live. **Sync to device** saves them
  on the headset, and **Clear changes** puts back what was saved.

Firmware updates are not supported, on purpose.

## Install (Arch, CachyOS, Manjaro)

```sh
git clone https://github.com/onepushmain/astro-a50-linux
cd astro-a50-linux
makepkg -si
```

After installing, re-plug the base station once. That applies the udev rule
that lets your user reach the headset without root. Then start **A50 Control**
from your app launcher, or run `astro-a50`.

The first time, click **Connect** and pick the A50 in Chromium's device
dialog. The app has its own browser profile, so it remembers that choice.

Other distributions: `sudo make install PREFIX=/usr UDEVDIR=/usr/lib/udev/rules.d`.
You need Chromium (or set `ASTRO_A50_BROWSER` to another Chromium-based
browser) and Python 3.

## Waybar

```jsonc
"custom/a50": {
  "exec": "astro-a50-status",
  "return-type": "json",
  "interval": 30,
  "on-click": "astro-a50"
}
```

The CSS classes are `charging`, `low` (15 % or less), `off`, `disconnected`,
`no-access` (udev rule missing) and `error`. While the A50 Control window is
open, the module shows the last value it read rather than talking to the
headset at the same time as the app.

## How it works

- `app/` is a plain HTML/JS page that uses **WebHID** to talk to the base
  station's HID control interface (report ID 2, 63-byte reports).
- `bin/astro-a50` serves `app/` on `127.0.0.1:47850` (change it with
  `ASTRO_A50_PORT`) and opens it with `chromium --app` in a separate profile
  under `~/.local/share/astro-a50/profile`. The server stops when you close
  the window.
- `bin/astro-a50-status` is the waybar helper (Python standard library only).
  It only sends read requests: battery, status, active slot and slot name.
- The protocol comes from [eh-fifty](https://github.com/tdryer/eh-fifty) by
  Tom Dryer, which reverse-engineered it. The app sends only the request types
  listed in `app/js/protocol.js`, and refuses any other type before it reaches
  the device.

Add `?demo` to the URL (for example `http://127.0.0.1:47850/?demo` while the
app is running) to try the interface with a fake headset.

## If something goes wrong

Re-plug the base station. To reset the headset, hold the **Game** and
**Dolby** buttons together for 15 seconds. This is eh-fifty's documented
recovery.

## Development

```sh
make test   # node --test (protocol, device, session, library, UI, headless Chromium) + Python unittest
```

The tests run against a fake base station (`app/js/fake-a50.js`, and a socket
pair for the Python helper), so they never touch real hardware.

## License

MIT. See `LICENSE`, which also credits eh-fifty (MIT).
