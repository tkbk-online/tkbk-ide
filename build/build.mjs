// TKBK IDE build pipeline: VSCodium release → brand → built-in extensions → portable profile → archive/installer.
//
//   node build/build.mjs --platform win32-x64 [--codium 1.140.06880] [--agent-vsix path]
//                        [--out dist] [--no-preinstall] [--no-installer] [--keep-stage]
//
// The pipeline never rebuilds VS Code: only resources/app/product.json, icons, launcher
// scripts and the extensions folder change. Core workbench files (and their checksums) stay intact.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BRAND,
  BUILTIN_EXTENSIONS_FROM_REPO,
  DEFAULT_ARGV,
  DEFAULT_SETTINGS,
  DIST_DIR,
  PLATFORMS,
  ROOT,
  TKBK_IDE_VERSION,
  VSCODIUM_VERSION,
  hostPlatform,
} from "./config.mjs";
import { createRequire } from "node:module";
import { fetchAll } from "./fetch.mjs";
import { generateIcons } from "./icons.mjs";
import {
  copyDir,
  createArchive,
  extractArchive,
  log,
  mergeProduct,
  patchText,
  readJson,
  rmrf,
  run,
  tarBinary,
  writeJson,
} from "./lib.mjs";

const requireCjs = createRequire(import.meta.url);
const { writeLanguagePacks } = requireCjs("./langpack.cjs");

function parseArgs(argv) {
  const opts = {
    platform: hostPlatform(),
    codium: VSCODIUM_VERSION,
    agentVsix: undefined,
    out: DIST_DIR,
    preinstall: true,
    installer: true,
    keepStage: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--platform") opts.platform = argv[++i];
    else if (a === "--codium") opts.codium = argv[++i];
    else if (a === "--agent-vsix") opts.agentVsix = argv[++i];
    else if (a === "--out") opts.out = path.resolve(argv[++i]);
    else if (a === "--no-preinstall") opts.preinstall = false;
    else if (a === "--no-installer") opts.installer = false;
    else if (a === "--keep-stage") opts.keepStage = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!PLATFORMS[opts.platform]) throw new Error(`unknown platform ${opts.platform}`);
  return opts;
}


// --- text replacements (exported for tests; they must match the current VSCodium scripts) ---
export const win32CmdReplacements = () => [["VSCodium.exe", `${BRAND.exeBaseName}.exe`]];
export const win32ShReplacements = () => [
  ['APP_NAME="codium"', `APP_NAME="${BRAND.applicationName}"`],
  ['NAME="VSCodium"', `NAME="${BRAND.exeBaseName}"`],
];
export const visualElementsReplacements = () => [
  ['ShortDisplayName="VSCodium"', `ShortDisplayName="${BRAND.nameShort}"`],
  ['BackgroundColor="#2D2D30"', `BackgroundColor="${BRAND.tileColor}"`],
];
export const linuxLauncherReplacements = () => [
  ["which -a 'codium'", `which -a '${BRAND.applicationName}'`],
  ['ELECTRON="$VSCODE_PATH/codium"', `ELECTRON="$VSCODE_PATH/${BRAND.linuxBinary}"`],
  ['VSCODE_PATH="/usr/share/codium"', `VSCODE_PATH="/usr/share/${BRAND.applicationName}"`],
  ["VSCodium", BRAND.nameShort],
  ["\\`codium\\`", "\\`" + BRAND.applicationName + "\\`"],
];
export const darwinLauncherReplacements = () => [["which -a 'codium'", `which -a '${BRAND.applicationName}'`]];
export const darwinPlistReplacements = (product) => [
  ["<key>CFBundleDisplayName</key>\n\t<string>VSCodium</string>", `<key>CFBundleDisplayName</key>\n\t<string>${BRAND.nameLong}</string>`],
  ["<key>CFBundleName</key>\n\t<string>VSCodium</string>", `<key>CFBundleName</key>\n\t<string>${BRAND.nameShort}</string>`],
  ["<key>CFBundleIdentifier</key>\n\t<string>com.vscodium</string>", `<key>CFBundleIdentifier</key>\n\t<string>${product.darwinBundleIdentifier}</string>`],
  ["<key>CFBundleURLName</key>\n\t\t\t<string>VSCodium</string>", `<key>CFBundleURLName</key>\n\t\t\t<string>${BRAND.nameShort}</string>`],
  ["<string>vscodium</string>", `<string>${product.urlProtocol}</string>`],
  ["Copyright (C) 2026 VSCodium. All rights reserved", BRAND.copyright],
];

/** Paths of the staged application for a platform. */
function layout(stageDir, platform) {
  const spec = PLATFORMS[platform];
  const os_ = platform.split("-")[0];
  if (os_ === "win32") {
    const appDir = stageDir;
    return {
      os: os_,
      appDir,
      appRoot: path.join(appDir, spec.appRootRel),
      exe: path.join(appDir, `${BRAND.exeBaseName}.exe`),
      originalExe: path.join(appDir, "VSCodium.exe"),
      portableData: path.join(appDir, "data"),
      archiveEntries: () => fs.readdirSync(stageDir),
    };
  }
  if (os_ === "linux") {
    const appDir = path.join(stageDir, `TKBK-IDE-${platform}`);
    return {
      os: os_,
      appDir,
      appRoot: path.join(appDir, spec.appRootRel),
      exe: path.join(appDir, BRAND.linuxBinary),
      originalExe: path.join(appDir, "codium"),
      portableData: path.join(appDir, "data"),
      archiveEntries: () => [path.basename(appDir)],
    };
  }
  const appDir = path.join(stageDir, `${BRAND.exeBaseName}.app`);
  return {
    os: os_,
    appDir,
    appRoot: path.join(appDir, spec.appRootRel),
    exe: path.join(appDir, "Contents", "MacOS", "VSCodium"),
    originalExe: null,
    portableData: null,
    archiveEntries: () => [path.basename(appDir)],
  };
}

function stageArchive(archive, stageDir, platform) {
  rmrf(stageDir);
  fs.mkdirSync(stageDir, { recursive: true });
  const spec = PLATFORMS[platform];
  if (spec.appDirName) {
    // VSCodium tarballs are flat (codium, bin/, resources/ at the root); older ones had a top folder.
    const appDir = path.join(stageDir, spec.appDirName);
    const unpack = path.join(stageDir, "_unpack");
    fs.mkdirSync(unpack);
    extractArchive(archive, unpack);
    const top = spec.topDir && path.join(unpack, spec.topDir);
    if (top && fs.existsSync(top)) {
      fs.renameSync(top, appDir);
      rmrf(unpack);
    } else {
      fs.renameSync(unpack, appDir);
    }
    return;
  }
  extractArchive(archive, stageDir);
  if (spec.appBundle) fs.renameSync(path.join(stageDir, spec.appBundle), path.join(stageDir, `${BRAND.exeBaseName}.app`));
}

function patchProduct(appRoot, codiumVersion) {
  const file = path.join(appRoot, "product.json");
  const base = readJson(file);
  const overrides = readJson(path.join(ROOT, "brand", "product.json"));
  const product = mergeProduct(base, overrides);
  // tkbk.version is what the built-in updater compares with update.json of the latest release.
  product.tkbk = { ...(product.tkbk || {}), version: TKBK_IDE_VERSION, vscodium: codiumVersion, basedOn: `VSCodium ${base.version}` };
  writeJson(file, product);
  log("product.json patched:", product.nameLong, product.applicationName, product.dataFolderName);
  return product;
}

async function applyIcons(l, icons) {
  const win32Res = path.join(l.appRoot, "resources", "win32");
  const linuxRes = path.join(l.appRoot, "resources", "linux");
  if (fs.existsSync(win32Res)) {
    fs.copyFileSync(icons.ico, path.join(win32Res, "code.ico"));
    fs.copyFileSync(icons.tile150, path.join(win32Res, "code_150x150.png"));
    fs.copyFileSync(icons.tile70, path.join(win32Res, "code_70x70.png"));
  }
  if (fs.existsSync(linuxRes)) {
    fs.copyFileSync(icons.png1024, path.join(linuxRes, "code.png"));
  }
  if (l.os === "darwin") {
    const res = path.join(l.appDir, "Contents", "Resources");
    fs.copyFileSync(icons.icns, path.join(res, "VSCodium.icns"));
  }
}

async function brandWindows(l, product, icons, codiumVersion) {
  fs.renameSync(l.originalExe, l.exe);
  const manifestOld = path.join(l.appDir, "VSCodium.VisualElementsManifest.xml");
  const manifestNew = path.join(l.appDir, `${BRAND.exeBaseName}.VisualElementsManifest.xml`);
  if (fs.existsSync(manifestOld)) {
    fs.renameSync(manifestOld, manifestNew);
    patchText(manifestNew, visualElementsReplacements());
  }
  // Launchers
  const bin = path.join(l.appDir, "bin");
  fs.renameSync(path.join(bin, "codium.cmd"), path.join(bin, `${BRAND.applicationName}.cmd`));
  patchText(path.join(bin, `${BRAND.applicationName}.cmd`), win32CmdReplacements());
  fs.renameSync(path.join(bin, "codium"), path.join(bin, BRAND.applicationName));
  patchText(path.join(bin, BRAND.applicationName), win32ShReplacements());
  if (fs.existsSync(path.join(bin, "codium-tunnel.exe"))) {
    fs.renameSync(path.join(bin, "codium-tunnel.exe"), path.join(bin, `${product.tunnelApplicationName}.exe`));
  }
  // Exe icon and version block (needs rcedit; Windows host only)
  if (process.platform === "win32") {
    const rcedit = (await import("rcedit")).default;
    const [maj, min, patch] = codiumVersion.split(".").map((n) => Number(n));
    const fileVersion = `${maj}.${min}.${patch}.0`;
    await rcedit(l.exe, {
      icon: icons.ico,
      "file-version": fileVersion,
      "product-version": fileVersion,
      "version-string": {
        ProductName: BRAND.nameLong,
        FileDescription: BRAND.nameLong,
        CompanyName: BRAND.company,
        LegalCopyright: BRAND.copyright,
        OriginalFilename: `${BRAND.exeBaseName}.exe`,
        InternalName: BRAND.applicationName,
      },
    });
    log("exe icon and version set");
  } else {
    log("WARN: not on Windows, exe icon/version left as VSCodium");
  }
}

function brandLinux(l, product) {
  fs.renameSync(l.originalExe, l.exe);
  const bin = path.join(l.appDir, "bin");
  fs.renameSync(path.join(bin, "codium"), path.join(bin, BRAND.applicationName));
  patchText(path.join(bin, BRAND.applicationName), linuxLauncherReplacements());
  if (fs.existsSync(path.join(bin, "codium-tunnel"))) {
    fs.renameSync(path.join(bin, "codium-tunnel"), path.join(bin, product.tunnelApplicationName));
  }
  const completions = path.join(l.appDir, "resources", "completions");
  rmrf(completions); // they complete `codium`; not worth regenerating
  const desktop = `[Desktop Entry]
Name=${BRAND.nameLong}
Comment=TKBK IDE — редактор с агентом TKBK
GenericName=Text Editor
Exec=/opt/tkbk-ide/${BRAND.linuxBinary} %F
Icon=tkbk-ide
Type=Application
StartupNotify=false
StartupWMClass=${BRAND.linuxBinary}
Categories=TextEditor;Development;IDE;
MimeType=text/plain;inode/directory;application/x-tkbk-ide-workspace;
Actions=new-empty-window;
Keywords=tkbk;vscode;

[Desktop Action new-empty-window]
Name=New Empty Window
Exec=/opt/tkbk-ide/${BRAND.linuxBinary} --new-window %F
Icon=tkbk-ide
`;
  fs.writeFileSync(path.join(l.appDir, "resources", `${BRAND.applicationName}.desktop`), desktop);
}

function brandDarwin(l, product, codiumVersion) {
  const plist = path.join(l.appDir, "Contents", "Info.plist");
  patchText(plist, darwinPlistReplacements(product));
  const bin = path.join(l.appRoot, "bin");
  fs.renameSync(path.join(bin, "codium"), path.join(bin, BRAND.applicationName));
  patchText(path.join(bin, BRAND.applicationName), darwinLauncherReplacements());
  if (fs.existsSync(path.join(bin, "codium-tunnel"))) {
    fs.renameSync(path.join(bin, "codium-tunnel"), path.join(bin, product.tunnelApplicationName));
  }
  if (process.platform === "darwin") {
    run("xattr", ["-cr", l.appDir]);
    run("codesign", ["--force", "--deep", "--sign", "-", l.appDir]);
    log("ad-hoc signed", l.appDir, "(owner: replace with Developer ID signing + notarization)");
  } else {
    log("WARN: not on macOS, bundle left unsigned");
  }
}

function installBuiltinExtensions(l, agentVsix, tmpDir) {
  const extDir = path.join(l.appRoot, "extensions");
  for (const name of BUILTIN_EXTENSIONS_FROM_REPO) {
    const src = path.join(ROOT, "extensions", name);
    const dest = path.join(extDir, name);
    rmrf(dest);
    copyDir(src, dest);
    log("builtin", name);
  }
  // TKBK Agent: unpack the vsix and keep its extension/ folder
  const unpack = path.join(tmpDir, "agent-vsix");
  rmrf(unpack);
  fs.mkdirSync(unpack, { recursive: true });
  run(tarBinary(), ["-xf", agentVsix, "-C", unpack]);
  const manifest = readJson(path.join(unpack, "extension", "package.json"));
  const dest = path.join(extDir, manifest.name);
  rmrf(dest);
  fs.renameSync(path.join(unpack, "extension"), dest);
  log("builtin", `${manifest.publisher}.${manifest.name}@${manifest.version}`);
  return { id: `${manifest.publisher}.${manifest.name}`, version: manifest.version };
}

function bundleMarketplace(l, marketplace, product) {
  const dir = path.join(l.appRoot, "bundled-extensions");
  rmrf(dir);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = [];
  for (const ext of marketplace) {
    const name = path.basename(ext.file);
    fs.copyFileSync(ext.file, path.join(dir, name));
    manifest.push({ id: ext.id, version: ext.version, file: name });
  }
  writeJson(path.join(dir, "manifest.json"), manifest);
  fs.copyFileSync(path.join(ROOT, "build", "langpack.cjs"), path.join(dir, "write-languagepacks.cjs"));
  // Windows installer runs this after copying files (installs into the user's profile),
  // then pre-creates languagepacks.json so the very first start is already in Russian.
  if (l.os === "win32") {
    const lines = [
      "@echo off",
      "setlocal",
      `set CLI=%~dp0..\\..\\..\\bin\\${BRAND.applicationName}.cmd`,
      `set APP=%~dp0..\\..\\..\\${BRAND.exeBaseName}.exe`,
    ];
    for (const m of manifest) lines.push(`call "%CLI%" --install-extension "%~dp0${m.file}"`);
    lines.push(
      "set ELECTRON_RUN_AS_NODE=1",
      `"%APP%" "%~dp0write-languagepacks.cjs" "%USERPROFILE%\\${product.dataFolderName}\\extensions" "%APPDATA%\\${BRAND.nameShort}"`,
      "endlocal",
      "exit /b 0",
      "",
    );
    fs.writeFileSync(path.join(dir, "install.cmd"), lines.join("\r\n"));
  }
  log("bundled", manifest.map((m) => m.id).join(", "));
  return manifest;
}

/** Portable profile: data/ next to the executable (Windows/Linux). Pre-installs marketplace extensions via the CLI. */
function preinstallPortable(l, marketplace, platform) {
  if (!l.portableData) return false;
  const data = l.portableData;
  rmrf(data);
  fs.mkdirSync(path.join(data, "user-data", "User"), { recursive: true });
  fs.mkdirSync(path.join(data, "extensions"), { recursive: true });
  fs.mkdirSync(path.join(data, "tmp"), { recursive: true });
  writeJson(path.join(data, "argv.json"), DEFAULT_ARGV);
  writeJson(path.join(data, "user-data", "User", "settings.json"), DEFAULT_SETTINGS);
  if (platform !== hostPlatform()) {
    log("WARN: cross-build, cannot run the CLI; marketplace extensions will be installed on first run");
    return true;
  }
  const cli = path.join(l.appRoot, "out", "cli.js");
  for (const ext of marketplace) {
    run(l.exe, [cli, "--install-extension", ext.file, "--extensions-dir", path.join(data, "extensions"), "--user-data-dir", path.join(data, "user-data")], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", VSCODE_PORTABLE: data },
    });
  }
  // Drop runtime noise produced by the CLI run; keep languagepacks.json, User/, extensions/.
  for (const junk of ["logs", "CachedExtensionVSIXs", "CachedProfilesData", "machineid", "storage.json", "telemetry.json"]) {
    rmrf(path.join(data, "user-data", junk));
  }
  // Paths relative to the app dir: Explorer/shortcut launches start there, so the first start is
  // Russian; launched from elsewhere VS Code falls back to English once and rewrites the cache itself.
  const lp = writeLanguagePacks(path.join(data, "extensions"), path.join(data, "user-data"), { relativeTo: l.appDir });
  log("languagepacks.json:", lp.languages.join(", ") || "none");
  rmrf(path.join(data, "tmp"));
  fs.mkdirSync(path.join(data, "tmp"), { recursive: true });
  log("portable profile ready:", fs.readdirSync(path.join(data, "extensions")).join(", "));
  return true;
}

function findIscc() {
  const candidates = [
    process.env.ISCC,
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Inno Setup 6", "ISCC.exe"),
    "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
    "C:\\Program Files\\Inno Setup 6\\ISCC.exe",
  ].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c));
}

function buildInstaller(l, product, icons, outDir) {
  const iscc = findIscc();
  if (!iscc) {
    log("WARN: ISCC.exe not found, skipping installer");
    return null;
  }
  const iss = path.join(ROOT, "build", "win32", "tkbk-ide.iss");
  const [maj, min, patch] = TKBK_IDE_VERSION.split(".").map((n) => Number(n));
  run(iscc, [
    `/DAppVersion=${TKBK_IDE_VERSION}`,
    `/DFileVersion=${maj}.${min}.${patch}.0`,
    `/DSourceDir=${l.appDir}`,
    `/DOutputDir=${outDir}`,
    `/DSetupIcon=${icons.ico}`,
    `/DAppId=${product.win32x64UserAppId.replace(/[{}]/g, "")}`,
    `/DAppMutex=${product.win32MutexName}`,
    "/Qp",
    iss,
  ]);
  const file = path.join(outDir, `TKBK-IDE-Setup-win32-x64-${TKBK_IDE_VERSION}.exe`);
  log("installer:", file);
  return file;
}

export async function build(opts) {
  const { platform, codium: codiumVersion } = opts;
  const outDir = opts.out;
  const stageDir = path.join(outDir, "stage", platform);
  const tmpDir = path.join(outDir, "tmp");
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  log(`building ${BRAND.nameLong} ${TKBK_IDE_VERSION} for ${platform} on VSCodium ${codiumVersion}`);
  const { codiumArchive, marketplace, agentVsix } = await fetchAll({ platform, codiumVersion, agentVsix: opts.agentVsix });

  stageArchive(codiumArchive, stageDir, platform);
  const l = layout(stageDir, platform);
  const product = patchProduct(l.appRoot, codiumVersion);
  const icons = await generateIcons(path.join(outDir, "icons"));
  await applyIcons(l, icons);
  if (l.os === "win32") await brandWindows(l, product, icons, codiumVersion);
  else if (l.os === "linux") brandLinux(l, product);
  else brandDarwin(l, product, codiumVersion);

  const agent = installBuiltinExtensions(l, agentVsix, tmpDir);
  const bundled = bundleMarketplace(l, marketplace, product);

  const artifacts = [];
  if (l.os === "win32" && opts.installer) {
    const exe = buildInstaller(l, product, icons, outDir);
    if (exe) artifacts.push(exe);
  }
  if (opts.preinstall) preinstallPortable(l, marketplace, platform);

  const archiveName =
    l.os === "linux" ? `TKBK-IDE-${platform}-${TKBK_IDE_VERSION}.tar.gz` : `TKBK-IDE-${platform}-${TKBK_IDE_VERSION}.zip`;
  const archive = path.join(outDir, archiveName);
  createArchive(archive, stageDir, l.archiveEntries());
  artifacts.push(archive);

  const summary = {
    platform,
    version: TKBK_IDE_VERSION,
    vscodium: codiumVersion,
    product: { nameLong: product.nameLong, applicationName: product.applicationName, dataFolderName: product.dataFolderName },
    agent,
    bundled,
    artifacts,
  };
  writeJson(path.join(outDir, `build-${platform}.json`), summary);
  for (const a of artifacts) log("artifact", a, `${(fs.statSync(a).size / 1024 / 1024).toFixed(1)} MB`);
  if (!opts.keepStage) rmrf(tmpDir);
  return summary;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  build(parseArgs(process.argv.slice(2))).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { parseArgs, layout };
