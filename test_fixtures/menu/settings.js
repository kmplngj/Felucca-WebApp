// SPDX-License-Identifier: GPL-3.0-only
// Real DOM, mock-only MIDI. This fixture never requests Web MIDI access.
import { Device } from "../../app/src/device.js";
import { makeMockDevice } from "../../app/src/proto.js";
import { settingsScreen } from "../../app/src/settings.js";
const root = document.querySelector("#fixture"), result = document.querySelector("#result");
const check = (ok, message) => { if (!ok) throw new Error(message); };
const tick = () => new Promise((r) => setTimeout(r, 0));
const pick = (el, value) => { el.value = String(value); el.dispatchEvent(new Event("input")); el.dispatchEvent(new Event("change")); };
let dev, mock;
try {
  mock = makeMockDevice({ auto: false, noCpu2: true });
  dev = new Device(mock.access);
  await dev.open();
  const statuses = [], ui = { prefResult: (rc) => statuses.push(rc), say: (text) => statuses.push(text), confirm: async () => false };
  const screen = settingsScreen(root, ui);
  screen.show(dev); dev.on("menu", (items) => screen.menu(items)); dev.on("error", (e) => ui.say(e.message));
  await dev.readMenu(); // The actual Settings route refreshes descriptor objects after constructing rows.
  const field = (name) => root.querySelector(`select[aria-label="${name}"]`);
  check(field("AUTO OFF").options.length === 13 && field("ALL DARK").options.length === 5, "dynamic enum choices");
  check(!field("2ND CORE") && field("WAKE"), "sparse ID33 discovered after missing CPU2 ID32");
  check(field("LEDS").options.length === 6, "all inverse LED choices exposed");
  const leds = field("LEDS"); leds.focus();
  mock.state.menu[4] = 5;
  await dev.readMenu();
  check(leds.value === "5", "confirmed reread reconciles a focused idle row");
  leds.value = "3"; leds.dispatchEvent(new Event("input"));
  mock.state.menu[4] = 4;
  await dev.readMenu();
  check(leds.value === "3", "confirmed reread preserves an unsubmitted focused draft");
  leds.blur();
  check(leds.value === "4", "blur restores the latest confirmed reread after a cancelled draft");
  const dark = field("ALL DARK"); dark.focus();
  await dev.menuSet(17, 3);
  pick(dark, 2); await tick(); await tick();
  // Await the actual serialized request, not a timing guess.
  await dev.idle(); await tick();
  check(dark.value === "0" && document.activeElement === dark && statuses.at(-1) === 2, "focused rejected value reconciled");
  const original = dev.menuSet.bind(dev);
  const item = dev.menu.find((m) => m.id === 33);
  let complete;
  dev.menuSet = async () => new Promise((r) => { complete = (value, rc) => { item.value = value; r(rc); }; });
  pick(dark, 4); await tick();
  screen.menu([{ ...item, value: 0 }]);
  check(dark.value === "4", "confirmed refresh cannot overwrite a submitted edit in flight");
  dark.value = "3"; dark.dispatchEvent(new Event("input"));
  complete(4, 4); await tick();
  check(dark.value === "3", "in-flight confirmation preserves a newer uncommitted picker draft");
  dark.blur();
  check(dark.value === "4", "cancelled picker draft restores confirmed value on blur");
  dark.focus();
  const completions = [];
  dev.menuSet = async () => new Promise((r) => completions.push((value, rc) => { item.value = value; r(rc); }));
  pick(dark, 3); await tick(); pick(dark, 4); await tick();
  completions[0](3, 0); await tick();
  screen.menu([{ ...item, value: 3 }]);
  check(dark.value === "4", "older committed response does not overwrite newer edit");
  completions[1](0, 2); await tick();
  check(dark.value === "0", "latest rejected response restores actual value while focused");
  dev.menuSet = async () => { throw new Error("simulated request failure"); };
  pick(dark, 4); await tick();
  check(dark.value === "0" && statuses.at(-1) === "simulated request failure", "request failure restores value and reports status");
  dev.menuSet = original;
  const rq = dev.rq.bind(dev);
  dev.rq = async () => { throw new Error("simulated transport failure"); };
  pick(dark, 4); await tick();
  check(dark.value === "0" && statuses.includes("simulated transport failure"), "transport error reports device status and restores value");
  dev.rq = rq;
  // USB confirmation cancellation uses the same focused rollback route.
  const usb = field("USB SERIAL"); usb.focus(); pick(usb, 1); await tick();
  check(usb.value === "0", "cancelled USB change rolls back with keyboard focus");
  dev.menuSet = original;
  // Leave the complete settings surface rendered for responsive/theme inspection.
  dark.blur(); result.textContent = "PASS: dynamic/sparse descriptors, focused rereads/refusal, draft preservation, ordered completion, failure and USB cancellation";
  document.documentElement.dataset.testResult = "passed";
} catch (e) {
  result.textContent = "FAIL: " + e.message; document.documentElement.dataset.testResult = "failed"; throw e;
} finally { if (dev) dev.close(); if (mock) mock.stop(); }
