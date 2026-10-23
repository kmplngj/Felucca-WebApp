// SPDX-License-Identifier: GPL-3.0-only
// Poll semantic fixtures on Chrome's real clock. Node 22 supplies the WebSocket client.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

export async function runFixture(chrome, url, profile, { afterNavigate } = {}) {
  const end = performance.now() + 80000;
  const args = ["--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
    `--user-data-dir=${profile}`, "about:blank"];
  if (process.getuid?.() === 0) args.unshift("--no-sandbox");
  const child = spawn(chrome, args, { stdio: ["ignore", "ignore", "inherit"] });
  let launchError, stopped = false, socket, cleanup, evaluate;
  child.on("error", (error) => { launchError = error; });
  const closed = new Promise((resolve) => child.on("close", () => { stopped = true; resolve(); }));
  const pending = new Map();
  let nextId = 0;
  const failPending = (error) => {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
    pending.clear();
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (socket?.readyState !== WebSocket.OPEN) { reject(new Error("Chrome debugging connection is not open")); return; }
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); },
      Math.max(1, Math.min(5000, end - performance.now())));
    pending.set(id, { resolve, reject, timer });
    try { socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
  try {
    let endpoint;
    const startEnd = performance.now() + 10000;
    while (!endpoint) {
      if (launchError) throw launchError;
      if (stopped) throw new Error(`Chrome exited before debugging was ready (${child.exitCode ?? child.signalCode})`);
      try {
        const [port, path] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
        if (/^\d+$/.test(port) && path?.startsWith("/devtools/browser/")) endpoint = `ws://127.0.0.1:${port}${path}`;
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (performance.now() >= startEnd) throw new Error("Chrome debugging startup exceeded 10 seconds");
      if (!endpoint) await sleep(25);
    }
    socket = new WebSocket(endpoint);
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data), request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(`CDP ${message.error.message}`)); else request.resolve(message.result);
    });
    socket.addEventListener("close", () => failPending(new Error("Chrome debugging connection closed")));
    socket.addEventListener("error", () => failPending(new Error("Chrome debugging connection failed")));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Chrome WebSocket startup exceeded 5 seconds")), 5000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Chrome WebSocket failed")); }, { once: true });
    });
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    evaluate = async (expression) => {
      const response = await send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
      if (response.exceptionDetails) throw new Error(`Fixture evaluation failed: ${response.exceptionDetails.text}`);
      return response.result.value;
    };
    const navigation = await send("Page.navigate", { url }, sessionId);
    if (navigation.errorText) throw new Error(`Fixture navigation failed: ${navigation.errorText}`);
    const resultEnd = Math.min(end, performance.now() + 60000);
    cleanup = await afterNavigate?.({ send, sessionId, evaluate });
    while (performance.now() < resultEnd) {
      let result;
      try { result = await evaluate('document.querySelector("#result")?.textContent || ""'); }
      catch (error) {
        // Navigation can replace the initial about:blank execution context between polls.
        if (!/Execution context was destroyed|Cannot find context/.test(error.message)) throw error;
      }
      if (/^(PASS|FAIL):/.test(result || "")) return { result, dom: await evaluate("document.documentElement.outerHTML"), completedAt: performance.now() };
      await sleep(25);
    }
    throw new Error("Fixture did not report PASS/FAIL within 60 real seconds");
  } catch (error) {
    if (evaluate) try { console.log(await evaluate("document.documentElement.outerHTML")); } catch { /* Chrome may have exited. */ }
    throw error;
  } finally {
    cleanup?.();
    if (socket?.readyState === WebSocket.OPEN) {
      try { await send("Browser.close"); } catch { /* Closing Chrome can close CDP before the reply. */ }
    }
    socket?.close();
    failPending(new Error("Fixture browser closed"));
    await Promise.race([closed, sleep(1000)]);
    if (!stopped) child.kill("SIGKILL");
    await Promise.race([closed, sleep(1000)]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [chrome, url, profile] = process.argv.slice(2);
    if (!chrome || !url || !profile) throw new Error("usage: node ci/browser.mjs CHROME URL TEMP_PROFILE");
    const { result, dom } = await runFixture(chrome, url, profile);
    console.log(dom);
    if (!result.startsWith("PASS:")) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
