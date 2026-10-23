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
node test_settings.mjs      # MENU replies, sparse IDs and AUTO OFF constraints (mock only)
node test_app.mjs           # the new editor: device layer, build, tokens, words, icons
node test_web.mjs           # the protocol, samples, packages, the updater (FELUCCA_PROTO=app: the new modules)
node test_backup.mjs        # the full backup
node test_project_import.mjs # firmware project bytes, import/restore compatibility guards
node test_catalog.mjs       # catalogs, stable ids and settings compatibility
node test_legacy.mjs        # stored-object export (STORE_LIST / STORE_GET) and legacy migration vectors (FELUCCA_ROOT: regenerate from the firmware)
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

## Device settings

The new editor builds Settings from the connected firmware's MENU descriptors, including all six LED
brightness modes and the AUTO OFF, WAKE and ALL DARK options when advertised. AUTO OFF keeps its combined
mode/time values over MIDI; the native panel's detail page does not add a separate editor protocol.
ALL DARK must be later than an enabled AUTO OFF timer. Rejected changes restore the device's actual value;
RAM-only and deferred-save replies retain the applied value and display their existing save-status messages.
Saved changes display "Saved", replacing earlier warnings in the status bar. Previous messages remain in the log.
Device-side changes appear when Settings is reopened. Older firmware keeps its advertised controls.

For a browser regression without hardware, run `python3 serve.py 8774` and open
`http://localhost:8774/test_fixtures/menu/settings.html`. It must report PASS. This fixture creates only a
simulated MIDI device and checks focused rollback, newer picker drafts, request failures and sparse IDs.
Open `http://localhost:8774/test_fixtures/menu/feedback.html` for the full editor's refusal-to-success regression,
including the status bar, retained message log and language changes; it must also report PASS.
The retained classic editor does not expose the MENU settings UI.

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

## Stored-object recovery: hardware and mock

The STORED card in the new editor reads the raw store advertised by firmware `INFO 59 01` bit 0
(Felucca #492, merged in firmware `63f4906`). It downloads originals and creates optional migrated files locally.
It does not upload, restore or replace stored objects. Keep the original `.bin` and its `.json` manifest together.

From this checkout, run `python3 serve.py 8766`. For an FM-1 already running the tested #492 firmware, open
**http://localhost:8766/app/index.html** in Chrome or Edge, without query parameters. The server prints a mock
example URL; use the plain URL for hardware. Stop playback on the FM-1, close other MIDI applications, connect
by a USB data cable, click CONNECT and allow MIDI/SysEx access. Open PROJECT and find STORED, then List.
Original downloads a selected object's `.bin` and manifest; Download all saves a `felucca-store` JSON archive.
Firmware without this capability shows no STORED card. This procedure needs no firmware installation.

For a separate browser-only exercise, open
`http://localhost:8766/app/index.html?mock=1&raw=1`. The simulated store includes a legacy FUN1 project and damaged,
unknown and empty objects. Select PROJECT, then STORED > List; on PROJECT A select Migrate, read the report and
select the migrated-file download. A device containing only current projects need not show a legacy project or
Migrate button: use this mock, or Files with a genuine older original and its manifest, for the conversion exercise.
Files remains inside the capability-gated STORED card, so offline conversion requires that mock or a connected
compatible device. It never requires writing an old fixture into hardware.

Migration targets the current standard profile (111 parameters and matching playable engine IDs). Other profiles
can still download originals, but conversion is disabled with a target-mismatch explanation. Legacy FUN1..FUN9 and
older-count FUN10 projects plus supported user-preset records can convert to files. Settings, the retired FM6 bank
and converted presets' FM6 patch links are not converted. Newer, damaged and unknown formats are preserved for
export and refused for conversion. A migrated `.bin` is a recovery file, not an installable firmware package or an
upload-ready project file; there is no current-schema upload in this workflow. Real USB/device observations remain
separate from the host and mock tests.

## Licence

GPL-3.0-only (`LICENSE`), Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments.
Bundled: Inter Tight (SIL OFL 1.1), Fukiai icons (MIT), and the FM algorithm tables of msfa (Apache-2.0);
see `LICENSING.md` and `LICENSES/`.

M-VAVE and FM-1 are trademarks of their respective owners. This project is not affiliated with or endorsed by them.
