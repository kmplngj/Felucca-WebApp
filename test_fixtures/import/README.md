<!-- SPDX-License-Identifier: GPL-3.0-only -->
# Project import fixtures

`projects.json` contains complete serialized bytes from firmware commit
`6379cf4` (the exact commit is recorded in the JSON). FUN10 records come from
`project_capture` and the actual `proj_pack`, with a plain record and a record
using !FILL on track 4, step 64. FUN7/8/9 records come from the firmware's historical
`old_pack` helper. These fixtures do not use the WebApp mock or its byte layout.
Each record includes its firmware FNV-1a trailer and an independently computed
Python CRC-32 for the archive envelope.

With the matching firmware checkout and its generated headers available:

```sh
python3 test_fixtures/import/generate.py /absolute/path/to/Felucca
node test_project_import.mjs
```

The generator compiles only a native fixture harness using the existing backup
host-test setup. It does not build firmware, flash hardware or make device requests.
Review generated differences when using another firmware revision. The focused
JavaScript test always uses committed fixtures; native regeneration is optional.

The test varies target parameter counts around the record's real count, uses the
original firmware-produced condition record, and derives boundary cases by changing
one chance byte and recomputing FNV and outer CRC. Firmware-side record validation
remains authoritative; client compatibility checks do not establish device acceptance.
