// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import * as appProtocol from "./app/src/proto.js";
import { Device } from "./app/src/device.js";
import * as appDiscovery from "./app/src/discovery.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function harness(mode) {
  if (mode === "app") return { p: appProtocol, d: appDiscovery };
  const html = readFileSync(new URL("editor.html", import.meta.url), "utf8");
  const protocol = html.slice(html.indexOf("/*PROTO-BEGIN*/"), html.indexOf("/*PROTO-END*/"));
  const discovery = html.slice(html.indexOf("/*DISCOVERY-BEGIN*/"), html.indexOf("/*DISCOVERY-END*/"));
  return vm.runInNewContext(protocol + discovery + ";({p:{CMD,F,Link,parse,req,frame,strEnc,v14enc,unframe,makeMockDevice},d:{discoveryFor,validateMidiInfo,validateMidiDesc}})",
    { console, setTimeout, clearTimeout, setInterval, clearInterval, AbortController });
}

// Serve real documents: srcdoc cannot exercise the retained editor's History API route changes.
export function prepareDiscoveryPages() {
  mkdirSync(new URL("build/discovery/", import.meta.url), { recursive: true });
  for (const [index, path] of ["app/index.html", "editor.html", "build/discovery/editor.html"].entries()) {
    const base = index === 1 ? "/" : "/app/";
    const init = `<head><base href="${base}"><script>
      Object.defineProperty(navigator,'requestMIDIAccess',{value:async()=>{if(parent.discoveryRequestAccess)return parent.discoveryRequestAccess();parent.discoveryPermissionEntered=true;await parent.discoveryPermission;return parent.discoveryAccess;}});
      addEventListener('error',e=>parent.discoveryError(e.message));
      addEventListener('unhandledrejection',e=>parent.discoveryError(String(e.reason)));
      </script>`;
    const html = readFileSync(new URL(path, import.meta.url), "utf8").replace("<html", `<html data-discovery-case="/${path}"`).replace("<head>", init);
    writeFileSync(new URL(`build/discovery/case${index}.html`, import.meta.url), html);
  }
}

export async function runDiscoveryChecks(mode) {
  if (mode === "app")
    execFileSync("python3", [fileURLToPath(new URL("test_gen_discovery.py", import.meta.url))], { stdio: "inherit" });
  const { p, d } = harness(mode), mocks = [];
  function device(name = "Felucca", suffix = "", opt = {}) {
    const mock = p.makeMockDevice({ auto: false, ...opt }); mocks.push(mock);
    const input = [...mock.access.inputs.values()][0], output = [...mock.access.outputs.values()][0];
    input.name = output.name = name; input.id += suffix; output.id += suffix;
    input.manufacturer = output.manufacturer = "";
    input.opens = output.opens = input.closes = output.closes = 0;
    for (const port of [input, output]) {
      port.open = async () => { port.opens++; };
      port.close = async () => { port.closes++; };
    }
    const sent = [], raw = output.send.bind(output);
    output.send = (bytes) => { sent.push(p.unframe(bytes)); raw(bytes); };
    const access = { inputs: new Map([[input.id, input]]), outputs: new Map([[output.id, output]]) };
    return { mock, input, output, sent, access, pair: { input: input.id, output: output.id }, raw };
  }
  try {
    for (const name of ["X0X FM-1", "USB-MIDI", "SLOOP", "Conflux"]) {
      const m = device(name), policy = d.discoveryFor(m.access, p);
      await assert.rejects(policy.open(), /selectPorts/);
      assert.equal(m.sent.length, 0, "cached/generic discovery waits for intent");
      const session = await policy.open({ select: async () => m.pair });
      assert.match(session.info.version, /^FELUCCA /);
      assert.equal(session.input, m.input); assert.equal(session.output, m.output);
      assert.deepEqual(Array.from(m.sent, (r) => r.cmd), [1, 5, 5], "qualification is INFO then coherent read-only descriptors");
      session.close(); await sleep(0);
      assert.equal(m.input.onmidimessage, null); assert.equal(m.input.closes, 1); assert.equal(m.output.closes, 1);
    }
    {
      const unrelated = device("Keyboard");
      await assert.rejects(d.discoveryFor(unrelated.access, p).open(), /nodevice/);
      assert.equal(unrelated.sent.length, 0); assert.equal(unrelated.input.opens, 0);
    }
    {
      const a = device("Felucca", "A"), b = device("Felucca", "B");
      const access = { inputs: new Map([[a.input.id, a.input], [b.input.id, b.input]]), outputs: new Map([[b.output.id, b.output], [a.output.id, a.output]]) };
      const policy = d.discoveryFor(access, p);
      await assert.rejects(policy.open(), /selectPorts/);
      assert.equal(a.sent.length + b.sent.length, 0, "no independent-first or cross-product traffic");
      const session = await policy.open({ select: async () => b.pair });
      assert.equal(session.input, b.input); assert.equal(a.sent.length, 0); session.close();
      await assert.rejects(policy.open({ select: async () => ({ input: b.input.id, output: a.output.id }) }), /pairAmbiguous/);
      assert.equal(a.sent.length, 0, "same-input retarget fails before sending");
    }
    for (const missing of ["input", "output", "both"]) {
      const selected = device("USB-MIDI", "selected"), other = device("Felucca", "other");
      const access = { inputs: new Map([[selected.input.id, selected.input], [other.input.id, other.input]]),
        outputs: new Map([[selected.output.id, selected.output], [other.output.id, other.output]]) };
      if (missing !== "output") selected.input.state = "disconnected";
      if (missing !== "input") selected.output.state = "disconnected";
      const policy = d.discoveryFor(access, p);
      await assert.rejects(policy.open({ preferred: selected.pair }), { message: "nodevice" },
        `missing remembered ${missing} is transient absence, not cancellation`);
      assert.equal(selected.sent.length + other.sent.length, 0, "missing preferred endpoints never fall back or probe another pair");
      assert.equal(other.input.opens + other.output.opens, 0);
      const abort = new AbortController(); abort.abort();
      await assert.rejects(policy.open({ preferred: selected.pair, signal: abort.signal }), { message: "closed" },
        "explicit cancellation remains closed even when the preferred endpoint is absent");
      selected.input.state = selected.output.state = "connected";
      const session = await policy.open({ preferred: selected.pair });
      assert.equal(session.input, selected.input); assert.equal(session.output, selected.output);
      assert.equal(other.sent.length, 0, "late reappearance requalifies the remembered pair only");
      session.close();
    }
    {
      const a = device("Felucca", "dead"), b = device("Felucca", "live");
      let ignored = 0;
      const foreignHeader = p.frame(p.CMD.INFO, [...p.strEnc("FELUCCA cached"), 1, 111, 27, 64, 103, ...p.strEnc("ANALOG")]);
      foreignHeader[1] = 124;
      a.output.send = () => { ignored++; setTimeout(() => a.input.onmidimessage?.({ data: foreignHeader }), 0); }; // Real Link timeout/retry path.
      const access = { inputs: new Map([[a.input.id, a.input], [b.input.id, b.input]]), outputs: new Map([[a.output.id, a.output], [b.output.id, b.output]]) };
      const session = await d.discoveryFor(access, p).open({ select: async () => [a.pair, b.pair] });
      assert.equal(session.input, b.input); assert.equal(a.input.onmidimessage, null);
      assert.equal(a.input.closes, 1); assert.equal(ignored, 4, "foreign SysEx header never qualifies INFO; retries are bounded"); session.close();
    }
    {
      const m = device();
      const original = m.output.send;
      m.output.send = (bytes) => {
        if (p.unframe(bytes).cmd === p.CMD.INFO) {
          m.sent.push(p.unframe(bytes));
          setTimeout(() => m.input.onmidimessage?.({ data: p.frame(1, [...p.strEnc("FELUCCA bad"), 0, 0, 0, 0, 0]) }), 0);
        } else original(bytes);
      };
      await assert.rejects(d.discoveryFor(m.access, p).open(), /protocol/);
      assert.equal(m.sent.length, 1, "bad INFO is rejected before DESC");
    }
    {
      const m = device(), policy = d.discoveryFor(m.access, p);
      m.output.send = () => { m.input.state = "disconnected"; policy.state(m.input); };
      await assert.rejects(policy.open(), /lost/, "physical probe loss retains its cause instead of Link.close winning");
      assert.equal(m.input.onmidimessage, null);
    }
    {
      const m = device(), abort = new AbortController(); let oldHandler;
      m.output.send = () => { oldHandler = m.input.onmidimessage; abort.abort(); };
      await assert.rejects(d.discoveryFor(m.access, p).open({ signal: abort.signal }), /closed/);
      assert.equal(m.input.onmidimessage, null);
      let replacement = 0; m.input.onmidimessage = () => replacement++;
      oldHandler({ data: p.frame(p.CMD.RELOAD, [0]) });
      assert.equal(replacement, 0, "late old callback cannot reach replacement");
      assert.notEqual(m.input.onmidimessage, null);
    }
    {
      const m = device(); m.input.open = async () => { throw Error("OS open failed"); };
      await assert.rejects(d.discoveryFor(m.access, p).open(), /OS open failed/);
      await sleep(0);
      assert.equal(m.input.closes, 1); assert.equal(m.output.closes, 1);
      assert.equal(m.sent.length, 0, "failed open cannot send or leave an owned handler");
      assert.equal(m.input.onmidimessage, null);
    }
    for (const held of ["input", "output"]) {
      const m = device(), abort = new AbortController(); let release;
      m[held].open = () => new Promise((resolve) => { release = resolve; });
      const pending = d.discoveryFor(m.access, p).open({ signal: abort.signal });
      await sleep(0); abort.abort(); await assert.rejects(pending, /closed/);
      await sleep(0);
      assert.equal(m[held].closes, 0);
      assert.equal(m[held === "input" ? "output" : "input"].closes, 1, "a hung peer must not prevent this port from closing");
      release(); await sleep(0); await sleep(0);
      assert.equal(m.input.closes, 1); assert.equal(m.output.closes, 1);
    }
    {
      const a = device("USB-MIDI", "late"), b = device("USB-MIDI", "replacement"), abort = new AbortController(); let release;
      a.input.open = () => new Promise((resolve) => { release = resolve; });
      const access = { inputs: new Map([[a.input.id, a.input], [b.input.id, b.input]]), outputs: new Map([[a.output.id, a.output]]) };
      const policy = d.discoveryFor(access, p);
      const old = policy.open({ select: async () => a.pair, signal: abort.signal });
      await sleep(0); abort.abort(); await assert.rejects(old, /closed/); await sleep(0);
      // Explicitly approved replacement route: the released output now delivers to the replacement input.
      a.output.send = b.output.send;
      const current = await policy.open({ select: async () => ({ input: b.input.id, output: a.output.id }) });
      release(); await sleep(0); await sleep(0);
      assert.equal(a.input.closes, 1); assert.equal(a.output.closes, 1, "late old open must not close the replacement's acquired peer");
      assert.equal(current.link.closed, false); assert.notEqual(b.input.onmidimessage, null);
      await current.link.request(p.req.info()); current.close(); await sleep(0);
      assert.equal(a.output.closes, 2);
    }
    {
      const m = device(), policy = d.discoveryFor(m.access, p); let release;
      m.input.open = () => new Promise((resolve) => { release = resolve; });
      const started = Date.now();
      await assert.rejects(policy.open(), /noreply/);
      assert.ok(Date.now() - started < 4000, "a hung OS open is bounded without waiting for it");
      release(); await sleep(0); await sleep(0);
      assert.equal(m.input.closes, 1);
    }
    for (const opt of [{ legacy: true }, { v3: true }, { v5: true }, { catalog: true, test14: true }, { catalog: true, omit: 10 }]) {
      const m = device("Felucca", "", opt), session = await d.discoveryFor(m.access, p).open();
      assert.equal(session.info.gcount, 27); session.close();
    }
    for (const payload of [[...p.strEnc("foreign"), 1, 111, 27, 64, 103, ...p.strEnc("ANALOG")],
      [...p.strEnc("FELUCCA x"), 0, 0, 0, 0, 0], [...p.strEnc("FELUCCA x"), 1, 111, 27, 127, 103, ...p.strEnc("ANALOG")]])
      assert.throws(() => d.validateMidiInfo(payload, p), /protocol/);
    const macro = [0, 103, p.F.ENUM, ...p.v14enc(0), ...p.v14enc(47), ...p.v14enc(0), ...p.strEnc("SHAPE"), 0,
      ...Array.from({ length: 48 }, (_, i) => p.strEnc("MODEL" + i)).flat()];
    assert.equal(d.validateMidiDesc(macro, 0, 103, p).names.length, 48, "real producer's extended enum bound");
    if (mode === "app") {
      const m = device("X0X FM-1"), connected = new Device(m.access, { selectPorts: async () => m.pair });
      await connected.open(); assert.equal(connected.loaded, true);
      assert.equal(m.sent.filter((r) => r.cmd === p.CMD.INFO).length, 1, "Device adopts the qualified INFO/link once");
      connected.close(); assert.equal(connected.timers.length, 0);
      const unplug = device(), originalUnplug = unplug.output.send;
      const loading = new Device(unplug.access);
      unplug.output.send = (bytes) => {
        const request = p.unframe(bytes);
        if (request.cmd === p.CMD.DESC && request.a[1] === 20) loading.close("lost");
        else originalUnplug(bytes);
      };
      await assert.rejects(loading.open(), /closed/);
      assert.equal(loading.closeReason, "lost", "main can preserve reconnect intent when loading was interrupted");
      assert.equal(unplug.input.onmidimessage, null);
      const bad = device(), original = bad.output.send;
      bad.output.send = (bytes) => {
        const request = p.unframe(bytes);
        if (request.cmd === p.CMD.DESC && request.a[0] === 0 && request.a[1] === 20)
          setTimeout(() => bad.input.onmidimessage?.({ data: p.frame(p.CMD.DESC, [0, 20, p.F.INT, ...p.v14enc(5), ...p.v14enc(1), ...p.v14enc(0), ...p.strEnc("BAD"), 0]) }), 0);
        else original(bytes);
      };
      const invalid = new Device(bad.access);
      await assert.rejects(invalid.open(), /protocol/);
      assert.equal(invalid.closed, true); assert.equal(bad.input.onmidimessage, null);
    } else {
      // Invoke the actual retained connect/disconnect call sites, with only rendering/load isolated.
      const html = readFileSync(new URL("editor.html", import.meta.url), "utf8"), m = device("USB-MIDI"), other = device("Felucca", "other");
      m.access.inputs.set(other.input.id, other.input); m.access.outputs.set(other.output.id, other.output);
      const begin = html.indexOf("let connecting = false;"), end = html.indexOf("\nfunction assertSession(", begin);
      const context = { ACCESS: m.access, PAIR: m.pair, console, setTimeout, clearTimeout, setInterval, clearInterval,
        AbortController, navigator: { requestMIDIAccess() { throw Error("unexpected permission request"); } } };
      const protocol = html.slice(html.indexOf("/*PROTO-BEGIN*/"), html.indexOf("/*PROTO-END*/"));
      const discovery = html.slice(html.indexOf("/*DISCOVERY-BEGIN*/"), html.indexOf("/*DISCOVERY-END*/"));
      const actual = vm.runInNewContext(protocol + discovery + `
        let access=ACCESS,dev=null,wantConnected=false,rewatch=false,needReload=false;
        const MOCK=false,button={}; const $=()=>button,t=k=>k,setLabel=(b,s)=>b.label=s,sayK=()=>{};
        const samplesLeave=()=>{},resetBusy=()=>{},resetSets=()=>{},renderPanels=()=>{},renderMixer=()=>{},renderSysinfo=()=>{},renderLive=()=>{},renderLib=()=>{},renderBank=()=>{},renderPreferences=()=>{};
        midiPortPicker=async()=>PAIR;
        async function load(d){ if(!d.info || !d.session) throw Error('qualification not adopted'); }
        ` + html.slice(begin, end) + ";({connect,disconnect,onState,get dev(){return dev},get wantConnected(){return wantConnected},get button(){return button}})", context);
      await actual.connect();
      assert.equal(actual.dev.input, m.input); assert.equal(actual.dev.info.gcount, 27);
      assert.equal(m.sent.filter((r) => r.cmd === p.CMD.INFO).length, 1);
      for (const late of ["input", "output"]) {
        m.input.state = m.output.state = "disconnected";
        actual.onState({ port: m.input }); actual.onState({ port: m.output });
        const first = late === "input" ? "output" : "input";
        m[first].state = "connected"; actual.onState({ port: m[first] });
        await sleep(900);
        assert.equal(actual.dev, null);
        assert.equal(actual.wantConnected, true, "actual retained connect catch preserves reconnect intent for a missing endpoint");
        assert.equal(other.sent.length, 0);
        m[late].state = "connected"; actual.onState({ port: m[late] });
        await sleep(900);
        assert.equal(actual.dev?.input, m.input, "late remembered peer reconnects through actual retained onState/connect");
        assert.equal(actual.dev?.output, m.output);
        assert.equal(other.sent.length, 0);
      }
      actual.disconnect(); await sleep(0);
      assert.equal(actual.dev, null); assert.equal(m.input.onmidimessage, null); assert.equal(m.input.closes, 1);
    }
    console.log(`discovery ${mode}: cached/ambiguous intent, actual handshakes, retry/cleanup/cancel, legacy/catalog and descriptor bounds passed`);
  } finally { for (const mock of mocks) mock.stop(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runDiscoveryChecks("app"); await runDiscoveryChecks("classic");
}
