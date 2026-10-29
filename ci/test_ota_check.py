# SPDX-License-Identifier: GPL-3.0-only
"""Only absent proprietary V15/V16 success fixtures may skip the updater contract gate."""
import unittest
from check import OTA_STOCK_SKIPS, PACKAGE_SKIP, unexpected_skips


class UpdaterSkips(unittest.TestCase):
    def test_only_absent_official_success_may_skip_in_ota(self):
        for line in OTA_STOCK_SKIPS:
            self.assertEqual(unexpected_skips(line, "ota"), ([line], []))
            self.assertEqual(unexpected_skips(line, "ota", stock_requested=True), ([line], [line]))
            self.assertEqual(unexpected_skips(line, "app"), ([line], [line]))

    def test_custom_contract_and_unknown_skips_fail(self):
        for line in ("SKIP immutable transfer buffers", "skip custom loader compatibility",
                     "updater: products: skipped (missing fixture)", "custom loader contract skip", PACKAGE_SKIP):
            with self.subTest(line=line):
                self.assertEqual(unexpected_skips(line, "ota"), ([line], [line]))
        # Prefix-style skips must not silently evade the other required stages either.
        self.assertEqual(unexpected_skips("SKIP generated comparison", "catalog"),
                         (["SKIP generated comparison"], ["SKIP generated comparison"]))


if __name__ == "__main__":
    unittest.main()
