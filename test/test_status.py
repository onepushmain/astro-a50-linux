"""Tests for bin/astro-a50-status against a fake base station on a socket pair."""

import importlib.machinery
import importlib.util
import json
import os
import pathlib
import socket
import tempfile
import threading
import time
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
_loader = importlib.machinery.SourceFileLoader("a50status", str(ROOT / "bin" / "astro-a50-status"))
_spec = importlib.util.spec_from_loader("a50status", _loader)
st = importlib.util.module_from_spec(_spec)
_loader.exec_module(st)


def ok(*data):
    return bytes([0x02, 0x02, len(data), *data]).ljust(64, b"\0")


def err(message):
    msg = message.encode() + b"\0"
    return bytes([0x02, 0x01, 4 + len(msg), 0, 0, 0, 0, *msg]).ljust(64, b"\0")


# Replies captured from the user's base station, 2026-10-21.
REAL = {
    0x7C: ok(0x58),
    0x54: ok(0x02),
    0x6C: ok(0x02),
    0x6E: lambda p: ok(0x6E, p[0], *{1: b"ASTRO+", 2: b"PRO", 3: b"ASTRO"}[p[0]], 0, 0x20, 0x4B, 0x49, 0x54),
}


class FakeBase:
    """Answers requests on one end of a SEQPACKET pair, like /dev/hidraw does."""

    def __init__(self, replies):
        self.replies = replies
        self.requests = []
        self.ours, self.theirs = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def serve(self):
        while True:
            try:
                req = self.theirs.recv(64)
            except OSError:
                return
            if not req:
                return
            self.requests.append(req)
            reply = self.replies.get(req[1])
            if callable(reply):
                reply = reply(req[3:3 + req[2]])
            if reply is not None:
                self.theirs.send(reply)

    @property
    def fd(self):
        return self.ours.fileno()

    def close(self):
        self.ours.close()
        self.theirs.close()


class QueryTests(unittest.TestCase):
    def setUp(self):
        self.base = FakeBase(dict(REAL))

    def tearDown(self):
        self.base.close()

    def test_requests_are_report_id_type_len_payload_padded_to_64(self):
        st.query(self.base.fd, 0x6E, [1, 0])
        self.assertEqual(self.base.requests[0], bytes([0x02, 0x6E, 2, 1, 0]).ljust(64, b"\0"))

    def test_reads_status_from_real_replies(self):
        self.assertEqual(st.read_status(self.base.fd), {
            "percent": 88, "charging": False, "on": True, "docked": False, "slot": 2, "name": "PRO",
        })

    def test_only_read_requests_can_be_sent(self):
        for t in (0x61, 0x62, 0x63, 0x67, 0x74, 0x00):
            with self.assertRaises(ValueError):
                st.query(self.base.fd, t)
        self.assertEqual(self.base.requests, [])

    def test_headset_off_error(self):
        self.base.replies[0x7C] = err("HID_ERROR_SLAVE_NO_SLAVE")
        with self.assertRaises(st.HeadsetOff):
            st.read_status(self.base.fd)

    def test_silence_times_out(self):
        self.base.replies[0x7C] = None
        with self.assertRaises(TimeoutError):
            st.query(self.base.fd, 0x7C, timeout=0.05)


class OutputTests(unittest.TestCase):
    def test_normal(self):
        out = st.waybar({"percent": 88, "charging": False, "on": True, "docked": False, "slot": 2, "name": "PRO"})
        self.assertEqual(out["text"], "󰋋 88%")
        self.assertEqual(out["percentage"], 88)
        self.assertIn("EQ 2: PRO", out["tooltip"])
        self.assertEqual(out["class"], [])

    def test_charging_and_low(self):
        out = st.waybar({"percent": 9, "charging": True, "on": True, "docked": True, "slot": 1, "name": "A"})
        self.assertIn("charging", out["class"])
        self.assertIn("low", out["class"])
        self.assertIn("󱐋", out["text"])

    def test_states_without_numbers(self):
        self.assertEqual(st.waybar(None, "disconnected")["class"], ["disconnected"])
        self.assertEqual(st.waybar(None, "off")["class"], ["off"])

    def test_output_is_one_line_of_json(self):
        line = st.dumps(st.waybar(None, "off"))
        self.assertNotIn("\n", line)
        json.loads(line)


# The real A50 report descriptor (vendor page 0xFF32, report ID 2, 63 bytes in/out).
A50_DESCRIPTOR = bytes.fromhex(
    "0632ff0974a101a10385027508150026ff00953f097581027508150026ff00953f09769102c0c0")


class FindDeviceTests(unittest.TestCase):
    def make(self, root, name, hid_id, descriptor=A50_DESCRIPTOR):
        d = pathlib.Path(root, "class", "hidraw", name, "device")
        d.mkdir(parents=True)
        (d / "uevent").write_text(f"DRIVER=hid-generic\nHID_ID={hid_id}\nHID_NAME=x\n")
        (d / "report_descriptor").write_bytes(descriptor)

    def test_skips_an_a50_interface_that_is_not_the_control_interface(self):
        with tempfile.TemporaryDirectory() as root:
            self.make(root, "hidraw1", "0003:00009886:0000002C", descriptor=bytes.fromhex("050c0901a101c0"))
            self.make(root, "hidraw2", "0003:00009886:0000002C")
            self.assertEqual(st.find_hidraw(root), "/dev/hidraw2")

    def test_finds_the_a50_among_other_hid_devices(self):
        with tempfile.TemporaryDirectory() as root:
            self.make(root, "hidraw0", "0003:0000046D:0000C547")
            self.make(root, "hidraw3", "0003:00009886:0000002C")
            self.assertEqual(st.find_hidraw(root), "/dev/hidraw3")

    def test_none_when_absent(self):
        with tempfile.TemporaryDirectory() as root:
            self.make(root, "hidraw0", "0003:0000046D:0000C547")
            self.assertIsNone(st.find_hidraw(root))


class AppRunningTests(unittest.TestCase):
    def test_pid_file_of_a_live_process(self):
        with tempfile.TemporaryDirectory() as run:
            pathlib.Path(run, "app.pid").write_text(str(os.getpid()))
            self.assertTrue(st.app_running(run))

    def test_stale_or_missing_pid_file(self):
        with tempfile.TemporaryDirectory() as run:
            self.assertFalse(st.app_running(run))
            pathlib.Path(run, "app.pid").write_text("999999999")
            self.assertFalse(st.app_running(run))
            pathlib.Path(run, "app.pid").write_text("garbage")
            self.assertFalse(st.app_running(run))


class LockTests(unittest.TestCase):
    def test_while_the_app_holds_the_lock_the_cached_value_is_shown_without_touching_the_device(self):
        import fcntl
        with tempfile.TemporaryDirectory() as run:
            pathlib.Path(run, "app.pid").write_text(str(os.getpid()))
            pathlib.Path(run, "last.json").write_text(json.dumps(st.waybar(None, "off")))
            with open(pathlib.Path(run, "status.lock"), "w") as held:
                fcntl.flock(held, fcntl.LOCK_EX)
                touched = []
                original = st.find_hidraw
                st.find_hidraw = lambda *a: touched.append(1)
                try:
                    out = st.run(pathlib.Path(run), wait=0.2)
                finally:
                    st.find_hidraw = original
        self.assertEqual(touched, [])
        self.assertIn("A50 Control is open", out["tooltip"])

    def test_a_lock_held_by_something_dead_or_stuck_gives_up_instead_of_hanging(self):
        import fcntl
        with tempfile.TemporaryDirectory() as run:
            with open(pathlib.Path(run, "status.lock"), "w") as held:
                fcntl.flock(held, fcntl.LOCK_EX)
                start = time.monotonic()
                out = st.run(pathlib.Path(run), wait=0.3)
        self.assertLess(time.monotonic() - start, 2)
        self.assertEqual(out["class"], ["busy"])


if __name__ == "__main__":
    unittest.main()
