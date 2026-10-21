# Felucca Web App

The web pages for [Felucca](https://github.com/hugelton/Felucca), custom firmware that runs on the M-VAVE FM-1:
the installer and the editor. They talk to the device over Web MIDI (SysEx) and run in the browser; nothing is
sent to a server. The site is published at https://hugelton.github.io/Felucca/.

- `app/` — the editor: ES modules, built into one page by `bundle.py`. `app/index.html?mock=1` runs it against
  a simulated device.
- `editor.html` — the current editor, kept while the new one replaces it.
- `index_pkg.html`, `fm1pkg.js`, `fm1ota.js`, `fm1backup.js` — the installer, the update protocol and the full backup.
- `make_site.py` — builds the site from these pages and a firmware release.

## Working on it

```sh
python3 serve.py            # http://localhost:8766/app/index.html?mock=1
node test_app.mjs           # the new editor: device layer, build, tokens, words, icons
node test_web.mjs           # the protocol, samples, packages, the updater (FELUCCA_PROTO=app: the new modules)
node test_backup.mjs        # the full backup
node test_project_import.mjs # firmware project bytes, import/restore compatibility guards
node test_catalog.mjs       # catalogs, stable ids and settings compatibility
```

Checks that compare with the firmware use files from a Felucca checkout, passed in by environment variables:
`FELUCCA_DESC` (the parameter tables, `desc.json`), `FELUCCA_TOOLS` (its `tools/`), `FELUCCA_ROOT` (a firmware
build), `FELUCCA_PALETTES` (`tools/gen_ui_palettes.py`), `FELUCCA_INTERTIGHT`
(`assets/fonts/InterTight[wght].ttf`), and `FELUCCA_FIRMWARE` (the firmware checkout root, for icon comparisons; the older `src/` + `tools/` layout is also accepted).
Without them those checks are skipped.

`FELUCCA_ROOT=/path/to/Felucca node test_catalog.mjs` also compiles the firmware's actual `tests/engid_test.c`
harness with `CC` (default `cc`, optimized with `-O1`) to test real INFO, settings, favourite and unavailable-track
replies. Build the firmware first so `build/gen/` exists. The fixtures include TEST14 and builds omitting DRUM,
NOISE or FM6; all compiler outputs stay in a temporary directory. Without the firmware checkout, the pure
JavaScript checks still run and this native check is explicitly skipped.

The editor protocol is described in the firmware repository (`web/EDITOR_PROTOCOL.md`).

## Engine catalogs and backup compatibility

Both editors read the versioned engine catalog (`INFO 49 01`) and use the advertised user-favourite marker
127. Firmware without this block uses its original name list and count marker. A malformed, truncated or
unsupported capability block stops the connection. Engine numbers stay stable: missing engines show
`N/A (id)`, and their saved sounds, parameters, drum grids and FM6 patches remain exportable. Unavailable
engines cannot be selected, auditioned or written into a device preset. Library files marked `engineIds: 64`
keep those numbers across different catalogs, including engines unknown to this editor. Mixed libraries retain each
patch’s source ID convention. When sending to legacy firmware, engine names must still match its numeric slots. Earlier library files resolve engine names using their own source layout before adopting stable IDs, and
retain their documented DIGITAL-to-FM6 and SAMPLE-PERC-to-DRUM migrations when those replacements exist.
If a stored historical library names an engine absent from the destination, connection stops before changing the
library; reconnect a build containing that engine to migrate it. Projects and complete backup objects retain their original bytes.

Settings backup objects stay **PER4** while no favourite uses an engine id from 14 upward. Those settings remain
restorable on original firmware 1.6 and older. A favourite on a higher id requires **PER6** settings: the editors
warn when saving that backup and refuse to start a restore to firmware without the versioned catalog, before
writing any objects. Keep the original archive and use a compatible build; the editor never truncates it to
PER4. The capability determines support, since development builds may still display version 1.6. Other archive
objects can have their own older-firmware limits.

FUN10 projects are checked using the firmware’s little-endian numeric magic. Single-project import and complete
restore refuse projects requiring more parameters than the connected firmware supports, before sending any
writes. Projects using conditional steps require the condition capability; complete restore can explicitly skip
those projects (including the current music) while restoring compatible objects. Original project bytes are retained.

Firmware advertising extended backups (`INFO 58 01`) is queried with `BACKUP_LIST 1`: its FM6 voice bank (id 20)
and saved SLICE records (id 21) join the archive, with SLICE restored after the samples. This also applies to the
installer's backup before returning to official firmware. Older devices receive the original backup query and
skip unsupported extended objects during restore. Keep the source `.syx` bank file for older devices.

For a browser-only sparse-catalog check, run `python3 serve.py` and open
`http://localhost:8766/app/index.html?mock=1&catalog=1&test14=1&omit=12`. Track 2 and its saved FM6 sound show
`N/A (12)`; TEST14 stays engine 14 with two presets, and user-favourite requests use 127. These mock options
only affect the simulated device.

## Licence

GPL-3.0-only (`LICENSE`), Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments.
Bundled: Inter Tight (SIL OFL 1.1), Fukiai icons (MIT), and the FM algorithm tables of msfa (Apache-2.0);
see `LICENSING.md` and `LICENSES/`.

M-VAVE and FM-1 are trademarks of their respective owners. This project is not affiliated with or endorsed by them.
