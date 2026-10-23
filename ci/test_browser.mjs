// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { runFixture } from "./browser.mjs";

const [chrome, base] = process.argv.slice(2), controls = [];
for (const mode of ["virtual-released", "real-released", "real-held"]) {
  const profile = await mkdtemp(join(tmpdir(), "felucca-clock-"));
  let started, stored, fixtureStarted;
  try {
    const outcome = await runFixture(chrome, `${base}/ci/browser-clock.html`, profile, {
      afterNavigate: async ({ send, sessionId, evaluate }) => {
        const readyEnd = performance.now() + 5000;
        while (true) {
          try { stored = await evaluate("globalThis.clockControl?.stored"); }
          catch (error) { if (!/Execution context was destroyed|Cannot find context/.test(error.message)) throw error; }
          if (stored) break;
          assert(performance.now() < readyEnd, "real IndexedDB transaction must complete before the clock comparison");
          await sleep(10);
        }
        // Observe this case late on purpose: its deadline must still be anchored to the page's start.
        if (mode === "real-held") await sleep(1500);
        const sent = performance.now();
        const age = await evaluate("performance.now() - globalThis.clockControl.started");
        started = performance.now();
        fixtureStarted = (sent + started) / 2 - age;
        let timer;
        if (mode !== "real-held") timer = setTimeout(() => {
          evaluate("globalThis.clockControl.release = true").catch(() => {});
        }, 2000);
        if (mode === "virtual-released") {
          // Negative control for the previous CLI virtual-time budget. Never set in the actual driver.
          await send("Emulation.setVirtualTimePolicy", { policy: "pauseIfNetworkFetchesPending", budget: 30000 }, sessionId);
        }
        return () => clearTimeout(timer);
      },
    });
    const elapsed = outcome.completedAt - started;
    assert.equal(stored, true);
    if (mode === "real-released") {
      assert.match(outcome.result, /^PASS:/);
      assert(elapsed >= 1900, "real wall-clock release must not be fast-forwarded");
    } else {
      assert.equal(outcome.result, "FAIL: IndexedDB delivery deadline");
      if (mode === "virtual-released") assert(elapsed < 1900, "virtual time must expose the premature deadline");
      else assert(outcome.completedAt - fixtureStarted >= 9000, "a held delivery still fails the original ten-second real deadline");
    }
    controls.push({ mode, stored, elapsed_ms: Math.round(elapsed), fixture_elapsed_ms: Math.round(outcome.completedAt - fixtureStarted), result: outcome.result });
  } finally { await rm(profile, { recursive: true, force: true }); }
}
console.log(JSON.stringify(controls));
console.log("PASS: real clock waits for IndexedDB delivery; virtual-time negative and held-delivery timeout remain red");
