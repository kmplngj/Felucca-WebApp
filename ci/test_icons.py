# SPDX-License-Identifier: GPL-3.0-only
"""Keep client tab glyphs stable across table-bearing and text-only producers."""
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import gen_icons


class MenuIcons(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "firmware/src"
        self.source.mkdir(parents=True)
        self.items = self.source / "menu_items.c"
        self.menu = self.source / "ui_menu.c"
        self.names = 'MTAB_NAME[MTAB_COUNT] = {"DISPLAY", "CONTROL", "AUDIO", "MIDI", "SYSTEM"};'
        self.items.write_text(self.names)
        self.menu.write_text('void draw_menu(void) { /* native text-only tabs */ }')
        self.glyph = {"ICON_" + str(i): glyph for i, glyph in enumerate(gen_icons.MENU_TAB_GLYPHS.values())}
        self.cmap = set(self.glyph.values())

    def read(self):
        return gen_icons.menu_icons(self.root, self.glyph, self.cmap)

    def test_text_only_and_historical_tabs_preserve_shipped_glyphs(self):
        text_only = self.read()
        self.menu.write_text('static const uint16_t MTAB_ICON[MTAB_COUNT] = {ICON_0, ICON_1, ICON_2, ICON_3, ICON_4};')
        self.assertEqual(self.read(), text_only)
        self.assertEqual(text_only["rows"], {})
        self.assertEqual(text_only["tabs"]["DISPLAY"], "symbol_eye")
        self.assertEqual(text_only["tabs"]["SYSTEM"], "symbol_cog")
        # Native presentation can change without replacing shipped client glyphs.
        self.menu.write_text('MTAB_ICON[MTAB_COUNT] = {ICON_4, ICON_3, ICON_2, ICON_1, ICON_0};')
        self.assertEqual(self.read(), text_only)

    def test_unknown_missing_duplicate_or_malformed_tab_names_fail(self):
        for text in (self.names.replace('"SYSTEM"', '"UNKNOWN"'),
                     self.names.replace(', "SYSTEM"', ''),
                     self.names.replace('"SYSTEM"', '"DISPLAY"'),
                     'MTAB_NAME[MTAB_COUNT] = not_an_array;'):
            with self.subTest(text=text):
                self.items.write_text(text)
                with self.assertRaises(SystemExit):
                    self.read()

    def test_native_table_mentions_in_comments_are_ignored(self):
        expected = self.read()
        self.menu.write_text('/* MTAB_ICON removed */\n// MTAB_ICON[MTAB_COUNT] = invalid;\nvoid draw_menu(void) {}')
        self.assertEqual(self.read(), expected)
        self.menu.write_text('/* MTAB_ICON[MTAB_COUNT] = {ICON_UNKNOWN}; */\n'
                             'MTAB_ICON[MTAB_COUNT] = {ICON_0, ICON_1, ICON_2, ICON_3, ICON_4};')
        self.assertEqual(self.read(), expected)

    def test_present_malformed_or_unknown_native_icons_are_not_ignored(self):
        for text in ('MTAB_ICON[MTAB_COUNT] = {ICON_0};',
                     'MTAB_ICON[MTAB_COUNT] = {ICON_0, ICON_1, ICON_2, ICON_3, ICON_UNKNOWN};',
                     'MTAB_ICON[MTAB_COUNT] = invalid;'):
            with self.subTest(text=text):
                self.menu.write_text(text)
                with self.assertRaises(SystemExit):
                    self.read()

    def test_missing_client_font_glyph_fails(self):
        self.cmap.remove("symbol_eye")
        with self.assertRaisesRegex(SystemExit, 'glyph missing'):
            self.read()

    def test_pre_tab_row_icons_and_no_menu_keep_historical_scope(self):
        self.items.write_text('MI_NAME[MI_COUNT] = {"COLOR"};')
        self.menu.write_text('static const uint16_t ICO[MI_COUNT] = {ICON_0};')
        self.assertEqual(self.read(), {"rows": {"COLOR": "symbol_eye"}, "tabs": {}})
        self.items.unlink()
        self.assertEqual(self.read(), {"rows": {}, "tabs": {}})


if __name__ == '__main__':
    unittest.main()
