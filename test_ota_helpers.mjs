// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
// Synthetic UFW with a CRC-valid custom loader; no vendor firmware or hardware.
import { crc16 } from "./fm1pkg.js";
export function customImage({ marker = "FELUCCA-LOADER-1", markerOffset = 0x4C } = {}) {
  const image = new Uint8Array(0x93400);
  const w16 = (b, o, n) => { b[o] = n; b[o + 1] = n >>> 8; };
  const w32 = (b, o, n) => { w16(b, o, n); w16(b, o + 2, n >>> 16); };
  const enc = (b) => { let key = 0xFFFF; for (let i = 0; i < b.length; i++) { b[i] ^= key & 255; key = ((key * 2) ^ (key & 0x8000 ? 0x1021 : 0)) & 65535; } };
  const loader = image.subarray(0x200, 0x300);
  w32(loader, 4, 0x20); w32(loader, 8, 0xE0); loader[12] = 0x41;
  w32(loader, 0x24, 0x10000); w32(loader, 0x28, 0x01C0A800);
  // Native producer 758f228 (JieLi Clang 4.0.1): the compressed first literal window starts
  // F1 46 04 88, then the marker, followed by LZ4 token 60 rather than a NUL terminator.
  // Synthetic headers/body below remain CRC-valid; no proprietary file or executable loader is embedded.
  loader.set([0xF1, 0x46, 0x04, 0x88], 0x48);
  const mark = new TextEncoder().encode(marker);
  loader.set(mark, markerOffset); loader[markerOffset + mark.length] = 0x60;
  w16(loader, 0x20, crc16(loader.subarray(0x22, 0x40)));
  w16(loader, 2, crc16(loader.subarray(0x20)));
  w16(loader, 0, crc16(loader.subarray(2, 32)));
  for (const [i, type, off, size] of [[0, 100, 0x200, 0x100], [1, 0, 0x400, 0x93000]]) {
    const entry = new Uint8Array(0x50);
    w16(entry, 0, type); w16(entry, 4, crc16(image.subarray(off, off + size)));
    w32(entry, 8, off); w32(entry, 12, size); enc(entry); image.set(entry, 0x40 + i * 0x50);
  }
  const h = new Uint8Array(0x40); w16(h, 8, 2);
  w16(h, 2, crc16(image.subarray(0x40, 0xE0))); w16(h, 0, crc16(h.subarray(2))); enc(h); image.set(h);
  return image;
}
