#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Discovery generation keeps UTF-8 text and surrounding line endings on non-UTF-8 hosts."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
ARTIFACTS = ROOT / "build/discovery/review-followup"
spec = importlib.util.spec_from_file_location("discovery_generator", ROOT / "gen_discovery.py")
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)


class DiscoveryGeneration(unittest.TestCase):
    def test_multilingual_lf_and_crlf_under_cp1252_default(self):
        for newline in ("\n", "\r\n"):
            with self.subTest(newline=repr(newline)), tempfile.TemporaryDirectory(prefix="generator-", dir=ARTIFACTS) as temporary:
                root = Path(temporary)
                source = root / "app/src/discovery.js"
                source.parent.mkdir(parents=True)
                source.write_text('export const label = "接続 · Verbindung";\n', encoding="utf-8")
                before = ('<!doctype html>\r\n<p>日本語 · français</p>' + newline).encode("utf-8")
                after = (newline + '<p>切断 · Grüße</p>\r\n').encode("utf-8")
                body = 'const label = "接続 · Verbindung";'
                expected = before + (generator.BEGIN + newline + body + newline + generator.END).encode("utf-8") + after
                path = root / "editor.html"
                path.write_bytes(expected)
                original_read, original_write = Path.read_text, Path.write_text

                def non_utf8_read(path, encoding=None, errors=None):
                    return original_read(path, encoding=encoding or "cp1252", errors=errors)

                def non_utf8_write(path, data, encoding=None, errors=None, newline=None):
                    return original_write(path, data, encoding=encoding or "cp1252", errors=errors, newline=newline)

                with patch.object(generator, "ROOT", root), patch.object(Path, "read_text", non_utf8_read), \
                        patch.object(Path, "write_text", non_utf8_write):
                    with patch.object(sys, "argv", ["gen_discovery.py", "--check"]):
                        generator.main()
                    self.assertEqual(path.read_bytes(), expected, "check must not mutate bytes")
                    with patch.object(sys, "argv", ["gen_discovery.py"]):
                        generator.main()
                    self.assertEqual(path.read_bytes(), expected, "generation is a byte-exact no-op")
                    path.write_bytes(before + (generator.BEGIN + newline + "stale" + newline + generator.END).encode() + after)
                    with patch.object(sys, "argv", ["gen_discovery.py", "--check"]):
                        with self.assertRaisesRegex(SystemExit, "stale"):
                            generator.main()
                    with patch.object(sys, "argv", ["gen_discovery.py"]):
                        generator.main()
                    self.assertEqual(path.read_bytes(), expected, "regeneration changes only the marked block")
                    with patch.object(sys, "argv", ["gen_discovery.py", "--check"]):
                        generator.main()


if __name__ == "__main__":
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    unittest.main()
