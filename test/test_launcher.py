"""Tests for bin/astro-a50 (with a fake browser) and libexec/astro-a50-server."""

import http.client
import os
import pathlib
import socket
import stat
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
LAUNCHER = ROOT / "bin" / "astro-a50"
SERVER = ROOT / "libexec" / "astro-a50-server"

# Started by the fake browser to play Chromium handing the window to an
# instance that is already running: it shows the page a moment later.
LATE_WINDOW = """
import pathlib, sys, time, urllib.request
time.sleep(0.5)
pathlib.Path(sys.argv[2]).write_bytes(urllib.request.urlopen(sys.argv[1], timeout=5).read())
"""


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for_port(port):
    for _ in range(100):
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.05)
    raise AssertionError(f"nothing listening on {port}")


def start_server(port):
    proc = subprocess.Popen([sys.executable, "-I", str(SERVER), "--port", str(port), "--dir", str(ROOT / "app")])
    wait_for_port(port)
    return proc


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = pathlib.Path(self.tmp.name)
        self.run_dir = self.dir / "run"
        self.run_dir.mkdir()
        self.profile = self.dir / "data" / "astro-a50" / "profile"
        self.port = free_port()
        self.browser = self.dir / "fake-browser"
        # Records its arguments, whether the pid file exists, and the page it got.
        self.write_browser(f"""
            import sys, pathlib, urllib.request
            out = pathlib.Path({str(self.dir)!r})
            (out / "args").write_text("\\n".join(sys.argv[1:]))
            (out / "pid-seen").write_text(str((pathlib.Path({str(self.run_dir)!r}) / "astro-a50" / "app.pid").exists()))
            url = next(a for a in sys.argv if a.startswith("--app=")).split("=", 1)[1]
            (out / "page").write_bytes(urllib.request.urlopen(url, timeout=5).read())
            """)

    def tearDown(self):
        self.tmp.cleanup()

    def write_browser(self, body):
        self.browser.write_text("#!/usr/bin/env python3\n" + textwrap.dedent(body))
        self.browser.chmod(self.browser.stat().st_mode | stat.S_IEXEC)

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
        self.assertIn(f"--user-data-dir={self.profile}", args)

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

    def test_holds_the_device_lock_while_the_window_is_open(self):
        self.write_browser(f"""
            import fcntl, pathlib
            lock = open({str(self.run_dir / "astro-a50" / "status.lock")!r}, "w")
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                result = "free"
            except BlockingIOError:
                result = "held"
            pathlib.Path({str(self.dir / "lock")!r}).write_text(result)
            """)
        self.assertEqual(self.launch().returncode, 0)
        self.assertEqual((self.dir / "lock").read_text(), "held")

    def test_waits_for_a_browser_that_handed_the_window_to_a_running_instance(self):
        self.write_browser(f"""
            import subprocess, sys
            url = next(a for a in sys.argv if a.startswith("--app=")).split("=", 1)[1]
            subprocess.Popen([sys.executable, "-c", {LATE_WINDOW!r}, url, {str(self.dir / "late")!r},
                              "--user-data-dir={self.profile}"], start_new_session=True)
            """)
        self.assertEqual(self.launch().returncode, 0)
        self.assertIn(b"A50 Control", (self.dir / "late").read_bytes())

    def test_a_server_left_by_a_killed_launcher_is_replaced(self):
        run = self.run_dir / "astro-a50"
        run.mkdir()
        stale = start_server(self.port)
        try:
            (run / "server.pid").write_text(str(stale.pid))
            (run / "app.pid").write_text("999999999")
            result = self.launch()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(b"<title>A50 Control</title>", (self.dir / "page").read_bytes())
            self.assertIsNotNone(stale.poll())
        finally:
            stale.kill()
            stale.wait()


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.port = free_port()
        self.proc = start_server(self.port)

    def tearDown(self):
        self.proc.kill()
        self.proc.wait()

    def get(self, path, host=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", path, headers={"Host": host or f"127.0.0.1:{self.port}"})
        resp = conn.getresponse()
        resp.read()
        conn.close()
        return resp

    def test_files_are_not_cached_so_upgrades_take_effect(self):
        resp = self.get("/js/protocol.js")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.getheader("Cache-Control"), "no-store")
        self.assertIn("javascript", resp.getheader("Content-Type"))

    def test_index_is_served_at_the_root(self):
        self.assertEqual(self.get("/").status, 200)
        self.assertEqual(self.get("/?demo").status, 200)

    def test_other_host_names_are_refused(self):
        self.assertEqual(self.get("/", host=f"evil.example:{self.port}").status, 403)

    def test_no_directory_listings(self):
        self.assertEqual(self.get("/js/").status, 404)

    def test_paths_outside_the_app_are_refused(self):
        self.assertIn(self.get("/../LICENSE").status, (403, 404))
        self.assertIn(self.get("/%2e%2e/LICENSE").status, (403, 404))


if __name__ == "__main__":
    unittest.main()
