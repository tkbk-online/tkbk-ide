import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { mergeProduct, patchText, satisfiesEngine } from "./lib.mjs";
import { ROOT } from "./config.mjs";
import { readJson } from "./lib.mjs";

test("mergeProduct: replace, delete, append, prepend", () => {
  const base = { a: 1, b: 2, list: ["x"], themes: [{ id: "d" }], keep: { x: 1 } };
  const out = mergeProduct(base, {
    a: 10,
    b: null,
    list: { $append: ["x", "y"] },
    themes: { $prepend: [{ id: "tkbk" }] },
  });
  assert.equal(out.a, 10);
  assert.equal("b" in out, false);
  assert.deepEqual(out.list, ["x", "y"]);
  assert.deepEqual(out.themes.map((t) => t.id), ["tkbk", "d"]);
  assert.deepEqual(out.keep, { x: 1 });
  assert.deepEqual(base.list, ["x"], "base is not mutated");
});

test("brand/product.json applies cleanly to the real VSCodium product.json", () => {
  const base = readJson(path.join(ROOT, "build", "test-fixtures", "product.json"));
  const brand = readJson(path.join(ROOT, "brand", "product.json"));
  const p = mergeProduct(base, brand);
  assert.equal(p.nameShort, "TKBK IDE");
  assert.equal(p.nameLong, "TKBK IDE");
  assert.equal(p.applicationName, "tkbk-ide");
  assert.equal(p.dataFolderName, ".tkbk-ide");
  assert.equal(p.urlProtocol, "tkbk-ide");
  assert.equal("updateUrl" in p, false, "no VSCodium auto-update");
  assert.equal(p.extensionsGallery.serviceUrl, "https://open-vsx.org/vscode/gallery");
  assert.ok(p.linkProtectionTrustedDomains.includes("https://tkbk.online"));
  assert.equal(p.linkProtectionTrustedDomains.filter((d) => d === "https://open-vsx.org").length, 1, "no duplicates");
  assert.equal(p.onboardingThemes[0].themeId, "TKBK Dark");
  // Remote/server bits stay VSCodium so Remote-SSH style setups keep working.
  assert.equal(p.serverApplicationName, base.serverApplicationName);
  assert.equal(p.serverDataFolderName, base.serverDataFolderName);
  assert.equal(p.commit, base.commit);
  assert.deepEqual(p.checksums, base.checksums, "core checksums untouched");
  assert.equal(p.version, base.version);
});

test("satisfiesEngine", () => {
  assert.equal(satisfiesEngine("^1.131.0", "1.140.06880"), true);
  assert.equal(satisfiesEngine("^1.141.0", "1.140.06880"), false);
  assert.equal(satisfiesEngine(">=1.101.0", "1.140.06880"), true);
  assert.equal(satisfiesEngine("~1.140.0", "1.140.06880"), true);
  assert.equal(satisfiesEngine("~1.139.0", "1.140.06880"), false);
  assert.equal(satisfiesEngine("*", "1.140.06880"), true);
  assert.equal(satisfiesEngine("^2.0.0", "1.140.06880"), false);
});

test("patchText replaces all and fails loudly on missing anchors", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkbk-ide-"));
  const file = path.join(dir, "t.txt");
  fs.writeFileSync(file, "a VSCodium b VSCodium");
  assert.equal(patchText(file, [["VSCodium", "TKBK IDE"]]), "a TKBK IDE b TKBK IDE");
  assert.throws(() => patchText(file, [["nope", "x"]]), /not found/);
  fs.rmSync(dir, { recursive: true, force: true });
});
