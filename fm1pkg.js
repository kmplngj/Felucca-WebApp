// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
//
// FM-1 .fwsc package handling in the browser.
//   logicalImage, productOf  the image the device reads during an update and the
//                            package identity (used by the installer, index_pkg.html)
//   Package, buildFeluccaPackage  a port of tools/fm1fw.py `patch`: put the Felucca app
//                            into the user's official V15 package (same size, SFC cipher
//                            with the chip key, CRCs) and set the identity. No page uses it
//                            since the installer ships an M-VAVE-free package
//                            (tools/fm1pkg_make.py); web/test_web.mjs keeps it
//                            byte-identical to fm1fw.py.

const BLOCKS = 20, BLK = 0x30, KEEP = 0x2F;
export const STOCK_V15_SHA256 = "db1642b2b6fa5c2cccb11ffd13878068bb28601678d3644049f99dc40e7edb8a";
export const STOCK_APP_SIZE = 0x8DFBC;
export const STOCK_V15_SIZE = 699956;
// M-VAVE's unmodified official FM-1 firmware files (FM-1.fwsc), reviewed for a return to stock (Felucca #619):
// the exact files only, as tools/fm1_install.py STOCK_SHA256 and firmware/src/ota.c OTA_STOCK pin them. An
// FM-1_0NN identity alone is no evidence: modified packages reuse FM-1_016. Both files carry the same update
// loader (STOCK_OTA: its ota.bin size and heads), which answers the handshake with STOCK_LOADER.
export const STOCK_PINS = {
  "FM-1_015": { version: "V15", size: STOCK_V15_SIZE, sha256: STOCK_V15_SHA256,
    flashSize: 0x93000, appOff: 16672, appSize: STOCK_APP_SIZE },
  "FM-1_016": { version: "V16", size: 718196, sha256: "d017fb65e70aca97ee29d944470c3515a74581df5c0576bf70de917c7b2b61d5",
    flashSize: 0xA9000, appOff: 16704, appSize: 597928 },
};
export const STOCK_LOADER = "ota-FM-1_015";
// Felucca's own update loader (tools/fm1_install.py LOADER_FAMILIES "felucca-v1"): the only one a Felucca package is
// written through, resumed or newly staged; M-VAVE's (STOCK_LOADER) would write it over the whole flash
export const FELUCCA_LOADER = "ota-FM-1_900";
const STOCK_OTA = { size: 19969, hcrc: 0xEBAA, dcrc: 0x5881, len: 0x4DE1 };
export const STOCK_MAX_SIZE = 0x200000;   // a larger file is refused before it is read (fm1_install.py MAX_PKG)
const STOCK_RE = /^FM-1_0\d\d$/;           // M-VAVE's identities (M-UPGRADE versions): pinned files only
const MBOOT_PRODUCT = "FM-1_099";          // m-bootloader's installer (jvitkauskas/m-bootloader)
// M-VAVE's FM1 Open firmware, as a package and on the device (fm1ota.js): its updater takes only a package
// it was armed for first, which Felucca's installers do not do
export const OPEN_RE = /^(?:FM1_OFFICIAL_OPEN|FM1_COMMUNITY_\d+|FM-1_8\d{6})$/;

const T = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i << 8;
  for (let k = 0; k < 8; k++) c = c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1;
  T[i] = c & 0xFFFF;
}

export function crc16(d, crc = 0) {
  for (let i = 0; i < d.length; i++) crc = ((crc << 8) & 0xFFFF) ^ T[((crc >> 8) ^ d[i]) & 0xFF];
  return crc;
}

function enc(buf, off, size, key = 0xFFFF) {
  for (let i = 0; i < size; i++) {
    buf[off + i] ^= key & 0xFF;
    key = ((key * 2) ^ (key & 0x8000 ? 0x1021 : 0)) & 0xFFFF;
  }
}

function sfc(buf, off, size, base, key) {
  for (let i = 0; i < size; i += 32) enc(buf, off + i, Math.min(size - i, 32), key ^ ((off + i - base) >> 2));
}

function chipkeyDecode(d) {
  let sum = 0;
  for (let i = 0; i < 16; i++) sum += d[i];
  sum &= 0xFF;
  sum = sum >= 0xE0 ? 0xAA : sum <= 0x10 ? 0x55 : sum;
  let k = 0;
  for (let i = 0; i < 16; i++) if ((d[16 + i] ^ d[15 - i]) < sum) k |= 1 << i;
  return k;
}

const align32 = (v) => (v + 31) & ~31;
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
function w16(b, o, v) { b[o] = v & 0xFF; b[o + 1] = (v >> 8) & 0xFF; }
function w32(b, o, v) { w16(b, o, v & 0xFFFF); w16(b, o + 2, (v >>> 16) & 0xFFFF); }

class Entry {                                   // JLFS head, 32 bytes
  constructor(raw, off) {
    this.hdrOff = off;
    this.hcrc = u16(raw, off);
    this.dcrc = u16(raw, off + 2);
    this.offset = u32(raw, off + 4);
    this.size = u32(raw, off + 8);
    this.flags = raw[off + 12];
    this.resvd = raw[off + 13];
    this.index = u16(raw, off + 14);
    this.rawName = raw.slice(off + 16, off + 32);
    const z = this.rawName.indexOf(0);
    this.name = String.fromCharCode(...this.rawName.slice(0, z < 0 ? 16 : z));
    if (crc16(raw.subarray(off + 2, off + 32)) !== this.hcrc) throw new Error(`JLFS header CRC mismatch @${off.toString(16)}`);
  }
  packInto(buf) {
    const o = this.hdrOff;
    w16(buf, o + 2, this.dcrc); w32(buf, o + 4, this.offset); w32(buf, o + 8, this.size);
    buf[o + 12] = this.flags; buf[o + 13] = this.resvd; w16(buf, o + 14, this.index);
    buf.set(this.rawName, o + 16);
    this.hcrc = crc16(buf.subarray(o + 2, o + 32));
    w16(buf, o, this.hcrc);
  }
}

export class Package {
  constructor(bytes) {
    this.raw = new Uint8Array(bytes);
    this.parseUfw();
    this.flash = this.raw.slice(this.flashFileOff, this.flashFileOff + this.flashSize);
    this.parseFlash();
  }

  get product() { return productOf(this.raw); }

  setProduct(name) {
    if (name.length > BLOCKS) throw new Error("product name too long");
    for (let i = 0; i < BLOCKS; i++) {
      const m = i < name.length ? (name.charCodeAt(i) + i + 1) & 0xFF : 0x7D;
      if (i < name.length && m === 0x7D) throw new Error("product name encodes to the unused marker");
      this.raw[i * BLK + KEEP] = m;
    }
  }

  headerBytes() {
    const h = new Uint8Array(BLOCKS * KEEP);
    for (let i = 0; i < BLOCKS; i++) h.set(this.raw.subarray(i * BLK, i * BLK + KEEP), i * KEEP);
    return h;
  }

  hdrFileOff(i) { return Math.floor(i / KEEP) * BLK + (i % KEEP); }

  parseUfw() {
    const h = this.headerBytes();
    enc(h, 0, 0x40);
    const hcrc = u16(h, 0), lcrc = u16(h, 2), nent = u16(h, 8);
    if (crc16(h.subarray(2, 0x40)) !== hcrc) throw new Error("not an FM-1 .fwsc (UFW header CRC mismatch)");
    this.skew = BLOCKS * BLK - h.length;
    this.ufw = h;
    this.nent = nent;
    const hsize = 0x40 + nent * 0x50;
    if (crc16(h.subarray(0x40, hsize)) !== lcrc) throw new Error("UFW entry list CRC mismatch");
    this.entries = [];
    for (let off = 0x40; off < hsize; off += 0x50) {
      const e = h.slice(off, off + 0x50);
      enc(e, 0, 0x50);
      const z = e.subarray(0x40, 0x50).indexOf(0);
      this.entries.push({ off, type: u16(e, 0), dcrc: u16(e, 4), dataOff: u32(e, 8), size: u32(e, 12),
        name: String.fromCharCode(...e.subarray(0x40, z < 0 ? 0x50 : 0x40 + z)), plain: e });
    }
    const fl = this.entries.find((e) => e.type === 0);
    if (!fl) throw new Error("no flash.bin in the package");
    this.flashEntry = fl;
    this.flashFileOff = fl.dataOff + this.skew;
    this.flashSize = fl.size;
    if (crc16(this.raw.subarray(this.flashFileOff, this.flashFileOff + fl.size)) !== fl.dcrc) throw new Error("flash.bin CRC mismatch");
  }

  parseFlash() {
    const dec = this.flash.slice();
    const h = dec.slice(0, 32);
    enc(h, 0, 32);
    if (crc16(h.subarray(2, 32)) !== u16(h, 0)) throw new Error("flash header CRC mismatch");
    this.chipKey = null; this.appBase = null;
    for (let off = 32; ; off += 32) {
      enc(dec, off, 32);
      const e = new Entry(dec, off);
      if (e.name === "isd_config.ini") {
        const blob = dec.subarray(e.offset, e.offset + 34);
        if (crc16(blob.subarray(0, 32)) === u16(blob, 32)) this.chipKey = chipkeyDecode(blob.subarray(0, 32));
      }
      if (e.flags === 0x81 && e.name === "app_dir_head" && this.appBase === null) this.appBase = e.offset;
      if (e.index) break;
    }
    if (this.chipKey === null || this.appBase === null) throw new Error("chip key or app_dir_head not found");
    const b = this.appBase, k = this.chipKey, end = align32(b + 32);
    sfc(dec, b, end - b, b, k);
    const head = new Entry(dec, b);
    const blkEnd = b + head.size;
    if (blkEnd > end) sfc(dec, end, blkEnd - end, b, k);
    this.sfcEnd = Math.max(end, blkEnd);
    this.cfgLen = 0;
    const probe = this.flash.slice(b, align32(blkEnd) + 32);
    sfc(probe, 0, probe.length, 0, k);
    try {
      const cfg = new Entry(probe, blkEnd - b);
      if (cfg.name === "cfg" && blkEnd + cfg.size <= this.flash.length) this.cfgLen = cfg.size;
    } catch (_) { /* no cfg block */ }
    if (this.cfgLen) {
      const region = this.flash.slice(b, blkEnd + this.cfgLen);
      sfc(region, 0, region.length, 0, k);
      dec.set(region, b);
      this.sfcEnd = blkEnd + this.cfgLen;
    }
    this.head = head;
    this.app = null;
    for (let off = b + 32; ; off += 32) {
      const e = new Entry(dec, off);
      if (e.flags === 0x82 && e.name === "app.bin") this.app = e;
      if (e.index) break;
    }
    if (!this.app) throw new Error("app.bin not found in app area");
    this.appOff = b + this.app.offset;
    this.dec = dec;
  }

  // the new app, padded to the stock size (Felucca never changes the layout)
  setApp(app) {
    if (app.length > this.app.size) throw new Error(`app is ${app.length} B, the slot is ${this.app.size} B`);
    const nw = new Uint8Array(this.app.size).fill(0xFF);
    nw.set(app);
    const a = this.app, h = this.head, b = this.appBase;
    this.dec.set(nw, this.appOff);
    a.dcrc = crc16(nw);
    a.packInto(this.dec);
    h.dcrc = crc16(this.dec.subarray(h.hdrOff + 32, h.hdrOff + h.size));
    h.packInto(this.dec);
    this.sfcEnd = Math.max(align32(b + 32), b + h.size + this.cfgLen);
    const region = this.dec.slice(b, this.sfcEnd);
    sfc(region, 0, region.length, 0, this.chipKey);
    this.flash.set(region, b);
  }

  serialize() {
    const out = this.raw.slice();
    out.set(this.flash, this.flashFileOff);
    const fl = this.flashEntry, e = fl.plain.slice();
    w16(e, 4, crc16(this.flash));
    enc(e, 0, 0x50);
    const h = this.ufw.slice();
    h.set(e, fl.off);
    const hsize = 0x40 + this.nent * 0x50;
    w16(h, 2, crc16(h.subarray(0x40, hsize)));
    w16(h, 0, crc16(h.subarray(2, 0x40)));
    enc(h, 0, 0x40);
    for (let i = 0; i < hsize; i++) out[this.hdrFileOff(i)] = h[i];
    return out;
  }
}

// the package identity ("FM-1_904"): one marker byte after each of the first 20 blocks
export function productOf(fwsc) {
  if (fwsc.length < BLOCKS * BLK) throw new Error("not an FM-1 package (too short)");
  let s = "";
  for (let i = 0; i < BLOCKS; i++) {
    const m = fwsc[i * BLK + KEEP];
    if (m !== 0x7D) s += String.fromCharCode((m - i - 1) & 0xFF);
  }
  return s;
}

// the image the device addresses during an update: the .fwsc without the 20 marker bytes
export function logicalImage(fwsc) {
  const out = new Uint8Array(fwsc.length - BLOCKS);
  for (let i = 0; i < BLOCKS; i++) out.set(fwsc.subarray(i * BLK, i * BLK + KEEP), i * KEEP);
  out.set(fwsc.subarray(BLOCKS * BLK), BLOCKS * KEEP);
  return out;
}

export async function sha256hex(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// errors carry a code the installer page translates (detail: the package identity), as fm1ota.js does
function refuse(code, msg, detail = "") { const e = new Error(msg); e.code = code; e.detail = detail; return e; }

// Only one of the user's unmodified official files (STOCK_PINS) is accepted for a return to stock.
// The digest pins every file, loader and flash layout; filenames and identities are not evidence.
export async function validateStockPackage(bytes) {
  const product = productOf(bytes);
  if (OPEN_RE.test(product))
    throw refuse("stockOpenPkg", `${product} is an M-VAVE FM1 Open firmware package: install it with M-VAVE's ` +
      "FM1 Open updater. Felucca's installers do not install it.", product);
  if (product === MBOOT_PRODUCT)
    throw refuse("stockMboot", `${product} is m-bootloader's installer: it replaces the FM-1's bootloader, which ` +
      "Felucca's installers never write. Install m-bootloader with its own instructions if you want it.", product);
  const pin = STOCK_PINS[product];
  if (!pin || bytes.length !== pin.size || await sha256hex(bytes) !== pin.sha256) {
    if (STOCK_RE.test(product))
      throw refuse("stockUnpinned", `${product} is reserved for M-VAVE's official firmware: only the exact reviewed ` +
        `files (${Object.values(STOCK_PINS).map((p) => p.version).join(", ")}) are installed, and this is not one of them.`, product);
    throw refuse("stockNotOfficial", "Select the unmodified official FM-1 V15 or V16 file (FM-1.fwsc).");
  }
  const pkg = new Package(bytes);
  const ota = pkg.entries.find((e) => e.type === 100 && e.name === "ota.bin");
  const head = ota && bytes.subarray(ota.dataOff + pkg.skew, ota.dataOff + pkg.skew + 32);
  if (pkg.flashFileOff !== 1044 || pkg.flashSize !== pin.flashSize || pkg.appBase !== 16384 ||
      pkg.appOff !== pin.appOff || pkg.app.size !== pin.appSize || !ota || ota.size !== STOCK_OTA.size ||
      u16(head, 0) !== STOCK_OTA.hcrc || u16(head, 2) !== STOCK_OTA.dcrc || u32(head, 8) !== STOCK_OTA.len)
    throw refuse("stockLayout", "The official firmware has an unsupported FM-1 layout.");
  return { product, version: pin.version, image: logicalImage(bytes), sha256: pin.sha256, loader: STOCK_LOADER };
}

// official V15 + Felucca app -> installable package (Uint8Array)
export async function buildFeluccaPackage(stockBytes, appBytes, product) {
  const sha = await sha256hex(stockBytes);
  if (sha !== STOCK_V15_SHA256) throw new Error("this is not the official FM-1 V15 firmware file (FM-1.fwsc)");
  const pkg = new Package(stockBytes);
  pkg.setApp(appBytes);
  pkg.setProduct(product);
  return pkg.serialize();
}
