// SPDX-License-Identifier: GPL-3.0-only
// Exercise the real page's Settings and message log, with mock MIDI only.
const frame = document.querySelector("#editor"), result = document.querySelector("#result");
const check = (ok, message) => { if (!ok) throw new Error(message); };
const until = async (fn, message) => {
  const end = Date.now() + 10000;
  while (!fn()) {
    if (Date.now() >= end) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
try {
  await until(() => frame.contentDocument?.querySelector("#settings")?.onclick, "editor ready");
  const doc = frame.contentDocument;
  doc.querySelector("#settings").click();
  const field = (name) => doc.querySelector(`select[aria-label="${name}"]`);
  const message = () => doc.querySelector("#msg-t").textContent;
  const language = (label) => [...doc.querySelectorAll("button")].find((el) => el.textContent === label).click();
  const pick = (name, value) => {
    const input = field(name); input.focus(); input.value = String(value);
    input.dispatchEvent(new frame.contentWindow.Event("input"));
    input.dispatchEvent(new frame.contentWindow.Event("change"));
  };
  await until(() => field("ALL DARK"), "mock settings loaded");
  language("ENGLISH");
  pick("AUTO OFF", 3);
  pick("ALL DARK", 2);
  await until(() => field("ALL DARK").value === "0" && message() === "Refused", "invalid timer refused");
  check(doc.querySelector("#msgs").classList.contains("warn"), "refusal warning shown");
  pick("ALL DARK", 4);
  await until(() => message() === "Saved", "successful change replaces old refusal");
  field("ALL DARK").blur();
  check(field("ALL DARK").value === "4", "accepted timer retained after blur");
  check(!doc.querySelector("#msgs").classList.contains("warn"), "success clears warning style");
  doc.querySelector("#msgs").click();
  const log = () => [...doc.querySelectorAll("#log-list li span")].map((el) => el.textContent);
  check(log()[0] === "Saved" && log().includes("Refused"), "message history retains previous refusal");
  doc.querySelector("#lg-x").click();
  language("日本語");
  check(message() === "保存済み", "success translates without reviving old refusal");
  language("ENGLISH");
  check(message() === "Saved", "success remains after relabel");
  pick("ALL DARK", 2);
  await until(() => message() === "Refused", "a later refusal is still shown");
  pick("LEDS", 3);
  await until(() => message() === "Saved", "success on another setting clears old refusal");
  result.textContent = "PASS: refusal → saved, warning reset, confirmed values, retained log and language changes";
  document.documentElement.dataset.testResult = "passed";
} catch (e) {
  result.textContent = "FAIL: " + e.message;
  document.documentElement.dataset.testResult = "failed";
  throw e;
}
