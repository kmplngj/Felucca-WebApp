// SPDX-License-Identifier: GPL-3.0-only
// The same INFO version/count can expose either CUSTOM schema. No device I/O.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Device } from "./app/src/device.js";
import { CMD, req, parse, makeMockDevice, PAL_BUILTIN_V2 } from "./app/src/proto.js";
import { roles, builtins, derive, contrastChecks, contrastWarnings } from "./app/src/palette.js";

assert.deepEqual(req.paletteGet(), [80, []]);
assert.deepEqual(req.paletteGet(2), [80, [2]]);
assert.deepEqual(req.paletteSet(2), [81, [2]]);
assert.deepEqual(req.paletteSet(3, undefined, 2), [81, [19]]);
for (const malformed of [[0, 5], [8, 5, ...Array(15).fill(0)], [4, 5, 32, ...Array(14).fill(0)]])
  assert.throws(() => parse[CMD.PALETTE_GET](malformed), /bad palette reply/);

let version, count;
for (const options of [{}, { rejectPaletteProbe: true }, { paletteschema: 2 }, {}, { paletteschema: 2, deferSettings: true }, { paletteschema: 2, noFlash: true }]) {
  const mock = makeMockDevice({ auto: false, ...options }), dev = new Device(mock.access);
  try {
    await dev.open();
    version ??= dev.info.version; count ??= dev.info.pcount;
    assert.equal(dev.info.version, version);
    assert.equal(dev.info.pcount, count);
    const requests = [], requestOptions = [], errors = [], original = dev.rq.bind(dev);
    dev.on("error", (e) => errors.push(e.message));
    dev.rq = (r, o) => { requests.push(r); requestOptions.push(o); return original(r, o); };
    await dev.readPalette();
    const schema = options.paletteschema === 2 ? 2 : 1;
    assert.equal(dev.palette.schema, schema);
    assert.deepEqual(requests[0], [CMD.PALETTE_GET, [2]]);
    assert.deepEqual(requestOptions[0], { quiet: true, retries: 0 });
    assert.deepEqual(errors, []);
    assert.equal(requests.some(([cmd, a]) => cmd === CMD.PALETTE_GET && !a.length), !!options.rejectPaletteProbe);
    assert.deepEqual(roles(schema), schema === 2 ? ["BG", "IDENTITY", "TEXT", "PRIMARY", "SECONDARY"] : ["BG", "SURF", "TEXT", "THEME", "ACCENT"]);
    const c = schema === 2 ? [0x0000, 0xff40, 0xffff, 0xfa49, 0x4c7f] : [0x0000, 0x0841, 0xffff, 0xff40, 0x4c7f];
    assert.equal(await dev.paletteSet(0, c), 0);
    assert.deepEqual(mock.state.custom.preview, c);
    assert.equal(dev.palette.stored, false);
    const save = options.noFlash ? 3 : options.deferSettings ? 4 : 0;
    assert.equal(await dev.paletteSet(1, c), save);
    assert.equal(dev.palette.schema, schema);
    assert.deepEqual(dev.palette.c, c);
    assert.deepEqual(mock.state.custom.c, c);
    assert.equal(dev.palette.active, true);
    await dev.paletteSet(0, [0, 0, 0, 0, 0]);
    assert.deepEqual(mock.state.custom.c, c);
    assert.equal(await dev.paletteSet(3), 0);
    assert.equal(mock.state.custom.preview, null);
    const setRequests = requests.filter(([cmd]) => cmd === CMD.PALETTE_SET);
    assert.deepEqual(setRequests.map(([, a]) => a[0]), schema === 2 ? [16, 17, 16, 19] : [0, 1, 0, 3]);
    assert.deepEqual(setRequests.map(([, a]) => a.length), [16, 16, 16, 1]);
    if (schema === 2) {
      // An old client still gets its old order and cannot overwrite PRIMARY.
      const old = [0x0841, 0x0000, 0xffff, 0x56af, 0xfeab];
      const reply = parse[CMD.PALETTE_SET](await original(req.paletteSet(1, old)));
      assert.equal(reply.schema, 1);
      assert.deepEqual(mock.state.custom.c, [old[0], old[3], old[2], c[3], old[4]]);
      assert.deepEqual(reply.c, [old[0], old[0], old[2], old[3], old[4]]);
      await dev.readPalette();
      assert.equal(dev.palette.c[3], c[3]);
      const before = mock.state.custom.c.slice();
      assert.equal(parse[CMD.PALETTE_SET](await original([CMD.PALETTE_SET, [17, 0]])).rc, 1);
      assert.deepEqual(mock.state.custom.c, before);
    }
    assert.equal(await dev.paletteSet(2), save);
    assert.equal(dev.palette.stored, false);
    assert.equal(mock.state.custom.stored, false);
  } finally { dev.close(); mock.stop(); }
}

// No writes if schema negotiation fails, or after a session closes.
{
  const mock = makeMockDevice({ auto: false }), dev = new Device(mock.access);
  try {
    await dev.open();
    const errors = [];
    dev.on("error", (e) => errors.push(e.message));
    dev.rq = async () => { throw new Error("no reply"); };
    await dev.paletteSet(1, Array(5).fill(0));
    assert.deepEqual(errors, ["palette unavailable"]);
    assert.equal(mock.state.custom.stored, false);
    dev.rq = async () => { throw new Error("closed"); };
    await assert.rejects(dev.readPalette(), /closed/);
  } finally { dev.close(); mock.stop(); }
}

// A response from another schema invalidates negotiation; no stale colours are accepted.
{
  const mock = makeMockDevice({ auto: false, paletteschema: 2 }), dev = new Device(mock.access);
  try {
    await dev.open(); await dev.readPalette();
    const errors = [], original = dev.rq.bind(dev);
    dev.on("error", (e) => errors.push(e.message));
    dev.rq = async (r, o) => {
      const reply = await original(r, o);
      if (r[0] === CMD.PALETTE_SET) reply[1] &= ~4;
      return reply;
    };
    await dev.paletteSet(3);
    assert.deepEqual(errors, ["palette schema changed"]);
    assert.equal(dev.palette, null);
    const requests = [];
    dev.rq = async (r) => { requests.push(r); throw new Error("probe failed"); };
    await dev.paletteSet(1, Array(5).fill(0));
    assert.ok(requests.every(([cmd]) => cmd === CMD.PALETTE_GET));
    assert.equal(mock.state.custom.stored, false);
    dev.close();
    await dev.paletteSet(1, Array(5).fill(0));
    assert.equal(requests.length, 2);
  } finally { dev.close(); mock.stop(); }
}

const native = derive([0, 0xff40, 0xffff, 0xfa49, 0x4c7f], 2);
assert.equal(native.surf, native.bg);
assert.equal(native.theme, 0xff40);
assert.equal(native.rec, 0xfa49);
assert.equal(native.accent, 0x4c7f);
assert.equal(builtins(2).length, 10);
assert.ok(builtins(2).every((p) => contrastWarnings(p.c, 2).length === 0));
assert.equal(contrastWarnings(Array(5).fill(0), 2).length, 10);
assert.ok(contrastChecks(Array(5).fill(0), 2).every((x) => x.a !== "surf" && x.b !== "surf"));
assert.ok(contrastChecks([0, 0xffff, 0xffff, 0, 0xffff], 2).some((x) => x.a === "primary" && x.ratio === 1));

const paletteSource = process.env.FELUCCA_PALETTES_V2 || process.env.FELUCCA_PALETTES;
if (paletteSource) {
  const generated = JSON.parse(execFileSync("python3", ["-c", `
import importlib.util,json,sys
s=importlib.util.spec_from_file_location('pal',sys.argv[1]);p=importlib.util.module_from_spec(s);s.loader.exec_module(p)
print(json.dumps([dict(name=row[0],c=[p.to565(c,row[0]==p.BW) for c in row[1:]]) for row in p.PALETTES]))
`, paletteSource], { encoding: "utf8" }));
  assert.deepEqual(PAL_BUILTIN_V2, generated);
} else console.log("CUSTOM schema2: native producer seed comparison skip (no FELUCCA_PALETTES_V2)");
console.log("CUSTOM schemas: same-version negotiation, legacy timeout fallback, exact save/preview/revert/remove bytes, primary preservation and schema-aware roles/contrast ok");
