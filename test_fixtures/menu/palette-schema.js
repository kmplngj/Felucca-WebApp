// SPDX-License-Identifier: GPL-3.0-only
// Reuse Settings across same-version legacy/native connections; mock MIDI only.
import { Device } from "../../app/src/device.js";
import { CMD, makeMockDevice } from "../../app/src/proto.js";
import { settingsScreen } from "../../app/src/settings.js";
import { setLang, t } from "../../app/src/text.js";

const root = document.querySelector("#fixture"), result = document.querySelector("#result");
const check = (ok, why) => { if (!ok) throw new Error(why); };
const until = async (fn, why) => { const end = Date.now() + 5000; while (!fn()) { if (Date.now() >= end) throw new Error(why); await new Promise((r) => setTimeout(r, 10)); } };
let confirm = async () => true;
const statuses = [], screen = settingsScreen(root, { prefResult: (rc) => statuses.push(rc), confirm: (...a) => confirm(...a) });
const extraSessions = [];
let dev, mock, version, count;
try {
  setLang("en");
  for (const options of [{}, { paletteschema: 2 }, { rejectPaletteProbe: true }, { paletteschema: 2 }]) {
    mock = makeMockDevice({ auto: false, ...options }); dev = new Device(mock.access);
    const session = dev;
    dev.on("preferences", () => { if (dev === session) screen.show(session); });
    await dev.open();
    version ??= dev.info.version; count ??= dev.info.pcount;
    check(dev.info.version === version && dev.info.pcount === count, "schema is independent of version and parameter count");
    await dev.readMenu(); screen.show(dev);
    const schema = options.paletteschema === 2 ? 2 : 1, native = schema === 2;
    check(dev.palette.schema === schema, "negotiated schema");
    const card = () => root.querySelector('input[aria-label="BG"]').closest(".card");
    const inputs = () => [...card().querySelectorAll('input[type="color"]')];
    check(inputs().map((x) => x.getAttribute("aria-label")).join() === (native ? "BG,IDENTITY,TEXT,PRIMARY,SECONDARY" : "BG,SURF,TEXT,THEME,ACCENT"), "labels follow this connection's schema");
    check(!root.querySelector(native ? 'input[aria-label="SURF"]' : 'input[aria-label="PRIMARY"]'), "previous connection leaves no stale role");
    const button = (key) => [...card().querySelectorAll("button")].find((x) => x.textContent.includes(t(key)));
    const colour = (role, value) => { const x = card().querySelector(`input[aria-label="${role}"]`); x.value = value; x.dispatchEvent(new Event("input")); };
    const checkbox = card().querySelector('input[type="checkbox"]'); checkbox.checked = false;
    const seed = card().querySelector("select"); seed.value = "7"; seed.dispatchEvent(new Event("change"));
    check(card().querySelector(".palwarn").hidden, "schema-aware built-in seed has no warning");
    check(!mock.state.custom.stored && mock.state.custom.preview === null, "draft seed writes nothing");
    if (native) {
      colour("PRIMARY", "#000000");
      check(card().querySelector(".palwarn").textContent.includes("PRIMARY / BG: 1.00:1"), "PRIMARY warning uses its independent stored colour");
      check(card().querySelector(".paldemo").style.getPropertyValue("--prec") === "#000000", "preview REC uses PRIMARY");
      check(card().querySelector('input[aria-label="IDENTITY"]').value === "#ffeb00", "PRIMARY edit leaves IDENTITY unchanged");
    }
    const requests = [], original = dev.rq.bind(dev);
    dev.rq = (r, o) => { if (r[0] === CMD.PALETTE_SET) requests.push(r[1]); return original(r, o); };
    checkbox.checked = true;
    colour(native ? "PRIMARY" : "THEME", "#ff0000");
    await until(() => mock.state.custom.preview?.[3] === 0xf800, "live preview sends the edited RGB565 slot");
    check(requests[0][0] === (native ? 16 : 0), "preview op follows negotiated schema");
    const draft = inputs().map((x) => x.value), before = statuses.length;
    button("paletteSave").click();
    await until(() => statuses.length > before && dev.palette.stored, "save completed");
    check(requests.some((a) => a[0] === (native ? 17 : 1)) && mock.state.custom.c[3] === 0xf800, "save preserves the intended fourth slot");
    check(inputs().map((x) => x.value).join() === draft.join(), "save does not rewrite current input roles");
    colour("TEXT", "#000000");
    await until(() => mock.state.custom.preview?.[2] === 0, "another live preview completed");
    button("paletteRevert").click();
    await until(() => mock.state.custom.preview === null, "revert drops preview");
    check(requests.some((a) => a[0] === (native ? 19 : 3)), "revert op follows negotiated schema");
    setLang("ja"); screen.show(dev);
    check(inputs().map((x) => x.getAttribute("aria-label")).includes(native ? "PRIMARY" : "THEME"), "language change retains negotiated role semantics");
    setLang("en"); screen.show(dev);
    button("paletteRemove").click();
    await until(() => !dev.palette.stored, "remove completed");
    check(requests.some((a) => a[0] === (native ? 18 : 2)), "remove op follows negotiated schema");
    dev.close(); mock.stop(); dev = mock = null;
  }
  {
    const oldMock = makeMockDevice({ auto: false }), nextMock = makeMockDevice({ auto: false, paletteschema: 2 });
    const old = new Device(oldMock.access), next = new Device(nextMock.access);
    extraSessions.push([old, oldMock], [next, nextMock]);
    await old.open(); await old.readMenu();
    await old.paletteSet(1, old.palette.c);
    await next.open(); await next.readMenu();
    screen.show(old);
    const card = root.querySelector('input[aria-label="BG"]').closest(".card");
    const colour = card.querySelector('input[aria-label="THEME"]');
    colour.value = "#ff0000"; colour.dispatchEvent(new Event("input"));
    await until(() => oldMock.state.custom.preview?.[3] === 0xf800, "first old preview starts its throttle window");
    colour.value = "#00ff00"; colour.dispatchEvent(new Event("input"));
    let completeConfirm;
    confirm = () => new Promise((resolve) => { completeConfirm = resolve; });
    [...card.querySelectorAll("button")].find((x) => x.textContent.includes(t("paletteRemove"))).click();
    check(completeConfirm, "old remove awaits confirmation");
    screen.show(next);
    completeConfirm(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    check(nextMock.state.custom.preview === null && !nextMock.state.custom.stored, "pending legacy preview and confirmation never write to new native connection");
    check(oldMock.state.custom.preview?.[3] === 0xf800 && oldMock.state.custom.stored, "replaced card cancels its timer and stale remove continuation");
    check(root.querySelector('input[aria-label="PRIMARY"]') && !root.querySelector('input[aria-label="THEME"]'), "pending old actions leave new schema labels intact");
  }
  result.textContent = "PASS: same-version old/new/rejected-probe reconnects, role labels, seeds, independent PRIMARY, exact operations, pending preview/confirmation ownership, save/revert/remove and language";
  document.documentElement.dataset.testResult = "passed";
} catch (error) {
  result.textContent = "FAIL: " + error.message; document.documentElement.dataset.testResult = "failed"; throw error;
} finally { if (dev) dev.close(); if (mock) mock.stop(); for (const [d, m] of extraSessions) { d.close(); m.stop(); } }
