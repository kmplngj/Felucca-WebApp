// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
// Public updater contract, fake devices and time only: node test_ota.mjs
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { Updater, pack7 } from "./fm1ota.js";
import { logicalImage, updateLoaderFor, validateStockPackage } from "./fm1pkg.js";
import { customImage } from "./test_ota_helpers.mjs";
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const image = customImage();
const id = (text) => ({ text, model: text.startsWith("ota-") ? text.split("_")[0] : text.startsWith("FM-1_") ? "FM-1" : text.split("_")[0] });
class FakeUpdater extends Updater {
  constructor(identity = "ota-FM-1_900", back = "FM-1_900", next = "ota-FM-1_900") {
    super({}); this.identity = identity; this.back = back; this.next = next; this.probes = this.upgrades = this.data = 0; this.images = [];
  }
  dev(text) { return { id: id(text), link: { close() {}, send: () => { this.upgrades++; return true; } } }; }
  async find(filter) { this.probes++; const d = this.dev(this.identity); return filter(d.id) ? d : null; }
  async waitFor(filter) {
    const d = this.dev(this.upgrades < 2 && !this.identity.startsWith("ota-") ? this.next : this.back || "ota-FM-1_900");
    return filter(d.id) ? d : null;
  }
  async serve(link, bytes) { this.images.push(bytes.slice()); this.data++; return { finished: true, served: 1 }; }
}
const rejects = (f, code) => assert.rejects(f, (e) => e.code === code);
for (const product of [undefined, null, "", "ota-FM-1_900", "FM-1_", "FM-1_hello", "FM-2_900"]) {
  for (const method of ["resume", "install", "write"]) {
    const u = new FakeUpdater();
    await rejects(() => method === "resume" ? u.resume(image, null, product) : method === "install" ? u.install(image, product) : u.write(u.dev(u.identity), image, undefined, product), "badpkg");
    assert.equal(u.probes + u.upgrades + u.data, 0);
  }
}
assert.equal(await updateLoaderFor(image, "FM-1_904"), "ota-FM-1_900");
assert.equal(await updateLoaderFor(image, "FM-1_TEST_1.0"), "ota-FM-1_900");
await assert.rejects(() => updateLoaderFor(image, "FM-1_015"));
const damaged = image.slice(); damaged[0x250] ^= 1;
await assert.rejects(() => updateLoaderFor(damaged, "FM-1_900"));
// Exercise the real handshake parser for build-product overrides as well as numeric IDs.
for (const text of ["FM-1_TEST_1.0", "ota-FM-1_900"]) {
  const input = { name: "Felucca", state: "connected", open: async () => {} };
  const output = { name: "Felucca", state: "connected", open: async () => {}, send() {
    const t = [...new TextEncoder().encode(text)];
    input.onmidimessage({ data: [0xF0, ...pack7([0, 0x59, 0x11, 0, 0, 0, ...t, ...Array(28 - t.length).fill(0)]), 0xF7] });
  } };
  const u = new Updater({ inputs: new Map([[1, input]]), outputs: new Map([[1, output]]) });
  const found = await u.find(); assert.equal(found.id.text, text); found.link.close();
}
const originalTimer = globalThis.setTimeout;
globalThis.setTimeout = (fn) => { queueMicrotask(fn); return 0; };
try {
  for (const loader of ["ota-FM-1_015", "ota-FM-1_901", "ota-FM-1_999", "ota-FM-2_900"]) {
    const u = new FakeUpdater(loader);
    await rejects(() => u.resume(image, null, "FM-1_900"), "incompatible");
    assert.equal(u.upgrades + u.data, 0);
    await rejects(() => u.write(u.dev(loader), image, undefined, "FM-1_900"), "incompatible");
    assert.equal(u.upgrades + u.data, 0);
  }
  // Caller mutations during preflight awaits or progress callbacks cannot change served bytes.
  class AliasedArray extends Uint8Array { slice() { return this; } }
  for (const makeSource of [(b) => b.slice(), (b) => Buffer.from(b), (b) => new AliasedArray(b)]) {
  for (const method of ["install", "resume", "write"]) {
    const source = makeSource(image), u = new FakeUpdater(method === "install" ? "FM-1_900" : "ota-FM-1_900");
    const callback = () => source.fill(0xFF);
    const pending = method === "install" ? u.install(source, "FM-1_900", callback)
      : method === "resume" ? u.resume(source, callback, "FM-1_900")
      : u.write(u.dev(u.identity), source, callback, "FM-1_900");
    source.fill(0); // occurs after the API call, before its first awaited result
    await pending;
    assert(u.images.length > 0);
    for (const served of u.images) assert.deepEqual(served, image);
  }
  }
  const steps = [], u = new FakeUpdater();
  assert.equal(await u.resume(image, (k) => steps.push(k), "FM-1_900"), true);
  assert.equal(steps.at(-1), "done");
  assert.equal(u.upgrades, 1);
  for (const [back, code] of [["FM-1_901", "mismatch"], ["FM-2_900", "mismatch"], [null, "noreturn"]]) {
    const u = new FakeUpdater("ota-FM-1_900", back), steps = [];
    await rejects(() => u.resume(image, (k) => steps.push(k), "FM-1_900"), code);
    assert(!steps.includes("done"));
  }
  const rescue = new FakeUpdater("FM-1_900");
  assert.equal(await rescue.resume(image, null, "FM-1_900"), false);
  assert.equal(rescue.upgrades, 0);
  assert.equal(await rescue.install(image, "FM-1_900"), "FM-1_900");
  assert.equal(rescue.data, 2); // stage, then write
  const wrong = new FakeUpdater("FM-2_900");
  await rejects(() => wrong.install(image, "FM-1_900"), "model");
  assert.equal(wrong.upgrades + wrong.data, 0);
  const unexpected = new FakeUpdater("FM-1_900", "FM-1_900", "ota-FM-1_999");
  await rejects(() => unexpected.install(image, "FM-1_900"), "incompatible");
  assert.equal(unexpected.data, 1); // no loader write
  const stockPath = process.env.FELUCCA_STOCK;
  if (stockPath) {
    const bytes = new Uint8Array(readFileSync(stockPath));
    const stock = await validateStockPackage(bytes);
    assert.equal(await updateLoaderFor(logicalImage(bytes), stock.product), "ota-FM-1_015");
    const u = new FakeUpdater("ota-FM-1_015", stock.product);
    assert.equal(await u.resume(stock.image, null, stock.product), true);
    const install = new FakeUpdater("FM-1_900", stock.product, "ota-FM-1_015");
    assert.equal(await install.install(stock.image, stock.product), stock.product);
    const bad = new FakeUpdater();
    await rejects(() => bad.resume(stock.image, null, stock.product), "incompatible");
    assert.equal(bad.upgrades + bad.data, 0);
    const changed = stock.image.slice(); changed[changed.length - 1] ^= 1;
    const corrupt = new FakeUpdater("ota-FM-1_015", stock.product);
    await rejects(() => corrupt.resume(changed, null, stock.product), "badpkg");
    assert.equal(corrupt.probes + corrupt.upgrades + corrupt.data, 0);
  } else console.log("updater: official V15 success: skipped (set FELUCCA_STOCK to the unmodified official file)");
} finally { globalThis.setTimeout = originalTimer; }
console.log("updater contract: all ok");
