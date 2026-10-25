// Pure helpers of the TKBK IDE updater (no vscode import: unit-tested with node --test).
//
// Every GitHub release of tkbk-online/tkbk-ide carries update.json (built by build/update-manifest.mjs);
// /releases/latest/download/update.json always points at the newest published (non-draft) release.
"use strict";

const REPO = "tkbk-online/tkbk-ide";
const DEFAULT_UPDATE_URL = `https://github.com/${REPO}/releases/latest/download/update.json`;
const ASSET_URL_PREFIX = `https://github.com/${REPO}/releases/download/`;

/** "v1.2.3" | "1.2.3" | "1.2.3-beta" → [1, 2, 3]; anything else → null. */
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(v || "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when `remote` is a strictly newer x.y.z than `local`. */
function isNewer(remote, local) {
  const r = parseVersion(remote);
  const l = parseVersion(local);
  if (!r || !l) return false;
  for (let i = 0; i < 3; i++) {
    if (r[i] !== l[i]) return r[i] > l[i];
  }
  return false;
}

/** Asset key in update.json: "<os>-<arch>-<setup|archive>". */
function assetKey(platform, arch, kind) {
  return `${platform}-${arch}-${kind}`;
}

/** Classify a release file name → asset key, or null for files the updater does not use. */
function classifyAsset(name) {
  if (/^TKBK-IDE-Setup-win32-x64-[\w.-]+\.exe$/.test(name)) return assetKey("win32", "x64", "setup");
  const m = /^TKBK-IDE-(win32-x64|linux-x64|darwin-arm64|darwin-x64)-[\w.-]+\.(zip|tar\.gz)$/.exec(name);
  return m ? `${m[1]}-archive` : null;
}

/**
 * Validate update.json; returns it or throws. Asset URLs must point at our own GitHub releases
 * (or, with a custom tkbk.update.url, at the same origin as that url).
 */
function validateManifest(m, { assetPrefix = ASSET_URL_PREFIX } = {}) {
  if (!m || typeof m !== "object") throw new Error("update.json: not an object");
  if (!parseVersion(m.version)) throw new Error(`update.json: bad version ${m.version}`);
  if (!m.assets || typeof m.assets !== "object") throw new Error("update.json: no assets");
  for (const [key, a] of Object.entries(m.assets)) {
    if (!a || typeof a.url !== "string" || !a.url.startsWith(assetPrefix)) {
      throw new Error(`update.json: asset ${key} has a foreign url`);
    }
    if (!/^[0-9a-f]{64}$/.test(String(a.sha256 || ""))) throw new Error(`update.json: asset ${key} has no sha256`);
  }
  return m;
}

/** Allowed asset url prefix for an update.json url. */
function assetPrefixFor(updateUrl) {
  if (!updateUrl || updateUrl === DEFAULT_UPDATE_URL) return ASSET_URL_PREFIX;
  return `${new URL(updateUrl).origin}/`;
}

/** The asset for this installation, or null (then the updater only links to the release page). */
function selectAsset(manifest, { platform, arch, kind }) {
  return manifest.assets[assetKey(platform, arch, kind)] || null;
}

/**
 * How this copy was installed. Only the Inno Setup install ("setup") can update itself in place:
 * portable zips, tarballs and macOS bundles get a download link instead.
 */
function installKind({ platform, appDir, exists, env }) {
  if (platform !== "win32") return "archive";
  if (env.VSCODE_PORTABLE) return "archive";
  return exists(require("path").join(appDir, "unins000.exe")) ? "setup" : "archive";
}

/**
 * PowerShell helper: wait until every TKBK IDE process of this install has exited (the app mutex
 * blocks Inno otherwise), run the setup silently, start the editor again. Inno reuses the previous
 * install dir, tasks and privilege mode on its own.
 */
function helperScript() {
  return `param([string]$Setup, [string]$AppDir, [string]$Exe, [string]$Log)
$ErrorActionPreference = 'SilentlyContinue'
$deadline = (Get-Date).AddMinutes(10)
$prefix = $AppDir.TrimEnd('\\') + '\\'
function Test-AppRunning {
  $procs = Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) }
  return @($procs).Count -gt 0
}
while (Test-AppRunning) {
  if ((Get-Date) -gt $deadline) { exit 2 }
  Start-Sleep -Milliseconds 500
}
$argList = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', "/LOG=\`"$Log\`"")
$p = Start-Process -FilePath $Setup -ArgumentList $argList -Wait -PassThru
if (Test-Path -LiteralPath $Exe) { Start-Process -FilePath $Exe }
exit $p.ExitCode
`;
}

/**
 * Command line for `cmd.exe` (spawned with windowsVerbatimArguments) that starts the helper.
 * powershell.exe started directly with DETACHED_PROCESS (Node `detached: true`) exits at once
 * without running the script, and a non-detached child dies with the editor (libuv kill-on-close
 * job), so cmd (detached, outside the job) `start`s PowerShell in its own minimized console.
 * Paths are passed without a trailing backslash: `"C:\dir\"` would escape the closing quote.
 */
function helperCommandLine({ script, setup, appDir, exe, log }) {
  const q = (p) => {
    const v = String(p).replace(/\\+$/, "");
    if (/["\r\n%]/.test(v)) throw new Error(`unsupported character in path: ${v}`);
    return `"${v}"`;
  };
  return [
    '/d /s /c "start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden',
    `-File ${q(script)} -Setup ${q(setup)} -AppDir ${q(appDir)} -Exe ${q(exe)} -Log ${q(log)}"`,
  ].join(" ");
}

module.exports = {
  ASSET_URL_PREFIX,
  DEFAULT_UPDATE_URL,
  assetKey,
  assetPrefixFor,
  classifyAsset,
  helperCommandLine,
  helperScript,
  installKind,
  isNewer,
  parseVersion,
  selectAsset,
  validateManifest,
};
