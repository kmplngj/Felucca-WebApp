// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Felucca contributors
// One policy for both editors. Names select candidates; only read-only replies qualify a session.
const midiPolicies = new WeakMap();
const midiCandidate = (p) => p.state === "connected" && !/ota|update/i.test(p.name || "") &&
  /felucca|fm-1|sloop|clipper|conflux|composite|sinco|usb-midi/i.test(p.name || "");
const midiError = (message) => new Error(message);

function midiString(r, max) {
  let text = "";
  for (;;) {
    const b = r.b();
    if (!b) return text;
    if (b < 32 || b > 126 || text.length === max) throw midiError("protocol");
    text += String.fromCharCode(b);
  }
}

export function validateMidiInfo(a, protocol) {
  if (a.length + 6 > 664 || a.some((b) => !Number.isInteger(b) || b < 0 || b > 127)) throw midiError("protocol");
  let at = 0;
  const r = { b() { if (at === a.length) throw midiError("protocol"); return a[at++]; } };
  const version = midiString(r, 24), n = r.b(), count = r.b(), globals = r.b(), steps = r.b(), pe0 = r.b();
  if (!/^FELUCCA /.test(version) || n < 1 || n > 64 || count < 57 || count > 127 ||
      globals !== 27 || steps !== 64 || pe0 !== count - 8) throw midiError("protocol");
  for (let i = 0; i < n; i++) if (!midiString(r, 8)) throw midiError("protocol");
  const info = protocol.parse[protocol.CMD.INFO](a);
  if (![0, 4].includes(info.ntrk) || ![0, 16].includes(info.chainRows)) throw midiError("protocol");
  return info;
}

export function validateMidiDesc(a, scope, id, protocol) {
  if (a.length + 6 > 664 || a.some((b) => !Number.isInteger(b) || b < 0 || b > 127)) throw midiError("protocol");
  let at = 0;
  const r = { b() { if (at === a.length) throw midiError("protocol"); return a[at++]; },
    v() { const lo = this.b(); return (lo | this.b() << 7) - 8192; } };
  const d = { scope: r.b(), id: r.b(), fmt: r.b(), min: r.v(), max: r.v(), def: r.v(), names: [] };
  if (d.scope !== scope || d.id !== id || d.fmt > 13 || d.min > d.max || d.def < d.min || d.def > d.max) throw midiError("protocol");
  d.label = midiString(r, 8); d.unit = midiString(r, 8);
  if (!d.label) throw midiError("protocol");
  if (d.fmt === protocol.F.ENUM) {
    // Ordinary enums have at most 24 names; the producer's MACRO SHAPE has 48, up to 12 characters.
    const count = Math.min(d.max - d.min + 1, 24);
    for (let i = 0; i < count; i++) d.names.push(midiString(r, 12));
    if (at < a.length && d.max - d.min + 1 === 48)
      while (d.names.length < 48) d.names.push(midiString(r, 12));
  }
  if (at !== a.length) throw midiError("protocol");
  return d;
}

export class MidiDiscovery {
  constructor(access, protocol) {
    this.access = access; this.protocol = protocol;
    this.targets = new Map(); this.closing = new Map(); this.owners = new Map(); this.pending = null;
  }
  ports() {
    const order = (a, b) => Number(!/felucca/i.test(a.name || "")) - Number(!/felucca/i.test(b.name || ""));
    return { inputs: [...this.access.inputs.values()].filter(midiCandidate).sort(order),
      outputs: [...this.access.outputs.values()].filter(midiCandidate).sort(order) };
  }
  state(port) {
    if (port.state !== "disconnected") return;
    if (this.probing?.includes(port)) this.pending?.abort(midiError("lost"));
    this.owners.delete(port); this.closing.delete(port);
    this.targets.delete(port.id);
    for (const [input, output] of this.targets) if (output === port.id) this.targets.delete(input);
  }
  async open({ select, signal, preferred, onPair } = {}) {
    this.pending?.abort();
    const abort = new AbortController(); this.pending = abort;
    const cancel = () => abort.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const { inputs, outputs } = this.ports();
    try {
      if (abort.signal.aborted) throw midiError("closed");
      let chosen = preferred;
      if (!chosen && inputs.length === 1 && outputs.length === 1 && /felucca/i.test(inputs[0].name || "") &&
          inputs[0].name === outputs[0].name && inputs[0].manufacturer === outputs[0].manufacturer)
        chosen = { input: inputs[0].id, output: outputs[0].id };
      if (!inputs.length || !outputs.length) throw midiError("nodevice");
      if (!chosen) {
        if (!select) throw midiError("selectPorts");
        chosen = await select({ inputs, outputs }, abort.signal);
      }
      if (!chosen || abort.signal.aborted) throw midiError("closed");
      const pairs = Array.isArray(chosen) ? chosen : [chosen];
      if (!pairs.length || pairs.length > 3) throw midiError("selectPorts");
      const end = Date.now() + 9000;
      let last;
      for (const pair of pairs) {
        const input = inputs.find((p) => p.id === pair.input), output = outputs.find((p) => p.id === pair.output);
        if (!input || !output || abort.signal.aborted) throw midiError("closed");
        if (this.targets.has(input.id) && this.targets.get(input.id) !== output.id) throw midiError("pairAmbiguous");
        this.targets.set(input.id, output.id);
        onPair?.({ input: input.id, output: output.id });
        this.probing = [input, output];
        try { return await this.probe(input, output, abort.signal, Math.min(3000, end - Date.now())); }
        catch (error) { if (abort.signal.aborted || Date.now() >= end) throw error; last = error; }
        finally { this.probing = null; }
      }
      throw last || midiError("noreply");
    } finally {
      signal?.removeEventListener("abort", cancel);
      if (this.pending === abort) this.pending = null;
    }
  }
  async probe(input, output, signal, milliseconds) {
    const { Link, CMD, req, F } = this.protocol;
    let closed = false, acquired = false, timer, rejectStop, malformed = false;
    const owner = {};
    const stop = new Promise((_, reject) => { rejectStop = reject; });
    const aborted = () => { rejectStop(midiError(signal.reason?.message === "lost" ? "lost" : "closed")); close(); };
    signal.addEventListener("abort", aborted, { once: true });
    timer = setTimeout(() => rejectStop(midiError("noreply")), Math.max(1, milliseconds));
    const link = new Link((data) => {
      if (closed || input.state !== "connected" || output.state !== "connected") throw midiError("lost");
      output.send(data);
    });
    const handler = (event) => {
      if (closed) return;
      const data = event.data;
      if (data?.[0] === 240 && data[1] === 125 && data[2] === 70 && data[3] === 76 && data[4] === CMD.INFO &&
          (data.length > 664 || data[data.length - 1] !== 247 || [...data.slice(1, -1)].some((b) => b > 127))) {
        malformed = true; rejectStop(midiError("protocol")); return;
      }
      link.receive(data);
    };
    const opened = new Map();
    const close = () => {
      if (closed) return;
      closed = true; link.close();
      if (input.onmidimessage === handler) input.onmidimessage = null;
      if (!acquired) return;
      for (const port of [input, output]) {
        if (this.owners.get(port) !== owner) continue;
        // Include late open completion: a replacement must not acquire the port before cleanup settles.
        const cleanup = Promise.allSettled([opened.get(port)]).then(() => this.owners.get(port) === owner ? port.close?.() : null).catch(() => {});
        this.closing.set(port, cleanup);
        cleanup.finally(() => {
          if (this.closing.get(port) === cleanup) this.closing.delete(port);
          if (this.owners.get(port) === owner) this.owners.delete(port);
        });
      }
    };
    try {
      await Promise.race([Promise.all([this.closing.get(input), this.closing.get(output)]), stop]);
      if (signal.aborted) throw midiError("closed");
      if (this.owners.has(input) || this.owners.has(output)) throw midiError("portBusy");
      acquired = true;
      this.owners.set(input, owner); this.owners.set(output, owner);
      for (const port of [input, output]) opened.set(port, Promise.resolve().then(() => port.open?.()));
      await Promise.race([Promise.all([...opened.values()]), stop]);
      if (signal.aborted) throw midiError("closed");
      input.onmidimessage = handler;
      const a = await Promise.race([link.request(req.info(), { timeout: 500, retries: 3, quiet: true }), stop]);
      const info = validateMidiInfo(a, this.protocol);
      const pdesc = validateMidiDesc(await Promise.race([link.request(req.desc(0, 0), { timeout: 250, retries: 0, quiet: true }), stop]), 0, 0, this.protocol);
      const gdesc = validateMidiDesc(await Promise.race([link.request(req.desc(1, 0), { timeout: 250, retries: 0, quiet: true }), stop]), 1, 0, this.protocol);
      if (pdesc.label !== "LVL" || pdesc.fmt !== F.DB || pdesc.min !== 0 || pdesc.max !== 127 ||
          gdesc.label !== "BPM" || gdesc.fmt !== F.BPM || gdesc.min !== 40 || gdesc.max !== 240) throw midiError("protocol");
      return { input, output, link, info, pdesc, gdesc, close };
    } catch (error) {
      close();
      throw signal.aborted ? midiError(signal.reason?.message === "lost" ? "lost" : "closed") : malformed ? midiError("protocol") : !acquired && error.message === "noreply" ? midiError("portBusy") : error;
    }
    finally { clearTimeout(timer); signal.removeEventListener("abort", aborted); }
  }
}

export function discoveryFor(access, protocol) {
  if (!midiPolicies.has(access)) midiPolicies.set(access, new MidiDiscovery(access, protocol));
  return midiPolicies.get(access);
}

export function midiPortState(access, port) { midiPolicies.get(access)?.state(port); }

// Existing dialog styles and translated strings are supplied by each editor.
export function midiPortPicker(ports, signal, words) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog"), form = document.createElement("form"); dialog.className = "midi-picker";
    const title = document.createElement("h3"), note = document.createElement("p");
    title.textContent = words.selectPorts; note.textContent = words.portHelp;
    title.id = "midi-picker-title"; dialog.setAttribute("aria-labelledby", title.id);
    const selects = [ports.inputs, ports.outputs].map((list, index) => {
      const label = document.createElement("label"), select = document.createElement("select");
      label.textContent = index ? words.midiOutput : words.midiInput;
      select.required = true; select.className = "text wide";
      const empty = document.createElement("option"); empty.value = ""; empty.textContent = words.selectPorts; select.append(empty);
      for (const port of list) {
        const option = document.createElement("option"); option.value = port.id;
        option.textContent = `${port.name || "—"} · ${port.manufacturer || "—"} · ${port.id}`;
        select.append(option);
      }
      label.append(select); form.append(label); return select;
    });
    const actions = document.createElement("div"), cancel = document.createElement("button"), connect = document.createElement("button");
    actions.className = "acts"; cancel.type = "button"; connect.type = "submit";
    cancel.className = "btn"; connect.className = "btn primary";
    cancel.textContent = words.cancel; connect.textContent = words.connect;
    actions.append(cancel, connect); form.append(actions); dialog.append(title, note, form); document.body.append(dialog);
    const finish = (value) => { signal.removeEventListener("abort", abort); dialog.close(); dialog.remove(); resolve(value); };
    const abort = () => finish(null);
    signal.addEventListener("abort", abort, { once: true });
    cancel.onclick = abort; dialog.oncancel = (event) => { event.preventDefault(); abort(); };
    form.onsubmit = (event) => { event.preventDefault(); finish({ input: selects[0].value, output: selects[1].value }); };
    if (signal.aborted) abort(); else { dialog.showModal(); selects[0].focus(); }
  });
}
