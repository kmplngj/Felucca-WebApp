// SPDX-License-Identifier: GPL-3.0-only
// Real Device + MIDI mock: background work must not reorder dependent MENU edits.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { Device } from "./app/src/device.js";
import { CMD, makeMockDevice, unframe } from "./app/src/proto.js";

async function scenario(mode) {
  const mock = makeMockDevice({ auto: false }), dev = new Device(mock.access);
  const originalTimeout = globalThis.setTimeout, waiters = [], wire = [], errors = [];
  const pause = (ms) => new Promise((resolve) => originalTimeout(resolve, ms));
  try {
    await dev.open();
    for (const timer of dev.timers) clearInterval(timer);
    dev.timers = [];
    dev.on("error", (error) => errors.push(error.message));
    const output = [...mock.access.outputs.values()][0], send = output.send.bind(output);
    output.send = (bytes) => {
      const frame = unframe(bytes);
      if (frame?.cmd === CMD.MENU_SET) {
        wire.push(frame.a[0]);
        if (mode === "error" && frame.a[0] === 17) throw new Error("MENU transport fixture");
      }
      return send(bytes);
    };
    const release = dev.beginBusy();
    // Only control idle()'s waiters. Actual Link scheduling, reply decoding and
    // firmware timer-pair semantics still run unchanged through the MIDI mock.
    globalThis.setTimeout = (fn, ms, ...args) => ms === 20
      ? (waiters.push(() => fn(...args)), 0) : originalTimeout(fn, ms, ...args);
    const result = Promise.allSettled([dev.menuSet(17, 3), dev.menuSet(33, 2)]);
    let finished = false;
    result.then(() => { finished = true; });
    await Promise.resolve(); await Promise.resolve();
    if (mode === "close") dev.close("ordering fixture");
    release();
    const end = Date.now() + 3000;
    while (!finished && Date.now() < end) {
      // Browser timer delivery under load need not follow registration order.
      for (const deliver of waiters.splice(0).reverse()) { deliver(); await pause(10); }
      await pause(1);
    }
    assert.ok(finished, "queued MENU writes settle after busy release, errors or close");
    const replies = await result;
    if (mode === "close") {
      assert.deepEqual(wire, [], "closed queued edits never transmit");
      assert.ok(replies.every((r) => r.status === "rejected" && r.reason.message === "closed"));
      assert.equal(dev.busy, 0);
      return;
    }
    assert.deepEqual(wire, [17, 33], "MENU wire order must preserve call order while background work is busy");
    assert.ok(replies.every((r) => r.status === "fulfilled"));
    assert.deepEqual(replies.map((r) => r.value), mode === "error" ? [undefined, 0] : [0, 2]);
    const expected = mode === "error" ? [0, 2] : [3, 0];
    assert.deepEqual([mock.state.menu[17], mock.state.menu[33]], expected);
    assert.deepEqual([17, 33].map((id) => dev.menu.find((m) => m.id === id).value), expected);
    assert.equal(errors.includes("MENU transport fixture"), mode === "error");
  } finally {
    globalThis.setTimeout = originalTimeout;
    dev.close(); mock.stop();
  }
}

export async function menuOrdering() {
  for (const mode of ["normal", "error", "close"]) await scenario(mode);
  console.log("settings ordering: caller order survives reversed busy waiters; transport error and close settle correctly");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await menuOrdering();
