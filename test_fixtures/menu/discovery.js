// SPDX-License-Identifier: GPL-3.0-only
// Real pages/DOM, independently routed fake ports; never asks for real MIDI access.
import { makeMockDevice, unframe, CMD } from "../../app/src/proto.js";
const frame = document.querySelector("#editor"), result = document.querySelector("#result");
const check = (ok, message) => { if (!ok) throw new Error(message); };
const until = async (condition, message) => {
  const end = Date.now() + 10000;
  while (!condition()) {
    if (Date.now() >= end) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
let mocks = [];
const manual = new URLSearchParams(location.search).get("manual");
addEventListener("pagehide", () => { for (const mock of mocks) mock.stop(); });
try {
  for (const path of ["/app/index.html", "/editor.html", "/build/discovery/editor.html"]) {
    const classic = path === "/editor.html", errors = [];
    if (manual && path !== ({ app: "/app/index.html", classic: "/editor.html", bundle: "/build/discovery/editor.html" })[manual]) continue;
    const pairs = ["A", "B"].map((suffix) => {
      const mock = makeMockDevice({ auto: false }); mocks.push(mock);
      const input = [...mock.access.inputs.values()][0], output = [...mock.access.outputs.values()][0];
      input.id += suffix; output.id += suffix; input.name = output.name = "USB-MIDI";
      input.manufacturer = output.manufacturer = "";
      for (const port of [input, output]) { port.closes = 0; port.open = async () => {}; port.close = async () => { port.closes++; }; }
      const sent = [], send = output.send.bind(output);
      output.send = (bytes) => { sent.push(unframe(bytes)); send(bytes); };
      return { mock, input, output, sent, send: output.send };
    });
    const [a, b] = pairs;
    window.discoveryAccess = { inputs: new Map(pairs.map((p) => [p.input.id, p.input])),
      outputs: new Map([...pairs].reverse().map((p) => [p.output.id, p.output])) };
    window.discoveryError = (text) => errors.push(text);
    let grant; window.discoveryPermissionEntered = false;
    window.discoveryPermission = manual ? Promise.resolve() : new Promise((resolve) => { grant = resolve; });
    frame.src = `/build/discovery/case${classic ? 1 : path.startsWith("/build/") ? 2 : 0}.html`;
    let doc;
    await until(() => { doc = frame.contentDocument; return doc?.documentElement?.dataset.discoveryCase === path && (classic ? doc.readyState === "complete" && doc.querySelector("#connect")?.textContent.trim() : doc.querySelector("#connect")?.onclick); }, path + " ready");
    if (manual) {
      const controls = document.createElement("p");
      for (const [label, connected] of [["Unplug A", false], ["Replug A", true]]) {
        const control = document.createElement("button"); control.textContent = label;
        control.onclick = () => { a.input.state = a.output.state = connected ? "connected" : "disconnected"; window.discoveryAccess.onstatechange?.({ port: a.input }); };
        controls.append(control);
      }
      const traffic = document.createElement("span");
      const update = setInterval(() => { traffic.textContent = ` A: ${a.sent.length} frames; B: ${b.sent.length} frames`; }, 100);
      addEventListener("pagehide", () => clearInterval(update), { once: true });
      controls.append(traffic); result.after(controls);
      result.textContent = "MANUAL: fake USB-MIDI devices A/B, reversed output order. Use the editor's Connect, picker, Cancel and Disconnect; unplug/replug A above. No real MIDI or firmware installation.";
      break;
    }
    const button = () => doc.querySelector("#connect");
    const ready = () => /Disconnect|切断/.test(button().textContent) && !/Cancel|やめる/.test(button().textContent);
    const choose = async (source, target) => {
      await until(() => doc.querySelector(".midi-picker[open]"), "endpoint picker");
      const selects = doc.querySelectorAll(".midi-picker select");
      selects[0].value = source.input.id; selects[1].value = target.output.id;
      doc.querySelector('.midi-picker button[type="submit"]').click();
    };
    button().click(); await until(() => window.discoveryPermissionEntered, "permission barrier entered");
    button().click(); grant();
    await until(() => !/Cancel|やめる/.test(button().textContent), "cancel pending permission");
    button().click(); await until(() => doc.querySelector(".midi-picker[open]"), "cached ports require choice");
    doc.querySelector('.midi-picker button[type="button"]').click();
    await until(() => !doc.querySelector(".midi-picker"), "picker cancel removes modal");
    await until(() => !/Cancel|やめる/.test(button().textContent), "picker cancel retires attempt");
    check(a.sent.length + b.sent.length === 0, "permission and picker cancellation send no frames");
    button().click(); await until(() => doc.querySelector(".midi-picker[open]"), "picker opens after cancellation");
    check(a.sent.length + b.sent.length === 0, "no candidate traffic before explicit choice");
    await choose(a, a); await until(ready, "selected cached pair loads");
    check(a.sent.filter((r) => r.cmd === CMD.INFO).length === 1 && b.sent.length === 0, "one qualified INFO, no cross-pair traffic");
    check(a.sent.some((r) => r.cmd === CMD.WATCH), "normal live session survives qualification");
    a.input.state = a.output.state = "disconnected";
    window.discoveryAccess.onstatechange({ port: a.input });
    await until(() => !ready(), "selected cached-name unplug detected");
    check(b.sent.length === 0, "remaining device never substituted");
    a.input.state = a.output.state = "connected";
    window.discoveryAccess.onstatechange({ port: a.input });
    await until(ready, "same selected pair reconnects");
    check(a.sent.filter((r) => r.cmd === CMD.INFO).length === 2 && b.sent.length === 0, "reconnect requalifies exact pair");
    button().click();
    let held;
    a.output.send = (bytes) => {
      if (unframe(bytes)?.cmd === CMD.INFO) held = () => a.send(bytes);
      else a.send(bytes);
    };
    button().click(); await choose(a, a); await until(() => held, "INFO barrier entered");
    button().click(); held();
    await until(() => !/Cancel|やめる/.test(button().textContent), "cancel retires connection");
    check(!ready() && a.input.onmidimessage === null, "late INFO does not restore cancelled session");
    a.output.send = a.send;
    button().click(); await choose(a, b);
    await until(() => !/Cancel|やめる/.test(button().textContent), "ambiguous same-input retarget finishes");
    check(!ready() && b.sent.length === 0, "same-input/different-output retarget fails closed");
    button().click(); await choose(b, b); await until(ready, "independent replacement loads");
    check(a.input.onmidimessage === null && b.input.onmidimessage, "old cleanup preserves replacement handler");
    button().click(); await until(() => !ready(), "replacement disconnects");
    let loading;
    a.output.send = (bytes) => {
      const request = unframe(bytes);
      if (request?.cmd === CMD.DESC && request.a[0] === 0 && request.a[1] === 20) loading = true;
      else a.send(bytes);
    };
    button().click(); await choose(a, a); await until(() => loading, "descriptor-loading barrier");
    a.input.state = a.output.state = "disconnected";
    window.discoveryAccess.onstatechange({ port: a.input });
    await until(() => !/Cancel|やめる/.test(button().textContent), "loading unplug retires attempt");
    a.output.send = a.send;
    a.input.state = a.output.state = "connected";
    window.discoveryAccess.onstatechange({ port: a.input });
    await until(ready, "unplug during loading preserves same-pair reconnect intent");
    button().click();

    check(errors.length === 0, path + " page errors: " + errors.join(", "));
    // MIDIPort.close() is asynchronous; observe completed cleanup, rather than the synchronous button label.
    await until(() => a.input.closes > 0 && b.input.closes > 0, path + " owned MIDI ports close: " + a.input.closes + "/" + b.input.closes);
    for (const mock of mocks) mock.stop(); mocks = [];
  }
  if (!manual) result.textContent = "PASS: modular, retained and bundled editor selection, no cross-pair traffic, cached-name reconnect, cancel/stale INFO and replacement cleanup";
} catch (error) { result.textContent = "FAIL: " + error.message; throw error; }
finally { if (!manual) for (const mock of mocks) mock.stop(); }
