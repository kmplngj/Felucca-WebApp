# SPDX-License-Identifier: GPL-3.0-only
"""Causal startup regressions: a failed attempt cannot retain an older green result."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


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

    def firmware_checkout(self):
        firmware = Path(self.temp.name) / "firmware"
        firmware.mkdir()
        subprocess.run(["git", "init", "-q", str(firmware)], check=True)
        subprocess.run(["git", "-c", "user.name=CI test", "-c", "user.email=ci@example.invalid",
                        "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
                        "commit", "-q", "--allow-empty", "-m", "fixture"], cwd=firmware, check=True)
        revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=firmware, text=True).strip()
        return firmware, revision

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

    def test_print_pin_does_not_create_artifacts(self):
        completed = self.run_gate("--print-firmware-revision")
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout.strip(), "1" * 40)
        self.assertFalse((self.root / "build").exists())


if __name__ == "__main__":
    unittest.main()
