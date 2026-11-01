// SPDX-License-Identifier: GPL-3.0-only
// Real device layer on both pre-aftertouch and114-parameter mock firmware.
import assert from "node:assert/strict";
import { Device, knownLayout } from "./app/src/device.js";
import { makeMockDevice } from "./app/src/proto.js";
import { LAYOUT } from "./app/src/layout.js";
import { TARGET, targetMismatch } from "./app/src/legacy.js";

assert.equal(TARGET.pcount, 114);
assert.equal(targetMismatch({ pcount: 114 }), "");
assert.match(targetMismatch({ pcount: 111 }), /114/);
let version;
for (const pcount of [111, 114]) {
  const mock = makeMockDevice({ auto: false, pcount }), d = new Device(mock.access);
  try {
    await d.open();
    version ??= d.info.version;
    assert.equal(d.info.version, version);
    assert.equal(d.info.pcount, pcount);
    assert.equal(d.info.pe0, pcount - 8);
    assert.ok(knownLayout(d.info));
    const voice = LAYOUT(d.info.pe0).find((g) => g.t === "VOICE").pages.find(([name]) => name === "VOICE 3")[2];
    assert.deepEqual(voice, pcount === 114 ? [95, 103, 104, 105] : [95]);
    await d.setParam(0, 9, 42);
    assert.equal(mock.state.p[9], 42, "ordinary editing remains available on111");
    await d.setParam(0, d.info.pe0, 1);
    assert.equal(mock.state.p[d.info.pe0], 1);
    if (pcount === 114) {
      assert.deepEqual(d.pdesc.slice(103, 106).map((x) => [x.label, x.min, x.max, x.def]), [["AT", 0, 10, 0], ["ATDST", 0, 22, 0], ["ATAMT", -64, 63, 0]]);
      await d.setParam(0, 103, 10); await d.setParam(0, 104, 2); await d.setParam(0, 105, -32);
      assert.deepEqual(mock.state.p.slice(103, 106), [10, 2, -32]);
      assert.equal(mock.state.p[106], 1, "aftertouch edits do not overwrite E0");
    }
  } finally { d.close(); mock.stop(); }
}
console.log("aftertouch:114 descriptors/VOICE3/write IDs, older111 editing and exact migration-target refusal passed");
