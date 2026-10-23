// SPDX-License-Identifier: GPL-3.0-only
// MENU contract and applied/rejected replies. Mock MIDI only; never opens hardware.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Device } from "./app/src/device.js";
import { makeMockDevice, v14enc } from "./app/src/proto.js";

for (const options of [{}, { noFlash: true }, { deferSettings: true }, { noCpu2: true }, { noAutoOff: true }]) {
  const mock = makeMockDevice({ auto: false, ...options }), dev = new Device(mock.access);
  await dev.open();
  try {
    const fixture = options.noCpu2 ? process.env.FELUCCA_MENU_NOCPU2 : Object.keys(options).length === 0 ? process.env.FELUCCA_MENU : null;
    if (fixture) {
      const normalize = ({ index, ...item }) => ({ ...item, names: item.names || [] });
      assert.deepEqual(dev.menu.map(normalize), JSON.parse(readFileSync(fixture, "utf8")).map(normalize));
      console.log(`settings: exact native MENU comparison passed (${dev.menu.length} descriptors)`);
    }
    const rc = options.noFlash ? 3 : options.deferSettings ? 4 : 0;
    for (let value = 0; value < 6; value++) {
      assert.equal(await dev.menuSet(4, value), rc);
      assert.equal(dev.menu.find((m) => m.id === 4).value, value);
      assert.equal(mock.state.menu[4], value);
    }
    if (options.noAutoOff) {
      assert.equal(dev.menu.find((m) => m.id === 17).name, "SCREEN OFF");
      assert.equal(dev.menu.find((m) => m.id === 33), undefined);
      continue;
    }
    assert.equal(dev.menu.find((m) => m.id === 17).names.length, 13);
    assert.equal(dev.menu.find((m) => m.id === 33).names.length, 5);
    assert.equal(dev.menu.some((m) => m.id === 32), !options.noCpu2);
    assert.equal(dev.menu.at(-1).id, 33);
    for (let stage = 0; stage <= 12; stage++) {
      await dev.menuSet(33, 0);
      assert.equal(await dev.menuSet(17, stage), rc);
      for (let dark = 0; dark <= 4; dark++) {
        const before = mock.state.menu[33];
        const rejected = stage > 0 && dark > 0 && dark <= ((stage - 1) % 4) + 1;
        assert.equal(await dev.menuSet(33, dark), rejected ? 2 : rc);
        assert.equal(dev.menu.find((m) => m.id === 33).value, rejected ? before : dark);
        assert.equal(mock.state.menu[33], rejected ? before : dark);
      }
    }
    await dev.menuSet(33, 0); await dev.menuSet(17, 1); await dev.menuSet(33, 4);
    assert.equal(await dev.menuSet(17, 4), 2);
    assert.equal(dev.menu.find((m) => m.id === 17).value, 1);
    assert.equal(await dev.menuSet(17, 0), rc); // ALL DARK also works on its own.
    // A malformed/unknown-id echo must not be mistaken for accepted state.
    const old = dev.menu[4].value, rq = dev.rq.bind(dev);
    dev.rq = async () => [1, 4, ...v14enc(99)];
    assert.equal(await dev.menuSet(4, 99), 1);
    assert.equal(dev.menu[4].value, old);
    const errors = [];
    dev.on("error", (e) => errors.push(e.message));
    dev.rq = async () => { throw new Error("simulated request failure"); };
    assert.equal(await dev.menuSet(4, 5), undefined);
    assert.equal(dev.menu[4].value, old);
    assert.deepEqual(errors, ["simulated request failure"]);
    dev.rq = rq;
    assert.equal(await dev.menuSet(11, 1), rc);
    assert.equal(dev.closed, true); // Applied USB personality changes re-enumerate even when not saved yet.
  } finally { dev.close(); mock.stop(); }
}
// Reconnect old/new firmware with the same version string; descriptors keep their stable IDs.
for (const options of [{}, { noUnifiedUI: true }, { uiCaps: 29 }, { uiCaps: 61 }]) {
  const mock = makeMockDevice({ auto: false, ...options }), dev = new Device(mock.access);
  await dev.open();
  try {
    const caps = options.noUnifiedUI ? 9 : (options.uiCaps ?? 25) & 31;
    assert.equal(dev.info.uiCaps, caps);
    assert.equal(dev.preferences.state.caps, caps);
    const descriptor = dev.menu.find((m) => m.id === 2);
    assert.equal(descriptor.name, "LARGE");
    assert.deepEqual(descriptor.names, ["OFF", "ON"]);
    const ids = dev.menu.map((m) => m.id);
    for (const value of [1, 0]) {
      assert.equal(await dev.menuSet(2, value), 0); // Historical clients may still write it.
      await dev.readMenu(); await dev.syncPreferences(true);
      assert.equal(dev.menu.find((m) => m.id === 2).value, value);
      assert.deepEqual(dev.menu.map((m) => m.id), ids);
      assert.equal(dev.info.uiCaps, caps);
      assert.equal(dev.preferences.state.caps, caps);
    }
    assert.equal(await dev.changePreference(0, 2), 0);
    assert.equal(dev.preferences.state.palette, 2);
    if (caps & 4) {
      assert.equal(await dev.changePreference(2, 1), 0);
      assert.equal(dev.preferences.state.monitor, 1);
    }
    assert.equal(await dev.menuSet(3, 2), 0);
    assert.equal(dev.menu.find((m) => m.id === 3).value, 2);
    assert.equal(dev.menu.find((m) => m.id === 4).name, "LEDS");
  } finally { dev.close(); mock.stop(); }
}
console.log("settings: unified/legacy reconnect, INFO/UI_STATE, refresh and stable MENU IDs passed");
console.log("settings: applied rc0/3/4, refused rc2, all timers/LEDS, sparse IDs, old firmware and errors passed");
