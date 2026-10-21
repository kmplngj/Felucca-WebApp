// SPDX-License-Identifier: GPL-3.0-only
// Independent firmware-serialized records, not the mock's synthetic project headers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Device } from "./app/src/device.js";
import { CMD } from "./app/src/proto.js";
import { BACKUP_IDS, BACKUP_CMD, bkCrc, bkR32, bkUnpack, conditionalProjects, projectFile, readProject, readBackup } from "./fm1backup.js";

const fixtures = JSON.parse(readFileSync(new URL("./test_fixtures/import/projects.json", import.meta.url)));
const fnv = (b) => b.reduce((h, v) => Math.imul(h ^ v, 16777619) >>> 0, 2166136261);
const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const projects = new Map(fixtures.objects.map((o) => {
  const bytes = Uint8Array.from(Buffer.from(o.data, "base64"));
  assert.equal(bkCrc(bytes), o.crc, `${o.name}: independent Python CRC`);
  assert.equal(fnv(bytes.subarray(0, -4)), view(bytes).getUint32(bytes.length - 4, true), `${o.name}: firmware FNV`);
  return [o.name, readProject({ format: "felucca-project", version: 1, slot: 0, object: o })];
}));
const plain = projects.get("fun10"), cond = projects.get("fun10-condition");
assert.deepEqual([...plain.bytes.slice(0, 4)], [0x41, 0x4e, 0x55, 0x46]);
assert.equal(plain.bytes[66], 111);
const archiveOf = (p, id = 2) => ({ objects: [{ id, ...p }] });
const fileOf = (p, id = 2) => ({ format: "felucca-backup", version: 1, objects: BACKUP_IDS.map((k) => {
  const bytes = k === id || k === 0 ? p.bytes : k === 1 ? Uint8Array.of(1) : new Uint8Array();
  return { id: k, size: bytes.length, crc: bkCrc(bytes), data: Buffer.from(bytes).toString("base64") };
}) });
function client(info = {}) {
  const d = Object.create(Device.prototype);
  Object.assign(d, { info: { motionCap: 128, pcount: 111, cond: true, ...info }, slotUsed: [0, 0, 0, 0],
    requests: [], errors: [], written: new Map(), op: (fn) => fn(), load: async () => {},
    emit(kind, value) { if (kind === "error") this.errors.push(value.message); },
    async rq([cmd, a]) {
      this.requests.push([cmd, a]);
      if (cmd === CMD.PROJECT) return [a[0], a[1], 1];
      if (cmd === 14) return [a[0], 0];
      assert.equal(cmd, BACKUP_CMD.PUT);
      const [op, id] = a;
      if (op === 0) this.written.set(id, new Uint8Array(bkR32(a, 2)));
      if (op === 1) {
        const dest = this.written.get(id), off = bkR32(a, 2);
        dest.set(bkUnpack(a.slice(7), Math.min(256, dest.length - off)), off);
      }
      return [op, id, 0];
    } });
  return d;
}
// Each on-disk record goes through the real project and archive readers, preserving original bytes.
for (const p of projects.values()) {
  assert.deepEqual(readProject(projectFile("fixture", 0, p)).bytes, p.bytes);
  assert.deepEqual(readBackup(fileOf(p)).objects[2].bytes, p.bytes);
}
for (const pcount of [104, 110, 111, 112]) {
  const d = client({ pcount });
  assert.equal(d.backupTooNew(archiveOf(plain)), pcount < 111);
  assert.equal(d.projectRefusal(plain), pcount < 111 ? "newer" : "");
  assert.equal(await d.projectImport(0, plain), pcount >= 111);
  if (pcount < 111) assert.equal(d.requests.length, 0, "newer project: no requests");
  else assert.deepEqual(d.written.get(2), plain.bytes);
  d.requests.length = 0;
  assert.equal(await d.backupRestore(d.backupCheck(fileOf(plain))), pcount >= 111);
  if (pcount < 111) assert.equal(d.requests.length, 0, "newer backup: no requests");
  else assert.deepEqual(d.written.get(2), plain.bytes);
}
const old = client({ motionCap: 0 });
assert.equal(await old.projectImport(0, plain), false);
assert.equal(await old.backupRestore(old.backupCheck(fileOf(plain))), false);
assert.equal(old.requests.length, 0, "FUN10 without motion support: no requests");
for (const support of [false, true]) {
  const d = client({ cond: support });
  assert.deepEqual(conditionalProjects(archiveOf(cond)), [2]);
  assert.deepEqual(d.backupConditional(archiveOf(cond)), support ? [] : [2]);
  assert.equal(d.projectRefusal(cond), support ? "" : "cond");
  assert.equal(await d.projectImport(0, cond), support);
  if (!support) assert.equal(d.requests.length, 0, "conditional project: no requests");
  else assert.deepEqual(d.written.get(2), cond.bytes);
  d.requests.length = 0;
  const archive = d.backupCheck(fileOf(cond));
  assert.equal(await d.backupRestore(archive), support);
  if (!support) {
    assert.equal(d.requests.length, 0, "conditional backup: no requests, including earlier objects");
    assert.equal(await d.backupRestore(archive, undefined, [2]), false, "current music also needs skipping");
    assert.equal(d.requests.length, 0);
    assert.equal(await d.backupRestore(archive, undefined, [0, 2]), true);
    assert(!d.requests.some(([cmd, a]) => cmd === BACKUP_CMD.PUT && [0, 2].includes(a[1])));
  } else assert.deepEqual(d.written.get(2), cond.bytes);
}
// Raw file objects and JSON text must be decoded before capability preflights, too.
for (const encode of [(f) => f, JSON.stringify]) for (const [p, info] of [[cond, { cond: false }], [plain, { pcount: 104 }]]) {
  const d = client(info);
  assert.equal(await d.backupRestore(encode(fileOf(p))), false);
  assert.equal(d.requests.length, 0, "serialized backup: no requests on refusal");
}
for (const encode of [(f) => f, JSON.stringify]) {
  const d = client();
  assert.equal(await d.backupRestore(encode(fileOf(plain))), true);
  assert.deepEqual(d.written.get(2), plain.bytes);
}
// Boundary conditions and ratchet bit, at every track's first/last step; independent firmware record underneath.
for (const t of [0, 1, 2, 3]) for (const i of [0, 63]) for (const c of [0, 100, 101, 102, 112, 113, 127]) for (const ratchet of [0, 128]) {
  const b = plain.bytes.slice();
  b[68 + t * (111 + 2 + 576) + 111 + 2 + i * 9 + 8] = c | ratchet;
  view(b).setUint32(b.length - 4, fnv(b.subarray(0, -4)), true);
  const p = readProject(projectFile("fixture-derived", 0, { bytes: b }));
  assert.deepEqual(conditionalProjects(archiveOf(p)), c >= 102 && c <= 112 ? [2] : []);
}
// Typed-array offsets must not decode an unrelated buffer prefix.
const padded = new Uint8Array(cond.size + 13); padded.set(cond.bytes, 9);
assert.deepEqual(conditionalProjects(archiveOf({ ...cond, bytes: padded.subarray(9, 9 + cond.size) })), [2]);
assert(client({ pcount: 104 }).backupTooNew(archiveOf({ ...cond, bytes: padded.subarray(9, 9 + cond.size) })));
for (const name of ["fun7", "fun8", "fun9"]) {
  const p = projects.get(name), d = client({ motionCap: 0, pcount: 104, cond: false });
  assert.deepEqual(conditionalProjects(archiveOf(p)), []);
  assert.equal(d.projectRefusal(p), "");
  assert.equal(await d.projectImport(0, p), true);
  assert.deepEqual(d.written.get(2), p.bytes);
}
for (const b of [new Uint8Array(), cond.bytes.subarray(0, 3), cond.bytes.subarray(0, 3839), Uint8Array.from(cond.bytes, (v, i) => i < 4 ? [0x46, 0x55, 0x4e, 0x41][i] : v)]) {
  assert.deepEqual(conditionalProjects(archiveOf({ size: b.length, bytes: b })), []);
  assert.equal(client().backupTooNew(archiveOf({ size: 3840, bytes: b })), false);
}
assert.deepEqual(conditionalProjects(null), []);
assert.deepEqual(conditionalProjects({ objects: [{ id: 2 }, { id: 1, bytes: cond.bytes }, { id: 6, bytes: cond.bytes }] }), []);
for (const id of [0, 2, 3, 4, 5]) assert.deepEqual(conditionalProjects(archiveOf(cond, id)), [id]);
const damaged = projectFile("fixture", 0, cond); damaged.object.crc ^= 1;
assert.throws(() => readProject(damaged), /checksum/);
assert.throws(() => readProject({ ...damaged, object: { ...damaged.object, size: 3 } }));
const d = client(), badArchive = fileOf(plain); badArchive.objects[2].crc ^= 1;
assert.equal(await d.backupRestore(badArchive), false);
assert.match(d.errors.at(-1), /checksum/);
assert.equal(d.requests.length, 0);
console.log("project import: firmware fixtures, LE guards, compatibility boundaries and pre-write refusals passed");
