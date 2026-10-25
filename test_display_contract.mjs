// SPDX-License-Identifier: GPL-3.0-only
// Actual producer replies and opaque settings bytes; no firmware source or expected baseline edits.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import vm from "node:vm";
import * as protocol from "./app/src/proto.js";
import { bkManifest, bkR32, bkUnpack, bkCrc } from "./fm1backup.js";

export function nativeDisplayContract() {
  if (!process.env.FELUCCA_ROOT) { console.log("display contract: skipped (set FELUCCA_ROOT to a generated firmware checkout)"); return; }
  const firmware = resolve(process.env.FELUCCA_ROOT), directory = resolve("build/display-contract");
  mkdirSync(directory, { recursive: true });
  const inputs = ["tests/editor_test.c", "firmware/src/editor_menu.c", "firmware/src/editor_preferences.c", "firmware/src/settings_persist.c", "firmware/src/ui.c"];
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const hashes = Object.fromEntries(inputs.map((name) => [name, hash(readFileSync(join(firmware, name)))]));
  const graph = /\{MI_GRAPH,\s*34\}/.test(readFileSync(join(firmware, "firmware/src/editor_menu.c"), "utf8"));
  let source = readFileSync(join(firmware, "tests/editor_test.c"), "utf8");
  assert.equal(source.split("int main(void)").length, 2, "one producer harness entry point");
  source = source.replace("int main(void)", "int original_editor_test_main(void)").replace(/#include "([^"]+)"/g, (_, path) => '#include "' + resolve(firmware, "tests", path) + '"');
  source += String.raw`
static void json_bytes(const uint8_t *p,uint32_t n){putchar('[');for(uint32_t i=0;i<n;i++)printf("%s%u",i?",":"",p[i]);putchar(']');}
static void json_frame(void){json_bytes(host_wire,host_wire_n);}
static void json_desc(uint32_t id){for(uint32_t i=0;i<ED_MENU_N;i++)if(ED_MENU[i][1]==id){uint8_t a=i;request(ED_MENU_DESC,&a,1);json_frame();return;}printf("null");}
int main(void){
 reset();panel=PANEL_DEFAULT;
 printf("{\"info\":");request(ED_INFO,0,0);json_frame();
 printf(",\"state\":");request(ED_UI_STATE,0,0);json_frame();
 printf(",\"menu\":[");for(uint32_t i=0;i<ED_MENU_N;i++){uint8_t a=i;if(i)putchar(',');request(ED_MENU_DESC,&a,1);json_frame();}putchar(']');
 printf(",\"invalidPreferences\":[");for(uint32_t i=4;i<=5;i++){uint8_t a[2]={i,1};if(i>4)putchar(',');request(ED_UI_SET,a,2);json_frame();}putchar(']');
 printf(",\"legacyWrites\":[");uint32_t first=1;
 for(uint32_t id=1;id<=2;id++)for(int32_t v=0;v<=1;v++){if(!first)putchar(',');first=0;printf("{\"reply\":");menu_set(id,v);json_frame();printf(",\"descriptor\":");json_desc(id);printf(",\"styleByte\":%u,\"largeBit\":%u}",settings_dev[29],!!(settings_dev[30]&32));}putchar(']');
 menu_set(1,1);menu_set(2,1);
 printf(",\"unrelatedWrites\":[");for(uint32_t id=3;id<=4;id++){if(id>3)putchar(',');printf("{\"reply\":");menu_set(id,id==3?2:5);json_frame();printf(",\"descriptor\":");json_desc(id);putchar('}');}putchar(']');
 printf(",\"graphWrites\":[");
`;
  if (graph) source += String.raw`
 {const int32_t values[]={0,1,2,3,99,-1};for(uint32_t i=0;i<6;i++){
 uint8_t before[sizeof settings_dev];memcpy(before,settings_dev,sizeof before);if(i)putchar(',');
 printf("{\"requested\":%d,\"reply\":",values[i]);menu_set(34,values[i]);json_frame();
 uint32_t same=1;for(uint32_t j=0;j<sizeof settings_dev;j++)same&=j==10?((before[j]&~6u)==(settings_dev[j]&~6u)):(before[j]==settings_dev[j]);
 printf(",\"descriptor\":");json_desc(34);printf(",\"mode\":%u,\"byte10\":%u,\"preserved\":%u}",graph_mode(),settings_dev[10],same);
 }}
`;
  source += String.raw`
 printf("],\"unknownWrite\":");menu_set(126,1);json_frame();
 printf(",\"backupList\":");request(ED_BACKUP_LIST,0,0);json_frame();
 uint32_t len;const uint8_t *bytes=ed_bk_object(1,&len);
 printf(",\"backup\":");json_bytes(bytes,len);
 printf(",\"backupGet\":[");for(uint32_t off=0;off<len;off+=256){uint32_t count=len-off>256?256:len-off;uint8_t a[8]={1,0,0,0,0,0,count&127,count>>7};for(uint32_t j=0;j<5;j++)a[1+j]=(off>>(j*7))&127;if(off)putchar(',');request(ED_BACKUP_GET,a,8);json_frame();}putchar(']');
 static persist_rec_t input,after;memcpy(&input,bytes,len);memset(settings_dev,0,sizeof settings_dev);uint32_t imported=settings_import((persist_t*)&input,len);settings_export_rec(&after);
 printf(",\"imported\":%u,\"roundtrip\":",imported);json_bytes((const uint8_t*)&after,persist_len(&after));
 printf(",\"restoredStyle\":%u,\"restoredLarge\":%u,\"restoredByte10\":%u}\n",settings_dev[29],!!(settings_dev[30]&32),settings_dev[10]);return 0;
}
`;
  const page = readFileSync("editor.html", "utf8");
  const classic = vm.runInNewContext(page.slice(page.indexOf("/*PROTO-BEGIN*/"), page.indexOf("/*PROTO-END*/")) + ";({CMD,parse})", { setTimeout, clearTimeout, setInterval, clearInterval });
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: firmware, encoding: "utf8" }).trim();
  for (const [name, flags] of [["normal", []], ["nocpu2", ["-DFELUCCA_CPU2=0"]]]) {
    const path = join(directory, name + ".c"), binary = join(directory, name); writeFileSync(path, source);
    const command = ["-O1", "-Wall", "-Wno-unused-function", "-w", "-I" + join(firmware, "build/gen"), "-I" + join(firmware, "firmware/src"), ...flags, path, "-lm", "-o", binary];
    execFileSync(process.env.CC || "cc", command, { cwd: firmware, stdio: "pipe" });
    const data = JSON.parse(execFileSync(binary, { encoding: "utf8", maxBuffer: 4 << 20 }));
    const payload = (wire) => { const frame = protocol.unframe(wire); assert.ok(frame); return frame.a; };
    for (const E of [protocol, classic]) {
      const info = E.parse[E.CMD.INFO](payload(data.info)), state = E.parse[E.CMD.UI_STATE](payload(data.state));
      assert.equal(info.uiCaps, state.caps); if (graph) assert.equal(info.uiCaps, 57);
      assert.equal(info.menuCount, data.menu.length);
    }
    const menu = data.menu.map((wire) => protocol.parse[protocol.CMD.MENU_DESC](payload(wire)));
    assert.equal(menu.length, (graph ? 35 : 34) - (flags.length ? 1 : 0));
    assert.equal(menu.some((m) => m.id === 32), !flags.length);
    assert.ok(menu.some((m) => m.id === 33));
    assert.deepEqual(menu.find((m) => m.id === 1).names, ["FLAT", "LINE"]);
    assert.deepEqual(menu.find((m) => m.id === 2).names, ["OFF", "ON"]);
    for (const E of [protocol, classic]) for (const [index, wire] of data.invalidPreferences.entries()) {
      const reply = E.parse[E.CMD.UI_SET](payload(wire));
      assert.equal(reply.rc, 1); assert.equal(reply.id, index + 4); assert.equal(reply.value, 1);
    }
    for (const write of data.legacyWrites) {
      const reply = protocol.parse[protocol.CMD.MENU_SET](payload(write.reply));
      const descriptor = protocol.parse[protocol.CMD.MENU_DESC](payload(write.descriptor));
      assert.equal(reply.rc, 3); assert.equal(descriptor.value, reply.value);
      if (descriptor.id === 1) assert.equal(write.styleByte, descriptor.value);
      else assert.equal(write.largeBit, descriptor.value);
    }
    for (const write of data.unrelatedWrites) {
      const reply = protocol.parse[protocol.CMD.MENU_SET](payload(write.reply));
      assert.equal(reply.rc, 3); assert.equal(reply.value, reply.id === 3 ? 2 : 5);
    }
    if (graph) {
      const row = menu.find((m) => m.id === 34);
      assert.deepEqual(row.names, ["SCOPE", "TURN", "CURVE", "STILL"]); assert.equal(row.value, 1);
      for (const write of data.graphWrites) {
        const reply = protocol.parse[protocol.CMD.MENU_SET](payload(write.reply));
        const value = Math.max(0, Math.min(3, write.requested));
        assert.equal(reply.rc, 3); assert.equal(reply.id, 34); assert.equal(reply.value, value);
        assert.equal(write.mode, value); assert.equal(write.byte10 & 1, 1); assert.equal(write.preserved, 1);
        assert.equal(protocol.parse[protocol.CMD.MENU_DESC](payload(write.descriptor)).value, value);
      }
    }
    assert.equal(protocol.parse[protocol.CMD.MENU_SET](payload(data.unknownWrite)).rc, 1);
    const record = Uint8Array.from(data.backup), copied = new Uint8Array(record.length);
    const listed = bkManifest(payload(data.backupList)).find((item) => item.id === 1);
    assert.equal(listed.size,record.length);assert.equal(listed.crc,bkCrc(record));
    for (const wire of data.backupGet) {
      const a = payload(wire); assert.equal(a[0], 1); assert.equal(a[1], 0);
      copied.set(bkUnpack(a.slice(9), a[7] | a[8] << 7), bkR32(a, 2));
    }
    assert.deepEqual(copied, record); assert.equal(data.imported, 1);
    assert.deepEqual(data.roundtrip, data.backup); assert.equal(data.restoredStyle, 1); assert.equal(data.restoredLarge, 1);
    if (graph) assert.equal(data.restoredByte10 & 7, 3);
    Object.assign(data,{ revision, cpu2: !flags.length, graph, hashes, compiler: process.env.CC || "cc", command, program_sha256: hash(source) });
    const encoded = JSON.stringify(data) + "\n";
    writeFileSync(join(directory, name + ".json"), encoded);
    mkdirSync(join(directory, revision), { recursive: true });
    writeFileSync(join(directory, revision, name + ".json"), encoded);
    console.log(`display contract: ${revision} CPU2=${!flags.length} INFO/UI_STATE, MENU${menu.length}, legacy/GRAPH writes, settings storage and actual backup wire/opaque roundtrip passed`);
  }
}
