// SPDX-License-Identifier: GPL-3.0-only
// Real Settings DOM and Device protocol; mock MIDI only, no permission or hardware access.
import { Device } from "../../app/src/device.js";
import { makeMockDevice } from "../../app/src/proto.js";
import { settingsScreen } from "../../app/src/settings.js";
import { setLang, t } from "../../app/src/text.js";

const root = document.querySelector("#fixture"), result = document.querySelector("#result");
const check = (ok, message) => { if (!ok) throw new Error(message); };
const until = async (fn, message) => {
  const end = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() >= end) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
let dev, mock;
try {
  setLang("en");
  mock = makeMockDevice({ auto: false });
  dev = new Device(mock.access);
  await dev.open();
  await dev.readMenu();
  const statuses = [], screen = settingsScreen(root, { prefResult: (rc) => statuses.push(rc), confirm: async () => false });
  screen.show(dev);
  const card = () => root.querySelector('input[aria-label="BG"]').closest(".card");
  const warning = () => card().querySelector(".palwarn");
  const rows = () => [...warning().querySelectorAll("li")].map((el) => el.textContent);
  const live = () => card().querySelector('input[type="checkbox"]');
  const button = (word) => [...card().querySelectorAll("button")].find((el) => el.textContent.includes(t(word)));
  const colour = (role, value) => {
    const input = card().querySelector(`input[aria-label="${role}"]`);
    input.value = value; input.dispatchEvent(new Event("input"));
  };
  const from = (value) => {
    const select = card().querySelector("select"); select.value = String(value); select.dispatchEvent(new Event("change"));
  };
  live().checked = false;
  for (let i = 0; i < 10; i++) { from(i); check(warning().hidden, `built-in seed ${i} has no warning as CUSTOM`); }
  check(!mock.state.custom.stored && mock.state.custom.preview === null, "editing with live preview off sends no palette change");
  for (const role of ["BG", "SURF", "TEXT", "THEME", "ACCENT"]) colour(role, "#000000");
  check(!warning().hidden && warning().getAttribute("role") === "status" && rows().length === 8, "eight failing pairs exposed in live status");
  check(rows().every((text) => text.endsWith("1.00:1")) && warning().textContent.includes("4.5:1") && warning().textContent.includes("3:1"), "measured ratios and separate text/graphic limits");
  check(!button("paletteSave").disabled && warning().textContent.includes("still save"), "warning is explicitly non-blocking");
  button("paletteSave").click();
  await until(() => statuses.length && dev.palette.stored, "low-contrast save completes");
  check(statuses.at(-1) === 0 && dev.palette.c.join() === "0,0,0,0,0" && mock.state.custom.c.join() === "0,0,0,0,0", "all five low-contrast RGB565 words saved unchanged");
  colour("TEXT", "#ffffff");
  check(!rows().some((text) => text.startsWith("TEXT / BG:") || text.startsWith("MID / BG:")), "fixing TEXT clears its derived label warnings immediately");
  from(7);
  check(warning().hidden && !rows().length && mock.state.custom.c.join() === "0,0,0,0,0", "good seed clears status without silently saving it");
  button("paletteRevert").click();
  await until(() => rows().length === 8, "revert restores saved low-contrast colours");
  live().checked = true;
  colour("TEXT", "#ffffff");
  await until(() => mock.state.custom.preview?.join() === "0,0,65535,0,0", "live preview uses unchanged op0 RGB565 payload");
  check(mock.state.custom.c.join() === "0,0,0,0,0", "live preview never overwrites saved words");
  button("paletteRevert").click();
  await until(() => mock.state.custom.preview === null && rows().length === 8, "revert clears live preview");
  setLang("ja"); screen.show(dev);
  check(warning().textContent.includes(t("paletteContrast")) && warning().textContent.includes(t("paletteTextContrast")) && rows().length === 8,
    "Japanese warning retains measured roles and thresholds");
  setLang("en"); screen.show(dev);
  // Leave the failing palette visible for responsive/theme inspection.
  result.textContent = "PASS: ten seeds, live failing pairs/ratios, colour correction, unrestricted save bytes, preview/revert and language";
  document.documentElement.dataset.testResult = "passed";
} catch (e) {
  result.textContent = "FAIL: " + e.message; document.documentElement.dataset.testResult = "failed"; throw e;
} finally { if (dev) dev.close(); if (mock) mock.stop(); }
