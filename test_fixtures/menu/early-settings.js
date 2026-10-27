// SPDX-License-Identifier: GPL-3.0-only
// Run the actual main entry point and DOM. Only the mock transport and lifecycle barriers are test-owned.
const result = document.querySelector("#result"), receipts = [];
const check = (ok, message) => { if (!ok) throw new Error(message); };
const until = async (fn, message) => {
  const end = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() >= end) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const source = await (await fetch("../../app/index.html")).text();
let active;
async function editor(options = {}) {
  const frame = document.createElement("iframe"); frame.title = "Mock editor";
  frame.style = "width:100%;height:75vh;border:0";
  // Static module imports share the same module instances as main.js in this fresh frame.
  const setup = `
    import { Device } from "./src/device.js";
    import { makeMockDevice } from "./src/proto.js";
    import { Library } from "./src/library.js";
    const options = ${JSON.stringify(options)};
    const mock = makeMockDevice({ auto: false, ...options });
    const test = window.test = { sessions: [], errors: [], mock };
    window.addEventListener("unhandledrejection", e => { test.errors.push(String(e.reason)); e.preventDefault(); });
    window.addEventListener("error", e => test.errors.push(e.message));
    Object.defineProperty(navigator, "requestMIDIAccess", { value: async () => mock.access });
    const open = Device.prototype.open, adopt = Library.prototype.adopt;
    const read = Device.prototype.readMenu, learn = Device.prototype.readLearn, palette = Device.prototype.readPalette;
    Device.prototype.open = async function () {
      const s = { dev: this, reads: 0, done: 0, learn: 0, palette: 0 };
      test.sessions.push(s);
      await new Promise(resolve => { s.load = resolve; });
      return open.call(this);
    };
    Library.prototype.adopt = async function (d) {
      const s = test.sessions.find(s => s.dev === d);
      s.loaded = true;
      if (options.holdAdopt) await new Promise(resolve => { s.adopt = resolve; });
      return adopt.call(this, d);
    };
    Device.prototype.readMenu = async function () {
      const s = test.sessions.find(s => s.dev === this); s.reads++;
      try { if (test.failRead) throw new Error("fixture optional read failure"); return await read.call(this); }
      finally { s.done++; }
    };
    Device.prototype.readLearn = function () { test.sessions.find(s => s.dev === this).learn++; return learn.call(this); };
    Device.prototype.readPalette = function () { test.sessions.find(s => s.dev === this).palette++; return palette.call(this); };
    await import("./src/main.js");
    test.ready = true;
  `;
  frame.srcdoc = source.replace("<head>", '<head><base href="' + new URL("../../app/", location.href) + '">')
    .replace('<script type="module" src="src/main.js"></script>', '<script type="module">' + setup + '</script>');
  document.body.append(frame); active = frame;
  await until(() => frame.contentWindow.test?.ready, "actual main entry point initialized");
  const t = frame.contentWindow.test, doc = frame.contentDocument;
  const connect = () => doc.querySelector("#connect").click();
  const settings = () => doc.querySelector("#settings").click();
  const cards = () => !!doc.querySelector('#s-settings input[aria-label="BG"]') && !!doc.querySelector('#s-settings input[aria-label="CC"]');
  const ready = () => {
    const current = t.sessions.at(-1);
    return !doc.querySelector("#connect").disabled && current?.dev.loaded && !current.dev.closed;
  };
  connect(); await until(() => t.sessions.length === 1, "connection entered controlled load");
  return { frame, t, doc, connect, settings, cards, ready, s: t.sessions[0] };
}
function finish(e, name) {
  check(!e.t.errors.length, name + ": no unhandled errors: " + e.t.errors.join(", "));
  receipts.push({ name, language: e.doc.documentElement.lang,
    sessions: e.t.sessions.map(s => ({ reads: s.reads, done: s.done, learn: s.learn, palette: s.palette })) });
  for (const s of e.t.sessions) s.dev.close();
  e.t.mock.stop(); e.frame.remove(); active = null;
}
try {
  // A bounded semantic wait is required: Connect becoming ready does not mean optional reads have finished.
  let e = await editor(); e.settings(); e.s.load();
  await until(e.ready, "early connection ready");
  try { await until(e.cards, "early-open Settings must eventually hydrate CUSTOM and MIDI LEARN without reopening"); }
  catch (error) {
    e.settings(); e.settings();
    await until(e.cards, "positive reopening control must restore supported cards");
    receipts.push({ name: "early-open-negative-witness", afterReopen: true });
    throw new Error(error.message + "; positive reopening control passed");
  }
  await until(() => e.s.done === 1, "early optional read completed");
  check(e.s.reads === 1 && e.s.learn === 1 && e.s.palette === 1, "exactly one early refresh");
  finish(e, "early-open");

  e = await editor(); e.s.load(); await until(e.ready, "late connection ready");
  check(e.s.reads === 0, "closed Settings does not preload optional data");
  e.settings(); await until(e.cards, "late-open cards"); await until(() => e.s.done === 1, "late read complete");
  finish(e, "late-open");

  e = await editor(); e.settings(); e.settings(); e.s.load(); await until(e.ready, "closed-before-load ready");
  check(e.s.reads === 0 && !e.cards(), "closing before load avoids optional refresh");
  finish(e, "close-before-load");

  e = await editor({ holdAdopt: true }); e.s.load(); await until(() => e.s.loaded, "loaded before adoption completes");
  // Keep the optional refresh waiting in idle while readiness and another open request coincide.
  e.s.dev.busy++; e.settings(); check(e.s.reads === 1, "loaded open starts refresh");
  e.settings(); e.settings(); e.s.adopt(); await until(e.ready, "adoption handoff ready");
  check(e.s.reads === 1, "pending open/readiness refreshes coalesce");
  e.s.dev.busy--; await until(e.cards, "coalesced cards"); await until(() => e.s.done === 1, "coalesced read complete");
  finish(e, "coalesced-open-and-ready");

  e = await editor({ noLearn: true }); e.settings(); e.s.load(); await until(e.ready, "unsupported connection ready");
  await until(() => e.s.done === 1, "unsupported refresh completed");
  check(e.s.learn === 0 && e.s.palette === 0 && !e.doc.querySelector('#s-settings input[aria-label="CC"]') &&
    !e.doc.querySelector('#s-settings input[aria-label="BG"]'), "unsupported optional requests/cards absent");
  check(e.doc.querySelector('#s-settings select[aria-label="LEDS"]'), "older advertised MENU controls remain available");
  finish(e, "unsupported");

  e = await editor(); e.s.load(); await until(e.ready, "replacement initial ready");
  e.s.dev.busy++; e.settings(); check(e.s.reads === 1, "old refresh queued in idle");
  e.connect(); e.connect(); await until(() => e.t.sessions.length === 2, "replacement session created");
  const replacement = e.t.sessions[1];
  await until(() => e.s.done === 1, "closed queued read settles after replacement creation");
  check(!e.cards() && replacement.reads === 0, "closed session cannot hydrate replacement");
  replacement.load(); await until(e.ready, "replacement ready"); await until(e.cards, "replacement gets its own cards");
  await until(() => replacement.done === 1, "replacement optional read complete");
  check(e.s.learn === 0 && e.s.palette === 0 && replacement.reads === 1, "only current session issues optional requests");
  finish(e, "disconnect-and-replacement");

  e = await editor(); e.s.load(); await until(e.ready, "error case ready");
  e.t.failRead = true; e.settings(); await until(() => e.s.done === 1, "rejected read settles");
  await until(() => e.doc.querySelector("#msg-t").textContent.includes("fixture optional read failure"), "current read error reported");
  e.doc.querySelector("#msgs").click();
  check([...e.doc.querySelectorAll("#log-list li")].filter(row => row.textContent.includes("fixture optional read failure")).length === 1,
    "optional rejection reports one error");
  e.doc.querySelector("#lg-x").click();
  e.t.failRead = false; e.settings(); e.settings(); await until(e.cards, "retry after rejected read works");
  await until(() => e.s.done === 2, "retry completed"); finish(e, "rejected-read-retry");

  result.textContent = "PASS: actual main early/late Settings, close-before-load, coalescing, unsupported, session replacement and rejected-read retry";
  document.documentElement.dataset.testResult = "passed";
} catch (error) {
  result.textContent = "FAIL: " + error.message; document.documentElement.dataset.testResult = "failed";
} finally {
  if (active) { for (const s of active.contentWindow.test?.sessions || []) s.dev.close(); active.contentWindow.test?.mock.stop(); active.remove(); }
  const pre = document.createElement("pre"); pre.id = "receipt"; pre.textContent = JSON.stringify(receipts, null, 2); document.body.append(pre);
}
