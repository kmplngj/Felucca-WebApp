#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Generate independent wire fixtures using Felucca's native backup-test harness.
Usage: python3 test_fixtures/import/generate.py /absolute/path/to/Felucca
Requires its build/gen headers; does not build or access a device.
"""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import zlib

root = Path(sys.argv[1]).resolve()
harness = (root / 'tests/backup_test.c').read_text().split('\nint main(void)\n', 1)
assert len(harness) == 2, 'backup_test main signature changed'
program = harness[0] + r'''
int main(void) {
    project_store_t st;
    reset();
    project_capture(&proj_scratch);
    if (!proj_pack(&st, &proj_scratch)) return 1;
    fwrite(st.raw, 1, sizeof st, stdout);
    proj_scratch.t[3].step[63].probability = 112; /* !FILL, last step of last track */
    if (!proj_pack(&st, &proj_scratch)) return 2;
    fwrite(st.raw, 1, sizeof st, stdout);
    proj_scratch.t[3].step[63].probability = 100;
    uint8_t old[3840];
    uint32_t magic[] = {OLD_FUN9, OLD_FUN8, OLD_FUN7}, np[] = {99, 91, 89};
    for (unsigned i = 0; i < 3; i++) {
        uint32_t n = old_pack(old, &proj_scratch, magic[i], np[i]);
        if (!n) return 3;
        fwrite(old, 1, n, stdout);
    }
    return 0;
}
'''
with tempfile.TemporaryDirectory() as tmp:
    src, exe = Path(tmp) / 'fixtures.c', Path(tmp) / 'fixtures'
    src.write_text(program)
    subprocess.run([os.environ.get('CC', 'cc'), '-O1', '-w', '-I' + str(root / 'tests'),
                    '-I' + str(root / 'build/gen'), '-I' + str(root / 'firmware/src'),
                    str(src), '-lm', '-o', str(exe)], check=True)
    data = subprocess.check_output([str(exe)])
rows = []
for name, size in [('fun10', 3840), ('fun10-condition', 3840), ('fun9', 3648), ('fun8', 3584), ('fun7', 3388)]:
    b, data = data[:size], data[size:]
    assert len(b) == size
    rows.append(dict(name=name, size=size, crc=zlib.crc32(b), data=base64.b64encode(b).decode()))
assert not data
result = dict(firmwareCommit=subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip(),
              producer='tests/backup_test.c: reset/project_capture + project.c: proj_pack; tests/old_pack.h: old_pack',
              objects=rows)
Path(__file__).with_name('projects.json').write_text(json.dumps(result, indent=2) + '\n')
