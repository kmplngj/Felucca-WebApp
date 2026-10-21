// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
//
// PROJECT > STORED (kmplngj/Felucca#456 / #457): the raw store export of firmware that offers it (INFO 59 01 bit 0).
// Every storage object with its state as the device lists it; each one's bytes as stored ("ORIGINAL": a .bin and a
// small .json manifest); for a legacy project or user preset bank an optional MIGRATE that makes today's format in the
// browser (legacy.js) and offers it as a file, with what changed. Read only: nothing here writes to the FM-1, and there is
// no upload (the firmware has no current-schema upload yet). Leaving an object unmigrated is always fine. Firmware
// without the capability shows none of this.

import { bkCrc, rawObjectManifest, readRawStore } from "../../fm1backup.js";
import { MigrationError, RULES, STORE_TYPES, TARGET, bankLegacyRecords, migrateObject, projectFormat, ruleFor, targetMismatch } from "./legacy.js";
import { el, ic } from "./dom.js";
import { card } from "./parts.js";
import { t, tf } from "./text.js";

const MAX_FILE = 600000;
const STATE_KEY = { empty: "rawEmpty", current: "rawCurrent", legacy: "rawLegacy", unknown: "rawUnknown", damaged: "rawDamaged" };
const typeName = (type) => STORE_TYPES[type] || `TYPE ${type}`;
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const day = () => new Date().toISOString().slice(0, 10);
const hex = (n) => (n >>> 0).toString(16).padStart(8, "0");
const fmtName = (f) => (f && f.fmt ? (f.fmt === 10 ? `FUN10 (${f.np})` : `FUN${f.fmt}`) : "?");

/* the file names: Felucca-store-<type>-<name>-<state>-<date>.bin (+ .json), Felucca-migrated-<type>-<name>-<schema>-<date> */
export function originalName(o, date = day()) { return `Felucca-store-${o.type}-${slug(typeName(o.type))}-${o.state}-${date}.bin`; }
export function migratedName(o, schema, date = day()) { return `Felucca-migrated-${o.type}-${slug(typeName(o.type))}-${schema}-${date}.bin`; }

/* the manifest beside a migrated file: where it came from and what changed */
export function migratedManifest(o, r, info, file) {
  return { format: "felucca-migrated-object", version: 1, created: new Date().toISOString(), file, type: o.type, typeName: typeName(o.type),
    size: r.bytes.length, crc: bkCrc(r.bytes), schema: r.kind === "project" ? { magic: "FUNA", pcount: TARGET.pcount } : { magic: "UPB1", pcount: TARGET.pcount },
    source: { state: o.state, copy: o.copy ?? null, size: o.size, crc: o.crc, seq: o.seq ?? null, firmware: info && info.version || o.firmware || "",
      format: r.kind === "project" ? fmtName(r.from) : "UPB1" },
    converter: { by: "Felucca-WebApp app/src/legacy.js", tables: TARGET.revision },
    report: r.kind === "project" ? { log: r.log, tracks: r.tracks } : { records: r.records },
    uploaded: false, note: "No upload path yet (kmplngj/Felucca issue 456): keep this file and the original. The FM-1 keeps its stored object until it is replaced on purpose." };
}

/* which objects get a MIGRATE: a legacy project (or autosave), a user preset bank (its records may be older), when the
   connected firmware's schema is the one this converter writes */
export const canMigrate = (o) => !!ruleFor(o.type) && o.size > 0 && (o.state === "legacy" || (ruleFor(o.type) === "presets" && o.state === "current"));

/* the card's state, kept across redraws (projectScreen): the device's list, the files opened, the results */
export function recoveryState() { return { list: null, files: [], bytes: new Map(), results: new Map(), dev: null }; }

/* -> the STORED card, or null without the capability. dev: the Device; ui: the page; st: recoveryState(); run(fn, done):
   the screen's busy wrapper; busy; redraw() */
export function recoveryCard(dev, ui, st, run, busy, redraw) {
  if (!dev || !(dev.rawCaps() & 1)) return null;
  if (st.dev !== dev) Object.assign(st, recoveryState(), { dev });
  const key = (o) => (o.file ? `file:${o.file}:${o.type}` : `dev:${o.type}`);
  const mismatch = targetMismatch(dev.info);

  async function bytesOf(o) {
    if (o.bytes) return o;
    const k = key(o);
    if (st.bytes.has(k)) return st.bytes.get(k);
    const got = await dev.storeObject(o.type);
    if (got) st.bytes.set(k, got);
    return got;
  }
  function original(o) {
    run(() => bytesOf(o), (got) => {
      if (!got) return;
      const name = originalName(got);
      ui.download(name, got.bytes, "application/octet-stream");
      ui.download(name.replace(/\.bin$/, ".json"), rawObjectManifest(got, dev.info, name, typeName(got.type)));
      ui.say(tf("rawDidOriginal", typeName(got.type)));
    });
  }
  function migrate(o) {
    run(() => bytesOf(o), (got) => {
      if (!got) return;
      let r;
      try { r = migrateObject(got.type, got.bytes); } catch (e) {
        st.results.set(key(o), { error: e instanceof MigrationError ? e.message : String(e.message || e) });
        redraw(); return;
      }
      st.results.set(key(o), { r, o: got });
      redraw();
    });
  }
  function saveMigrated(o, r) {
    const name = migratedName(o, r.kind === "project" ? "FUN10" : "UPB1");
    ui.download(name, r.bytes, "application/octet-stream");
    ui.download(name.replace(/\.bin$/, ".json"), migratedManifest(o, r, dev.info, name));
    ui.say(tf("rawDidMigrate", typeName(o.type)));
  }

  /* files (offline): a felucca-store export, or originals (.bin, with their .json manifests when picked too) */
  const fileInput = el("input", { type: "file", multiple: true, accept: ".bin,.json,application/json,application/octet-stream", hidden: true });
  fileInput.addEventListener("change", async () => {
    const fs = [...fileInput.files]; fileInput.value = "";
    const manifests = [], bins = [];
    for (const f of fs) {
      if (f.size > MAX_FILE) { ui.say(`${f.name}: ${t("tooLarge")}`, "warn"); continue; }
      if (/\.json$/i.test(f.name)) {
        let j = null;
        try { j = JSON.parse(await f.text()); } catch (_) { ui.say(`${f.name}: ${t("rawFileBad")}`, "warn"); continue; }
        if (j && j.format === "felucca-store") {
          try { for (const o of readRawStore(j).objects) st.files.push({ ...o, file: f.name, firmware: j.firmware }); }
          catch (e) { ui.say(`${f.name}: ${e.message}`, "warn"); }
        } else if (j && j.format === "felucca-store-object") manifests.push(j);
        else ui.say(`${f.name}: ${t("rawFileBad")}`, "warn");
      } else bins.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
    }
    for (const b of bins) {
      const m = manifests.find((x) => x.file === b.name) || manifests.find((x) => x.size === b.bytes.length && x.crc === bkCrc(b.bytes));
      if (m && m.state !== "damaged" && m.size && bkCrc(b.bytes) !== m.crc) { ui.say(`${b.name}: ${t("rawFileBad")}`, "warn"); continue; }
      const pf = projectFormat(b.bytes), bank = b.bytes.length === 3080 && String.fromCharCode(...b.bytes.subarray(0, 4)) === "UPB1";
      const type = m ? m.type : pf.fmt ? 1 : bank ? 5 : -1;
      const state = m ? m.state : pf.fmt ? pf.state : bank ? "current" : "unknown";
      st.files.push({ type, state, copy: m ? m.copy : null, size: b.bytes.length, crc: bkCrc(b.bytes), seq: m ? m.seq : null,
        magic: b.bytes.length >= 4 ? (b.bytes[0] | b.bytes[1] << 8 | b.bytes[2] << 16 | b.bytes[3] << 24) >>> 0 : 0, bytes: b.bytes, file: b.name,
        firmware: m ? m.firmware : "" });
    }
    redraw();
  });

  function row(o) {
    const k = key(o), res = st.results.get(k), ported = !!ruleFor(o.type);
    const label = o.file ? `${o.file}${o.type >= 0 ? " · " + typeName(o.type) : ""}` : typeName(o.type);
    const have = o.bytes || (st.bytes.get(k) || {}).bytes, recs = have && ruleFor(o.type) === "presets" ? bankLegacyRecords(have) : 0;
    const meta = o.size ? `${o.size} B · seq ${o.seq ?? "-"}${o.copy != null ? ` · ${o.copy ? "B" : "A"}` : ""} · ${hex(o.magic || 0)}` +
      (recs ? ` · ${tf("rawLegacyRecs", recs)}` : "") : "";
    const head = el("div", { class: "rawrow" },
      el("span", { class: "nm", text: label }),
      el("span", { class: "tag state " + o.state, text: t(STATE_KEY[o.state] || "rawUnknown") }),
      el("span", { class: "meta", text: meta }),
      el("div", { class: "rowacts" },
        !o.file ? el("button", { type: "button", class: "btn sm", disabled: busy || !o.size, onclick: () => original(o) }, ic("symbol_download"), t("rawOriginal")) : null,
        canMigrate(o) && !mismatch ? el("button", { type: "button", class: "btn sm", disabled: busy, onclick: () => migrate(o) }, ic("symbol_transition"), t("rawMigrate")) : null,
        o.state === "legacy" && !ported ? el("span", { class: "tag", text: t("rawNotPorted") }) : null));
    return el("div", { class: "rawobj" }, head, res ? result(o, k, res) : null);
  }
  function result(o, k, res) {
    const close = el("button", { type: "button", class: "iconbtn sm", "aria-label": t("close"), onclick: () => { st.results.delete(k); redraw(); } }, ic("symbol_cross"));
    if (res.error) return el("div", { class: "rawres" }, el("div", { class: "rawhead" }, el("b", { text: t("rawRefused") }), close), el("p", { class: "loss", text: res.error }));
    const r = res.r, lines = [];
    let title;
    if (r.kind === "project") {
      title = `${fmtName(r.from)} → FUN10 (${TARGET.pcount})${r.name ? " · " + r.name : ""}`;
      r.tracks.forEach((x, i) => lines.push({ text: `T${i + 1}: ${x.before ? (x.before.engine !== x.engine ? `${x.before.engineName} → ` : "") : `${t("rawPowerOn")} · `}${x.engineName}` }));
      for (const l of r.log) lines.push({ text: (l.track != null ? `T${l.track + 1}: ` : "") + l.text, loss: l.loss });
    } else {
      const n = (s) => r.records.filter((x) => x.status === s).length;
      title = `UPB1 · ${tf("rawRecords", n("converted"), n("refused") + n("kept"))}`;
      for (const x of r.records) {
        if (x.status === "empty" || x.status === "current") continue;
        lines.push({ text: `${x.slot} ${x.name} (${x.engineName}, v${x.ver}/${x.np}): ${x.notes.join("; ") || x.status}`, loss: x.status === "refused" || x.notes.some((s) => /not ported|replaced/.test(s)) });
      }
    }
    if (r.same) lines.unshift({ text: t("rawSame") });
    return el("div", { class: "rawres" },
      el("div", { class: "rawhead" }, el("b", { text: title }), close),
      el("ul", { class: "rawlog" }, ...lines.map((l) => el("li", { class: l.loss ? "loss" : "", text: (l.loss ? "! " : "") + l.text }))),
      el("div", { class: "acts" },
        el("button", { type: "button", class: "btn sm primary", disabled: r.same, onclick: () => saveMigrated(res.o, r) }, ic("symbol_download"), t("rawMigrated"))));
  }

  const objs = [...(st.list || []), ...st.files];
  const c = card(t("rawTitle"), "symbol_inbox",
    el("p", { class: "rawnote", text: t("rawNoUpload") }),
    mismatch ? el("p", { class: "rawnote loss", text: `${t("rawNoTarget")}: ${mismatch}` }) : null,
    el("div", { class: "acts wrap" },
      el("button", { type: "button", class: "btn", disabled: busy, onclick: () => run(() => dev.storeList(), (l) => { if (l) { st.list = l; ui.say(tf("rawDidList", l.length)); } }) },
        ic("symbol_search"), t("rawList")),
      el("button", { type: "button", class: "btn", disabled: busy, onclick: () => run(
        () => dev.storeAll((n, total) => ui.progress(`STORE ${Math.round(n / Math.max(1, total) * 100)}%`)),
        (f) => { if (f) { ui.download(`Felucca-store-${day()}.json`, f); ui.say(t("rawDidAll")); } }) },
        ic("symbol_download_as"), t("rawAll")),
      el("button", { type: "button", class: "btn", disabled: busy, onclick: () => fileInput.click() }, ic("symbol_folder"), t("rawFile"))),
    objs.length ? el("div", { class: "rawlist" }, ...objs.map(row)) : null,
    el("p", { class: "rawnote", text: `${t("rawPorted")}: ${RULES.filter((x) => x.ported).map((x) => x.id).join(", ")} · ${t("rawNotPorted")}: ${RULES.filter((x) => !x.ported).map((x) => x.id).join(", ")}` }),
    fileInput);
  c.classList.add("wide");
  c.aside.textContent = t("rawReadOnly");
  return c;
}
