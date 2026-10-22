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
  **Revert & close** does that and then closes the window. Closing the
  window any other way with unsynced changes gets Chromium's "Leave site?"
  prompt, and the changes stay live until the headset powers off.
- Choosing which slot you hear (the dot next to a slot) takes effect at once,
  like the EQ button on the headset. It is not an unsynced change.

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

Only one window talks to the headset at a time. Opening the app again shows
"already open" in the new window. Use the first one.

Uninstall with `sudo pacman -R astro-a50`. Your preset library and the
app's browser profile stay in `~/.local/share/astro-a50`; delete that folder
to remove them.

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

The icons are Nerd Font glyphs, so your waybar font needs to be a Nerd Font
(most waybar setups already use one). The CSS classes are `charging`, `low`
(15 % or less), `off`, `disconnected`, `no-access` (udev rule missing),
`busy` and `error`. While the A50 Control window is
open, the module shows the last value it read rather than talking to the
headset at the same time as the app.

## How it works

- `app/` is a plain HTML/JS page that uses **WebHID** to talk to the base
  station's HID control interface (report ID 2, 63-byte reports).
- `bin/astro-a50` serves `app/` on `127.0.0.1:47850` (change it with
  `ASTRO_A50_PORT`) and opens it with `chromium --app` in a separate profile
  under `~/.local/share/astro-a50/profile`. The server stops when you close
  the window. It sends `no-store`, so an upgrade never mixes old and new
  files, and it only answers requests addressed to `127.0.0.1` or
  `localhost`.
- `bin/astro-a50-status` is the waybar helper (Python standard library only).
  It only sends read requests: battery, status, active slot and slot name.
- The protocol comes from [eh-fifty](https://github.com/tdryer/eh-fifty) by
  Tom Dryer, which reverse-engineered it. The app sends only the request types
  listed in `app/js/protocol.js`, and refuses any other type before it reaches
  the device.

Add `?demo` to the URL (for example `http://127.0.0.1:47850/?demo` while the
app is running) to try the interface with a fake headset. **Leave demo** at
the top goes back to the real one.

## If something goes wrong

If the base station stops answering, the app stops sending and asks you to
re-plug it. Replies after a missed one can't be trusted, so it won't send
anything until the base station has actually been unplugged. It reconnects
by itself when you plug it back in.

If that doesn't help, reset the headset by holding the **Game** and
**Dolby** buttons together for 15 seconds. This is eh-fifty's documented
recovery.

## Development

```sh
make test   # node --test (protocol, device, session, library, controller, UI, headless Chromium) + Python unittest
```

The tests run against a fake base station (`app/js/fake-a50.js`, a fake
WebHID in `test/helpers/fake-hid.js`, and a socket pair for the Python
helper), so they never touch real hardware. `packaging/aur/PKGBUILD` builds
a tagged release from GitHub.

## License

MIT. See `LICENSE`, which also credits eh-fifty (MIT).
