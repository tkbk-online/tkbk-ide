// The launcher scripts and Info.plist of each VSCodium build are patched by exact text anchors.
// These tests apply the anchors to real files from VSCodium 1.140 so a VSCodium change breaks CI, not users.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ROOT } from "./config.mjs";
import { mergeProduct, patchText, readJson } from "./lib.mjs";
import {
  darwinLauncherReplacements,
  darwinPlistReplacements,
  linuxLauncherReplacements,
  visualElementsReplacements,
  win32CmdReplacements,
  win32ShReplacements,
} from "./build.mjs";

const FIX = path.join(ROOT, "build", "test-fixtures");
const product = mergeProduct(readJson(path.join(FIX, "product.json")), readJson(path.join(ROOT, "brand", "product.json")));

function withCopy(rel, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkbk-fix-"));
  const file = path.join(dir, path.basename(rel));
  fs.copyFileSync(path.join(FIX, rel), file);
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("win32 launchers", () => {
  const cmd = withCopy("win32/bin/codium.cmd", (f) => patchText(f, win32CmdReplacements()));
  assert.match(cmd, /"%~dp0\.\.\\TKBK IDE\.exe"/);
  assert.doesNotMatch(cmd, /VSCodium/);
  const sh = withCopy("win32/bin/codium", (f) => patchText(f, win32ShReplacements()));
  assert.match(sh, /NAME="TKBK IDE"/);
  assert.match(sh, /APP_NAME="tkbk-ide"/);
  assert.match(sh, /ELECTRON="\$VSCODE_PATH\/\$NAME\.exe"/);
  const xml = withCopy("win32/VSCodium.VisualElementsManifest.xml", (f) => patchText(f, visualElementsReplacements()));
  assert.match(xml, /ShortDisplayName="TKBK IDE"/);
  assert.match(xml, /BackgroundColor="#08090b"/);
});

test("linux launcher", () => {
  const sh = withCopy("linux/bin/codium", (f) => patchText(f, linuxLauncherReplacements()));
  assert.match(sh, /ELECTRON="\$VSCODE_PATH\/tkbk-ide"/);
  assert.match(sh, /which -a 'tkbk-ide'/);
  assert.match(sh, /\/usr\/share\/tkbk-ide/);
  assert.doesNotMatch(sh, /VSCodium/);
  assert.doesNotMatch(sh, /`codium`/);
});

test("darwin launcher and Info.plist", () => {
  const sh = withCopy("darwin/Contents/Resources/app/bin/codium", (f) => patchText(f, darwinLauncherReplacements()));
  assert.match(sh, /which -a 'tkbk-ide'/);
  assert.match(sh, /ELECTRON="\$CONTENTS\/MacOS\/VSCodium"/, "executable name is kept (helpers reference it)");
  const plist = withCopy("darwin/Contents/Info.plist", (f) => patchText(f, darwinPlistReplacements(product)));
  assert.match(plist, /<key>CFBundleName<\/key>\n\t<string>TKBK IDE<\/string>/);
  assert.match(plist, /<key>CFBundleIdentifier<\/key>\n\t<string>online\.tkbk\.ide<\/string>/);
  assert.match(plist, /<string>tkbk-ide<\/string>/);
  assert.match(plist, /<key>CFBundleExecutable<\/key>\n\t<string>VSCodium<\/string>/);
  assert.doesNotMatch(plist, /<string>vscodium<\/string>/);
});
