"""Tests for bin/astro-a50 with a fake browser that fetches the page and exits."""

import os
import pathlib
import socket
import stat
import subprocess
import tempfile
import textwrap
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
LAUNCHER = ROOT / "bin" / "astro-a50"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = pathlib.Path(self.tmp.name)
        self.run_dir = self.dir / "run"
        self.run_dir.mkdir()
        self.port = free_port()
        self.browser = self.dir / "fake-browser"
        # Records its arguments, whether the pid file exists, and the page it got.
        self.browser.write_text(textwrap.dedent(f"""\
            #!/usr/bin/env python3
            import sys, pathlib, urllib.request
            out = pathlib.Path({str(self.dir)!r})
            (out / "args").write_text("\\n".join(sys.argv[1:]))
            (out / "pid-seen").write_text(str((pathlib.Path({str(self.run_dir)!r}) / "astro-a50" / "app.pid").exists()))
            url = next(a for a in sys.argv if a.startswith("--app=")).split("=", 1)[1]
            (out / "page").write_bytes(urllib.request.urlopen(url, timeout=5).read())
            """))
        self.browser.chmod(self.browser.stat().st_mode | stat.S_IEXEC)

    def tearDown(self):
        self.tmp.cleanup()

    def launch(self):
        env = dict(os.environ, ASTRO_A50_BROWSER=str(self.browser), ASTRO_A50_PORT=str(self.port),
                   XDG_RUNTIME_DIR=str(self.run_dir), XDG_DATA_HOME=str(self.dir / "data"))
        return subprocess.run([str(LAUNCHER)], env=env, capture_output=True, text=True, timeout=30)

    def test_serves_the_app_on_localhost_and_opens_an_app_window(self):
        result = self.launch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b"<title>A50 Control</title>", (self.dir / "page").read_bytes())
        args = (self.dir / "args").read_text().splitlines()
        self.assertIn(f"--app=http://127.0.0.1:{self.port}/", args)
        self.assertIn(f"--user-data-dir={self.dir / 'data' / 'astro-a50' / 'profile'}", args)

    def test_pid_file_exists_while_the_window_is_open_and_is_removed_after(self):
        self.launch()
        self.assertEqual((self.dir / "pid-seen").read_text(), "True")
        self.assertFalse((self.run_dir / "astro-a50" / "app.pid").exists())

    def test_server_stops_when_the_window_closes(self):
        self.launch()
        with socket.socket() as s:
            self.assertNotEqual(s.connect_ex(("127.0.0.1", self.port)), 0)

    def test_port_taken_by_something_else_is_an_error(self):
        with socket.socket() as s:
            s.bind(("127.0.0.1", self.port))
            s.listen()
            result = self.launch()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("in use", result.stderr)
        self.assertFalse((self.dir / "args").exists())


if __name__ == "__main__":
    unittest.main()
