import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { buildManifest } from "../../build/update-manifest.mjs";

const require = createRequire(import.meta.url);
const lib = require("./update-lib.js");

test("isNewer compares x.y.z numerically and ignores junk", () => {
  assert.equal(lib.isNewer("0.3.0", "0.2.0"), true);
  assert.equal(lib.isNewer("v0.10.0", "0.9.9"), true);
  assert.equal(lib.isNewer("0.3.0", "0.3.0"), false);
  assert.equal(lib.isNewer("0.2.9", "0.3.0"), false);
  assert.equal(lib.isNewer("1.0.0-beta", "0.9.0"), true);
  assert.equal(lib.isNewer("garbage", "0.1.0"), false);
  assert.equal(lib.isNewer("0.3.0", ""), false);
});

test("classifyAsset knows every artifact build.mjs produces", () => {
  assert.equal(lib.classifyAsset("TKBK-IDE-Setup-win32-x64-0.3.0.exe"), "win32-x64-setup");
  assert.equal(lib.classifyAsset("TKBK-IDE-win32-x64-0.3.0.zip"), "win32-x64-archive");
  assert.equal(lib.classifyAsset("TKBK-IDE-linux-x64-0.3.0.tar.gz"), "linux-x64-archive");
  assert.equal(lib.classifyAsset("TKBK-IDE-darwin-arm64-0.3.0.zip"), "darwin-arm64-archive");
  assert.equal(lib.classifyAsset("TKBK-IDE-darwin-x64-0.3.0.zip"), "darwin-x64-archive");
  assert.equal(lib.classifyAsset("TKBK-IDE-win32-x64-0.3.0.zip.sha256"), null);
  assert.equal(lib.classifyAsset("build-win32-x64.json"), null);
});

test("validateManifest rejects foreign urls and missing hashes", () => {
  const good = {
    version: "0.3.0",
    assets: { "win32-x64-setup": { url: `${lib.ASSET_URL_PREFIX}v0.3.0/x.exe`, sha256: "a".repeat(64) } },
  };
  assert.equal(lib.validateManifest(good), good);
  assert.throws(() => lib.validateManifest({ ...good, version: "latest" }), /bad version/);
  assert.throws(
    () => lib.validateManifest({ version: "0.3.0", assets: { k: { url: "https://evil.example/x.exe", sha256: "a".repeat(64) } } }),
    /foreign url/,
  );
  assert.throws(
    () => lib.validateManifest({ version: "0.3.0", assets: { k: { url: `${lib.ASSET_URL_PREFIX}v0.3.0/x.exe`, sha256: "x" } } }),
    /sha256/,
  );
});

test("assetPrefixFor: GitHub by default, the custom server's origin otherwise", () => {
  assert.equal(lib.assetPrefixFor(""), lib.ASSET_URL_PREFIX);
  assert.equal(lib.assetPrefixFor(lib.DEFAULT_UPDATE_URL), lib.ASSET_URL_PREFIX);
  assert.equal(lib.assetPrefixFor("http://127.0.0.1:8123/stable/update.json"), "http://127.0.0.1:8123/");
  const m = { version: "0.3.1", assets: { k: { url: "http://127.0.0.1:8123/x.exe", sha256: "b".repeat(64) } } };
  assert.equal(lib.validateManifest(m, { assetPrefix: "http://127.0.0.1:8123/" }), m);
  assert.throws(() => lib.validateManifest(m), /foreign url/);
});

test("installKind: only the Inno install on Windows updates in place", () => {
  const exists = (p) => p.endsWith("unins000.exe");
  assert.equal(lib.installKind({ platform: "win32", appDir: "C:\\TKBK IDE", exists, env: {} }), "setup");
  assert.equal(lib.installKind({ platform: "win32", appDir: "C:\\TKBK IDE", exists, env: { VSCODE_PORTABLE: "C:\\x\\data" } }), "archive");
  assert.equal(lib.installKind({ platform: "win32", appDir: "C:\\TKBK IDE", exists: () => false, env: {} }), "archive");
  assert.equal(lib.installKind({ platform: "darwin", appDir: "/Applications", exists, env: {} }), "archive");
});

test("helper script waits for the app, runs the setup silently and restarts", () => {
  const ps = lib.helperScript();
  assert.match(ps, /param\(\[string\]\$Setup, \[string\]\$AppDir, \[string\]\$Exe, \[string\]\$Log\)/);
  assert.match(ps, /while \(Test-AppRunning\)/);
  assert.match(ps, /'\/VERYSILENT', '\/SUPPRESSMSGBOXES', '\/NORESTART', '\/SP-'/);
  assert.match(ps, /Start-Process -FilePath \$Exe/);
  assert.doesNotMatch(ps, /\$args\b/, "$args is a PowerShell automatic variable");
});

test("helperCommandLine: cmd start, quoted paths without trailing backslashes", () => {
  const line = lib.helperCommandLine({
    script: "C:\\Temp\\u\\apply-update.ps1",
    setup: "C:\\Temp\\u\\setup.exe",
    appDir: "C:\\Program Files\\TKBK IDE\\",
    exe: "C:\\Program Files\\TKBK IDE\\TKBK IDE.exe",
    log: "C:\\Temp\\u\\setup.log",
  });
  assert.ok(line.startsWith('/d /s /c "start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden'));
  assert.ok(line.includes('-AppDir "C:\\Program Files\\TKBK IDE" -Exe'), line);
  assert.ok(line.endsWith('-Log "C:\\Temp\\u\\setup.log""'), line);
  assert.throws(() => lib.helperCommandLine({ script: "C:\\100%\\a.ps1", setup: "s", appDir: "a", exe: "e", log: "l" }), /unsupported/);
  assert.match(lib.helperScript(), /\$prefix = \$AppDir\.TrimEnd\('\\'\) \+ '\\'/);
});

test("buildManifest: release files → update.json the updater accepts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkbk-manifest-"));
  for (const f of [
    "TKBK-IDE-Setup-win32-x64-0.3.0.exe",
    "TKBK-IDE-win32-x64-0.3.0.zip",
    "TKBK-IDE-win32-x64-0.3.0.zip.sha256",
    "TKBK-IDE-linux-x64-0.3.0.tar.gz",
    "TKBK-IDE-darwin-arm64-0.3.0.zip",
  ]) {
    fs.writeFileSync(path.join(dir, f), f);
  }
  fs.writeFileSync(path.join(dir, "build-win32-x64.json"), JSON.stringify({ vscodium: "1.140.06880", agent: { version: "0.3.0" } }));
  const m = buildManifest({ dir, tag: "v0.3.0", version: "0.3.0", now: new Date("2026-10-25T00:00:00Z") });
  assert.equal(m.version, "0.3.0");
  assert.equal(m.agent, "0.3.0");
  assert.equal(m.vscodium, "1.140.06880");
  assert.deepEqual(Object.keys(m.assets).sort(), ["darwin-arm64-archive", "linux-x64-archive", "win32-x64-archive", "win32-x64-setup"]);
  const setup = lib.selectAsset(m, { platform: "win32", arch: "x64", kind: "setup" });
  assert.equal(setup.url, "https://github.com/tkbk-online/tkbk-ide/releases/download/v0.3.0/TKBK-IDE-Setup-win32-x64-0.3.0.exe");
  assert.match(setup.sha256, /^[0-9a-f]{64}$/);
  assert.equal(lib.selectAsset(m, { platform: "darwin", arch: "x64", kind: "archive" }), null);
  assert.throws(() => buildManifest({ dir, tag: "v0.4.0", version: "0.3.0" }), /does not match/);
  fs.rmSync(dir, { recursive: true, force: true });
});
