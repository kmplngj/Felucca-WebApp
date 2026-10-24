// SPDX-License-Identifier: GPL-3.0-only
// Actual page call sites, independently held permission promises and distinct MIDIAccess objects.
import { makeMockDevice, unframe } from "../../app/src/proto.js";
const frame = document.querySelector("#editor"), result = document.querySelector("#result");
const check = (ok, message) => { if (!ok) throw Error(message); };
const until = async (fn, message) => {
  const end = Date.now() + 10000;
  while (!fn()) { if (Date.now() >= end) throw Error(message); await new Promise((resolve) => setTimeout(resolve, 10)); }
};
const turn = () => new Promise((resolve) => setTimeout(resolve, 0)); // Flush settled promise handlers, no timing assumption.
let mocks = [];
try {
  for (const index of [0, 1, 2]) for (const order of ["new-first", "old-first", "late-denial", "cancel-denial"]) {
    const pending = [], errors = [], classic = index === 1;
    const pairs = ["A", "B"].map((id) => {
      const mock = makeMockDevice({ auto: false }); mocks.push(mock);
      const input = [...mock.access.inputs.values()][0], output = [...mock.access.outputs.values()][0];
      input.id += id; output.id += id; input.name = output.name = "USB-MIDI";
      for (const port of [input, output]) { port.open = async () => {}; port.close = async () => {}; }
      const sent = [], send = output.send.bind(output);
      output.send = (bytes) => { sent.push(unframe(bytes)); send(bytes); };
      return { input, output, sent, access: { inputs: new Map([[input.id, input]]), outputs: new Map([[output.id, output]]) } };
    });
    const [a, b] = pairs, label = `${index}/${order}`;
    window.discoveryRequestAccess = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
    window.discoveryError = (text) => errors.push(text);
    frame.src = `/build/discovery/case${index}.html?permission=${order}`;
    let doc;
    await until(() => { doc = frame.contentDocument; return doc?.location.search === `?permission=${order}` && doc.readyState === "complete" && (classic || doc.querySelector("#connect")?.onclick); }, label + " ready");
    const button = () => doc.querySelector("#connect"), status = () => doc.querySelector(classic ? "#status" : "#msg-t").textContent;
    const ready = () => /Disconnect|切断/.test(button().textContent);
    button().click(); await until(() => pending.length === 1, label + " first permission");
    button().click();
    if (order === "cancel-denial") {
      const before = status(); pending[0].reject(Error("permission denied")); await turn();
      check(status() === before && !ready() && !doc.querySelector(".midi-picker"), label + " cancelled denial must not replace current status");
    } else {
      button().click(); await until(() => pending.length === 2, label + " replacement permission");
      if (order === "old-first") { pending[0].resolve(a.access); await turn(); check(a.sent.length === 0 && !doc.querySelector(".midi-picker"), label + " cancelled grant stays inert"); }
      pending[1].resolve(b.access);
      await until(() => doc.querySelector(".midi-picker[open]"), label + " new picker");
      const selects = doc.querySelectorAll(".midi-picker select");
      selects[0].value = b.input.id; selects[1].value = b.output.id;
      doc.querySelector('.midi-picker button[type="submit"]').click();
      await until(ready, label + " new session loads");
      const before = status();
      if (order === "new-first") pending[0].resolve(a.access);
      if (order === "late-denial") pending[0].reject(Error("permission denied"));
      await turn();
      check(status() === before, label + " stale denial must not overwrite ready status");
      check(a.sent.length === 0 && a.input.onmidimessage == null, label + " cancelled access stays unused");
      button().click(); button().click();
      await until(() => doc.querySelector(".midi-picker[open]"), label + " reconnect picker");
      const ids = [...doc.querySelectorAll(".midi-picker select")[0].options].map((option) => option.value);
      check(ids.includes(b.input.id) && !ids.includes(a.input.id), label + " old grant must not overwrite selected MIDIAccess");
      doc.querySelector('.midi-picker button[type="button"]').click();
    }
    check(errors.length === 0, label + " page errors: " + errors.join(", "));
    for (const mock of mocks) mock.stop(); mocks = [];
  }
  result.textContent = "PASS: source, retained and bundle preserve current access/status across overlapping grants in both orders and stale/cancelled denials";
} catch (error) { result.textContent = "FAIL: " + error.message; throw error; }
finally { for (const mock of mocks) mock.stop(); }
