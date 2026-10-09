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


if __name__ == "__main__":
    unittest.main()
