// SPDX-License-Identifier: GPL-3.0-only
// Real DOM and mock MIDI only. Reuse the same screen across connections.
import { Device } from "../../app/src/device.js";
import { makeMockDevice } from "../../app/src/proto.js";
import { settingsScreen } from "../../app/src/settings.js";
const root = document.querySelector("#fixture"), result = document.querySelector("#result");
const check = (ok, message) => { if (!ok) throw new Error(message); };
const screen = settingsScreen(root, { prefResult() {}, say() {}, confirm: async () => false });
const field = (name) => root.querySelector(`select[aria-label="${name}"]`);
let dev, mock;
try {
  let version;
  for (const options of [{}, { noUnifiedUI: true }, { uiCaps: 61 }, { noUnifiedUI: true }, {}]) {
    mock = makeMockDevice({ auto: false, ...options }); dev = new Device(mock.access);
    await dev.open();
    version = version || dev.info.version;
    check(dev.info.version === version, "capability detection must not depend on version");
    const unified = !!(dev.info.uiCaps & 16);
    check(dev.preferences.state.caps === dev.info.uiCaps, "UI_STATE preserves all known INFO bits and ignores unknown bits");
    dev.on("menu", (items) => screen.menu(items));
    dev.on("preferences", () => screen.show(dev));
    screen.show(dev);
    const verify = () => {
      check(!!field("LARGE") === !unified, "LARGE visibility follows this connection's tagged INFO");
      check(field("STYLE") && field("ANIM") && field("LEDS"), "neighbouring rows retain their IDs");
      check(dev.menu.find((m) => m.id === 2).name === "LARGE", "wire descriptor stays present");
    };
    verify();
    check(await dev.changePreference(4, 1) === 1, "informational bit 4 never becomes a writable preference");
    verify();
    await dev.menuSet(2, 1); await dev.readMenu(); screen.show(dev); verify();
    check(dev.menu.find((m) => m.id === 2).value === 1, "hidden historical value is retained");
    await dev.changePreference(0, 2); verify();
    if (dev.info.uiCaps & 4) {
      await dev.changePreference(2, 1); verify();
      check(dev.preferences.state.monitor === 1, "monitor remains usable with combined capability bits");
    }
    await dev.syncPreferences(true); await dev.readMenu(); screen.show(dev); verify();
    check(dev.preferences.state.caps === dev.info.uiCaps, "UI_STATE retains capability bits after refresh");
    dev.close(); mock.stop(); screen.show(null);
  }
  result.textContent = "PASS: unified/legacy reconnects, reopen/refresh, combined capabilities and retained LARGE descriptor/value";
} catch (error) { result.textContent = `FAIL: ${error.message}`; throw error; }
finally { if (dev) dev.close(); if (mock) mock.stop(); }
