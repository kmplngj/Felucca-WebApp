// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
//
// Legacy stored objects -> today's schema, in the browser (kmplngj/Felucca#456 / #457). Pure: bytes in, bytes and a
// report out; nothing here talks to a device, and nothing is ever uploaded (the firmware has no current-schema upload
// yet). The rules are the firmware's own conversions, ported from its sources at the revision legacy_tables.js was
// generated from (Felucca docs/legacy-formats.md section 4), and their output is byte for byte what that firmware makes
// of the same input: test_legacy.mjs checks every vector of legacy_vectors.json (made by gen_legacy.c from the
// firmware itself).
//
// Ported:
//   - projects FUN1..FUN9 and FUN10 of 103 / 104 parameters -> FUN10 of P_COUNT (project.c proj_fetch: proj_import,
//     proj_bound, proj_pack), with every in-project rule on the way: parameters by count (core.h params_by_count), the
//     GM drum part (proj_drums_to_part), PHYS DUST / PHYS DRUM (proj_phys: phys_legacy, drum_from_phys), the drum grid
//     (proj_grid: step_to_grid), DIGITAL -> FM6 (proj_fm4: fm4_convert, fm6_pack, motion on EDIT / OP ENV dropped),
//     SAMPLE PERC -> DRUM (proj_perc), retired DRUM KITs and FM6 bank SLOTs (param_fit), the song chain
//     (chain_from_v9), motion records and their ids (proj_motion_v9, proj_motion_ids), REVERB TYPE (proj_rtype_room),
//     the init FM6 patch of FUN7 and older (proj_fm6_init), MIDI IN TRACK (proj_midi_unpack / proj_midi_pack), names;
//   - user preset banks (UPB1): the records of versions 1..3 and of fewer parameters -> version 4 / 5 with P_COUNT
//     (upreset.c up_bank_check, then the firmware's UP_GET reply of the record sent back as UP_PUT: up_values,
//     up_parse), PHYS DRUM / SAMPLE PERC records -> DRUM (up_migrate).
// Not ported yet (RULES below; an object of these kinds is reported, never converted): settings PER1..PER6
// (settings_import), the retired FM6 patch bank (upf_migrate), re-linking an FM6 user preset's patch in the user presets'
// FM6 patches (upf_tag of a converted record), the autosave's sizes other than FUN10, and targets other than the
// standard engine catalog of P_COUNT 111.

import { T } from "./legacy_tables.js";
import { FM4, FM6 } from "./proto.js";

const FUN = { 1: 0x46554E31, 2: 0x46554E32, 3: 0x46554E33, 4: 0x46554E34, 5: 0x46554E35, 6: 0x46554E36, 7: 0x46554E37,
  8: 0x46554E38, 9: 0x46554E39, 10: 0x46554E41 };
const SIZE = { 1: 688, 2: 2552, 3: 2584, 4: 2680, 5: 3352, 6: 3388, 7: 3388, 8: 3584, 9: 3648, 10: 3840 };
const NP_V2 = 53, NP_V3 = 57, NP_V4 = 69, NAME_LEN = 12, STORE = 3840;
const NAME_OFF = STORE - 4 - NAME_LEN, FM6_OFF = NAME_OFF - T.NTRK * T.FM6_PACKED, MIDI_OFF = FM6_OFF - 3;
const UP_MAGIC = 0x31425055, UP_BANK = 3080, UP_REC = 192, UP_SLOTS_PER_BANK = 16, UP_CAT_AT = T.UP_PMAX * 2 - 1;

/* the storage types of the raw store export (STORE_LIST) */
export const STORE_TYPES = {
  0: "SETTINGS", 1: "PROJECT A", 2: "PROJECT B", 3: "PROJECT C", 4: "PROJECT D", 5: "USER 1-16", 6: "USER 17-32",
  7: "FM6 BANK (1.0)", 8: "USER FM6", 9: "AUTOSAVE", 32: "FM6 VOICES",
};
/* the conversion rules of docs/legacy-formats.md section 4 and whether this library has them */
export const RULES = [
  { id: "project", label: "Project FUN1..FUN9, FUN10 np 103 / 104 -> FUN10", ported: true, ref: "project.c proj_fetch" },
  { id: "params", label: "Parameter count remap (projects, presets)", ported: true, ref: "core.h params_by_count" },
  { id: "retired", label: "Retired sounds: DIGITAL -> FM6, SAMPLE PERC / PHYS DRUM -> DRUM, PHYS DUST", ported: true,
    ref: "fm4_convert.c, core.h drum_from_perc / drum_from_phys, eng_phys.c phys_legacy" },
  { id: "drums", label: "GM drum part, drum grid", ported: true, ref: "proj_drums_to_part, eng_drum.c step_to_grid" },
  { id: "enums", label: "Enum aliases: retired DRUM KITs, FM6 bank SLOTs", ported: true, ref: "params.c param_fit" },
  { id: "presets", label: "User preset records versions 1..3, fewer parameters -> version 4 / 5", ported: true,
    ref: "upreset.c up_bank_check, up_values, up_parse" },
  { id: "upf6", label: "FM6 user preset patch link (UPF6 tag of a converted record)", ported: false, ref: "up_fm6.c upf_tag" },
  { id: "fm6bank", label: "Retired FM6 patch bank (FM6B) -> user presets' patches", ported: false, ref: "up_fm6.c upf_migrate" },
  { id: "settings", label: "Settings PER1..PER6 (field rules, favourites, calibration)", ported: false,
    ref: "settings_persist.c settings_import" },
];
/* the schema this library writes: P_COUNT and the engine catalog of the tables (the firmware's standard profile) */
export const TARGET = { pcount: T.P_COUNT, pe0: T.P_E0, engines: T.NAMES, engOk: T.ENG_OK, revision: T.REVISION };
/* a connected firmware this library's output fits: the same P_COUNT and, with a versioned catalog (INFO 49 01), the same
   playable engine ids -> "" when it fits, else why not (that firmware's own schema is not ported yet) */
export function targetMismatch(info) {
  if (!info) return "";
  if (info.pcount !== T.P_COUNT) return `the FM-1 has ${info.pcount} parameters per track; this converter writes ${T.P_COUNT}`;
  const c = info.engineCatalog;
  if (c && c.bitmap) for (let id = 0; id < T.ENG_ID_MAX; id++) {
    const on = !!((c.bitmap[Math.floor(id / 7)] >> (id % 7)) & 1);
    if (on !== !!T.ENG_OK[id] && id !== T.ENGI_DIGITAL) return `the FM-1's engine catalog differs from the standard one (id ${id})`;
  }
  return "";
}

export class MigrationError extends Error {
  constructor(message, code = "invalid") { super(message); this.code = code; }
}

/* ------------------------------------------------------------------ helpers --- */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const u32 = (b, o) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
const i16 = (b, o) => ((b[o] | b[o + 1] << 8) << 16) >> 16;
const put32 = (b, o, v) => { b[o] = v & 255; b[o + 1] = v >>> 8 & 255; b[o + 2] = v >>> 16 & 255; b[o + 3] = v >>> 24 & 255; };
const put16 = (b, o, v) => { b[o] = v & 255; b[o + 1] = v >> 8 & 255; };
export function fnv1a(b, n = b.length, skip = null) {
  let s = 0x811C9DC5;
  for (let i = 0; i < n; i++) if (!skip || !skip(i)) s = Math.imul(s ^ b[i], 16777619) >>> 0;
  return s >>> 0;
}
const toInt16 = (v) => (v << 16) >> 16;
/* a parameter's descriptor for engine id e (an id this build lacks: ENG_NONE's): [min, max, def, fit] */
const desc = (e, i) => {
  if (i < T.P_E0) return T.TP.slice(i * 4, i * 4 + 4);
  const id = e < T.ENG_ID_MAX ? e : null;
  const o = ((id ?? 14) * 8 + i - T.P_E0) * 4;         /* (ids past 63 never reach here: refused before) */
  return T.EDIT.slice(o, o + 4);
};
/* params.c param_fit: inside the range; a retired DRUM KIT is the kit it plays; FM6's bank SLOTs are OWN */
function paramFit(d, v) {
  v = clamp(v, d[0], d[1]);
  if (d[3] === 2) return v > T.FM6_OWN ? T.FM6_OWN : v;
  return d[3] === 1 && v >= 0 && v < T.DK_PLAYS.length ? T.DK_PLAYS[v] : v;
}
/* core.h params_by_count: the first np - 8 in order, the last 8 the engine's, the rest their defaults */
function paramsByCount(inp, np, def) {
  const out = new Array(T.P_COUNT), nc = np - 8;
  for (let i = 0; i < T.P_E0; i++) out[i] = i < nc ? inp[i] : def[i];
  for (let i = 0; i < 8; i++) out[T.P_E0 + i] = inp[nc + i];
  return out;
}
const TP_DEF = Array.from({ length: T.P_COUNT }, (_, i) => (i < T.P_E0 ? T.TP[i * 4 + 2] : 0));
function physLegacy(p) { if (p[T.P_E0] === 2) { p[T.P_E0] = 0; p[T.P_E0 + 6] = 64; } }
function drumFromPhys(engine, p) {
  const e0 = T.P_E0;
  if (engine !== T.ENGI_PHYS || p[e0] !== 4) return false;
  p[e0] = toInt16(clamp(p[e0 + 7], 0, 127) >> 5);
  p[e0 + 6] = p[e0 + 6] >= 64 ? 1 : 0;
  p[e0 + 7] = 0;
  return true;
}
function drumFromPerc(engine, p) {
  if (engine !== T.ENGI_SAMPLE || p[T.P_E0] !== 4) return false;
  for (let i = 0; i < 8; i++) p[T.P_E0 + i] = T.DRUM_KIT_E[i];
  return true;
}
const drumLane = (note) => T.DRUM_LANE[note >= 35 && note <= 81 ? note : 36 + (note + 84) % 12];
function stepToGrid(s) {
  if (s.time !== 0) return false;
  let k = 0, hit = s.hit;
  for (let i = 0; i < s.n && i < 4; i++) {
    const l = drumLane(s.note[i]);
    if (s.note[i] === T.DRUM_LANE_NOTE[l]) s.hit = (s.hit | 1 << l) & 255;
    else s.note[k++] = s.note[i];
  }
  const changed = k !== s.n || s.hit !== hit;
  for (let i = k; i < 4; i++) s.note[i] = 0;
  s.n = k;
  if (!k && (s.flags & 1)) { s.acc = (s.acc | s.hit) & 255; s.flags &= ~1 & 255; }
  return changed;
}
const motionParam = (id) => !!T.MOTION_PARAM[id];
const engName = (e) => (e < T.ENG_ID_MAX ? (e === T.ENGI_DIGITAL ? "DIGITAL" : T.NAMES[e] === "N/A" ? `N/A (${e})` : T.NAMES[e]) : `#${e}`);

/* ------------------------------------------------------------- projects --- */
/* the format of a stored project: {fmt (1..10), np, size, state: "current" | "legacy" | "unknown"} (editor_backup.c
   ed_raw_kind: magic, size word = its length, FNV-1a last; a FUN10 by its parameter count) */
export function projectFormat(b) {
  const n = b.length;
  if (n < 8) return { fmt: 0, state: n ? "unknown" : "empty", size: n };
  const m = u32(b, 0), w = u32(b, 4), s = u32(b, n - 4);
  for (let f = 10; f >= 1; f--) {
    if (n === SIZE[f] && m === FUN[f] && w === n && s === fnv1a(b, n - 4)) {
      if (f < 10) return { fmt: f, np: f >= 7 ? b[66] : f >= 4 ? NP_V4 : f === 3 ? NP_V3 : NP_V2, state: "legacy", size: n };
      const np = b[66];
      return { fmt: 10, np, size: n, state: np === T.P_COUNT ? "current" : np >= 8 && np < T.P_COUNT ? "legacy" : "unknown" };
    }
  }
  return { fmt: 0, state: "unknown", size: n };
}

const newStep = () => ({ note: [0, 0, 0, 0], n: 0, time: 0, flags: 0, vel: 0, hit: 0, acc: 0, probability: 0 });
function newProject() {
  return { g: new Array(T.G_COUNT).fill(0), sel: 0, parts: 0, phys: 0,
    t: Array.from({ length: T.NTRK }, () => ({ p: new Array(T.P_COUNT).fill(0), engine: 0, preset: 0,
      step: Array.from({ length: T.NSTEP }, newStep) })),
    chain: new Uint8Array(84), motion: { count: 0, on: 0, rsv: [0, 0], ev: Array.from({ length: T.MOTION_MAX }, () => [0, 0, 0]) },
    fm6: Array.from({ length: T.NTRK }, () => new Uint8Array(T.FM6_PACKED)), mch: [0, 0, 0, 0], name: [] };
}
function chainDefaults(c) { c.fill(0); for (let i = 0; i < T.CHAIN_ROWS; i++) c[4 + i * 5 + 4] = 1; }
function chainValid(c) {
  if (c[0] > T.CHAIN_ROWS) return false;
  for (let i = 0; i < c[0]; i++) {
    for (let k = 0; k < T.NTRK; k++) if (c[4 + i * 5 + k] > T.CHAIN_SILENT) return false;
    const r = c[4 + i * 5 + 4];
    if (!r || r > 16) return false;
  }
  return true;
}
/* song_chain.c chain_from_v9: rows {slot, repeat} (36 bytes at o) -> sections with the four tracks on the row's slot */
function chainFromV9(c, b, o) {
  chainDefaults(c);
  const count = b[o];
  if (count > T.CHAIN_ROWS) return false;
  for (let i = 0; i < count; i++) {
    const slot = b[o + 4 + 2 * i], rep = b[o + 5 + 2 * i];
    if (slot >= 4 || !rep || rep > 16) return false;
    c.fill(slot, 4 + i * 5, 8 + i * 5);
    c[8 + i * 5] = rep;
  }
  c[0] = count;
  return true;
}
function motionValid(m) {
  if (m.count > T.MOTION_MAX || (m.on & ~15)) return false;
  for (let i = 0; i < m.count; i++) {
    const [place, param, value] = m.ev[i], id = param & 127;
    if (!motionParam(id) || value < -64 || value > 127) return false;
    for (let j = 0; j < i; j++) if (m.ev[j][0] === place && (m.ev[j][1] & 127) === id) return false;
  }
  return true;
}
/* proj_name_get: up to the first 0, upper case; a byte outside 32..126 makes it no name */
function nameGet(s) {
  const d = [];
  for (let i = 0; i < NAME_LEN && s[i]; i++) {
    if (s[i] < 32 || s[i] > 126) return [];
    d.push(s[i] >= 97 && s[i] <= 122 ? s[i] - 32 : s[i]);
  }
  return d;
}

function drumsToPart(q, log) {
  if (q.parts === T.NPART) return;
  const d = q.t[T.NTRK - 1];
  log.push({ track: 3, rule: "drums", text: `GM drum part -> DRUM (LEVEL ${clamp(q.g[T.G_DRLVL], 0, 127)}, REV ${clamp(q.g[T.G_DRREV], 0, 127)})` });
  d.engine = T.ENGI_DRUM;
  d.preset = T.PROJ_DEF_KEEP;
  d.p[T.P_LEVEL] = clamp(q.g[T.G_DRLVL], 0, 127);
  d.p[T.P_REV] = clamp(q.g[T.G_DRREV], 0, 127);
  q.parts = T.NPART;
}
function projPhys(q, log) {
  if (q.phys >= T.PROJ_PHYS) return;
  q.t.forEach((d, k) => {
    if (d.engine !== T.ENGI_PHYS) return;
    if (!q.phys) {
      const was = d.p[T.P_E0];
      physLegacy(d.p);
      if (was === 2) log.push({ track: k, rule: "retired", text: "PHYS DUST -> MODAL bowed" });
    }
    if (drumFromPhys(d.engine, d.p)) {
      d.engine = T.ENGI_DRUM;
      d.preset = 0;
      log.push({ track: k, rule: "retired", text: "PHYS MODEL DRUM -> DRUM" });
    }
  });
  q.phys = T.PROJ_PHYS;
}
function projGrid(q, log) {
  q.t.forEach((d, k) => {
    if (d.engine !== T.ENGI_DRUM) return;
    let n = 0;
    for (const s of d.step) if (stepToGrid(s)) n++;
    if (n) log.push({ track: k, rule: "drums", text: `${n} steps: lane notes -> grid hits` });
  });
}
/* the motion records of the tracks in `hit` that `drop(id)` names go (proj_fm4 / proj_perc) */
function dropMotion(q, hit, drop) {
  const m = q.motion, keep = [];
  let gone = 0;
  for (let i = 0; i < m.count && i < T.MOTION_MAX; i++) {
    const e = m.ev[i];
    if (((hit >> (e[0] >> 6)) & 1) && drop(e[1] & 127)) { gone++; continue; }
    keep.push(e);
  }
  const n = keep.length;
  for (let i = 0; i < n; i++) m.ev[i] = keep[i];
  for (let i = n; i < m.count && i < T.MOTION_MAX; i++) m.ev[i] = [0, 0, 0];
  m.count = n;
  return gone;
}
function projFm4(q, log) {
  let hit = 0;
  q.t.forEach((d, k) => {
    if (d.engine !== T.ENGI_DIGITAL) return;
    for (let i = 0; i < T.P_COUNT; i++) { const ds = desc(T.ENGI_DIGITAL, i); d.p[i] = clamp(d.p[i], ds[0], ds[1]); }
    const r = FM4.convert(d.p, T.P_E0);
    d.p = r.p;
    q.fm6[k] = Uint8Array.from(FM6.pack(r.voice));
    d.engine = T.ENGI_FM6;
    if (d.preset < T.PROJ_DEF_KEEP) d.preset = r.preset;
    hit |= 1 << k;
    log.push({ track: k, rule: "retired", text: "DIGITAL -> FM6 (its own converted patch)" });
  });
  if (!hit) return;
  const gone = dropMotion(q, hit, (id) => id >= T.P_E0 || (id >= T.P_FM1_ATK && id <= T.P_FM4_LEVEL));
  if (gone) log.push({ rule: "retired", loss: true, text: `${gone} motion records on DIGITAL's EDIT / OP ENV values dropped` });
}
function projPerc(q, log) {
  let hit = 0;
  q.t.forEach((d, k) => {
    if (!drumFromPerc(d.engine, d.p)) return;
    d.engine = T.ENGI_DRUM;
    if (d.preset < T.PROJ_DEF_KEEP) d.preset = 0;
    hit |= 1 << k;
    log.push({ track: k, rule: "retired", loss: true, text: "SAMPLE PERC -> DRUM (default kit; its EDIT values replaced)" });
  });
  if (!hit) return;
  const gone = dropMotion(q, hit, (id) => id >= T.P_E0);
  if (gone) log.push({ rule: "retired", loss: true, text: `${gone} motion records on SAMPLE PERC's EDIT values dropped` });
}

/* proj_trk_from: an int16 track of formats 1..4 (np values, 8-byte steps at b[so..]) */
function trkFrom(d, vals, np, engine, preset, b, so) {
  d.p = paramsByCount(vals, np, TP_DEF);
  d.engine = engine;
  d.preset = preset;
  d.src = { engine, preset };
  for (let k = 0; k < T.NSTEP; k++) {
    const o = so + k * 8, s = d.step[k];
    s.note = [b[o], b[o + 1], b[o + 2], b[o + 3]];
    s.n = b[o + 4]; s.time = b[o + 5]; s.flags = b[o + 6] & 3; s.vel = b[o + 7]; s.hit = s.acc = 0;
  }
}
const int16s = (b, o, n) => Array.from({ length: n }, (_, i) => i16(b, o + 2 * i));
function roomG(g, log, was) { if (was !== 0) log.push({ rule: "project", text: `REVERB TYPE (was the drum part's channel ${was}) -> ROOM` }); g[T.G_RTYPE] = 0; }

/* formats 1..4 (project.c proj_from_v1 .. proj_from_v4), 5 and 6 (proj_import_old) -> q, or null */
function importOld(b, n, log) {
  const q = newProject(), hashOk = (len) => u32(b, len - 4) === fnv1a(b, len - 4);
  if ((n === SIZE[5] || n === SIZE[6]) && ((n === SIZE[5] && u32(b, 0) === FUN[5]) || (n === SIZE[6] && u32(b, 0) === FUN[6] &&
      chainFromV9(q.chain, b, 66 + 4 * 820))) && u32(b, 4) === n && hashOk(n)) {
    q.g = int16s(b, 8, T.G_COUNT);
    roomG(q.g, log, q.g[T.G_RTYPE]);
    q.sel = b[62]; q.parts = b[63]; q.phys = b[64];
    for (let i = 0; i < T.NTRK; i++) {
      const o = 66 + i * 820, d = q.t[i], engine = b[o + 138];
      if (engine >= T.ENG_ID_MAX) throw new MigrationError(`track ${i + 1}: engine byte ${engine} is past the engine id space`);
      d.p = paramsByCount(int16s(b, o, 69), 69, TP_DEF);
      d.engine = engine; d.preset = b[o + 139]; d.src = { engine, preset: d.preset };
      for (let k = 0; k < T.NSTEP; k++) {
        const so = o + 140 + k * 10, s = d.step[k];
        s.note = [b[so], b[so + 1], b[so + 2], b[so + 3]];
        s.n = b[so + 4]; s.time = b[so + 5]; s.flags = b[so + 6] & 3; s.vel = b[so + 7]; s.hit = b[so + 8]; s.acc = b[so + 9];
      }
    }
    if (n === SIZE[5]) chainDefaults(q.chain);
    log.push({ rule: "project", text: n === SIZE[5] ? "FUN5: no song chain (empty)" : `song chain: ${q.chain[0]} rows -> sections` });
    drumsToPart(q, log);
    projPhys(q, log);
    return q;
  }
  let fmt = 0;
  for (const f of [4, 3, 2, 1]) if (n === SIZE[f] && u32(b, 0) === FUN[f] && u32(b, 4) === n && hashOk(n)) { fmt = f; break; }
  if (!fmt) return null;
  if (fmt === 4 || fmt === 3) {
    const np = fmt === 4 ? NP_V4 : NP_V3, tl = np * 2 + 2 + 512;
    q.g = int16s(b, 8, T.G_COUNT);
    roomG(q.g, log, q.g[T.G_RTYPE]);
    q.sel = b[62]; q.parts = b[63]; q.phys = fmt === 4 ? b[64] : 0;
    for (let i = 0; i < T.NTRK; i++) {
      const o = 66 + i * tl;
      trkFrom(q.t[i], int16s(b, o, np), np, b[o + np * 2], b[o + np * 2 + 1], b, o + np * 2 + 2);
    }
    drumsToPart(q, log);
  } else if (fmt === 2) {
    q.g = int16s(b, 8, T.G_COUNT);
    roomG(q.g, log, q.g[T.G_RTYPE]);
    q.sel = b[62];
    for (let i = 0; i < T.NTRK; i++) {
      const o = 66 + i * 620;
      trkFrom(q.t[i], int16s(b, o, NP_V2), NP_V2, b[o + 106], b[o + 107], b, o + 108);
    }
    drumsToPart(q, log);
  } else {
    q.g = int16s(b, 8, T.G_COUNT);
    roomG(q.g, log, q.g[T.G_RTYPE]);
    q.parts = T.NPART;
    trkFrom(q.t[0], int16s(b, 62, NP_V2), NP_V2, b[62 + 106], b[62 + 107], b, 62 + 108);
    for (let i = 1; i < T.NTRK; i++) {
      const e = T.TRK_DEF_ENGINE[i], d = q.t[i];
      d.p = Array.from({ length: T.P_COUNT }, (_, k) => desc(e, k)[2]);
      d.engine = e; d.preset = T.PROJ_DEF_SOUND;
      for (const s of d.step) s.time = T.ST_REST;
    }
    log.push({ rule: "project", text: "FUN1: one instrument -> track 1; tracks 2..4 their power-on sounds, no steps" });
  }
  projPhys(q, log);
  projGrid(q, log);
  return q;
}

/* proj_unpack: FUN7 / FUN8 / FUN9 / FUN10 (st bytes) -> q, or null */
function unpack(b, st, log) {
  const np = b[66], v7 = st === SIZE[7], v10 = st === STORE;
  const nameOff = st - 4 - NAME_LEN, end = v7 ? nameOff : nameOff - T.NTRK * T.FM6_PACKED;
  const mot = v10 ? 388 : 260, chn = v10 ? 84 : 36;
  const magic = v7 ? FUN[7] : st === SIZE[8] ? FUN[8] : st === SIZE[9] ? FUN[9] : FUN[10];
  if (u32(b, 0) !== magic || u32(b, 4) !== st || u32(b, st - 4) !== fnv1a(b, st - 4) || np < 8 || np > T.P_COUNT ||
      68 + T.NTRK * (np + 2 + T.NSTEP * 9) + chn + mot > end) return null;
  const q = newProject();
  let pos = 68;
  q.g = int16s(b, 8, T.G_COUNT);
  q.sel = b[62]; q.parts = b[63]; q.phys = b[64];
  if (v7 && (q.g[T.G_RTYPE] < 0 || q.g[T.G_RTYPE] > 1)) roomG(q.g, log, q.g[T.G_RTYPE]);
  for (let t = 0; t < T.NTRK; t++) {
    const values = [], d = q.t[t];
    for (let i = 0; i < np; i++) { if (b[pos] > 191) return null; values.push(b[pos++] - 64); }
    d.engine = b[pos++]; d.preset = b[pos++];
    d.src = { engine: d.engine, preset: d.preset };
    if (d.engine >= T.ENG_ID_MAX) return null;
    d.p = paramsByCount(values, np, TP_DEF);
    for (let i = 0; i < T.NSTEP; i++) {
      const s = d.step[i];
      let nd = 0;
      for (let j = 0; j < 4; j++) {
        if (b[pos] > 127 && !v10) return null;
        nd |= (b[pos] >> 7) << j;
        s.note[j] = b[pos++] & 127;
      }
      let meta = b[pos++];
      s.n = meta & 7; s.time = (meta >> 3) & 3; s.flags = (meta >> 5) & 3;
      s.vel = b[pos] & 127; meta |= (b[pos++] & 128) << 1;
      s.hit = b[pos++]; s.acc = b[pos++];
      s.probability = b[pos] & 127; meta |= (b[pos++] & 128) << 2;
      if ((meta & 255) > 127 || s.n > 4 || s.time > T.ST_REST || s.probability >= T.COND_LIMIT) return null;
      if (s.acc & ~s.hit) return null;
      const hits = (meta >> 8) + 1, r = hits < 1 ? 0 : hits > 4 ? 3 : hits - 1;
      s.flags = (s.flags & ~0x18) | r << 3;
      const u = (((nd ^ 8) - 8) < -8 ? -8 : ((nd ^ 8) - 8) > 7 ? 7 : (nd ^ 8) - 8) & 15;
      s.flags = (s.flags & ~0xE4 & 255) | (u & 7) << 5 | (u >> 1 & 4);
    }
  }
  if (v10) q.chain.set(b.subarray(pos, pos + 84));
  else if (!chainFromV9(q.chain, b, pos)) return null;
  pos += chn;
  const m = q.motion;
  if (v10) {
    m.count = b[pos]; m.on = b[pos + 1]; m.rsv = [b[pos + 2], b[pos + 3]];
    for (let i = 0; i < T.MOTION_MAX; i++) m.ev[i] = [b[pos + 4 + 3 * i], b[pos + 5 + 3 * i], (b[pos + 6 + 3 * i] << 24) >> 24];
  } else {
    if (b[pos] > 64) return null;
    m.count = b[pos]; m.on = b[pos + 1];
    for (let i = 0; i < m.count; i++) {
      const e = pos + 4 + 4 * i, v = i16(b, e + 2);
      if (v < -64 || v > 127) return null;
      m.ev[i] = [b[e], b[e + 1], (v << 24) >> 24];
    }
  }
  for (let i = 0; i < m.count && i < T.MOTION_MAX; i++) {          /* proj_motion_ids */
    const id = m.ev[i][1] & 127;
    if (id >= np) return null;
    if (np < T.P_COUNT && id >= np - 8) m.ev[i][1] = (m.ev[i][1] & 128) | (id + T.P_COUNT - np);
  }
  if (!chainValid(q.chain) || !motionValid(m)) return null;
  if (v10) {                                                    /* proj_midi_unpack */
    const v = b[MIDI_OFF] | b[MIDI_OFF + 1] << 8 | b[MIDI_OFF + 2] << 16;
    for (let k = 0; k < T.NTRK; k++) { const f = (v >> (5 * k)) & 31; q.mch[k] = f < T.MCH_N ? f : 0; }
    if (v >> 23) q.g[T.G_ROUTE] = T.ROUTE_TRACK;
  }
  for (let t = 0; t < T.NTRK; t++)
    q.fm6[t] = v7 ? Uint8Array.from(T.FM6_INIT) : Uint8Array.from(b.subarray(end + t * T.FM6_PACKED, end + (t + 1) * T.FM6_PACKED), (x) => x & 0x7F);
  q.name = nameGet(b.subarray(nameOff, nameOff + NAME_LEN));
  if (np < T.P_COUNT) log.push({ rule: "params", text: `${np} parameters -> ${T.P_COUNT}: ${T.P_COUNT - np} new ones at their defaults` });
  if (!v10) log.push({ rule: "project", text: `song chain: ${q.chain[0]} rows -> sections; motion: ${m.count} records (4 -> 3 bytes)` });
  if (v7) log.push({ rule: "project", loss: true, text: "FUN7: no FM6 patches stored: every track gets the init patch" });
  drumsToPart(q, log);
  projPhys(q, log);
  return q;
}

/* proj_bound: the steps inside their fields, every value inside its range (param_fit) */
function bound(q, log) {
  let fit = 0;
  q.t.forEach((d) => {
    for (const s of d.step) {
      if (s.n > 4) s.n = 4;
      if (s.time > T.ST_REST) s.time = T.ST_REST;
      for (let j = 0; j < 4; j++) s.note[j] &= 127;
      s.acc &= s.hit;
      s.vel &= 127;
      if (s.probability >= T.COND_LIMIT) s.probability = 0;
    }
    for (let i = 0; i < T.P_COUNT; i++) {
      const v = toInt16(paramFit(desc(d.engine, i), d.p[i]));
      if (v !== d.p[i]) fit++;
      d.p[i] = v;
    }
  });
  if (fit) log.push({ rule: "enums", text: `${fit} values brought inside their ranges (retired KITs, FM6 bank SLOTs -> OWN, out of range)` });
}

/* proj_pack -> FUN10 bytes, or null */
function pack(q) {
  for (const f of q.fm6) if (f.some((x) => x > 127)) return null;
  if (!chainValid(q.chain) || !motionValid(q.motion)) return null;
  const b = new Uint8Array(STORE);
  put32(b, 0, FUN[10]); put32(b, 4, STORE);
  q.g.forEach((v, i) => put16(b, 8 + 2 * i, v));
  b[62] = q.sel & 255; b[63] = q.parts & 255; b[64] = q.phys & 255; b[66] = T.P_COUNT;
  let pos = 68;
  for (const d of q.t) {
    for (let i = 0; i < T.P_COUNT; i++) { if (d.p[i] < -64 || d.p[i] > 127) return null; b[pos++] = d.p[i] + 64; }
    b[pos++] = d.engine; b[pos++] = d.preset;
    for (const s of d.step) {
      const r = (s.flags >> 3) & 3, nd = ((s.flags >> 5) | (s.flags & 4) << 1) & 15;
      if (s.n > 4 || s.time > T.ST_REST || s.probability >= T.COND_LIMIT) return null;
      for (let j = 0; j < 4; j++) b[pos++] = (s.note[j] > 127 ? 127 : s.note[j]) | ((nd >> j) & 1) << 7;
      b[pos++] = s.n | s.time << 3 | (s.flags & 3) << 5;
      b[pos++] = (s.vel > 127 ? 127 : s.vel) | (r & 1) << 7;
      b[pos++] = s.hit;
      b[pos++] = s.acc & s.hit;
      b[pos++] = s.probability | (r >> 1) << 7;
    }
  }
  if (pos + 84 + 388 > MIDI_OFF) return null;
  b.set(q.chain, pos); pos += 84;
  const m = q.motion;
  b[pos] = m.count; b[pos + 1] = m.on; b[pos + 2] = m.rsv[0]; b[pos + 3] = m.rsv[1];
  m.ev.forEach((e, i) => { b[pos + 4 + 3 * i] = e[0]; b[pos + 5 + 3 * i] = e[1]; b[pos + 6 + 3 * i] = e[2] & 255; });
  let v = 0;                                                    /* proj_midi_pack */
  for (let k = 0; k < T.NTRK; k++) v |= (q.mch[k] < T.MCH_N ? q.mch[k] : 0) << (5 * k);
  if (q.g[T.G_ROUTE] === T.ROUTE_TRACK) {
    const c = q.mch, same = c.every((x) => x === c[0]);
    put16(b, 8 + 2 * T.G_ROUTE, !same || c[0] % 4 || c[0] >= 16 ? 0 : c[0] ? Math.floor(c[0] / 4) + 1 : 0);
    v |= 1 << 23;
  }
  b[MIDI_OFF] = v & 255; b[MIDI_OFF + 1] = v >> 8 & 255; b[MIDI_OFF + 2] = v >> 16 & 255;
  q.fm6.forEach((f, t) => b.set(f, FM6_OFF + t * T.FM6_PACKED));
  b.set(nameGet(q.name), NAME_OFF);
  put32(b, STORE - 4, fnv1a(b, STORE - 4));
  return b;
}

/* proj_import_any + proj_engines_ok + proj_fm4 + proj_perc (the decoded project), then proj_bound and proj_pack: the
   bytes a device holds in its RAM slot after reading this stored project (project.c proj_fetch) */
function importProject(bytes, log) {
  const b = bytes;
  let n = b.length, q = null;
  if (n === STORE && u32(b, 0) === FUN[10]) q = unpack(b, STORE, log);
  else {
    if (n === STORE && u32(b, 4) >= 8 && u32(b, 4) < STORE) n = u32(b, 4);   /* (a retained RAM slot of an older record) */
    if (n === SIZE[9] && u32(b, 0) === FUN[9]) q = unpack(b, SIZE[9], log);
    else if (n === SIZE[8] && u32(b, 0) === FUN[8]) q = unpack(b, SIZE[8], log);
    else if (n === SIZE[7] && u32(b, 0) === FUN[7]) q = unpack(b, SIZE[7], log);
    else if (n === T.PROJECT_T_SIZE && u32(b, 0) === FUN[10])
      throw new MigrationError("a decoded RAM image (not a stored format): not supported", "unsupported");
    else {
      q = importOld(b, n, log);
      if (q) { q.fm6 = q.fm6.map(() => Uint8Array.from(T.FM6_INIT)); log.push({ rule: "project", loss: true, text: "no FM6 patches stored before FUN8: every track gets the init patch" }); }
    }
  }
  if (!q) return null;
  q.t.forEach((d, k) => { if (d.engine >= T.ENG_ID_MAX) throw new MigrationError(`track ${k + 1}: engine byte ${d.engine} is past the engine id space`); });
  projFm4(q, log);
  projPerc(q, log);
  return q;
}

/* a stored project (any format) -> {bytes: FUN10 of P_COUNT, from: its format, log: [{track?, rule, text, loss?}],
   tracks: [{before, after}]} as the firmware converts it. Throws MigrationError (nothing converted) when the bytes are
   no project this firmware reads: a later format, a damaged one, a FUN10 of more parameters */
export function migrateProject(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  const f = projectFormat(b), log = [];
  if (f.fmt === 10 && f.np > T.P_COUNT)
    throw new MigrationError(`a FUN10 of ${f.np} parameters (a later firmware's): not converted`, "newer");
  let q;
  try { q = importProject(b, log); } catch (e) { if (e instanceof MigrationError) throw e; throw new MigrationError(e.message); }
  if (!q) throw new MigrationError(f.fmt ? `FUN${f.fmt}: its contents fail the firmware's checks: not converted` : "not a project this firmware reads (unknown or damaged): not converted", f.fmt ? "invalid" : "unknown");
  bound(q, log);
  const out = pack(q);
  if (!out) throw new MigrationError("the converted project does not fit FUN10: not converted");
  return { bytes: out, from: f, to: { fmt: 10, np: T.P_COUNT, size: STORE }, log,
    tracks: q.t.map((d) => ({ engine: d.engine, engineName: engName(d.engine), preset: d.preset,
      before: d.src ? { engine: d.src.engine, engineName: engName(d.src.engine), preset: d.src.preset } : null })),
    name: String.fromCharCode(...nameGet(q.name)), same: out.length === b.length && out.every((x, i) => x === b[i]) };
}

/* ---------------------------------------------------------- user presets --- */
const rec = (bank, i) => bank.subarray(8 + i * UP_REC, 8 + (i + 1) * UP_REC);
const upValue = (r, k) => (r[1] >= 4 ? r[16 + k] - 64 : i16(r, 16 + 2 * k));
const upSetValue = (r, k, v) => { if (r[1] >= 4) r[16 + k] = (v + 64) & 255; else put16(r, 16 + 2 * k, v); };
function upValid(r) {
  if (!(r[0] === T.UP_USED && r[1] >= 1 && r[1] <= T.UP_VER_GRID && r[2] < T.ENG_ID_MAX && r[3] >= 8 &&
        r[3] <= (r[1] >= 4 ? T.UP_PMAX * 2 : T.UP_PMAX) && r[4])) return false;
  if (r[1] >= 4) for (let i = 0; i < r[3]; i++) if (r[16 + i] > 191) return false;
  return true;
}
const upGrid = (r) => r[1] === 3 || r[1] === T.UP_VER_GRID;
/* up_migrate: a PHYS DRUM or SAMPLE PERC record -> DRUM, its E values in place; true when it was one */
function upMigrate(r) {
  if (!upValid(r)) return false;
  const np = r[3], p = new Array(T.P_COUNT).fill(0);
  for (let k = 0; k < 8; k++) p[T.P_E0 + k] = upValue(r, np - 8 + k);
  if (!(drumFromPhys(r[2], p) || drumFromPerc(r[2], p))) return false;
  r[2] = T.ENGI_DRUM;
  for (let k = 0; k < 8; k++) upSetValue(r, np - 8 + k, p[T.P_E0 + k]);
  return true;
}
function patNorm(r, k) {
  let note = r[160 + k] & 127, flags = r[176 + k];
  if (flags & 4) { note = 0; flags = 4; } else flags = note ? flags & (1 | 2 | 0x18) : 0;
  r[160 + k] = note; r[176 + k] = flags;
}
/* up_values: the record's values in today's order (by count), PHYS DUST of version 1, each inside its range */
function upValues(r) {
  const np = r[3], vals = [];
  for (let i = 0; i < np; i++) vals.push(upValue(r, i));
  const v = paramsByCount(vals, np, TP_DEF);
  if (r[1] === 1 && T.ENG_IS_PHYS[r[2]]) physLegacy(v);
  for (let i = 0; i < T.P_COUNT; i++) v[i] = toInt16(paramFit(desc(r[2], i), v[i]));
  return v;
}
export const upfTag = (r) => fnv1a(r, UP_REC, (i) => i >= 4 && i < 16);
/* the firmware's UP_GET reply of r sent back as UP_PUT (editor.c; upreset.c up_parse) -> the new record, or a reason */
function roundTrip(r) {
  const v = upValues(r), name = [];
  for (let i = 0; i < 12 && r[4 + i]; i++) name.push(r[4 + i] & 127);
  let n = 0;
  while (n < name.length && name[n]) n++;
  if (!n || n > 12 || name.slice(0, n).some((c) => c < 32 || c > 126)) return "its name is not 1..12 printable characters";
  if (!(T.ENG_OK[r[2]] || r[2] === T.ENGI_DIGITAL)) return `${engName(r[2])} is not on this firmware`;
  const vals = v.map((x) => clamp(x, -8192, 8191));
  if (vals.some((x) => x < -64 || x > 127)) return "a value outside -64..127";
  const o = new Uint8Array(UP_REC);
  o[0] = T.UP_USED; o[1] = T.UP_VER; o[2] = r[2] & 127; o[3] = T.P_COUNT;
  for (let i = 0; i < n; i++) o[4 + i] = name[i];
  vals.forEach((x, i) => { o[16 + i] = x + 64; });
  const cat = r[1] >= 4 && r[3] <= UP_CAT_AT && r[16 + UP_CAT_AT] && r[16 + UP_CAT_AT] < T.CAT_N ? r[16 + UP_CAT_AT] : 0;
  if (upGrid(r)) {
    o[1] = T.UP_VER_GRID;
    for (let i = 0; i < 16; i++) { o[160 + i] = r[160 + i]; o[176 + i] = r[176 + i] & r[160 + i]; }
    if (cat) o[16 + UP_CAT_AT] = cat;
  } else {
    for (let i = 0; i < 16; i++) { o[160 + i] = r[160 + i] & 127; o[176 + i] = r[176 + i] & 127; patNorm(o, i); }
    if (cat) o[16 + UP_CAT_AT] = cat;
    upMigrate(o);
  }
  upValues(o).forEach((x, i) => upSetValue(o, i, x));
  return o;
}
const slotName = (b, i) => `U${String(b * 16 + i + 1).padStart(2, "0")}`;
/* a user preset bank (UPB1, `which` 0 / 1: slots U01..U16 / U17..U32) -> {bytes, records: [{slot, name, status, ...}]}
   as the firmware keeps it (up_bank_check) with every legacy record rewritten as version 4 / 5 of P_COUNT. Records it
   cannot rewrite (an engine this firmware lacks, a name UP_PUT refuses, a later version) stay as they are */
export function migrateUserBank(bytes, which = 0) {
  const src = Uint8Array.from(bytes);                  /* (a copy: a Node Buffer's slice() would share its memory) */
  if (src.length !== UP_BANK || u32(src, 0) !== UP_MAGIC || (src[4] | src[5] << 8) !== UP_REC || (src[6] | src[7] << 8) !== UP_SLOTS_PER_BANK)
    throw new MigrationError("not a user preset bank this firmware reads (another magic, record size or count): not converted", "unknown");
  const b = src.slice(), records = [];
  for (let i = 0; i < UP_SLOTS_PER_BANK; i++) {
    const r = rec(b, i), was = src.subarray(8 + i * UP_REC, 8 + (i + 1) * UP_REC);
    const nm = [];
    for (let k = 4; k < 16 && was[k]; k++) nm.push(was[k] >= 32 && was[k] <= 126 ? was[k] : 63);
    const info = { slot: slotName(which, i), index: i, ver: was[1], np: was[3], engine: was[2], engineName: engName(was[2]),
      name: String.fromCharCode(...nm), notes: [] };
    if (!upValid(r)) {
      info.status = r[0] === T.UP_USED ? "kept" : "empty";
      if (r[0] === T.UP_USED) info.notes.push(r[1] > T.UP_VER_GRID ? `record version ${r[1]} (a later firmware's): kept as it is` : "not a valid record: kept as it is");
      records.push(info);
      continue;
    }
    const migrated = upMigrate(r);
    if (migrated) info.notes.push(was[2] === T.ENGI_PHYS ? "PHYS MODEL DRUM -> DRUM" : "SAMPLE PERC -> DRUM (the default kit; its EDIT values replaced)");
    for (let k = 0; k < 16; k++) {
      if (upGrid(r)) r[176 + k] &= r[160 + k];
      else patNorm(r, k);
    }
    const legacy = (r[1] < T.UP_VER || r[3] < T.P_COUNT) && r[3] <= T.P_COUNT;
    if (legacy) {
      const o = roundTrip(r);
      if (typeof o === "string") { info.status = "refused"; info.notes.push(`not converted: ${o}`); }
      else {
        r.set(o);
        info.status = "converted";
        info.notes.unshift(`version ${was[1]}, ${was[3]} parameters -> version ${o[1]}, ${T.P_COUNT}`);
        if (was[1] === 1 && T.ENG_IS_PHYS[was[2]] && upValue(was, was[3] - 8) === 2) info.notes.push("PHYS DUST -> MODAL bowed");
      }
    } else if (r[3] > T.P_COUNT) {
      info.status = "kept"; info.notes.push(`${r[3]} parameters (a later firmware's): kept as it is`);
    } else info.status = migrated ? "migrated" : r.every((x, k) => x === was[k]) ? "current" : "normalized";
    if (r[2] === T.ENGI_FM6 && !r.every((x, k) => x === was[k]))
      info.notes.push(`FM6: its own patch is linked by tag ${upfTag(was).toString(16)}; the new record's is ${upfTag(r).toString(16)} (re-linking the user presets' FM6 patches is not ported: until then it would load without its own patch)`);
    info.after = { ver: r[1], np: r[3], engine: r[2], engineName: engName(r[2]) };
    records.push(info);
  }
  return { bytes: b, records, same: b.every((x, i) => x === src[i]) };
}

/* ----------------------------------------------------------- dispatch --- */
/* which rule converts a raw store object of `type` (STORE_LIST's) -> "project" | "presets" | null (none ported) */
export function ruleFor(type) {
  if ((type >= 1 && type <= 4) || type === 9) return "project";
  if (type === 5 || type === 6) return "presets";
  return null;
}
/* a raw store object (type, bytes) -> the migration result {kind, bytes, ...}; MigrationError "notPorted" for the
   kinds this library does not convert yet */
export function migrateObject(type, bytes) {
  const rule = ruleFor(type);
  if (rule === "project") return { kind: "project", ...migrateProject(bytes) };
  if (rule === "presets") return { kind: "presets", ...migrateUserBank(bytes, type - 5) };
  throw new MigrationError(`${STORE_TYPES[type] || `type ${type}`}: no conversion ported yet`, "notPorted");
}
/* what the firmware's raw state of a bank cannot show: a CURRENT bank holding records of older versions or counts */
export function bankLegacyRecords(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  if (b.length !== UP_BANK || u32(b, 0) !== UP_MAGIC) return 0;
  let n = 0;
  for (let i = 0; i < UP_SLOTS_PER_BANK; i++) { const r = rec(b, i); if (upValid(r) && (r[1] < T.UP_VER || r[3] < T.P_COUNT)) n++; }
  return n;
}
