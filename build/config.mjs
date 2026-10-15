// Central build configuration for TKBK IDE.
// Everything brand-related lives here or in brand/product.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CACHE_DIR = path.join(ROOT, ".cache");
export const DIST_DIR = path.join(ROOT, "dist");

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

/** VSCodium release used as the base. Override: --codium <tag> or env VSCODIUM_VERSION. */
export const VSCODIUM_VERSION = process.env.VSCODIUM_VERSION || "1.140.06880";

/** Our own release number (package.json version). */
export const TKBK_IDE_VERSION = pkg.version;

export const BRAND = {
  nameShort: "TKBK IDE",
  nameLong: "TKBK IDE",
  applicationName: "tkbk-ide",
  exeBaseName: "TKBK IDE", // Windows: "TKBK IDE.exe"; macOS: "TKBK IDE.app"
  linuxBinary: "tkbk-ide",
  company: "TKBK",
  copyright: "Copyright (c) 2026 TKBK. Built on VSCodium (MIT) and Visual Studio Code OSS (MIT).",
  homepage: "https://tkbk.online",
  repo: "https://github.com/tkbk-online/tkbk-ide",
  // Background colour of the Windows tile and of the welcome page.
  tileColor: "#08090b",
};

/** Marketplace extensions pre-installed into the user profile (Open VSX). */
export const MARKETPLACE_EXTENSIONS = [
  {
    id: "MS-CEINTL.vscode-language-pack-ru",
    namespace: "MS-CEINTL",
    name: "vscode-language-pack-ru",
    // Language packs must not be newer than the editor: pick the newest version
    // whose engines.vscode is satisfied by the VSCodium version.
    matchEngine: true,
  },
  {
    id: "eamodio.gitlens",
    namespace: "eamodio",
    name: "gitlens",
    matchEngine: true,
  },
];

/** Extensions bundled as built-in (resources/app/extensions). */
export const BUILTIN_EXTENSIONS_FROM_REPO = ["tkbk-welcome", "tkbk-theme", "tkbk-complete"];

/** Where to get the TKBK Agent .vsix when --agent-vsix is not given. */
export const AGENT_RELEASE = {
  repo: "tkbk-online/tkbk-agent",
  assetPattern: /^tkbk-agent-.*\.vsix$/,
};

export const PLATFORMS = {
  "win32-x64": {
    archive: (v) => `VSCodium-win32-x64-${v}.zip`,
    kind: "zip",
    appRootRel: "resources/app",
  },
  "linux-x64": {
    archive: (v) => `VSCodium-linux-x64-${v}.tar.gz`,
    kind: "tar.gz",
    topDir: "VSCodium-linux-x64",
    appRootRel: "resources/app",
  },
  "darwin-x64": {
    archive: (v) => `VSCodium-darwin-x64-${v}.zip`,
    kind: "zip",
    appBundle: "VSCodium.app",
    appRootRel: "Contents/Resources/app",
  },
  "darwin-arm64": {
    archive: (v) => `VSCodium-darwin-arm64-${v}.zip`,
    kind: "zip",
    appBundle: "VSCodium.app",
    appRootRel: "Contents/Resources/app",
  },
};

export function hostPlatform() {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${process.platform}-${arch}`;
}

/** Seed settings written to the portable profile (and used as configurationDefaults). */
export const DEFAULT_SETTINGS = {
  "workbench.colorTheme": "TKBK Dark",
  "workbench.startupEditor": "none",
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "extensions.autoCheckUpdates": true,
  "workbench.tips.enabled": false,
  "tkbk.welcome.showOnStartup": true,
  "gitlens.showWhatsNewAfterUpgrades": false,
  "gitlens.telemetry.enabled": false,
  "gitlens.graph.layout": "editor",
  "workbench.welcomePage.walkthroughs.openOnInstall": false,
};

export const DEFAULT_ARGV = {
  locale: "ru",
  "enable-crash-reporter": false,
};
