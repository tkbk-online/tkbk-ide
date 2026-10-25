// TKBK IDE updater (built-in, replaces the VS Code update service: our Inno installer is not the
// VS Code one, so product.json keeps updateUrl unset and update.mode = none).
// - Checks update.json of the latest GitHub release 20 s after start and every 6 h.
// - Inno Setup install on Windows: downloads the setup, checks sha256, offers «Перезапустить и обновить»
//   → a detached PowerShell helper waits for the editor to exit, runs the setup silently, starts it again.
// - Portable zip, Linux tarball, macOS: notification with a download link.
"use strict";

const vscode = require("vscode");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const lib = require("./update-lib");

const CHECK_DELAY_MS = 20 * 1000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STATE_SKIPPED = "tkbk.update.skippedVersion";
const STATE_LAST_SEEN = "tkbk.update.lastSeenVersion";

const output = vscode.window.createOutputChannel("TKBK IDE: обновления");

function log(msg) {
  output.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

function config() {
  return vscode.workspace.getConfiguration("tkbk.update");
}

function appDir() {
  // <app>/resources/app → <app> on Windows and Linux.
  return path.resolve(vscode.env.appRoot, "..", "..");
}

function updateDir(version) {
  return path.join(os.tmpdir(), "tkbk-ide-update", version);
}

async function fetchManifest() {
  const url = config().get("url") || lib.DEFAULT_UPDATE_URL;
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return lib.validateManifest(await res.json(), { assetPrefix: lib.assetPrefixFor(url) });
}

function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("error", reject)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")));
  });
}

/** Download an asset into the per-version temp dir; reuses a previous verified download. */
async function download(asset, version, progress) {
  const dir = updateDir(version);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, path.basename(new URL(asset.url).pathname));
  if (fs.existsSync(file) && (await sha256Of(file)) === asset.sha256) return file;
  const part = `${file}.part`;
  const res = await fetch(asset.url, { redirect: "follow", signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${asset.url}`);
  const total = Number(res.headers.get("content-length")) || asset.size || 0;
  let done = 0;
  let reported = 0;
  const body = Readable.fromWeb(res.body);
  body.on("data", (chunk) => {
    done += chunk.length;
    if (progress && total) {
      const pct = Math.floor((done / total) * 100);
      if (pct > reported) {
        progress.report({ increment: pct - reported, message: `${pct}%` });
        reported = pct;
      }
    }
  });
  await pipeline(body, fs.createWriteStream(part));
  const actual = await sha256Of(part);
  if (actual !== asset.sha256) {
    fs.rmSync(part, { force: true });
    throw new Error(`sha256 mismatch: ${actual} != ${asset.sha256}`);
  }
  fs.renameSync(part, file);
  log(`downloaded ${file}`);
  return file;
}

/** Hand over to the PowerShell helper and quit; the helper installs once every window is closed. */
async function applyWindowsSetup(setupFile, version) {
  const dir = updateDir(version);
  const script = path.join(dir, "apply-update.ps1");
  fs.writeFileSync(script, lib.helperScript(), "utf8");
  const app = appDir();
  const exe = path.join(app, path.basename(process.execPath));
  const logFile = path.join(dir, "setup.log");
  const cmdLine = lib.helperCommandLine({ script, setup: setupFile, appDir: app, exe, log: logFile });
  const child = spawn(process.env.ComSpec || "cmd.exe", [cmdLine], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  child.unref();
  log(`helper started (pid ${child.pid}), setup log: ${logFile}`);
  await vscode.commands.executeCommand("workbench.action.quit");
}

function localVersion(product) {
  return (product.tkbk && product.tkbk.version) || "";
}

/**
 * One update check. `manual` = from the command palette: always answers, ignores «skip this version»
 * and the window-focus guard.
 */
async function check(context, product, { manual = false } = {}) {
  const mode = config().get("mode", "auto");
  if (mode === "off" && !manual) return;
  const local = localVersion(product);
  if (!local) {
    if (manual) vscode.window.showWarningMessage("TKBK IDE: версия сборки не записана в product.json — обновление недоступно.");
    return;
  }
  let manifest;
  try {
    manifest = await fetchManifest();
  } catch (err) {
    log(`check failed: ${err.message}`);
    if (manual) vscode.window.showErrorMessage(`TKBK IDE: не удалось проверить обновления (${err.message}).`);
    return;
  }
  const remote = manifest.version;
  log(`installed ${local}, latest ${remote}`);
  if (!lib.isNewer(remote, local)) {
    if (manual) vscode.window.showInformationMessage(`Установлена последняя версия TKBK IDE (${local}).`);
    return;
  }
  // Every window runs this extension: only the focused one talks to the user on automatic checks.
  if (!manual && (context.globalState.get(STATE_SKIPPED) === remote || !vscode.window.state.focused)) return;

  const kind = lib.installKind({ platform: process.platform, appDir: appDir(), exists: fs.existsSync, env: process.env });
  const asset = lib.selectAsset(manifest, { platform: process.platform, arch: process.arch, kind });
  const notes = manifest.releaseUrl || `https://github.com/tkbk-online/tkbk-ide/releases/tag/v${remote}`;

  if (kind === "setup" && asset) {
    let setupFile;
    if (mode === "auto" && !manual) {
      try {
        setupFile = await download(asset, remote);
      } catch (err) {
        log(`background download failed: ${err.message}`);
      }
    }
    const action = setupFile ? "Перезапустить и обновить" : "Обновить";
    const pick = await vscode.window.showInformationMessage(
      setupFile ? `Обновление TKBK IDE ${remote} скачано.` : `Доступна TKBK IDE ${remote} (у вас ${local}).`,
      action,
      "Что нового",
      "Позже",
    );
    if (pick === "Что нового") return vscode.env.openExternal(vscode.Uri.parse(notes));
    if (pick !== action) return;
    try {
      if (!setupFile) {
        setupFile = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `TKBK IDE ${remote}: загрузка` },
          (progress) => download(asset, remote, progress),
        );
      }
      await applyWindowsSetup(setupFile, remote);
    } catch (err) {
      log(`update failed: ${err.message}`);
      const again = await vscode.window.showErrorMessage(`TKBK IDE: обновление не удалось (${err.message}).`, "Скачать вручную");
      if (again) vscode.env.openExternal(vscode.Uri.parse(asset.url));
    }
    return;
  }

  const archive = lib.selectAsset(manifest, { platform: process.platform, arch: process.arch, kind: "archive" });
  const pick = await vscode.window.showInformationMessage(
    `Доступна TKBK IDE ${remote} (у вас ${local}).`,
    "Скачать",
    "Что нового",
    "Пропустить версию",
  );
  if (pick === "Скачать") return vscode.env.openExternal(vscode.Uri.parse(archive ? archive.url : notes));
  if (pick === "Что нового") return vscode.env.openExternal(vscode.Uri.parse(notes));
  if (pick === "Пропустить версию") await context.globalState.update(STATE_SKIPPED, remote);
}

/** After an update: one toast with the new version. */
async function announceUpdated(context, product) {
  const local = localVersion(product);
  if (!local) return;
  const seen = context.globalState.get(STATE_LAST_SEEN);
  await context.globalState.update(STATE_LAST_SEEN, local);
  if (seen && lib.isNewer(local, seen)) {
    const pick = await vscode.window.showInformationMessage(`TKBK IDE обновлена до ${local}.`, "Что нового");
    if (pick) vscode.env.openExternal(vscode.Uri.parse(`https://github.com/tkbk-online/tkbk-ide/releases/tag/v${local}`));
  }
}

function activateUpdater(context, readProduct) {
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand("tkbk.update.check", () => check(context, readProduct(), { manual: true })),
  );
  announceUpdated(context, readProduct()).catch((err) => log(`announce failed: ${err.message}`));
  const run = () => check(context, readProduct()).catch((err) => log(`check crashed: ${err.stack || err}`));
  const first = setTimeout(run, CHECK_DELAY_MS);
  const every = setInterval(run, CHECK_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => (clearTimeout(first), clearInterval(every)) });
}

module.exports = { activateUpdater, check };
