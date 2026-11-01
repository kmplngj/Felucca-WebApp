// SPDX-License-Identifier: GPL-3.0-only
// Optional CONTROL QUERY identity: actual Link/Device load, legacy compatibility and malformed wire data.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { CMD, Link, frame, unframe, parse, req, makeMockDevice, parseBuildIdentity, readBuildIdentity, strEnc } from "./app/src/proto.js";
import { Device } from "./app/src/device.js";

const commit = "0123456789abcdef0123456789abcdef01234567";
const identity = { commit, dirty: true, version: "Felucca v1.6.1", pr: "PR #790 head", profile: "standard" };
const u32 = (v) => [0, 7, 14, 21, 28].map((n) => v >>> n & 127);
const reply = (id, extended = true) => [0, 0, ...u32(id), ...u32(1), ...u32(0), ...u32(123), ...u32(0), 1,
  ...strEnc(commit), ...strEnc(identity.version), ...(extended ? [...strEnc(identity.pr), ...strEnc(identity.profile)] : [])];
const infoBytes = (caps) => [...strEnc("Felucca v1.6.1"), 0, 0, 0, 0, 0, 0, ...(caps == null ? [] : [0x5a, 1, caps])];
const html = readFileSync(new URL("./editor.html", import.meta.url), "utf8");
const classic = vm.runInNewContext(html.slice(html.indexOf("/*PROTO-BEGIN*/"), html.indexOf("/*PROTO-END*/")) + ";({parse,CMD})", {setTimeout,clearTimeout,setInterval,clearInterval,console});
for (const caps of [null, 0, 2, 3, 7, 127]) {
  const app = parse[CMD.INFO](infoBytes(caps)), old = classic.parse[classic.CMD.INFO](infoBytes(caps));
  assert.equal(app.controlCaps, (caps || 0) & 7);
  assert.equal(old.controlCaps, app.controlCaps);
  assert.equal(app.uiCaps, 0);
  assert.equal(app.engineCatalog, null);
}
assert.deepEqual(req.buildIdentity(0xffffffff), [84, [0, 127, 127, 127, 127, 15]]);
assert.deepEqual(req.buildIdentity(1, true), [84, [0, 1, 0, 0, 0, 0, 1]]);
for (const id of [-1, 0x100000000, NaN, 1.5]) assert.throws(() => req.buildIdentity(id));
assert.equal(parseBuildIdentity(reply(0xffffffff), true).requestId, 0xffffffff);
assert.equal(parseBuildIdentity(reply(1, false)).pr, null);
assert.equal(parseBuildIdentity(reply(1, false)).profile, null);
assert.equal(parseBuildIdentity(reply(1), true).pr, identity.pr);
assert.equal(parseBuildIdentity(reply(1), true).profile, identity.profile);
const emptyPr = [...reply(1, false), 0, ...strEnc("unknown")];
assert.equal(parseBuildIdentity(emptyPr, true).pr, "");
assert.equal(parseBuildIdentity(emptyPr, true).profile, "unknown");
const malformed = [];
for (const at of [6, 11, 16, 21, 26]) { const a = reply(1); a[at] = 16; malformed.push(a); }
for (const [at, value] of [[0, 1], [1, 1], [27, 2], [28, 31], [28, 128], [28, 65]]) { const a = reply(1); a[at] = value; malformed.push(a); }
malformed.push(reply(1).slice(0, -1), [...reply(1), 0], [...reply(1, false), ...strEnc("PR #0 head"), ...strEnc("standard")],
  [...reply(1, false), ...strEnc("PR #790"), ...strEnc("standard")],
  [...reply(1, false), ...strEnc(identity.pr), ...strEnc("Bad Profile")],
  [...reply(1, false), ...strEnc(identity.pr), ...strEnc("a".repeat(65))]);
for (const a of malformed) assert.throws(() => parseBuildIdentity(a, true));
assert.throws(() => parseBuildIdentity(reply(1), false));
assert.throws(() => parseBuildIdentity(reply(1, false), true));
console.log("identity protocol: strict bounds, canonical u32/commit/PR/profile and classic INFO compatibility ok");
if (process.env.FELUCCA_BUILD_IDENTITY_FIXTURE) {
  const fixture = JSON.parse(readFileSync(process.env.FELUCCA_BUILD_IDENTITY_FIXTURE, "utf8"));
  const i = parse[CMD.INFO](unframe(fixture.info).a), legacy = parseBuildIdentity(unframe(fixture.legacy).a), extended = parseBuildIdentity(unframe(fixture.extended).a, true);
  assert.equal(i.controlCaps, 7); assert.equal(legacy.requestId, 23); assert.equal(extended.requestId, 23);
  assert.equal(legacy.commit, extended.commit); assert.equal(legacy.version, extended.version); assert.equal(legacy.dirty, extended.dirty);
  assert.equal(legacy.pr, null); assert.equal(legacy.profile, null); assert.equal(extended.profile, "standard");
  assert.equal(classic.parse[classic.CMD.INFO](unframe(fixture.info).a).controlCaps, 7);
  console.log("identity producer: actual firmware INFO and legacy/extended CONTROL fixture ok");
} else console.log("identity producer fixture: skipped (FELUCCA_BUILD_IDENTITY_FIXTURE unset)");


/* Link must ignore another request's identity, including a delayed reply from a previous session. */
{
  let link, unknown = 0, timeouts = 0, sends = 0;
  link = new Link((raw) => {
    sends++;
    const f = unframe(raw), id = f.a.slice(1, 6).reduce((n, x, k) => n + x * 2 ** (7 * k), 0);
    queueMicrotask(() => { link.receive(frame(CMD.CONTROL, reply((id + 1) >>> 0))); link.receive(frame(CMD.CONTROL, reply(id))); });
  }, { onUnknown: () => unknown++, onTimeout: () => timeouts++ });
  const got = await readBuildIdentity((r, o) => link.request(r, o), {controlCaps: 7});
  assert.equal(got.commit, commit); assert.equal(unknown, 1); assert.equal(sends, 1); assert.equal(timeouts, 0);
  link.close();
}

async function load(opt, transform = null) {
  const mock = makeMockDevice({ auto: false, ...opt }), input = [...mock.access.inputs.values()][0], output = [...mock.access.outputs.values()][0];
  const sent = [], send = output.send.bind(output);
  output.send = (raw) => {
    const f = unframe(raw); sent.push(f);
    if (f.cmd === CMD.CONTROL && transform) { transform(f, input); return; }
    send(raw);
  };
  const d = new Device(mock.access), errors = [];
  d.buildIdentity = identity;  // load/reload must discard any earlier successful identity before reading INFO.
  d.on("error", (e) => errors.push(e));
  try {
    await d.open();
    assert.equal(d.loaded, true); assert.equal(errors.length, 0);
    const controls = sent.filter((f) => f.cmd === CMD.CONTROL);
    for (const f of controls) { assert.equal(f.a[0], 0); assert.ok(f.a.length === 6 || f.a.length === 7); }
    if (controls.length) { assert.equal(sent[0].cmd, CMD.INFO); assert.equal(sent[1].cmd, CMD.CONTROL); assert.equal(controls.length, 1); }
    return { identity: d.buildIdentity, controls, info: d.info, sent };
  } finally { d.close(); mock.stop(); }
}
assert.equal((await load({legacy: true})).identity, null);
const noCap = await load({}); assert.equal(noCap.identity, null); assert.equal(noCap.controls.length, 0);
const oldQuery = await load({controlCaps: 3, buildIdentity: identity});
assert.equal(oldQuery.identity.commit, commit); assert.equal(oldQuery.identity.dirty, true);
assert.equal(oldQuery.identity.pr, null); assert.equal(oldQuery.identity.profile, null); assert.equal(oldQuery.controls[0].a.length, 6);
const extended = await load({controlCaps: 127, buildIdentity: identity});
assert.equal(extended.info.version, identity.version); assert.equal(extended.info.controlCaps, 7); assert.equal(extended.identity.pr, identity.pr); assert.equal(extended.identity.profile, "standard");
assert.equal(extended.controls[0].a.length, 7);
for (const session of [oldQuery, extended]) assert.deepEqual(session.sent.filter((f) => f.cmd !== CMD.CONTROL), noCap.sent,
  "identity adds exactly one read-only QUERY and no other MIDI operations");
const muted = await load({controlCaps: 7}, () => {}); assert.equal(muted.identity, null); assert.equal(muted.controls.length, 1);
const bad = await load({controlCaps: 7}, (f, input) => {
  const id = f.a.slice(1, 6).reduce((n, x, k) => n + x * 2 ** (7 * k), 0), a = reply(id); a[27] = 2;
  queueMicrotask(() => input.onmidimessage({data: frame(CMD.CONTROL, a)}));
});
assert.equal(bad.identity, null);
// Reconnect to older firmware must not retain a successful earlier device identity.
const reconnected = await load({controlCaps: 2}); assert.equal(reconnected.identity, null); assert.equal(reconnected.controls.length, 0);
console.log("identity device: old/no capability, QUERY v1/v2, unknown bits, quiet timeout, malformed fallback and reconnect ok");

{
  const mock = makeMockDevice({auto:false,controlCaps:7}), output = [...mock.access.outputs.values()][0], original = output.send.bind(output);
  const d = new Device(mock.access);
  output.send = (raw) => { if (unframe(raw).cmd === CMD.CONTROL) queueMicrotask(() => d.close()); else original(raw); };
  try { await assert.rejects(d.open(), /closed/); assert.equal(d.loaded, false); assert.equal(d.buildIdentity, null); }
  finally { d.close(); mock.stop(); }
}
console.log("identity abort: device close during optional query propagates closed ok");
