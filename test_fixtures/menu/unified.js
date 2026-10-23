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
const until = async (fn, message) => { const end = Date.now() + 10000; while (!fn()) { if (Date.now() >= end) throw Error(message); await new Promise((resolve) => setTimeout(resolve, 10)); } };
try {
  let version;
  for (const options of [{ noUnifiedUI: true }, {}, { uiCaps: 41 }, { graph: true, uiCaps: 57 }, { graph: true, uiCaps: 61, noCpu2: true }, { graph: true, uiCaps: 125 }, { uiCaps: 93 }, {}, { noUnifiedUI: true }]) {
    mock = makeMockDevice({ auto: false, ...options }); dev = new Device(mock.access);
    await dev.open();
    version = version || dev.info.version;
    check(dev.info.version === version, "capability detection must not depend on version");
    const unified = !!(dev.info.uiCaps & 16), oneStyle = !!(dev.info.uiCaps & 32);
    check(dev.preferences.state.caps === dev.info.uiCaps, "UI_STATE preserves all known INFO bits and ignores unknown bits");
    dev.on("menu", (items) => screen.menu(items));
    dev.on("preferences", () => screen.show(dev));
    screen.show(dev);
    const verify = () => {
      check(!!field("LARGE") === !unified, "LARGE visibility follows this connection's tagged INFO");
      check(!!field("STYLE") === !oneStyle, "STYLE visibility independently follows tagged INFO bit5");
      check(field("ANIM") && field("LEDS"), "neighbouring rows retain their IDs");
      check(!!field("GRAPH") === !!options.graph, "GRAPH appears only when its descriptor is advertised");
      check(dev.menu.find((m) => m.id === 1).name === "STYLE", "historical STYLE descriptor stays present");
      check(dev.menu.find((m) => m.id === 2).name === "LARGE", "wire descriptor stays present");
    };
    verify();
    for (const id of [4, 5]) check(await dev.changePreference(id, 1) === 1, "informational bits never become writable preferences");
    verify();
    await dev.menuSet(1, 1); await dev.menuSet(2, 1); await dev.readMenu(); screen.show(dev); verify();
    check(dev.menu.find((m) => m.id === 1).value === 1, "hidden historical STYLE value is retained");
    check(dev.menu.find((m) => m.id === 2).value === 1, "hidden historical value is retained");
    if (options.graph) {
      check(field("GRAPH").value === "1", "GRAPH default is logical TURN1");
      const input = field("GRAPH"); input.focus(); input.value = "3";
      input.dispatchEvent(new Event("input")); input.dispatchEvent(new Event("change"));
      await until(() => dev.menu.find((m) => m.id === 34).value === 3, "GRAPH control applies STILL3");
      await dev.readMenu(); screen.show(dev); verify();
      check(field("GRAPH").value === "3", "GRAPH refresh retains confirmed value");
      check(dev.menu.some((m) => m.id === 32) === !options.noCpu2, "GRAPH keeps sparse CPU2 stable IDs");
    }
    await dev.changePreference(0, 2); verify();
    if (dev.info.uiCaps & 4) {
      await dev.changePreference(2, 1); verify();
      check(dev.preferences.state.monitor === 1, "monitor remains usable with combined capability bits");
    }
    await dev.syncPreferences(true); await dev.readMenu(); screen.show(dev); verify();
    check(dev.preferences.state.caps === dev.info.uiCaps, "UI_STATE retains capability bits after refresh");
    dev.close(); mock.stop(); screen.show(null);
  }
  result.textContent = "PASS: independent STYLE/LARGE retirement, legacy/new reconnects, GRAPH controls/sparse IDs, refresh and retained historical values";
} catch (error) { result.textContent = `FAIL: ${error.message}`; throw error; }
finally { if (dev) dev.close(); if (mock) mock.stop(); }
