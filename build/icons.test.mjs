import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { dibFromRgba, makeIcns, makeIco, readIcoDirectory, generateIcons } from "./icons.mjs";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const fakePng = (n) => Buffer.concat([PNG_SIG, Buffer.alloc(n, 1)]);

test("dibFromRgba: BGRA bottom-up with AND mask", () => {
  const size = 2;
  // row0: red, green ; row1: blue, transparent
  const raw = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0]);
  const dib = dibFromRgba(raw, size);
  assert.equal(dib.readUInt32LE(0), 40);
  assert.equal(dib.readInt32LE(8), size * 2);
  const xor = dib.subarray(40, 40 + size * size * 4);
  // first stored row is the bottom row (blue, transparent)
  assert.deepEqual([...xor.subarray(0, 4)], [255, 0, 0, 255]); // B,G,R,A of blue
  assert.deepEqual([...xor.subarray(4, 8)], [0, 0, 0, 0]);
  assert.deepEqual([...xor.subarray(8, 12)], [0, 0, 255, 255]); // red
  assert.equal(dib.length, 40 + 16 + 4 * size); // mask rows padded to 4 bytes
});

test("makeIco: directory entries and offsets", () => {
  const images = {
    16: { png: fakePng(10), raw: Buffer.alloc(16 * 16 * 4) },
    256: { png: fakePng(20), raw: Buffer.alloc(256 * 256 * 4) },
  };
  const ico = makeIco(images);
  assert.equal(ico.readUInt16LE(2), 1);
  const dir = readIcoDirectory(ico);
  assert.deepEqual(dir.map((d) => d.width), [16, 256]);
  assert.equal(dir[0].bpp, 32);
  assert.equal(dir[0].offset, 6 + 16 * 2);
  assert.equal(dir[1].offset, dir[0].offset + dir[0].size);
  assert.equal(ico.subarray(dir[1].offset, dir[1].offset + 8).equals(PNG_SIG), true, "256px entry is PNG");
  assert.equal(ico.length, dir[1].offset + dir[1].size);
});

test("makeIcns: header length and chunk types", () => {
  const icns = makeIcns({ 16: fakePng(5), 512: fakePng(7), 1024: fakePng(9) });
  assert.equal(icns.subarray(0, 4).toString("ascii"), "icns");
  assert.equal(icns.readUInt32BE(4), icns.length);
  const types = [];
  let o = 8;
  while (o < icns.length) {
    types.push(icns.subarray(o, o + 4).toString("ascii"));
    o += icns.readUInt32BE(o + 4);
  }
  assert.deepEqual(types, ["icp4", "ic09", "ic10"]);
});

test("generateIcons produces all files from brand/logo.png", async (t) => {
  try {
    await import("sharp");
  } catch {
    t.skip("sharp not installed");
    return;
  }
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "tkbk-icons-"));
  const files = await generateIcons(out);
  for (const f of Object.values(files)) assert.ok(fs.statSync(f).size > 100, f);
  const dir = readIcoDirectory(fs.readFileSync(files.ico));
  assert.deepEqual(dir.map((d) => d.width), [16, 24, 32, 48, 64, 128, 256]);
  fs.rmSync(out, { recursive: true, force: true });
});
