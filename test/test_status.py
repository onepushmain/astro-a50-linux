"""Tests for bin/astro-a50-status against a fake base station on a socket pair."""

import importlib.machinery
import importlib.util
import json
import os
import pathlib
import socket
import tempfile
import threading
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


class FindDeviceTests(unittest.TestCase):
    def make(self, root, name, hid_id):
        d = pathlib.Path(root, "class", "hidraw", name, "device")
        d.mkdir(parents=True)
        (d / "uevent").write_text(f"DRIVER=hid-generic\nHID_ID={hid_id}\nHID_NAME=x\n")

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


if __name__ == "__main__":
    unittest.main()
