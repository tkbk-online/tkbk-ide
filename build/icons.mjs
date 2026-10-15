// Icon generation: PNG sizes, Windows .ico (BMP entries + PNG 256) and macOS .icns from brand/logo.png.
// Usage: node build/icons.mjs [outDir]   (default: dist/icons)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "./config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

export const LOGO = path.join(ROOT, "brand", "logo.png");

/** Build an ICO buffer from { size: {png, raw} } entries. raw = RGBA bytes (size*size*4). */
export function makeIco(images) {
  const sizes = Object.keys(images).map(Number).sort((a, b) => a - b);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  const dirEntries = [];
  const blobs = [];
  let offset = 6 + 16 * sizes.length;
  for (const size of sizes) {
    const { png, raw } = images[size];
    // Windows: PNG only for 256px, classic DIB for the rest (max compatibility).
    const blob = size >= 256 ? png : dibFromRgba(raw, size);
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // palette
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(blob.length, 8);
    entry.writeUInt32LE(offset, 12);
    dirEntries.push(entry);
    blobs.push(blob);
    offset += blob.length;
  }
  return Buffer.concat([header, ...dirEntries, ...blobs]);
}

/** 32-bit BGRA bottom-up DIB with an empty AND mask, as used inside .ico files. */
export function dibFromRgba(raw, size) {
  if (raw.length !== size * size * 4) throw new Error(`raw size mismatch for ${size}px`);
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // width
  header.writeInt32LE(size * 2, 8); // height (XOR + AND)
  header.writeUInt16LE(1, 12); // planes
  header.writeUInt16LE(32, 14); // bpp
  header.writeUInt32LE(0, 16); // compression BI_RGB
  header.writeUInt32LE(size * size * 4, 20); // image size
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4; // bottom-up
    const dstRow = y * size * 4;
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4;
      const d = dstRow + x * 4;
      xor[d] = raw[s + 2]; // B
      xor[d + 1] = raw[s + 1]; // G
      xor[d + 2] = raw[s]; // R
      xor[d + 3] = raw[s + 3]; // A
    }
  }
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const and = Buffer.alloc(maskRowBytes * size); // all zero = fully opaque per mask; alpha channel decides
  return Buffer.concat([header, xor, and]);
}

/** ICNS with PNG payloads. images: { size: pngBuffer }. */
export function makeIcns(images) {
  const types = {
    16: "icp4",
    32: "icp5",
    64: "icp6",
    128: "ic07",
    256: "ic08",
    512: "ic09",
    1024: "ic10",
  };
  const chunks = [];
  for (const [size, type] of Object.entries(types)) {
    const png = images[size];
    if (!png) continue;
    const head = Buffer.alloc(8);
    head.write(type, 0, "ascii");
    head.writeUInt32BE(8 + png.length, 4);
    chunks.push(head, png);
  }
  const total = 8 + chunks.reduce((n, c) => n + c.length, 0);
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(total, 4);
  return Buffer.concat([header, ...chunks]);
}

/** Parse ICO directory (for tests). */
export function readIcoDirectory(buf) {
  const count = buf.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    entries.push({
      width: buf.readUInt8(o) || 256,
      height: buf.readUInt8(o + 1) || 256,
      bpp: buf.readUInt16LE(o + 6),
      size: buf.readUInt32LE(o + 8),
      offset: buf.readUInt32LE(o + 12),
    });
  }
  return entries;
}

/**
 * Generate every icon file we need. Returns absolute paths.
 * Requires `sharp` (devDependency).
 */
export async function generateIcons(outDir, logo = LOGO) {
  const sharp = (await import("sharp")).default;
  fs.mkdirSync(outDir, { recursive: true });
  const src = sharp(logo).ensureAlpha();

  const png = {};
  const raw = {};
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    const img = src.clone().resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } });
    png[size] = await img.clone().png().toBuffer();
    if (size <= 256) raw[size] = await img.clone().raw().toBuffer();
  }

  const files = {};
  files.ico = path.join(outDir, "tkbk-ide.ico");
  fs.writeFileSync(
    files.ico,
    makeIco(Object.fromEntries([16, 24, 32, 48, 64, 128, 256].map((s) => [s, { png: png[s], raw: raw[s] }]))),
  );

  // macOS icons sit on a transparent canvas with ~10% margin like Apple's own.
  const macPng = {};
  for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
    const inner = Math.round(size * 0.82);
    const pad = Math.round((size - inner) / 2);
    macPng[size] = await sharp({
      create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{ input: await src.clone().resize(inner, inner).png().toBuffer(), left: pad, top: pad }])
      .png()
      .toBuffer();
  }
  files.icns = path.join(outDir, "tkbk-ide.icns");
  fs.writeFileSync(files.icns, makeIcns(macPng));

  files.png512 = path.join(outDir, "tkbk-ide-512.png");
  fs.writeFileSync(files.png512, png[512]);
  files.png1024 = path.join(outDir, "tkbk-ide-1024.png");
  fs.writeFileSync(files.png1024, png[1024]);
  files.png128 = path.join(outDir, "tkbk-ide-128.png");
  fs.writeFileSync(files.png128, png[128]);

  // Windows tiles (Start menu).
  for (const size of [150, 70]) {
    const file = path.join(outDir, `tkbk-ide-tile-${size}.png`);
    const inner = Math.round(size * 0.6);
    await sharp({ create: { width: size, height: size, channels: 4, background: { r: 8, g: 9, b: 11, alpha: 1 } } })
      .composite([{ input: await src.clone().resize(inner, inner).png().toBuffer(), gravity: "centre" }])
      .png()
      .toFile(file);
    files[`tile${size}`] = file;
  }
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(here, "icons.mjs")) {
  const out = process.argv[2] || path.join(ROOT, "dist", "icons");
  generateIcons(out).then((files) => {
    for (const [k, v] of Object.entries(files)) console.log(k, v);
  });
}
