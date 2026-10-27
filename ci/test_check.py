# SPDX-License-Identifier: GPL-3.0-only
"""Causal startup regressions: a failed attempt cannot retain an older green result."""
import json
import hashlib
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from check import (STOCK_FILE_SKIPS, STOCK_PIN_SKIP, firmware_environment, font_input, owned_run,
                   stock_pins_available, unexpected_skips)


class FontInput(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="felucca-font-input-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = b"unchanged source fixture"
        self.digest = hashlib.sha256(self.source).hexdigest()
        expected = patch("check.INTERTIGHT_SHA256", self.digest)
        expected.start()
        self.addCleanup(expected.stop)

    def write(self, relative, content=None):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(self.source if content is None else content)
        return path

    def test_legacy_and_relocated_source_have_same_provenance(self):
        legacy = self.write("assets/fonts/InterTight[wght].ttf")
        before = font_input(self.root)
        relocated = self.write("docs/manual/fonts/InterTight[wght].ttf")
        legacy.unlink()
        after = font_input(self.root)
        self.assertEqual(before["path"], str(legacy.resolve()))
        self.assertEqual(after["path"], str(relocated.resolve()))
        self.assertEqual(before["sha256"], after["sha256"])
        self.assertEqual(after["selection"], "firmware")

    def test_explicit_override_wins_and_bad_override_never_falls_back(self):
        self.write("assets/fonts/InterTight[wght].ttf")
        chosen = self.write("chosen/font.ttf")
        self.assertEqual(font_input(self.root, str(chosen)), {
            "path": str(chosen.resolve()), "sha256": self.digest, "selection": "FELUCCA_INTERTIGHT"})
        chosen.unlink()
        with self.assertRaisesRegex(RuntimeError, "source missing.*chosen/font.ttf"):
            font_input(self.root, str(chosen))
        chosen.write_bytes(b"wrong font")
        with self.assertRaisesRegex(RuntimeError, "SHA-256 mismatch.*chosen/font.ttf"):
            font_input(self.root, str(chosen))

    def test_missing_both_locations_fails_with_both_paths(self):
        with self.assertRaisesRegex(RuntimeError, "source missing.*assets/fonts/.*docs/manual/fonts/"):
            font_input(self.root)

    def test_wrong_legacy_source_does_not_hide_behind_valid_relocated_source(self):
        self.write("assets/fonts/InterTight[wght].ttf", b"wrong source")
        self.write("docs/manual/fonts/InterTight[wght].ttf")
        with self.assertRaisesRegex(RuntimeError, "SHA-256 mismatch.*assets/fonts/"):
            font_input(self.root)


class AttemptSummary(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="felucca-ci-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "client"
        (self.root / "ci").mkdir(parents=True)
        self.script = self.root / "ci/check.py"
        shutil.copyfile(Path(__file__).with_name("check.py"), self.script)
        self.pin = self.root / "ci/firmware.json"
        self.pin.write_text(json.dumps({"repository": "kmplngj/Felucca", "revision": "1" * 40}))
        self.summary = self.root / "build/ci/summary.json"

    def previous_green(self):
        self.summary.parent.mkdir(parents=True)
        self.summary.write_text(json.dumps({"status": "passed", "old_attempt": True}))

    def run_gate(self, *args, env=None):
        return subprocess.run([sys.executable, str(self.script), *args], cwd=self.root,
                              env=env, text=True, capture_output=True, timeout=20)

    def assert_failed_attempt(self, completed, message):
        self.assertNotEqual(completed.returncode, 0, completed.stdout)
        current = json.loads(self.summary.read_text())
        self.assertEqual(current["status"], "failed")
        self.assertNotIn("old_attempt", current)
        self.assertIn(message, current["error"])

    def git_checkout(self, directory):
        directory.mkdir(exist_ok=True)
        subprocess.run(["git", "init", "-q", str(directory)], check=True)
        subprocess.run(["git", "-c", "user.name=CI test", "-c", "user.email=ci@example.invalid",
                        "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
                        "commit", "-q", "--allow-empty", "-m", "fixture"], cwd=directory, check=True)
        return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=directory, text=True).strip()

    def firmware_checkout(self):
        firmware = Path(self.temp.name) / "firmware"
        revision = self.git_checkout(firmware)
        return firmware, revision

    def fake_tool(self, name, source):
        bin_dir = Path(self.temp.name) / "bin"
        bin_dir.mkdir(exist_ok=True)
        tool = bin_dir / name
        tool.write_text(f"#!{sys.executable}\n" + source)
        tool.chmod(0o755)
        return {**os.environ, "PATH": str(bin_dir) + os.pathsep + os.environ["PATH"]}

    def short_bounds(self):
        # Exercise real timeout handling without waiting the production 18-minute/30-second limits.
        self.script.write_text(self.script.read_text().replace("LOCKED_RUNNER_TIMEOUT = 18 * 60", "LOCKED_RUNNER_TIMEOUT = 1")
                               .replace("PROBE_TIMEOUT = 30", "PROBE_TIMEOUT = 1"))

    def late_writer(self):
        pid = Path(self.temp.name) / "writer.pid"
        marker = Path(self.temp.name) / "late-write"
        source = ("import os,time,json\nfrom pathlib import Path\n"
                  f"Path({str(pid)!r}).write_text(str(os.getpid()))\n"
                  "time.sleep(2)\n"
                  f"Path({str(self.summary)!r}).write_text(json.dumps({{'status': 'passed', 'late': True}}))\n"
                  f"Path({str(marker)!r}).write_text('wrote')\n")
        return pid, marker, source

    def test_stalled_uv_replaces_green_and_stops_late_writer(self):
        firmware, revision = self.firmware_checkout()
        self.pin.write_text(json.dumps({"repository": "kmplngj/Felucca", "revision": revision}))
        self.previous_green()
        self.short_bounds()
        pid, marker, writer = self.late_writer()
        env = self.fake_tool("uv", "import subprocess,time\nfrom pathlib import Path\n"
                             f"subprocess.Popen([{sys.executable!r}, '-c', {writer!r}], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n"
                             "time.sleep(60)\n")
        completed = self.run_gate("--firmware", str(firmware), env=env)
        self.assert_failed_attempt(completed, "timed out after")
        self.assertIn("uv", json.loads(self.summary.read_text())["error"])
        self.assertTrue(pid.exists(), "the owned descendant actually started")
        time.sleep(2.1)  # Past the descendant's attempted late summary write.
        self.assertFalse(marker.exists())
        self.assertEqual(json.loads(self.summary.read_text())["status"], "failed")

    def test_stalled_probe_replaces_previous_green(self):
        firmware, _revision = self.firmware_checkout()
        self.previous_green()
        self.short_bounds()
        env = self.fake_tool("git", "import time\ntime.sleep(60)\n")
        completed = self.run_gate("--firmware", str(firmware), env=env)
        self.assert_failed_attempt(completed, "timed out after")
        self.assertIn("rev-parse", json.loads(self.summary.read_text())["error"])

    def test_locked_probe_cause_survives_parent_and_descendant_cleanup(self):
        firmware, revision = self.firmware_checkout()
        self.git_checkout(self.root)
        self.pin.write_text(json.dumps({"repository": "kmplngj/Felucca", "revision": revision}))
        self.previous_green()
        self.short_bounds()
        self.script.write_text(self.script.read_text().replace("LOCKED_RUNNER_TIMEOUT = 1", "LOCKED_RUNNER_TIMEOUT = 5"))
        pid, marker, writer = self.late_writer()
        self.fake_tool("node", "print('v22 fixture')\n")
        self.fake_tool("stalled-compiler", "import subprocess,time\n"
                       f"subprocess.Popen([{sys.executable!r}, '-c', {writer!r}], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n"
                       "time.sleep(60)\n")
        env = self.fake_tool("uv", "import os,sys\n"
                             "if sys.argv[1:] == ['--version']: print('uv fixture')\n"
                             "else: os.execv(sys.executable, [sys.executable, *sys.argv[sys.argv.index('python') + 1:]])\n")
        completed = self.run_gate("--firmware", str(firmware),
                                  env={**env, "CC": str(Path(self.temp.name) / "bin/stalled-compiler")})
        self.assert_failed_attempt(completed, "stalled-compiler")
        self.assertIn("timed out after", json.loads(self.summary.read_text())["error"])
        self.assertTrue(pid.exists(), "the locked probe's descendant actually started")
        time.sleep(2.1)
        self.assertFalse(marker.exists())
        self.assertEqual(json.loads(self.summary.read_text())["status"], "failed")

    def test_success_cleans_owned_descendant_and_preserves_unrelated_process(self):
        self.summary.parent.mkdir(parents=True)
        pid, marker, writer = self.late_writer()
        leader = ("import subprocess,time\nfrom pathlib import Path\n"
                  f"subprocess.Popen([{sys.executable!r}, '-c', {writer!r}], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n"
                  f"while not Path({str(pid)!r}).exists(): time.sleep(0.01)\n")
        with subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"]) as unrelated:
            try:
                completed = owned_run([sys.executable, "-c", leader], timeout=5)
                self.assertEqual(completed.returncode, 0)
                self.assertTrue(pid.exists(), "the owned descendant actually started")
                time.sleep(2.1)
                self.assertFalse(marker.exists())
                self.assertFalse(self.summary.exists())
                self.assertIsNone(unrelated.poll(), "cleanup must not touch another process group")
            finally:
                unrelated.terminate()

    def test_missing_checkout_replaces_previous_green(self):
        self.previous_green()
        self.assert_failed_attempt(self.run_gate("--firmware", str(Path(self.temp.name) / "missing")), "missing")

    def test_wrong_revision_replaces_previous_green(self):
        firmware, _revision = self.firmware_checkout()
        self.previous_green()
        self.assert_failed_attempt(self.run_gate("--firmware", str(firmware)), "must be exactly")

    def test_broken_uv_replaces_previous_green(self):
        firmware, revision = self.firmware_checkout()
        self.pin.write_text(json.dumps({"repository": "kmplngj/Felucca", "revision": revision}))
        self.previous_green()
        bin_dir = Path(self.temp.name) / "bin"
        bin_dir.mkdir()
        uv = bin_dir / "uv"
        uv.write_text("#!/bin/sh\nexit 73\n")
        uv.chmod(0o755)
        env = {**os.environ, "PATH": str(bin_dir) + os.pathsep + os.environ["PATH"]}
        self.assert_failed_attempt(self.run_gate("--firmware", str(firmware), env=env), "locked runner exited 73")

    def test_explicit_font_override_reaches_locked_runner(self):
        firmware, revision = self.firmware_checkout()
        self.pin.write_text(json.dumps({"repository": "kmplngj/Felucca", "revision": revision}))
        marker = Path(self.temp.name) / "override.json"
        env = self.fake_tool("uv", "import os,json\nfrom pathlib import Path\n"
                             f"Path({str(marker)!r}).write_text(json.dumps(os.environ.get('FELUCCA_INTERTIGHT')))\n"
                             "raise SystemExit(73)\n")
        self.run_gate("--firmware", str(firmware), env={**env, "FELUCCA_INTERTIGHT": "chosen-font.ttf"})
        self.assertEqual(json.loads(marker.read_text()), str((self.root / "chosen-font.ttf").resolve()))

    def test_missing_font_replaces_previous_green_without_skip(self):
        firmware, revision = self.firmware_checkout()
        self.git_checkout(self.root)
        self.pin.write_text(json.dumps({"repository": "kmplngj/Felucca", "revision": revision}))
        self.previous_green()
        env = self.fake_tool("node", "print('v22 fixture')\n")
        env.pop("FELUCCA_INTERTIGHT", None)  # Exercise missing discovery, independent of the caller's valid override.
        completed = self.run_gate("--firmware", str(firmware), "--inside-locked-env", env=env)
        self.assert_failed_attempt(completed, "Inter Tight source missing")
        self.assertEqual(json.loads(self.summary.read_text())["checks"], [])
        self.assertNotIn(" skip", completed.stdout)

    def test_print_pin_does_not_create_artifacts(self):
        completed = self.run_gate("--print-firmware-revision")
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout.strip(), "1" * 40)
        self.assertFalse((self.root / "build").exists())

    def test_missing_compiler_records_original_startup_cause(self):
        firmware, revision = self.firmware_checkout()
        self.git_checkout(self.root)
        self.pin.write_text(json.dumps({"repository": "kmplngj/Felucca", "revision": revision}))
        self.previous_green()
        env = {**os.environ, "CC": str(Path(self.temp.name) / "missing-compiler")}
        completed = self.run_gate("--firmware", str(firmware), "--inside-locked-env", env=env)
        self.assert_failed_attempt(completed, "missing-compiler")

    def test_consumer_pr_does_not_become_firmware_identity(self):
        client_root = Path(__file__).resolve().parents[1]
        firmware = Path(os.environ.get("FELUCCA_TEST_FIRMWARE", client_root.parent / "Felucca"))
        pin = json.loads((client_root / "ci/firmware.json").read_text())
        revision = os.environ.get("FELUCCA_TEST_FIRMWARE_REVISION", pin["revision"])
        spec = importlib.util.spec_from_file_location("firmware_build_identity", firmware / "tools/build_identity.py")
        identity = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(identity)
        event = Path(self.temp.name) / "client-pr.json"
        event.write_text(json.dumps({"repository": {"full_name": "kmplngj/Felucca-WebApp"}, "number": 10,
                                    "pull_request": {"head": {"sha": "a" * 40}}}))
        client = {**os.environ, "GITHUB_ACTIONS": "true", "GITHUB_EVENT_NAME": "pull_request",
                  "GITHUB_EVENT_PATH": str(event), "GITHUB_REPOSITORY": "kmplngj/Felucca-WebApp",
                  "GITHUB_REF": "refs/pull/10/merge", "GITHUB_SHA": "b" * 40,
                  "GITHUB_STEP_SUMMARY": str(self.root / "step-summary"),
                  "GITHUB_OUTPUT": str(self.root / "output"), "GITHUB_RUN_ID": "1234"}
        with self.assertRaisesRegex(ValueError, "PR merge identity does not match compiled checkout"):
            identity.resolve(firmware, env=client)
        isolated = firmware_environment(client)
        resolved = identity.resolve(firmware, env=isolated)
        self.assertEqual(resolved["revision"], revision)
        self.assertEqual(resolved["repository"], pin["repository"])
        self.assertIsNone(resolved["pr"])
        self.assertFalse(resolved["dirty"])
        for key in ("GITHUB_STEP_SUMMARY", "GITHUB_OUTPUT", "GITHUB_RUN_ID"):
            self.assertEqual(isolated[key], client[key])
        self.assertEqual(client["GITHUB_REPOSITORY"], "kmplngj/Felucca-WebApp")
        self.assertEqual(client["GITHUB_SHA"], "b" * 40)


class StockSkips(unittest.TestCase):
    """Felucca#619: private official files and a pre-#619 firmware pin are the only accepted stock skips"""
    LOG = "\n".join([STOCK_PIN_SKIP, *sorted(STOCK_FILE_SKIPS)])

    def test_private_files_and_pre_619_pin_are_documented(self):
        for suite in ("classic", "app-protocol"):
            skips, unexpected = unexpected_skips(self.LOG, suite, stock_pins=False)
            self.assertEqual(len(skips), 3)
            self.assertEqual(unexpected, [])

    def test_pin_parity_skip_fails_once_the_pin_has_the_installer(self):
        _, unexpected = unexpected_skips(self.LOG, "classic", stock_pins=True)
        self.assertEqual(unexpected, [STOCK_PIN_SKIP])

    def test_requested_stock_files_must_not_skip(self):
        _, unexpected = unexpected_skips(self.LOG, "classic", stock_requested=True, stock_pins=False)
        self.assertEqual(sorted(unexpected), sorted(STOCK_FILE_SKIPS))

    def test_other_suites_accept_none(self):
        _, unexpected = unexpected_skips(self.LOG, "backup", stock_pins=False)
        self.assertEqual(len(unexpected), 3)

    def test_installer_detection(self):
        with tempfile.TemporaryDirectory(prefix="felucca-stock-pins-") as temp:
            root = Path(temp)
            self.assertFalse(stock_pins_available(root))
            (root / "tools").mkdir()
            (root / "tools/fm1_install.py").write_text("PRODUCTS = {}\n")
            self.assertFalse(stock_pins_available(root))
            (root / "tools/fm1_install.py").write_text("STOCK_SHA256 = {}\n")
            self.assertTrue(stock_pins_available(root))


if __name__ == "__main__":
    unittest.main()
