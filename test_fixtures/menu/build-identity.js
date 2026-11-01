// SPDX-License-Identifier: GPL-3.0-only
// The real editor connection and Settings route; mock MIDI only, no device permission.
const frame = document.querySelector("#editor"), result = document.querySelector("#result");
const previousLanguage = localStorage.getItem("felucca-editor-lang");
localStorage.setItem("felucca-editor-lang", "en");
const commit = "0123456789abcdef0123456789abcdef01234567";
const check = (ok, message) => { if (!ok) throw new Error(message); };
const until = async (fn, message) => {
  const end = Date.now() + 10000;
  while (!fn()) {
    if (Date.now() >= end) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const doc = () => frame.contentDocument;
const value = (label) => [...doc().querySelectorAll("#s-settings dt")].find((el) => el.textContent === label)?.nextElementSibling.textContent;
const language = (label) => [...doc().querySelectorAll("button")].find((el) => el.textContent === label).click();
async function open(query) {
  const loaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
  frame.src = "../../app/index.html?mock=1" + query;
  await loaded;
  await until(() => doc().querySelector("#connect")?.disabled === false && doc().querySelector("#state-t")?.textContent.startsWith("LIVE · "), "mock connection ready");
  doc().querySelector("#settings").click();
  await until(() => value("Firmware"), "System information visible");
}
try {
  await open("&build=extended");
  check(value("Commit") === commit && value("PR build") === "PR #790 head", "full commit and verified PR visible");
  check(value("Build profile") === "standard" && value("Build state") === "Clean", "profile and clean state visible");
  check(doc().querySelector("#state-t").textContent.endsWith(" · 01234567"), "short commit in connection status");
  check(value("Commit").length === 40, "System retains all SHA digits");
  language("日本語");
  check(value("コミット") === commit && value("ビルド状態") === "変更なし", "build information follows language changes");
  language("ENGLISH");
  // A disconnected view must never retain the previous device's identity.
  doc().querySelector("#connect").click();
  check(!value("Commit") && doc().querySelector("#state-t").textContent === "OFFLINE", "disconnect clears build display");
  await open("&build=legacy");
  check(value("Commit") === commit && value("Build state") === "Clean", "unextended PR790 QUERY still shows commit");
  check(value("PR build") === "Not reported" && value("Build profile") === "Not reported", "old QUERY never guesses PR or profile");
  await open("");
  check(value("Firmware").includes("MOCK") && value("Commit") === "Not reported", "older firmware stays connected with honest fallback");
  check(value("PR build") === "Not reported" && value("Build profile") === "Not reported" && value("Build state") === "Not reported", "no stale build details on older firmware");
  check(!doc().querySelector("#state-t").textContent.includes("01234567"), "older firmware header retains only reported version");
  await open("&build=extended&dirty=1");
  check(value("Build state") === "Local changes" && doc().querySelector("#state-t").textContent.endsWith("01234567-dirty"), "local changes are explicit in both displays");
  for (const width of [320, 714]) {
    frame.style.width = width + "px";
    await new Promise((resolve) => requestAnimationFrame(resolve));
    check(doc().documentElement.scrollWidth <= doc().documentElement.clientWidth, "build details and header fit at " + width + "px");
  }
  frame.style.width = "100%";
  result.textContent = "PASS: exact build and header, PR790 and older firmware fallback, disconnect, language and dirty state";
  document.documentElement.dataset.testResult = "passed";
} catch (error) {
  result.textContent = "FAIL: " + error.message;
  document.documentElement.dataset.testResult = "failed";
  throw error;
} finally {
  if (previousLanguage === null) localStorage.removeItem("felucca-editor-lang");
  else localStorage.setItem("felucca-editor-lang", previousLanguage);
}
