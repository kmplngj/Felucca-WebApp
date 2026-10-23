// SPDX-License-Identifier: GPL-3.0-only
// Versioned engine catalogs, stable library ids, and opaque settings/extended backup compatibility.
// FELUCCA_ROOT points to the firmware checkout: compile its actual engine-id harness to produce wire/settings bytes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import * as app from "./app/src/proto.js";
import { Device } from "./app/src/device.js";
import { validateMidiInfo, validateMidiDesc } from "./app/src/discovery.js";
import { Library, memoryStore } from "./app/src/library.js";
import { BACKUP_IDS, BACKUP_CMD, bkU32, bkR32, bkPack, bkUnpack, bkCrc, captureBackup, restoreBackup, readBackup, settingsFormat } from "./fm1backup.js";

const html = readFileSync(new URL("./editor.html", import.meta.url), "utf8");
const legacy = vm.runInNewContext(html.slice(html.indexOf("/*PROTO-BEGIN*/"), html.indexOf("/*PROTO-END*/")) +
  ";({CMD,F,parse,req,engineAvailable,userEngine,catalogLabel,readDevicePreferences,devicePresetRows,readLibraryFile,libraryFile,capturePatch,bank})", { setTimeout, clearTimeout, setInterval, clearInterval, console });
const eq = (a, b) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
const str = (s) => [...s].map((c) => c.charCodeAt(0)).concat(0);
const names = ["ANALOG", "-", "PHASE", "LOFI", "SAMPLE", "VOICE", "TRIO", "WHEEL", "GRAIN", "PHYS", "DRUM", "-", "FM6", "SLICE", "TEST14"];
const bitmap = Array.from({ length: 10 }, (_, i) => Array.from({ length: 7 }, (_, k) => 7 * i + k).reduce((b, e, k) => b | (e < names.length && names[e] !== "-" ? 1 << k : 0), 0));
const prefix = [...str("FELUCCA v1.6"), names.length, 111, 27, 64, 103, ...names.flatMap(str), 4, 16];
const tag = [0x49, 1, 64, 127, ...bitmap];
const wire = [...prefix, ...tag, 0x58, 1, 7];
const info = app.parse[app.CMD.INFO](wire);
for (const E of [app, legacy]) {
  const i = E.parse[E.CMD.INFO](wire);
  assert.equal(i.userEngine, 127); assert.equal(i.backupExtraCaps, 7);
  assert.equal(E.engineAvailable(i, 14), true); assert.equal(E.engineAvailable(i, 11), false);
  assert.equal(E.engineAvailable(i, 40), false); assert.equal(E.catalogLabel(i, 40), "N/A (40)");
  assert.equal(E.userEngine(E.parse[E.CMD.INFO](prefix)), 15);
  const clear = wire.slice(); clear[prefix.length + 4] &= ~1;
  assert.equal(E.engineAvailable(E.parse[E.CMD.INFO](clear), 0), false, "clear bitmap overrides a nonempty name");
  for (let n = 1; n < tag.length; n++) assert.throws(() => E.parse[E.CMD.INFO]([...prefix, ...tag.slice(0, n)]), /catalog/);
  for (const [idx, v] of [[1, 2], [2, 63], [3, 15], [13, 127], [4, 128]]) {
    const bad = tag.slice(); bad[idx] = v;
    assert.throws(() => E.parse[E.CMD.INFO]([...prefix, ...bad]), /catalog/);
  }
  assert.throws(() => E.parse[E.CMD.INFO]([...wire, ...tag]), /catalog/);
  assert.throws(() => E.parse[E.CMD.INFO]([...prefix, ...tag, 0x58, 1]), /capability/);
  const unnamed = { ...i, engines: i.engines.map((n, e) => e === 14 ? "-" : n) };
  assert.equal(E.engineAvailable(unnamed, 14), false);
  // Favorite requests use stable user marker127; omitted factory rows are never probed.
  const queried = [], presetNames = names.map((_, e) => E.engineAvailable(i, e) ? ["A", "B"] : []);
  const prefs = await E.readDevicePreferences(async ([cmd, a]) => {
    if (cmd === E.CMD.UI_STATE) return [9,0,127,127,0,0,0,0,0,0,0,0,0];
    if (cmd === E.CMD.UI_PALETTES) return [1, ...str("GREY")];
    if (cmd === E.CMD.UP_LIST) return [0,2,2,1,11,...str("LOST"),1,14,...str("MINE")];
    if (cmd === E.CMD.FAV_GET) { queried.push(a[0]); return [0,...a, ...Array.from({length:a[3]}, () => 1)]; }
    throw Error("unexpected preference request");
  }, { ...i, uiCaps: 9 }, presetNames);
  assert.ok(queried.includes(127) && queried.includes(14) && !queried.includes(11));
  const rows = E.devicePresetRows(i, presetNames, prefs);
  assert.equal(rows.find((r) => r.user && r.preset === 0).unavailable, true);
  assert.equal(rows.find((r) => r.user).engine, 127);
  assert.ok(rows.some((r) => !r.user && r.engine === 14 && r.favorite));
  // Old settings/layouts still migrate explicitly retired sounds on a catalog destination.
  const p = new Array(111).fill(0), ctx = { engineIds: 64, engines: names, pe0: 103 };
  const moved = E.readLibraryFile({ format: "felucca-patch", engine: 1, engineName: "PHASE", p }, ctx).patches[0];
  assert.equal(moved.engine, 2, "historical patch maps by source name on catalog destination");
  const movedFile = E.readLibraryFile({ format: "felucca-library", version: 1, engines: ["ANALOG", "PHASE"], patches: [{ engine: 1, params: p }] }, ctx);
  assert.equal(movedFile.patches[0].engine, 2, "historical library uses its own engine-name table");
  const mixed = E.libraryFile("library", [
    { name: "old phase", engine: 1, engineName: "PHASE", p },
    { name: "stable future", engine: 40, engineName: "FUTURE", engineIds: 64, p },
  ], { engines: ["ANALOG", "PHASE"] });
  assert.equal(mixed.engineIds, undefined, "one stable patch cannot promote historical entries");
  assert.equal(mixed.patches[1].engineIds, 64);
  const mixedRead = E.readLibraryFile(mixed, ctx);
  eq(mixedRead.patches.map((p) => p.engine), [2, 40]);
  const oldDigital = E.readLibraryFile({ format: "felucca-patch", engine: 1, engineName: "DIGITAL", p }, ctx).patches[0];
  assert.equal(oldDigital.engine, 12); assert.equal(oldDigital.fm4.length, 111);
  const oldPerc = E.readLibraryFile({ format: "felucca-patch", engine: 4, engineName: "SAMPLE", p: p.map((v, k) => k === 103 ? 4 : v) }, ctx).patches[0];
  assert.equal(oldPerc.engine, 10);
  // A newer file is stable even if labels collide, engines are missing, or the device has an older prefix.
  const pt = { name: "future", engineIds: 64, engine: 40, engineName: "-", p: p.map((_, k) => k < 103 ? 0 : -64 + k - 103), fm6: app.FM6.INIT_PK };
  const file = E.libraryFile("library", [pt, { ...pt, engine: 11 }, { ...pt, engine: 12 }], ctx);
  const out = E.readLibraryFile(file, { engines: ["ANALOG", "-", "-"] });
  eq(out.patches.map((p) => p.engine), [40, 11, 12]); eq(out.patches[0].p, pt.p); eq(out.patches[2].fm6, pt.fm6);
  assert.equal(out.skipped, 0);
  const again = E.readLibraryFile(E.libraryFile("library", out.patches, ctx), ctx);
  eq(again.patches.map((p) => p.engine), [40, 11, 12]);
  const boundary = E.readLibraryFile({ ...file, patches:[{ ...file.patches[0], engine:63 }] }, ctx);
  assert.equal(boundary.patches[0].engine,63);
  const bad = structuredClone(file); bad.patches[0].engine = 64; bad.patches[1].engine = -1; bad.patches[2].engine = "12";
  assert.equal(E.readLibraryFile(bad, ctx).patches.length, 0);
  console.log(`${E === app ? "app" : "legacy"}: catalog, fail-closed malformed INFO, legacy migrations, stable ids ok`);
}

// Opaque transport used for both ordinary and extended manifests.
function device(objects, caps = 0) {
  const d = { objects: new Map(objects), log: [], staged: null };
  d.request = async ([cmd, a]) => {
    if (cmd === BACKUP_CMD.LIST) {
      d.log.push(["list", ...a]); const ids = a[0] === 1 ? [...BACKUP_IDS, ...(caps & 2 ? [20] : []), ...(caps & 4 ? [21] : [])] : BACKUP_IDS;
      return [1, 0, ids.length, ...ids.flatMap((id) => { const b = d.objects.get(id) || new Uint8Array(0); return [id, ...bkU32(b.length), ...bkU32(b.length ? bkCrc(b) : 0)]; })];
    }
    if (cmd === BACKUP_CMD.GET) { const id = a[0], off = bkR32(a, 1), n = a[6] | a[7] << 7; return [id, 0, ...bkU32(off), n & 127, n >> 7, ...bkPack(d.objects.get(id).subarray(off, off + n))]; }
    if (cmd === BACKUP_CMD.PUT) {
      const [op, id] = a; d.log.push([op, id]);
      if (op === 0 && ((id === 20 && !(caps & 2)) || (id === 21 && !(caps & 4)))) return [op, id, 1];
      if (op === 0) d.staged = { id, bytes: new Uint8Array(bkR32(a, 2)) };
      if (op === 1) { const off = bkR32(a, 2), n = Math.min(256, d.staged.bytes.length - off); d.staged.bytes.set(bkUnpack(a.slice(7), n), off); }
      if (op === 2) { d.objects.set(id, d.staged.bytes); d.staged = null; }
      return [op, id, 0];
    }
    if (cmd === 14) { d.log.push(["sample", a[0]]); return [a[0], 0]; }
    throw Error(`unexpected ${cmd}`);
  };
  return d;
}
function settings(per6) { const b = new Uint8Array(per6 ? 2688 : 572); new DataView(b.buffer).setUint32(0, per6 ? 0x50455236 : 0x50455234, true); return b; }
async function roundtrip(settingsBytes, catalogInfo) {
  const objects = [[0, new Uint8Array(3388)], [1, settingsBytes], [20, Uint8Array.from({ length: 3616 }, (_, k) => k & 255)], [21, new Uint8Array(472).fill(201)]];
  const src = device(objects, 7), archive = await captureBackup(src.request, "v1.6", () => {}, { info: { ...catalogInfo, backupExtraCaps: 7 } });
  eq(src.log[0], ["list", 1]); assert.equal(archive.objects.length, 15);
  const parsed = readBackup(JSON.stringify(archive)); eq(parsed.objects.find((o) => o.id === 1).bytes, settingsBytes);
  const dst = device([], 7); await restoreBackup(dst.request, archive, () => {}, { info: catalogInfo });
  for (const [id, bytes] of objects) eq(dst.objects.get(id), bytes);
  assert.ok(dst.log.findIndex((x) => x[0] === 0 && x[1] === 21) > dst.log.findIndex((x) => x[0] === "sample" && x[1] === 2));
  eq(dst.log.at(-1), [2, 0]);
  if (settingsFormat(archive) === "PER6") {
    const old = device([]); await assert.rejects(restoreBackup(old.request, archive, () => {}, { info: { version: "1.6" } }), /PER6/);
    assert.equal(old.log.length, 0, "incompatible PER6 never partially restores preceding objects");
  } else {
    const old = device([]); await restoreBackup(old.request, archive, () => {}, { info: {} });
    assert.ok(old.log.some((x) => x[0] === 0 && x[1] === 21), "old firmware skips refused extended objects");
  }
  return parsed;
}
// Each extension is optional independently, including the previously rejected SLICE-only inventory.
for (const caps of [1, 3, 5, 7]) {
  const ids = [...BACKUP_IDS, ...(caps & 2 ? [20] : []), ...(caps & 4 ? [21] : [])];
  const objects = ids.map((id) => [id, id === 0 ? new Uint8Array(3388) : id === 1 ? settings(false) : new Uint8Array(0)]);
  const src = device(objects, caps);
  const archive = await captureBackup(src.request, "v1.6", () => {}, { info: { ...info, backupExtraCaps: caps } });
  eq(readBackup(JSON.stringify(archive)).objects.map((o) => o.id), ids);
  const dst = device([], caps); await restoreBackup(dst.request, archive, () => {}, { info: { ...info, backupExtraCaps: caps } });
  for (const [id, bytes] of objects) if (bytes.length) eq(dst.objects.get(id), bytes);
  const bad = structuredClone(archive); bad.objects[2].id = 99;
  assert.throws(() => readBackup(bad), /complete Felucca backup/);
}
const per4Archive = await roundtrip(settings(false), info), per6Archive = await roundtrip(settings(true), info);
assert.equal(settingsFormat(per4Archive), "PER4"); assert.equal(settingsFormat(per6Archive), "PER6");
await assert.rejects(captureBackup(device([[0,new Uint8Array(3388)],[1,settings(false)]]).request,"v1.6",()=>{}, {info:{...info,backupExtraCaps:7}}), /Incomplete extended/);
console.log("backup: PER4/PER6/extended opaque round trips, restore order, preflight before writes ok");

// Device/library methods without a browser or MIDI timing; real request guard behavior is observable.
{
  const d = new Device(null); d.info = info; d.dump = { engine: 40, preset: 201, p: new Array(111).fill(-63), g: [] }; d.gdesc = []; d.pdesc = [];
  let requests = 0; d.rq = async () => { requests++; throw Error("unexpected request"); };
  assert.equal(await d.loadPreset(11, 0), false); assert.equal(await d.initSound(), false);
  await d.setParam(0, 103, 99); assert.equal(d.dump.p[103], -63); assert.equal(requests, 0);
  assert.equal(d.engineOk({ engine: 11 }), false); assert.equal(d.engineOk({ engine: -1 }), false);
  // Persisted legacy data must resolve names before being stamped with the destination's stable-ID marker.
  const oldStore = memoryStore(), oldLib = new Library(oldStore); await oldLib.init();
  d.keys = Array.from({ length: 111 }, (_, k) => `P${k}`);
  oldLib.meta = { engines: ["ANALOG", "PHASE"], keys: d.keys };
  await oldLib.add([{ name: "legacy phase", engine: 1, engineName: "PHASE", p: new Array(111).fill(0) }]);
  await oldLib.adopt(d); assert.equal(oldLib.patches[0].engine, 2); assert.equal(oldLib.patches[0].engineIds, 64);
  assert.equal((await oldStore.all())[0].engine, 2);
  const classicState = { lib: [{ id: "old", engine: 1, engineName: "PHASE", p: new Array(111).fill(0) }],
    libMeta: { engines: ["ANALOG", "PHASE"], keys: d.keys }, sameKeys: app.sameKeys, remapParams: app.remapParams,
    fromDigital: app.fromDigital, fromPerc: app.fromPerc, cleanPatch: app.cleanPatch,
    libWrite: async () => {}, store: { setMeta: async () => {} }, renderLib: () => {}, console };
  const adoptClassic = vm.runInNewContext(html.slice(html.indexOf("async function libAdopt(d)"), html.indexOf("const engineOk =")) + ";libAdopt", classicState);
  await adoptClassic(d); assert.equal(classicState.lib[0].engine, 2); assert.equal(classicState.lib[0].engineIds, 64);
  const missingPhase = { ...d, info: { ...info, engines: names.map((n) => n === "PHASE" ? "-" : n) } };
  const unresolved = new Library(memoryStore()); await unresolved.init();
  unresolved.meta = { engines: ["ANALOG", "PHASE"], keys: d.keys };
  await unresolved.add([{ name: "keep old", engine: 1, engineName: "PHASE", p: new Array(111).fill(0) }]);
  await assert.rejects(unresolved.adopt(missingPhase), /Cannot migrate unavailable historical engine PHASE/);
  assert.equal(unresolved.patches[0].engine, 1); assert.equal(unresolved.patches[0].engineIds, undefined);
  classicState.lib = [{ engine: 1, engineName: "PHASE", p: new Array(111).fill(0) }];
  classicState.libMeta = { engines: ["ANALOG", "PHASE"], keys: d.keys };
  await assert.rejects(adoptClassic(missingPhase), /Cannot migrate unavailable historical engine PHASE/);
  assert.equal(classicState.lib[0].engine, 1); assert.equal(classicState.lib[0].engineIds, undefined);
  for (const name of ["", "-"]) {
    unresolved.patches[0].engineName = name; unresolved.meta.engines = [];
    await assert.rejects(unresolved.adopt(d), /Cannot migrate unavailable historical engine/);
    assert.equal(unresolved.patches[0].engineIds, undefined);
    classicState.lib[0].engineName = name; classicState.libMeta.engines = [];
    await assert.rejects(adoptClassic(d), /Cannot migrate unavailable historical engine/);
    assert.equal(classicState.lib[0].engineIds, undefined);
  }
  d.info = { engines: ["ANALOG", "PHASE", "LOFI"] };
  const stablePhase = { engine: 2, engineName: "PHASE", engineIds: 64 };
  assert.equal(d.engineOk(stablePhase), false, "legacy compact engine names must match even for stable source patches");
  const classicEngineOk = vm.runInNewContext(html.slice(html.indexOf("const engineOk ="), html.indexOf("/* a full parameter set", html.indexOf("const engineOk ="))) + ";engineOk", { dev: d, engineAvailable: app.engineAvailable });
  assert.equal(classicEngineOk(stablePhase), false);
  assert.equal(d.engineOk({ ...stablePhase, engineName: "" }), false);
  assert.equal(classicEngineOk({ ...stablePhase, engineName: "" }), false);
  d.info = info;
  const reconnected = new Library(memoryStore()); await reconnected.init();
  reconnected.meta = { engines: ["ANALOG", "PHASE", "LOFI"], keys: d.keys, engineIds: 64 };
  await reconnected.add([{ name: "stable", engine: 2, engineName: "PHASE", engineIds: 64, p: new Array(111).fill(0) }]);
  const compact = { keys: d.keys, info: { engines: ["ANALOG", "PHASE", "LOFI"] } };
  await reconnected.importFiles([{ name: "old.json", text: JSON.stringify({ format: "felucca-patch", engine: 1, engineName: "PHASE", p: new Array(111).fill(0) }) }], compact);
  assert.equal(reconnected.patches[1].engine, 1); assert.equal(reconnected.patches[1].engineIds, undefined);
  assert.equal(reconnected.file("library", reconnected.patches).engineIds, undefined, "stale metadata cannot promote mixed source conventions");
  await reconnected.adopt(d);
  eq(reconnected.patches.map((p) => p.engine), [2, 2]);
  classicState.lib = [{ engine: 2, engineName: "PHASE", engineIds: 64, p: new Array(111).fill(0) }, { engine: 1, engineName: "PHASE", p: new Array(111).fill(0) }];
  classicState.libMeta = { engines: compact.info.engines, keys: d.keys, engineIds: 64 };
  await adoptClassic(d); eq(classicState.lib.map((p) => p.engine), [2, 2]);
  for (const [engineName, engine, expected] of [["DIGITAL", 1, 12], ["SAMPLE", 4, 10]]) {
    const old = { engineName, engine, p: new Array(111).fill(0) }; if (engineName === "SAMPLE") old.p[103] = 4;
    const migrations = new Library(memoryStore()); await migrations.init();
    migrations.meta = { keys: d.keys, engines: names, engineIds: 64 };
    await migrations.add([{ engine: 2, engineName: "PHASE", engineIds: 64, p: new Array(111).fill(0) }, old]);
    await migrations.adopt(d); assert.equal(migrations.patches[1].engine, expected, "mixed imported legacy conversion ignores stale metadata marker");
    classicState.lib = [{ engine: 2, engineName: "PHASE", engineIds: 64, p: new Array(111).fill(0) }, structuredClone(old)];
    classicState.libMeta = { keys: d.keys, engines: names, engineIds: 64 };
    await adoptClassic(d); assert.equal(classicState.lib[1].engine, expected);
  }
  // Both bulk exporters mark retained unavailable slots as stable, just like single-slot capture.
  const missing = { used: true, name: "retained", engine: 12, p: new Array(111).fill(0) };
  const bankDev = new Device(null); bankDev.info = { ...info, engines: names.map((n, e) => e === 12 ? "-" : n) };
  bankDev.bank = { total: 1, slots: [{ slot: 0, used: true }] }; bankDev.op = (fn) => fn(); bankDev.emit = () => {};
  const originalGet = app.bank.get; app.bank.get = async () => missing;
  let bulk;
  try { bulk = await bankDev.bankAll(); } finally { app.bank.get = originalGet; }
  assert.equal(bulk[0].engineIds, 64);
  const bulkFile = app.libraryFile("bank", bulk, { engines: bankDev.info.engines });
  assert.equal(app.readLibraryFile(bulkFile, { engines: names }).patches[0].engine, 12);
  let exportHandler, classicBulk;
  const startExport = html.indexOf('$("bkexport").addEventListener');
  vm.runInNewContext(html.slice(startExport, html.indexOf('\n}));', startExport) + 5), {
    $: () => ({ addEventListener: (_, fn) => { exportHandler = fn; } }),
    libOp: (fn) => fn(bankDev, () => {}), dev: bankDev, bank: { get: async () => missing },
    sayK: () => {}, slotName: () => "U01", reservedFm4: app.reservedFm4, today: () => "test",
    libraryFile: legacy.libraryFile, libCtx: () => ({ engines: bankDev.info.engines }), download: (_, file) => { classicBulk = file; },
  });
  await exportHandler(); assert.equal(classicBulk.engineIds, 64);
  assert.equal(legacy.readLibraryFile(classicBulk, { engines: names }).patches[0].engine, 12);
  const st = memoryStore(), lib = new Library(st); await lib.init(); lib.meta = { engines: names, keys: null, engineIds: 64 };
  const fm = { name: "absent", engine: 12, engineName: "-", engineIds: 64, p: new Array(111).fill(0), fm6: app.FM6.INIT_PK };
  await lib.add([fm, { ...fm, engine: 40 }]); d.keys = Array.from({ length: 111 }, (_, k) => `P${k}`);
  lib.meta.keys = d.keys;
  d.info = { ...info, engines: names.map((n, k) => k === 12 ? "-" : n) }; await lib.adopt(d);
  const exported = lib.file("library", lib.patches, d); const back = new Library(memoryStore()); await back.init();
  await back.importFiles([{ name: "library.json", text: JSON.stringify(exported) }], d);
  d.info = info; await back.adopt(d);
  assert.equal(d.engineOk(back.patches[0]), true, "restored playable id is authoritative despite stored '-' name");
  eq(back.patches[0].fm6, fm.fm6); assert.equal(back.patches[1].engine, 40);
  d.closed = false; const per6 = await roundtrip(settings(true), info); d.info = { motionCap: 128, pcount: 111 }; let emitted;
  d.emit = (kind, err) => { emitted = err; }; assert.equal(await d.backupRestore(per6), false); assert.match(emitted.message, /PER6/); assert.equal(requests, 0);
  console.log("device/library: unavailable writes blocked, numeric ids/FM6 survive sparse→full catalogs ok");
}

// Actual current firmware production bytes, not a handwritten model of its INFO/settings layout.
const installer = readFileSync(new URL("./index_pkg.html", import.meta.url), "utf8");
const installerInfo = vm.runInNewContext(installer.slice(installer.indexOf("function archiveInfo(a)"), installer.indexOf('$("stock-go").addEventListener')) + ";archiveInfo");
assert.equal(installerInfo([...prefix.slice(0,-1),16,0x55,1,9,0x4d,1,64,1,0x42,1,3,...tag,0x58,1,7]).backupExtraCaps,7);
const fw = process.env.FELUCCA_ROOT;
if (fw && existsSync(join(fw, "tests/engid_test.c"))) {
  const temp = mkdtempSync(join(tmpdir(), "felucca-catalog-"));
  const original = readFileSync(join(fw, "tests/engid_test.c"), "utf8").replace("int main(void)", "int engid_regression_main(void)");
  const extra = String.raw`
static void json_bytes(const uint8_t *p, uint32_t n) { putchar('['); for (uint32_t i=0;i<n;i++) printf("%s%u", i?",":"",p[i]); putchar(']'); }
static void json_reply(uint32_t cmd,const uint8_t*a,uint32_t n) { uint32_t z=request(cmd,a,n); json_bytes(host_wire+5,z-6); }
int main(void) {
 static persist_rec_t r, r4, r2; uint8_t a[4]; reset(); panel=PANEL_DEFAULT;
 printf("{\"testEngine\":%u,\"info\":", (unsigned)ENGI_TEST); json_reply(ED_INFO,a,0);
 a[0]=0;a[1]=0;printf(",\"baseDesc\":");json_reply(ED_DESC,a,2);
 a[0]=1;printf(",\"tempoDesc\":");json_reply(ED_DESC,a,2);
 printf(",\"per4\":"); settings_export_rec(&r); r4=r; json_bytes((const uint8_t*)&r,persist_len(&r));
 favorite_set(ENGI_TEST,1,1); settings_export_rec(&r); printf(",\"per6\":"); json_bytes((const uint8_t*)&r,persist_len(&r));
 memset(&favorites,0,sizeof favorites);uint32_t rc6=bk_put((const uint8_t*)&r,persist_len(&r));settings_export_rec(&r2);
 uint32_t same6=!rc6&&!memcmp(&r,&r2,persist_len(&r));
 uint32_t rc4=bk_put((const uint8_t*)&r4,persist_len(&r4));settings_export_rec(&r2);
 printf(",\"settingsRoundtrip\":%u",same6&&!rc4&&!memcmp(&r4,&r2,persist_len(&r4)));
 up_store(3,"MINE"); a[0]=ENG_USER_WIRE;a[1]=3;a[2]=64;a[3]=1;printf(",\"fav\":");json_reply(ED_FAV_GET,a,4);
 a[0]=ENGI_TEST;printf(",\"testNames\":");json_reply(ED_NAMES,a,1);
 trk[0].engine=40;trk[0].eng_req=40;trk[0].preset=101;
 for(uint32_t k=0;k<8;k++)trk[0].p[P_E0+k]=-64+(int32_t)k;
 printf(",\"missing\":");json_reply(ED_DUMP,a,0);
 trk[0].engine=10;trk[0].eng_req=10;trk[0].step[0].n=0;trk[0].step[0].time=0;trk[0].step[0].hit=1;trk[0].step[0].acc=1;
 printf(",\"drumDump\":");json_reply(ED_DUMP,a,0);a[0]=0;printf(",\"drumStep\":");json_reply(ED_STEP_GET,a,1);
 puts("}");return 0;
}`;
  const source = join(temp, "producer.c"); writeFileSync(source, original + extra);
  for (const omit of [-1, 10, 11, 12]) {
    const exe = join(temp, `producer${omit}`);
    execFileSync(process.env.CC || "cc", ["-O1", "-w", "-I" + join(fw, "tests"), "-I" + join(fw, "build/gen"), "-I" + join(fw, "firmware/src"), "-DFELUCCA_ENG_TEST14=1", `-DFELUCCA_ENG_OMIT=${omit}`, source, "-lm", "-o", exe], { stdio: "pipe" });
    const f = JSON.parse(execFileSync(exe, { encoding: "utf8" }));
    assert.equal(f.settingsRoundtrip,1,"actual firmware restores PER4/PER6 byte for byte");
    assert.ok(Number.isInteger(f.testEngine) && f.testEngine >= 14 && f.testEngine < 64, "test placeholder has a valid extended stable id");
    assert.equal(settingsFormat({ objects: [{ id: 1, bytes: Uint8Array.from(f.per4) }] }), "PER4");
    assert.equal(settingsFormat({ objects: [{ id: 1, bytes: Uint8Array.from(f.per6) }] }), "PER6", "placeholder favourite actually exercises PER6");
    for (const E of [app, legacy]) {
      const i = validateMidiInfo(f.info, E);
      assert.equal(validateMidiDesc(f.baseDesc,0,0,E).label,"LVL");
      assert.equal(validateMidiDesc(f.tempoDesc,1,0,E).label,"BPM");
      assert.equal(E.userEngine(i), 127); assert.equal(i.backupExtraCaps, 0);
      assert.equal(i.engines[f.testEngine], "TEST14");
      assert.equal(E.engineAvailable(i, f.testEngine), true); if (omit >= 0) assert.equal(E.engineAvailable(i, omit), false);
      const dump = E.parse[E.CMD.DUMP](f.missing, i); assert.equal(dump.engine, 40); assert.equal(dump.preset, 101); eq(dump.p.slice(i.pe0), [-64,-63,-62,-61,-60,-59,-58,-57]);
      assert.equal(E.parse[E.CMD.FAV_GET](f.fav).engine, 127); assert.equal(E.parse[E.CMD.NAMES](f.testNames).names.length, 2);
      assert.equal(installerInfo(f.info).backupExtraCaps, 0);
      const captured = (await E.capturePatch(async ([cmd]) => {
        if (cmd === E.CMD.DUMP) return f.drumDump;
        if (cmd === E.CMD.STEP_GET) return f.drumStep;
        throw Error("unexpected capture request");
      }, i, "DRUM KEPT")).patch;
      assert.equal(captured.engine, 10); eq(captured.grid[0], [1,1]);
      const kept = E.readLibraryFile(E.libraryFile("library",[captured],{engineIds:64,engines:i.engines}),{engineIds:64,engines:names}).patches[0];
      eq(kept.grid,captured.grid);
      await roundtrip(Uint8Array.from(f.per4), i); await roundtrip(Uint8Array.from(f.per6), i);
    }
    console.log(`native firmware: real INFO49+58, TEST14 id=${f.testEngine}, omit=${omit}, missing DUMP and PER4/PER6 (${f.per4.length}/${f.per6.length} bytes) native+JS round trips ok`);
  }
} else console.log("native firmware: skipped (set FELUCCA_ROOT to a built firmware checkout)");
console.log("catalog tests passed");
