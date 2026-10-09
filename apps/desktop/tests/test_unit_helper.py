"""Host tests for the device helper; all storage is isolated from the unit."""
import contextlib
import errno
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock


HELPER = Path(__file__).resolve().parents[1] / "src-tauri" / "src" / "unit_helper.py"


class PlayerOptionsTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "player.json"
        spec = importlib.util.spec_from_file_location("unit_helper", str(HELPER))
        self.helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.helper)
        self.helper.PLAYER = str(self.path)

    def save(self, value):
        self.path.write_text(json.dumps(value), encoding="utf-8")

    def options(self, size="0.5", gain="-", sha="new-hash"):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.helper.cmd_opts([sha, size, gain])
        return json.loads(output.getvalue())

    def assert_rejected_without_write(self, size="0.5", gain="-"):
        before = self.path.read_bytes()
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            with self.assertRaises((SystemExit, OSError, ValueError)):
                self.helper.cmd_opts(["new-hash", size, gain])
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(output.getvalue(), "")

    def listed(self):
        self.helper.IR_DIR = str(self.path.parent)
        self.helper.INDEX = str(self.path.parent / "index.json")
        capture = self.path.parent / "test.nam.wav"
        capture.write_bytes(b"fixture")
        output = io.StringIO()
        with mock.patch.object(self.helper, "registered_names", return_value=[]), \
                mock.patch.object(self.helper, "sha256_path", return_value="new-hash"), \
                mock.patch.object(self.helper, "describe", return_value={}), \
                contextlib.redirect_stdout(output):
            self.helper.cmd_list([])
        return json.loads(output.getvalue())

    def test_size_change_preserves_gain_after_failed_list_read(self):
        self.save({"models": {"new-hash": {"size": 0.5, "output_gain": 4.0}}})
        real_open = open
        def fail_settings_read(path, *args, **kwargs):
            if path == str(self.path):
                raise OSError(errno.EIO, "read failed")
            return real_open(path, *args, **kwargs)
        with mock.patch.object(self.helper, "open", fail_settings_read, create=True):
            listed = self.listed()
        self.assertEqual(listed["models"][0]["options"], {})
        result = self.options(size="0", gain="=")
        self.assertEqual(result, {"options": {"size": 0.0, "output_gain": 4.0}})
        self.assertIn("settings_error", listed)

    def test_size_change_preserves_gain_changed_since_listing(self):
        self.save({"models": {"new-hash": {"output_gain": 2.0}}})
        self.assertEqual(self.listed()["models"][0]["options"]["output_gain"], 2.0)
        self.save({"models": {"new-hash": {"output_gain": 4.0, "sample_rate_hz": 48000},
                              "other": {"output_gain": 3.0}}})
        self.assertEqual(self.options(size="0", gain="=")["options"],
                         {"size": 0.0, "output_gain": 4.0, "sample_rate_hz": 48000})
        self.assertEqual(self.options(size="-", gain="=")["options"],
                         {"output_gain": 4.0, "sample_rate_hz": 48000})
        self.assertEqual(self.options(size="=", gain="-")["options"],
                         {"sample_rate_hz": 48000})
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8"))["models"]["other"],
                         {"output_gain": 3.0})

    def test_list_reports_invalid_settings_without_repairing_them(self):
        for raw in (b"invalid", b"\xff", b'[]', b'{}', b'{"models":[]}'):
            with self.subTest(raw=raw):
                self.path.write_bytes(raw)
                self.assertIn("settings_error", self.listed())
                self.assertEqual(self.path.read_bytes(), raw)
                self.assertEqual(list(self.path.parent.glob("player.json.invalid.*")), [])

    def test_list_missing_settings_are_defaults_but_dangling_link_is_error(self):
        self.assertNotIn("settings_error", self.listed())
        self.path.symlink_to(self.path.parent / "missing.json")
        self.assertIn("settings_error", self.listed())
        self.assertTrue(self.path.is_symlink())

    def test_list_valid_settings_has_no_warning(self):
        self.save({"models": {"new-hash": {"output_gain": 4.0}}})
        listed = self.listed()
        self.assertNotIn("settings_error", listed)
        self.assertEqual(listed["models"][0]["options"], {"output_gain": 4.0})

    def test_invalid_listed_numbers_mark_the_capture_without_hiding_it_or_writing(self):
        for key, values in (("size", ["0.5", None, True, [], {}, -1, 2,
                                      float("nan"), float("inf")]),
                            ("output_gain", ["4", None, False, [], {}, -1, 9,
                                             float("nan"), float("inf")])):
            for value in values:
                with self.subTest(key=key, value=value):
                    self.save({"models": {"new-hash": {key: value}}})
                    before = self.path.read_bytes()
                    listed = self.listed()
                    self.assertNotIn("settings_error", listed)
                    self.assertEqual(len(listed["models"]), 1)
                    self.assertEqual(listed["models"][0]["options"], {})
                    self.assertIs(listed["models"][0]["options_invalid"], True)
                    # The reply must be strict JSON, including non-finite inputs.
                    json.dumps(listed, allow_nan=False)
                    self.assertEqual(self.path.read_bytes(), before)

    def test_invalid_entry_marks_only_its_capture(self):
        self.helper.IR_DIR = str(self.path.parent)
        self.helper.INDEX = str(self.path.parent / "index.json")
        for name in ("bad.nam.wav", "good.nam.wav"):
            (self.path.parent / name).write_bytes(name.encode())
        for entry in (None, [], "invalid", {"size": "0.5"}, {"output_gain": 9}):
            with self.subTest(entry=entry):
                self.save({"models": {"sha-bad": entry, "sha-good": {"size": 0},
                                      "sha-gone": None}})
                output = io.StringIO()
                with mock.patch.object(self.helper, "registered_names", return_value=[]), \
                        mock.patch.object(self.helper, "sha256_path",
                                          side_effect=lambda p: "sha-" + Path(p).name[:-8]), \
                        mock.patch.object(self.helper, "describe", return_value={}), \
                        contextlib.redirect_stdout(output):
                    self.helper.cmd_list([])
                listed = json.loads(output.getvalue())
                self.assertNotIn("settings_error", listed)
                rows = {row["name"]: row for row in listed["models"]}
                self.assertIs(rows["bad.nam"]["options_invalid"], True)
                self.assertEqual(rows["bad.nam"]["options"], {})
                self.assertNotIn("options_invalid", rows["good.nam"])
                self.assertEqual(rows["good.nam"]["options"], {"size": 0})

    def test_list_accepts_zero_and_boundary_options(self):
        for size, gain in ((0, 0), (1, 8), (0.5, 4.0)):
            self.save({"models": {"new-hash": {"size": size, "output_gain": gain}}})
            listed = self.listed()
            self.assertNotIn("settings_error", listed)
            self.assertEqual(listed["models"][0]["options"],
                             {"size": size, "output_gain": gain})

    def test_empty_patch_does_not_read_write_or_recover_settings(self):
        for raw in (None, b"invalid", b'{"models":{"new-hash":{"output_gain":4}}}'):
            with self.subTest(raw=raw):
                if raw is not None:
                    self.path.write_bytes(raw)
                with mock.patch.object(self.helper, "open", side_effect=AssertionError("unexpected read"), create=True):
                    self.assertEqual(self.options(size="=", gain="="), {"unchanged": True})
                self.assertEqual(self.path.read_bytes() if self.path.exists() else None, raw)
                self.assertEqual(list(self.path.parent.glob("player.json.invalid.*")), [])

    def test_missing_settings_are_initialized(self):
        self.assertEqual(self.options(), {"options": {"size": 0.5}})
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8")),
                         {"models": {"new-hash": {"size": 0.5}}})

    def assert_recovered(self):
        before = self.path.read_bytes()
        existing = set(self.path.parent.glob("player.json.invalid.*"))
        result = self.options()
        backups = set(self.path.parent.glob("player.json.invalid.*")) - existing
        self.assertEqual(len(backups), 1)
        backup = backups.pop()
        self.assertEqual(backup.read_bytes(), before)
        self.assertIn(str(backup), result["warning"])
        self.assertEqual(result["options"], {"size": 0.5})
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8")),
                         {"models": {"new-hash": {"size": 0.5}}})

    def test_malformed_settings_are_backed_up_and_recovered(self):
        for raw in (b'{"models":{"existing":', b'', b'not json', b'\xff'):
            with self.subTest(raw=raw):
                self.path.write_bytes(raw)
                self.assert_recovered()

    def test_invalid_settings_structure_is_backed_up_and_recovered(self):
        for value in (None, [], "settings", {}, {"models": None},
                      {"models": []}, {"models": "invalid"}):
            with self.subTest(value=value):
                self.save(value)
                self.assert_recovered()

    def test_invalid_selected_entry_recovers_without_resetting_other_models(self):
        for entry in (None, [], "invalid", 0):
            with self.subTest(entry=entry):
                value = {"models": {"new-hash": entry, "other": {"size": 0.25}},
                         "unrelated": True}
                self.save(value)
                before = self.path.read_bytes()
                result = self.options()
                self.assertIn("this capture", result["warning"])
                value["models"]["new-hash"] = {"size": 0.5}
                self.assertEqual(json.loads(self.path.read_text(encoding="utf-8")), value)
                self.assertTrue(any(p.read_bytes() == before for p in
                                    self.path.parent.glob("player.json.invalid.*")))

    def test_invalid_kept_options_are_dropped_with_a_backup(self):
        for kept, size, gain, value, expected in (
                ("output_gain", "0", "=", "4", {"size": 0.0}),
                ("output_gain", "0", "=", 9, {"size": 0.0}),
                ("output_gain", "0", "=", True, {"size": 0.0}),
                ("output_gain", "-", "=", None, {}),
                ("size", "=", "2", 2, {"output_gain": 2.0}),
                ("size", "=", "2", -1, {"output_gain": 2.0})):
            with self.subTest(kept=kept, value=value):
                for backup in self.path.parent.glob("player.json.invalid.*"):
                    backup.unlink()
                self.save({"models": {"new-hash": {kept: value, "sample_rate_hz": 48000},
                                      "other": {"output_gain": "x"}}})
                before = self.path.read_bytes()
                result = self.options(size=size, gain=gain)
                expected = dict(expected, sample_rate_hz=48000)
                self.assertEqual(result["options"], expected)
                label = "output gain" if kept == "output_gain" else kept
                self.assertIn("Invalid %s for this capture was removed." % label,
                              result["warning"])
                saved = json.loads(self.path.read_text(encoding="utf-8"))["models"]
                self.assertEqual(saved["new-hash"], expected)
                # Other captures' entries are left as they were.
                self.assertEqual(saved["other"], {"output_gain": "x"})
                backups = list(self.path.parent.glob("player.json.invalid.*"))
                self.assertEqual([p.read_bytes() for p in backups], [before])

    def test_replaced_invalid_options_are_backed_up(self):
        for key, size, gain, expected in (
                ("size", "0.5", "=", {"size": 0.5}),
                ("output_gain", "=", "2", {"output_gain": 2.0})):
            with self.subTest(key=key):
                for backup in self.path.parent.glob("player.json.invalid.*"):
                    backup.unlink()
                self.save({"models": {"new-hash": {key: "bad"}}})
                before = self.path.read_bytes()
                result = self.options(size=size, gain=gain)
                self.assertEqual(result["options"], expected)
                label = "output gain" if key == "output_gain" else key
                self.assertIn("Invalid saved %s for this capture was replaced." % label,
                              result["warning"])
                backups = list(self.path.parent.glob("player.json.invalid.*"))
                self.assertEqual([p.read_bytes() for p in backups], [before])

    def test_valid_kept_options_need_no_recovery(self):
        self.save({"models": {"new-hash": {"output_gain": 8}}})
        self.assertEqual(self.options(size="0", gain="="),
                         {"options": {"output_gain": 8, "size": 0.0}})
        self.assertEqual(list(self.path.parent.glob("player.json.invalid.*")), [])

    def test_repeated_recovery_preserves_existing_backups(self):
        self.path.write_bytes(b'first invalid file')
        self.assert_recovered()
        backups = {p: p.read_bytes() for p in self.path.parent.glob("player.json.invalid.*")}
        self.path.write_bytes(b'second invalid file')
        self.assert_recovered()
        for path, raw in backups.items():
            self.assertEqual(path.read_bytes(), raw)
        self.assertEqual(len(list(self.path.parent.glob("player.json.invalid.*"))), 2)

    def test_failed_backup_leaves_original_untouched(self):
        self.path.write_bytes(b'invalid')
        for owner, operation in ((self.helper.tempfile, "mkstemp"),
                                 (self.helper.os, "fsync")):
            with self.subTest(operation=operation):
                with mock.patch.object(owner, operation,
                                       side_effect=OSError(errno.ENOSPC, "full")):
                    self.assert_rejected_without_write()
                self.assertEqual(list(self.path.parent.glob("player.json.invalid.*")), [])

    def test_failed_recovery_save_preserves_original_and_backup(self):
        self.path.write_bytes(b'invalid')
        real_fsync = os.fsync
        for operation in ("fsync", "rename"):
            calls = 0
            def fail_second_fsync(fd):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise OSError(errno.ENOSPC, "full")
                return real_fsync(fd)
            failure = fail_second_fsync if operation == "fsync" else OSError(errno.EIO, "failed")
            with self.subTest(operation=operation):
                with mock.patch.object(self.helper.os, operation, side_effect=failure):
                    self.assert_rejected_without_write()
                backups = list(self.path.parent.glob("player.json.invalid.*"))
                self.assertTrue(backups)
                self.assertTrue(all(p.read_bytes() == b'invalid' for p in backups))

    def test_invalid_option_does_not_start_recovery(self):
        self.path.write_bytes(b'invalid')
        self.assert_rejected_without_write(gain="not-a-number")
        self.assertEqual(list(self.path.parent.glob("player.json.invalid.*")), [])

    def test_unreadable_settings_are_preserved(self):
        self.save({"models": {"existing": {"size": 0.25}}})
        real_open = open
        for code in (errno.EACCES, errno.EIO):
            def fail_read(path, mode="r", *args, code=code, **kwargs):
                if path == str(self.path) and mode == "rb":
                    raise OSError(code, os.strerror(code), path)
                return real_open(path, mode, *args, **kwargs)

            with self.subTest(errno=code):
                # Inject the read error: chmod is unreliable when run as root.
                with mock.patch.object(self.helper, "open", fail_read, create=True):
                    self.assert_rejected_without_write()

    def test_missing_symlink_target_does_not_replace_existing_link(self):
        self.path.symlink_to(self.path.parent / "missing.json")
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            with self.assertRaises((SystemExit, OSError, ValueError)):
                self.helper.cmd_opts(["new-hash", "0.5", "-"])
        self.assertTrue(self.path.is_symlink())
        self.assertEqual(output.getvalue(), "")

    def test_valid_update_preserves_other_models_and_fields(self):
        value = {"models": {"existing": {"size": 0.25},
                            "new-hash": {"sample_rate_hz": 48000}},
                 "unrelated": {"keep": True}}
        self.save(value)
        self.assertEqual(self.options(gain="1.25"),
                         {"options": {"size": 0.5, "output_gain": 1.25,
                                      "sample_rate_hz": 48000}})
        value["models"]["new-hash"].update(size=0.5, output_gain=1.25)
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8")), value)

    def test_removing_options_preserves_other_fields(self):
        self.save({"models": {"new-hash": {"size": 0.5, "output_gain": 1.25,
                                           "sample_rate_hz": 48000}}})
        self.assertEqual(self.options(size="-"),
                         {"options": {"sample_rate_hz": 48000}})
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8")),
                         {"models": {"new-hash": {"sample_rate_hz": 48000}}})

    def test_removing_last_options_removes_only_selected_entry(self):
        self.save({"models": {"new-hash": {"size": 0.5},
                              "existing": {"output_gain": 1.25}}})
        self.assertEqual(self.options(size="-"), {"options": {}})
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8")),
                         {"models": {"existing": {"output_gain": 1.25}}})

    def test_invalid_option_does_not_change_settings(self):
        self.save({"models": {"existing": {"size": 0.25}}})
        self.assert_rejected_without_write(gain="not-a-number")

    def test_failed_atomic_save_preserves_existing_settings(self):
        self.save({"models": {"existing": {"size": 0.25}}})
        for operation in ("fsync", "rename"):
            with self.subTest(operation=operation):
                with mock.patch.object(self.helper.os, operation,
                                       side_effect=OSError(errno.ENOSPC, "full")):
                    self.assert_rejected_without_write()


# Throwaway public keys and the fingerprints `ssh-keygen -l` prints for them.
KEYS = {
    "ed25519": (
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILi8KzRrtyJmUSNagtW73E1WgHF2YdXmSwVpuHnQjg6t "
        "test@ed25519",
        256, "SHA256:gnW2c+6N0FRetAkbDojHSGQN1p60SPD0Pr6927fmQ58"),
    "rsa": (
        "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDofZY6iL6EyvMEN8ro15zdsRPMcISlY7le01PZ52gdvLm"
        "D9S3WU3gHWuxH+qYfQdLZjjMAhmsWSX8tu5aoCRTZr4rok3nr1OfuqlQMID19wEM6YMYTbki+UescGFe16b"
        "z0LBtmSnDFAF/piXMADfNG34eyVbssyJ0DxWQ0zHroZLgo22YxyWj9ORgkinH2wme6JuWAltWZR4pfmVUNm"
        "eEaJQX/HvnTj/FARINCmpFzBZqkpC/LHNbZGBmxCAMZtZQbrWwo/8+LXgB4o0IK8qGKhkPoYDhXd5AtCvAc"
        "jtGRDfhKhDpG6NoaTFZIfqK7UaHV79ho8m1TinWHaLPGku/F test@rsa",
        2048, "SHA256:SpD9/hvo2c053TtXZAuy4SYBY+SnnW9yHPlC4g6J4lY"),
    "ecdsa256": (
        "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBDenZRcqGdj"
        "LSIZuWCtazk44QdTa3uKbMzi4m58hYn0YTvZCG1UJAMHr1pdI08bzhic7WqnAZLb/gIdjBFEwie0= "
        "test@ecdsa256",
        256, "SHA256:aHnvOzLfJynV+4avLS/KACuOSGC3LsCGYUmBwcV9kj0"),
    "ecdsa384": (
        "ecdsa-sha2-nistp384 AAAAE2VjZHNhLXNoYTItbmlzdHAzODQAAAAIbmlzdHAzODQAAABhBGLJ06uOIFJ"
        "u7SoxTODJYmkilTvRLjBlFygOk7Gza1EfIUk2IT9dbwf9ySZQJDNnLVUIaZBTSWcqO2OaYqYvBXRjVc8jBr"
        "mOsG5NXl+L/bGTR7LbfDZVcT9TY5QiHQUe5Q== test@ecdsa384",
        384, "SHA256:8aGm1gOIsMhl2vtUFb61W/3DsPtnl5kA0YfC+yQ0m74"),
    "ecdsa521": (
        "ecdsa-sha2-nistp521 AAAAE2VjZHNhLXNoYTItbmlzdHA1MjEAAAAIbmlzdHA1MjEAAACFBAHQG9j4GL1"
        "oPubuw2Drk2K9OTI//6gSWYP79VRe/X1x4SN6vr820aSsGxVblwq+DGha+S8tRByhC9rk6SjBv3Fu4wH3TO"
        "5Ruk9bccAz6SGeWZG3STTelCtjoBnkTTJ1MFqDj+dHWht1XkZvGXLbZ+7dNFTJi5O6bgXHGaNNENXhlLshT"
        "Q== test@ecdsa521",
        521, "SHA256:7I/ZL18u6Hd9zi50MF5CYiZEyXl5es3Q6RAY7dMGbQs"),
}


class SshAccessTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        spec = importlib.util.spec_from_file_location("unit_helper", str(HELPER))
        self.helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.helper)
        h = self.helper
        h.SSH_DIR = str(root / "ssh")
        h.SSH_STATE = h.SSH_DIR + "/state"
        h.SSH_KEYS = h.SSH_DIR + "/authorized_keys"
        h.SSH_LAUNCHER = str(root / "nam-ssh.sh")
        Path(h.SSH_LAUNCHER).write_text("#!/bin/sh\n")
        self.root = root
        self.restarts = []
        for patch in (
            mock.patch.object(h.os, "system", side_effect=self.system),
            mock.patch.object(h, "ssh_running", side_effect=lambda: self.running),
            mock.patch.object(h.time, "sleep"),
        ):
            patch.start()
            self.addCleanup(patch.stop)
        self.running = False

    def system(self, cmd):
        if "restart" in cmd:
            self.restarts.append(cmd)
            self.running = self.helper.read_ssh_state()["enabled"]
        return 0

    def key_file(self, line):
        path = self.root / "key.pub"
        path.write_text(line + "\n")
        return str(path)

    def run_cmd(self, name, args):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.helper.COMMANDS[name](args)
        return json.loads(output.getvalue())

    def test_parses_every_supported_key_type(self):
        for line, bits, fingerprint in KEYS.values():
            key = self.helper.parse_key(line)
            self.assertEqual((key["bits"], key["fingerprint"]), (bits, fingerprint))
            self.assertTrue(key["comment"].startswith("test@"))

    def test_rejects_what_is_not_a_public_key(self):
        line = KEYS["ed25519"][0]
        kind, blob, _ = line.split(" ")
        for bad in ("", "hello", kind, "ssh-dss " + blob,
                    "ssh-rsa " + blob,  # embedded type is ed25519
                    kind + " not-base64!",
                    "-----BEGIN OPENSSH PRIVATE KEY-----"):
            self.assertIsNone(self.helper.parse_key(bad), bad)

    def test_off_by_default_and_card_too_old(self):
        self.assertEqual(self.run_cmd("ssh-state", []),
                         {"supported": True, "enabled": False, "mode": "key",
                          "running": False, "keys": []})
        os.remove(self.helper.SSH_LAUNCHER)
        self.assertEqual(self.run_cmd("ssh-state", []), {"supported": False})
        with self.assertRaises(SystemExit) as e:
            self.run_cmd("ssh-set", ["1", "key", self.key_file(KEYS["rsa"][0])])
        self.assertEqual(str(e.exception), "card_too_old")

    def test_enable_installs_the_key_privately_and_starts(self):
        state = self.run_cmd("ssh-set", ["1", "key", self.key_file(KEYS["ed25519"][0])])
        self.assertEqual((state["enabled"], state["mode"], state["running"]),
                         (True, "key", True))
        self.assertEqual([k["fingerprint"] for k in state["keys"]], [KEYS["ed25519"][2]])
        self.assertNotIn("line", state["keys"][0])
        self.assertEqual(os.stat(self.helper.SSH_KEYS).st_mode & 0o777, 0o600)
        self.assertEqual(os.stat(self.helper.SSH_DIR).st_mode & 0o777, 0o700)
        self.assertEqual(Path(self.helper.SSH_STATE).read_text(), "enabled=1\nmode=key\n")
        # Enabling again with the same key doesn't duplicate it.
        state = self.run_cmd("ssh-set", ["1", "key", self.key_file(KEYS["ed25519"][0])])
        self.assertEqual(len(state["keys"]), 1)

    def test_key_only_needs_a_key(self):
        with self.assertRaises(SystemExit) as e:
            self.run_cmd("ssh-set", ["1", "key"])
        self.assertEqual(str(e.exception), "no_keys")
        self.assertFalse(os.path.exists(self.helper.SSH_STATE))

    def test_no_security_and_off(self):
        state = self.run_cmd("ssh-set", ["1", "none"])
        self.assertEqual((state["enabled"], state["mode"]), (True, "none"))
        state = self.run_cmd("ssh-set", ["0", "none"])
        self.assertEqual((state["enabled"], state["running"]), (False, False))

    def test_add_rejects_duplicates_several_lines_and_private_keys(self):
        self.run_cmd("ssh-add", [self.key_file(KEYS["rsa"][0])])
        for text, error in (
            (KEYS["rsa"][0], "duplicate"),
            (KEYS["ed25519"][0] + "\n" + KEYS["ecdsa256"][0], "invalid_key"),
            ("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA==\n", "invalid_key"),
        ):
            with self.assertRaises(SystemExit) as e:
                self.run_cmd("ssh-add", [self.key_file(text)])
            self.assertEqual(str(e.exception), error)
        self.assertNotIn("PRIVATE", Path(self.helper.SSH_KEYS).read_text())
        # Adding needs no restart: Dropbear reads the file at each login.
        self.assertEqual(self.restarts, [])

    def test_removing_the_last_key_turns_key_only_off(self):
        self.run_cmd("ssh-set", ["1", "key", self.key_file(KEYS["ed25519"][0])])
        self.run_cmd("ssh-add", [self.key_file(KEYS["ecdsa384"][0])])
        state = self.run_cmd("ssh-remove", [KEYS["ed25519"][2]])
        self.assertTrue(state["enabled"])
        state = self.run_cmd("ssh-remove", [KEYS["ecdsa384"][2]])
        self.assertEqual((state["enabled"], state["running"], state["keys"]),
                         (False, False, []))
        with self.assertRaises(SystemExit) as e:
            self.run_cmd("ssh-remove", [KEYS["ecdsa384"][2]])
        self.assertEqual(str(e.exception), "unknown_key")


if __name__ == "__main__":
    unittest.main()
