// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
//
// The legacy migration library (app/src/legacy.js, kmplngj/Felucca#456 / #457) and the raw store export it reads
// (STORE_LIST 82 / STORE_GET 83, INFO 59 01 bit 0):
//   - every vector of legacy_vectors.json (made by gen_legacy.c from the firmware itself) converts byte for byte, and the
//     objects the firmware refuses are refused here too;
//   - the export against the mock device: list, one object, all of them, a file read back, playback refusals;
//   - capability gating: firmware without INFO 59 01 gets no STORE request and no STORED card;
//   - read only: the export and the migration send nothing but STORE_LIST / STORE_GET and change nothing.
// FELUCCA_ROOT=/path/to/Felucca (a checkout with build/gen) also builds gen_legacy.c with CC (default cc) and checks
// that its tables and vectors are the committed ones, plus a seeded corpus (FELUCCA_CORPUS=SEED:COUNT, default 1:240).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import * as proto from "./app/src/proto.js";
import { Device } from "./app/src/device.js";
import { T } from "./app/src/legacy_tables.js";
import { MigrationError, RULES, STORE_TYPES, TARGET, bankLegacyRecords, migrateObject, migrateProject, migrateUserBank, projectFormat,
  ruleFor, targetMismatch, fnv1a } from "./app/src/legacy.js";
import { canMigrate, migratedManifest, migratedName, originalName, objectBytes, objectKey, recoveryCard, recoveryState, relist } from "./app/src/recovery.js";
import { RAW_CMD, bkU32, bkPack, captureRawObject, captureRawStore, bkCrc, rawManifest, rawObjectManifest, readRawStore } from "./fm1backup.js";

let failed = 0;
const ok = (cond, what) => { console.log(`${what.padEnd(72)} ${cond ? "ok" : "FAIL"}`); if (!cond) failed++; };
const HERE = new URL(".", import.meta.url).pathname;
const B = (s) => Uint8Array.from(Buffer.from(s, "base64"));
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
const STATES = ["empty", "current", "legacy", "unknown", "damaged"];

/* the vectors: input bytes -> the firmware's output bytes (out absent: the firmware refuses the object) */
function checkVectors(v, label) {
  const bad = [];
  for (const p of v.projects) {
    const inp = B(p.in), keep = inp.slice(); let got = null, err = null;
    try { got = migrateProject(inp).bytes; } catch (e) { err = e; }
    if (p.out ? !same(got, B(p.out)) : got || !(err instanceof MigrationError)) bad.push(`project ${p.name}${err ? ": " + err.message : ""}`);
    if (p.state !== undefined && projectFormat(inp).state !== STATES[p.state]) bad.push(`state ${p.name}: ${projectFormat(inp).state}`);
    if (!same(inp, keep)) bad.push(`input changed ${p.name}`);
  }
  for (const p of v.presets) {
    const inp = B(p.in), keep = inp.slice(); let r = null, err = null;
    try { r = migrateUserBank(inp); } catch (e) { err = e; }
    if (p.out ? !(r && same(r.bytes, B(p.out))) : r || !(err instanceof MigrationError)) bad.push(`bank ${p.name}${err ? ": " + err.message : ""}`);
    for (const i of p.refused || []) if (!r || r.records[i].status !== "refused") bad.push(`bank ${p.name}: record ${i} not refused`);
    if (!same(inp, keep)) bad.push(`input changed ${p.name}`);
  }
  if (bad.length) console.log(bad.slice(0, 10).join("\n"));
  ok(!bad.length, `${label}: ${v.projects.length} projects, ${v.presets.length} banks byte for byte`);
}

/* ------------------------------------------------------------- vectors --- */
const vectors = JSON.parse(readFileSync(join(HERE, "legacy_vectors.json"), "utf8"));
ok(vectors.P_COUNT === TARGET.pcount && vectors.projects.length >= 20 && vectors.presets.length >= 2, "vectors: made for this library's P_COUNT");
checkVectors(vectors, "vectors");
{
  const fmts = new Set(vectors.projects.map((p) => projectFormat(B(p.in)).fmt));
  ok([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].every((f) => fmts.has(f)), "vectors: every project format FUN1..FUN10");
  const refusal = (name) => { const p = vectors.projects.find((x) => x.name.startsWith(name)); try { migrateProject(B(p.in)); return "converted"; } catch (e) { return e.code; } };
  ok(refusal("FUN10 np 112") === "newer", "a later firmware's FUN10 (np 112): refused as newer, not converted");
  ok(refusal("FUN3 with a damaged hash") !== "converted", "a damaged project: refused");
  const fun1 = vectors.projects.find((x) => x.name.startsWith("FUN1 ")), r = migrateProject(B(fun1.in));
  ok(r.from.fmt === 1 && r.to.fmt === 10 && r.bytes.length === 3840 && r.log.length > 0 && r.tracks.length === 4 && !r.same,
    "FUN1 -> FUN10 of 111 with a report (log, tracks)");
  const again = migrateProject(r.bytes);
  ok(again.same && same(again.bytes, r.bytes), "a migrated project migrates to itself (already current)");
  const bank = vectors.presets[0], u = migrateUserBank(B(bank.in));
  ok(u.records.length === 16 && u.records.some((x) => x.status === "converted") && bankLegacyRecords(B(bank.in)) > 0 && bankLegacyRecords(u.bytes) <= u.records.filter((x) => x.status === "refused" || x.status === "kept").length,
    "user bank: legacy records converted, the rest kept / refused and counted");
  let e = null; try { migrateObject(0, new Uint8Array(572)); } catch (x) { e = x; }
  ok(e instanceof MigrationError && e.code === "notPorted" && ruleFor(7) === null && ruleFor(8) === null && ruleFor(32) === null,
    "settings, FM6 banks: no conversion ported, reported as such");
  ok(RULES.some((x) => !x.ported) && RULES.filter((x) => x.ported).length >= 5 && STORE_TYPES[9] === "AUTOSAVE", "rules: what is ported and what is not");
  ok(targetMismatch({ pcount: 111 }) === "" && /104/.test(targetMismatch({ pcount: 104 })), "target: only firmware of the same schema gets MIGRATE");
}

/* Current raw-reader contract, including empty tombstones and changed repeated metadata. */
const rawWire = (objects) => [1, 0, objects.length, ...objects.flatMap((o) => [o.type, STATES.indexOf(o.state), o.copy ?? 127,
  ...bkU32(o.size), ...bkU32(o.crc), ...bkU32(o.seq), ...bkU32(o.magic)])];
const rawSample = { type: 1, state: "current", copy: 0, size: 4, crc: bkCrc(Uint8Array.of(1, 2, 3, 4)), seq: 1, magic: 0x04030201 };
const invalidManifests = [[1, 0, 0], rawWire([rawSample, rawSample]), ...[
  { state: "empty", size: 0, crc: 1, magic: 0 }, { state: "empty", size: 0, crc: 0, magic: 1 },
  { state: "empty", copy: null, size: 0, crc: 0, magic: 0 }, { state: "current", size: 0 }, { copy: null },
].map((change) => rawWire([{ ...rawSample, ...change }]))];
for (const w of invalidManifests) assert.throws(() => rawManifest(w));
for (const copy of [null, 0, 1]) {
  const empty = { ...rawSample, state: "empty", size: 0, crc: 0, magic: 0, copy, seq: copy === null ? 0 : 7 };
  assert.deepEqual(rawManifest(rawWire([empty])), [empty]);
}
for (const capture of [(rq) => captureRawObject(rq, 1), (rq) => captureRawStore(rq, "test")]) {
  let lists = 0;
  await assert.rejects(() => capture(async ([cmd]) => cmd === RAW_CMD.LIST
    ? rawWire([{ ...rawSample, magic: rawSample.magic + (lists++ ? 1 : 0) }])
    : [1, 0, ...bkU32(0), 4, 0, ...bkPack(Uint8Array.of(1, 2, 3, 4))]), /changed/);
}
const rawFile = { format: "felucca-store", version: 1, objects: [{ ...rawSample, data: "AQIDBA==" }] };
assert.equal(readRawStore(rawFile).objects.length, 1);
for (const file of [{ ...rawFile, objects: [] }, { ...rawFile, objects: [...rawFile.objects, ...rawFile.objects] },
  ...[{ crc: -1 }, { seq: 0x100000000 }, { magic: null }, { copy: 3 }, { type: -1 }, { data: "AQID!A==" }]
    .map((bad) => ({ ...rawFile, objects: [{ ...rawFile.objects[0], ...bad }] }))]) assert.throws(() => readRawStore(file));
for (const fmt of [7, 8, 9, 10]) {
  const p = vectors.projects.find((p) => projectFormat(B(p.in)).fmt === fmt && p.out);
  assert(p);
  for (const np of [0, 7, 112, 127]) {
    const b = B(p.in); b[66] = np;
    new DataView(b.buffer).setUint32(b.length - 4, fnv1a(b, b.length - 4), true);
    assert.equal(projectFormat(b).state, "unknown", `FUN${fmt} count ${np}`);
  }
}
ok(true, "raw schema: duplicate/empty metadata, count limits, repeated magic and malformed files refused");

/* ---------------------------------------------------------- INFO 59 01 --- */
{
  const str = (s) => [...s].map((c) => c.charCodeAt(0)).concat(0);
  const names = ["ANALOG", "-", "PHASE", "LOFI", "SAMPLE", "VOICE", "TRIO", "WHEEL", "GRAIN", "PHYS", "DRUM", "-", "FM6", "SLICE"];
  const bitmap = Array.from({ length: 10 }, (_, i) => Array.from({ length: 7 }, (_, k) => 7 * i + k).reduce((b, e, k) => b | (e < names.length && names[e] !== "-" ? 1 << k : 0), 0));
  const wire = [...str("FELUCCA v1.6"), names.length, 111, 27, 64, 103, ...names.flatMap(str), 4, 16, 0x49, 1, 64, 127, ...bitmap, 0x58, 1, 0];
  const html = readFileSync(join(HERE, "editor.html"), "utf8");
  const old = vm.runInNewContext(html.slice(html.indexOf("/*PROTO-BEGIN*/"), html.indexOf("/*PROTO-END*/")) + ";({CMD,parse})",
    { setTimeout, clearTimeout, setInterval, clearInterval, console });
  const P = (E, w) => E.parse[E.CMD.INFO](w);
  ok(P(proto, [...wire, 0x59, 1, 1]).rawStoreCaps === 1 && P(proto, [...wire, 0x59, 1, 0]).rawStoreCaps === 0 && P(proto, wire).rawStoreCaps === 0,
    "INFO 59 01: bit 0 read; absent or clear: no raw store export");
  ok(P(proto, [...wire, 0x59, 1, 0x7f]).rawStoreCaps === 1, "INFO 59 01: unknown bits ignored");
  let threw = false; try { P(old, [...wire, 0x59, 1, 1]); } catch { threw = true; }
  ok(!threw, "the old editor (editor.html) accepts INFO 59 01 and ignores it");
  const pkg = readFileSync(join(HERE, "index_pkg.html"), "utf8");
  ok(/0x59: 1/.test(pkg), "the package installer knows the 59 tag's length");
  ok(RAW_CMD.LIST === proto.CMD.STORE_LIST && RAW_CMD.GET === proto.CMD.STORE_GET, "STORE_LIST 82, STORE_GET 83 in both modules");
}

/* the mock's output with a record of every command sent (cmd byte of each frame) */
function recorder(m) {
  const out = m.access.outputs.values().next().value, send = out.send.bind(out), sent = [];
  out.send = (x) => { sent.push(x[4]); return send(x); };
  return sent;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------- gating, no capability --- */
for (const [label, opt] of [["1.6 without INFO 59", { auto: false, catalog: true }], ["older firmware", { auto: false }]]) {
  const m = proto.makeMockDevice(opt), d = new Device(m.access);
  await d.open();
  const sent = recorder(m);
  const res = [await d.storeList(), await d.storeObject(1), await d.storeAll()];
  await sleep(50);
  ok(d.rawCaps() === 0 && res.every((x) => x === undefined) && !sent.includes(82) && !sent.includes(83) && recoveryCard(d, {}, recoveryState(), null, false, () => {}) === null,
    `gating (${label}): no STORE request, no STORED card`);
  d.close();
}

/* ------------------------------------------------- export against the mock --- */
{
  const m = proto.makeMockDevice({ auto: false, catalog: true, rawStore: true }), d = new Device(m.access);
  await d.open();
  const snap = () => JSON.stringify({ ...m.state, lastReq: 0 });   /* (lastReq: when it was last asked) */
  const before = snap();
  const sent = recorder(m);
  const list = await d.storeList();
  ok(d.rawCaps() === 1 && list.length === 11 && list.map((o) => o.state).join() === "current,legacy,damaged,empty,empty,current,empty,legacy,empty,unknown,empty",
    "STORE_LIST: every object with its state (demo: legacy, damaged, unknown, empty)");
  ok(list.every((o) => o.state === "empty" ? o.size === 0 && o.copy === null : o.size > 0), "STORE_LIST: empty objects have no size and no copy");
  const p = await d.storeObject(1);
  ok(p.bytes.length === 688 && bkCrc(p.bytes) === p.crc && projectFormat(p.bytes).fmt === 1, "STORE_GET: project A as stored (a FUN1, its CRC)");
  const dmg = await d.storeObject(2);
  ok(dmg.bytes.length === 3388 && dmg.state === "damaged", "STORE_GET: a damaged object is read as it is");
  const all = await d.storeAll();
  const file = readRawStore(JSON.stringify(all));
  ok(all.format === "felucca-store" && file.objects.length === 11 && same(file.objects[1].bytes, p.bytes), "the whole store to a file and back");
  /* migrate what can be migrated, in the browser */
  const mig = list.filter(canMigrate).map((o) => o.type);
  ok(mig.join() === "1,5", "MIGRATE offered for the legacy project and the user bank only");
  const r = { kind: "project", ...migrateProject(p.bytes) };
  ok(r.bytes.length === 3840 && projectFormat(r.bytes).state === "current", "the device's FUN1 migrates to FUN10");
  const man = migratedManifest(p, r, d.info, migratedName(p, "FUNA"));
  ok(man.uploaded === false && man.source.crc === p.crc && man.crc === bkCrc(r.bytes) && /^Felucca-migrated-1-project-a-FUNA-/.test(man.file),
    "the migrated file's manifest: its source, never uploaded");
  const om = rawObjectManifest(p, d.info, originalName(p), "PROJECT A");
  ok(om.crcOfFile === p.crc && om.magicText === "1NUF" && /^Felucca-store-1-project-a-legacy-/.test(om.file), "the original's manifest");
  await sleep(50);
  ok(sent.length > 0 && sent.every((c) => c === 82 || c === 83), "read only: the export sends STORE_LIST / STORE_GET and nothing else");
  ok(snap() === before, "read only: the device's state is unchanged");
  d.close();
}
/* the device's own vectors through the wire: each vector's input stored, read back, converted as the firmware does */
{
  const pick = vectors.projects.filter((p) => p.out).slice(0, 4);
  const objs = pick.map((p, i) => ({ type: 1 + i, state: 2, copy: 0, seq: i, bytes: B(p.in) }));
  objs.push({ type: 5, state: 1, copy: 0, seq: 9, bytes: B(vectors.presets[0].in) });
  const m = proto.makeMockDevice({ auto: false, catalog: true, rawStore: objs }), d = new Device(m.access);
  await d.open();
  let good = true;
  for (const [i, p] of pick.entries()) { const o = await d.storeObject(1 + i); good &&= same(migrateObject(o.type, o.bytes).bytes, B(p.out)); }
  const bank = await d.storeObject(5);
  good &&= same(migrateObject(5, bank.bytes).bytes, B(vectors.presets[0].out));
  ok(good, "vectors through STORE_GET: the same bytes as the firmware's conversion");
  ok(objs.every((o, i) => same(o.bytes, i < pick.length ? B(pick[i].in) : B(vectors.presets[0].in))), "read only: the stored bytes are unchanged");
  d.close();
}
/* a slot that changes between two listings: the cached bytes of the first are never used for the second */
{
  const v = vectors.projects.filter((p) => p.out);
  const objs = [{ type: 1, state: 2, copy: 0, seq: 3, bytes: B(v[0].in) }];
  const m = proto.makeMockDevice({ auto: false, catalog: true, rawStore: objs }), d = new Device(m.access);
  await d.open();
  const sent = recorder(m), st = recoveryState(); st.dev = d;
  const gets = () => sent.filter((c) => c === 83).length;
  relist(st, await d.storeList());
  const a = await objectBytes(d, st, st.list[0]);
  const g1 = gets();
  await objectBytes(d, st, st.list[0]);
  ok(same(a.bytes, B(v[0].in)) && g1 > 0 && gets() === g1, "recovery: an unchanged listing reuses the bytes read (no new STORE_GET)");
  st.results.set(objectKey(st.list[0]), { r: 1 });
  objs[0] = { type: 1, state: 2, copy: 1, seq: 4, bytes: B(v[1].in) };
  relist(st, await d.storeList());
  ok(st.bytes.size === 0 && st.results.size === 0, "recovery: re-listing a changed slot drops its cached bytes and result");
  const b = await objectBytes(d, st, st.list[0]);
  ok(gets() > g1 && same(b.bytes, B(v[1].in)) && same(migrateObject(1, b.bytes).bytes, B(v[1].out)), "recovery: the changed slot is fetched anew; Original / Migrate use the new bytes");
  /* the slot changes after the listing: the stale entry is refused, not used */
  objs[0] = { type: 1, state: 2, copy: 1, seq: 5, bytes: B(v[2].in) };
  st.bytes.clear();
  let err = null; try { await objectBytes(d, st, st.list[0]); } catch (e) { err = e; }
  ok(/List again/.test(err && err.message) , "recovery: bytes whose CRC is not the listed one are refused");
  d.close();
}
/* Reopening same-day filenames with different content keeps each displayed result tied to its source. */
{
  const a = { ...rawSample, file: "Felucca-store.json" }, b = { ...a, crc: a.crc + 1, seq: a.seq + 1 };
  assert.notEqual(objectKey(a), objectKey(b));
  assert.notEqual(objectKey(a), objectKey({ ...a, firmware: "different source build" }), "same bytes from different firmware retain their own provenance");
  const st = recoveryState(); st.files.push(a, b);
  st.results.set(objectKey(a), { o: a }); st.results.set(objectKey(b), { o: b });
  assert.equal(st.results.get(objectKey(st.files[0])).o, a);
  assert.equal(st.results.get(objectKey(st.files[1])).o, b);
  const dev = { storeObject: async () => ({ ...rawSample, seq: rawSample.seq + 1 }) };
  await assert.rejects(() => objectBytes(dev, recoveryState(), rawSample), /List again/);
  ok(true, "recovery: same-name imports keep distinct results; same-CRC changed metadata needs a fresh list");
}
/* an imported file's manifests name the file's firmware, not the connected device's */
{
  const v = vectors.projects.find((p) => p.out), bytes = B(v.in);
  const o = { type: 1, state: "legacy", copy: 0, seq: 1, size: bytes.length, crc: bkCrc(bytes), bytes, file: "x.bin", firmware: "FELUCCA v1.4" };
  const r = { kind: "project", ...migrateProject(bytes) }, dev = { version: "FELUCCA v1.6", pcount: 111 };
  const mk = (info) => migratedManifest(o, r, info, "m.bin").source.firmware;
  ok(mk(null) === "FELUCCA v1.4" && mk(dev) === "FELUCCA v1.6", "migrated manifest: a file's own firmware unless a device's info is passed");
  const html = readFileSync(join(HERE, "app/src/recovery.js"), "utf8");
  ok(/srcInfo\(o\), name\)/.test(html) && /rawObjectManifest\(got, srcInfo\(got\)/.test(html) && /o\.file \? \(o\.firmware/.test(html), "recovery: manifests of imported files take the file's firmware");
}
/* refusals: playing (rc 3), a bad request */
{
  const m = proto.makeMockDevice({ auto: false, catalog: true, rawStore: true, rawPlaying: true }), d = new Device(m.access);
  await d.open();
  let e = null; d.on("error", (x) => { e = x; });
  const l = await d.storeList();
  ok(l === undefined && e && /Stop playback/.test(e.message), "STORE_LIST while playing: refused (rc 3), the page says stop first");
  d.close();
  assert.throws(() => rawManifest([2, 0, 0]), /protocol/);
  assert.throws(() => rawManifest([1, 0, 1]), /Incomplete/);
  assert.throws(() => readRawStore({ ...rawFile, objects: [{ ...rawFile.objects[0], crc: 0 }] }), /checksum/);
  ok(true, "a malformed manifest or file is refused");
}
/* the page's code: STORED only reads (no write the Device has is called from recovery.js or legacy.js) */
{
  const rec = readFileSync(join(HERE, "app/src/recovery.js"), "utf8"), lib = readFileSync(join(HERE, "app/src/legacy.js"), "utf8");
  const calls = new Set([...rec.matchAll(/\bdev\.(\w+)/g)].map((x) => x[1]));
  ok([...calls].every((c) => ["rawCaps", "storeList", "storeObject", "storeAll", "info"].includes(c)), `read only: recovery.js calls only ${[...calls].join(", ")}`);
  const code = lib.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  ok(!/\b(rq|request|send|putObject|restoreBackup|BACKUP_PUT|UP_PUT|fetch)\b/.test(code) && !/from "\.\/device\.js"|fm1backup/.test(code), "read only: legacy.js has no device access");
}

/* ------------------------------------------- the firmware (FELUCCA_ROOT) --- */
const fw = process.env.FELUCCA_ROOT;
if (fw) {
  const temp = mkdtempSync(join(tmpdir(), "felucca-legacy-"));
  try {
    const exe = join(temp, "gen_legacy");
    execFileSync(process.env.CC || "cc", ["-O1", "-w", "-I" + join(fw, "build/gen"), "-I" + join(fw, "firmware/src"), "-I" + join(fw, "tests"),
      "-o", exe, join(HERE, "gen_legacy.c"), "-lm"], { stdio: "pipe" });
    const tables = readFileSync(join(HERE, "app/src/legacy_tables.js"), "utf8");
    const rev = /REVISION: "([^"]*)"/.exec(tables)[1];
    const big = { encoding: "utf8", maxBuffer: 1 << 28 };
    ok(execFileSync(exe, ["tables", rev], big) === tables, `firmware: the tables are the checkout's (${rev})`);
    ok(execFileSync(exe, ["vectors"], big) === readFileSync(join(HERE, "legacy_vectors.json"), "utf8"), "firmware: the vectors are the checkout's");
    // Consume the current firmware's actual standard INFO catalog (this host harness has flash disabled).
    const infoSource = join(temp, "info.c"), infoExe = join(temp, "info");
    const host = readFileSync(join(fw, "tests/engid_test.c"), "utf8").replace("int main(void)", "int engid_regression_main(void)");
    writeFileSync(infoSource, host + `
int main(void) { uint8_t a[1]={0}; reset(); uint32_t n=request(ED_INFO,a,0); putchar('[');
for(uint32_t k=5;k<n-1;k++) printf("%s%u",k==5?"":",",host_wire[k]); puts("]"); return 0; }
`);
    execFileSync(process.env.CC || "cc", ["-O1", "-w", "-I" + join(fw, "build/gen"), "-I" + join(fw, "firmware/src"), "-I" + join(fw, "tests"), "-o", infoExe, infoSource, "-lm"], { stdio: "pipe" });
    const currentInfo = proto.parse[proto.CMD.INFO](JSON.parse(execFileSync(infoExe, big)));
    assert.equal(currentInfo.nengines, T.NENGINES);
    assert.equal(targetMismatch(currentInfo), "", "current standard native catalog matches migration target");
    assert.equal(currentInfo.rawStoreCaps, 0, "native INFO host harness has flash disabled");
    assert.notEqual(targetMismatch({ ...currentInfo, pcount: currentInfo.pcount + 1 }), "");
    const omitted = structuredClone(currentInfo); omitted.engineCatalog.bitmap[0] &= ~1;
    assert.notEqual(targetMismatch(omitted), "", "different profiles remain refused");
    const reference = await import(pathToFileURL(join(fw, "web/fm1backup.js")));
    for (const w of invalidManifests) assert.throws(() => reference.rawManifest(w));
    for (const fmt of [7, 8, 9, 10]) {
      const p = vectors.projects.find((p) => projectFormat(B(p.in)).fmt === fmt && p.out);
      for (const np of [0, 7, 112, 127]) {
        const b = B(p.in); b[66] = np;
        new DataView(b.buffer).setUint32(b.length - 4, fnv1a(b, b.length - 4), true);
        assert.equal(projectFormat(b).state, STATES[Number(execFileSync(exe, ["classify"], { input: b, encoding: "utf8" }).trim())]);
      }
    }
    ok(true, `firmware: current INFO catalog (${currentInfo.nengines} slots), raw reference and malformed schema counts agree`);
    const [seed, count] = (process.env.FELUCCA_CORPUS || "1:240").split(":").map(Number);
    const corpus = join(temp, "corpus.json");
    writeFileSync(corpus, execFileSync(exe, ["corpus", String(seed), String(count)], big));
    checkVectors(JSON.parse(readFileSync(corpus, "utf8")), `firmware: corpus seed ${seed}`);
  } finally { rmSync(temp, { recursive: true, force: true }); }
} else console.log("native firmware: skipped (set FELUCCA_ROOT to a built firmware checkout)");

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
