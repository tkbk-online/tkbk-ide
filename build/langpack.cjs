// Generates VS Code's languagepacks.json cache from installed language-pack extensions.
// VS Code (main process) only writes this cache during a GUI session, so after a CLI
// `--install-extension` the very first start would still be English. We pre-create it.
//
// Format and hash mirror src/vs/platform/languagePacks/node/languagePacks.ts:
//   { [languageId]: { hash: md5(id+version...), extensions: [{extensionIdentifier:{id}, version}],
//                     translations: { [id]: absolutePath }, label } }
//
// CommonJS on purpose: this file is also shipped inside the app and executed with
// `ELECTRON_RUN_AS_NODE=1 "TKBK IDE.exe" write-languagepacks.cjs <extensionsDir> <userDataDir> [--relative-to <dir>]`.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * @param {string} extensionsDir  user extensions directory
 * @param {{ relativeTo?: string }} [opts]  write translation paths relative to this directory (portable builds)
 */
function collectLanguagePacks(extensionsDir, opts = {}) {
  const packs = {};
  if (!fs.existsSync(extensionsDir)) return packs;
  for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const extPath = path.join(extensionsDir, entry.name);
    const manifestFile = path.join(extPath, "package.json");
    if (!fs.existsSync(manifestFile)) continue;
    let manifest;
    try {
      manifest = readJson(manifestFile);
    } catch {
      continue;
    }
    const localizations = manifest.contributes && manifest.contributes.localizations;
    if (!Array.isArray(localizations) || !localizations.length) continue;
    const id = `${manifest.publisher}.${manifest.name}`.toLowerCase();
    for (const loc of localizations) {
      if (!loc.languageId || !Array.isArray(loc.translations)) continue;
      const pack = (packs[loc.languageId] ||= {
        hash: "",
        extensions: [],
        translations: {},
        label: loc.localizedLanguageName || loc.languageName,
      });
      const existing = pack.extensions.find((e) => e.extensionIdentifier.id === id);
      if (existing) existing.version = manifest.version;
      else pack.extensions.push({ extensionIdentifier: { id }, version: manifest.version });
      for (const t of loc.translations) {
        const abs = path.join(extPath, t.path);
        pack.translations[t.id] = opts.relativeTo ? path.relative(opts.relativeTo, abs) : abs;
      }
    }
  }
  for (const pack of Object.values(packs)) {
    const h = crypto.createHash("md5");
    for (const e of pack.extensions) h.update(e.extensionIdentifier.uuid || e.extensionIdentifier.id).update(e.version);
    pack.hash = h.digest("hex");
  }
  return packs;
}

function writeLanguagePacks(extensionsDir, userDataDir, opts = {}) {
  const packs = collectLanguagePacks(extensionsDir, opts);
  fs.mkdirSync(userDataDir, { recursive: true });
  const file = path.join(userDataDir, "languagepacks.json");
  fs.writeFileSync(file, JSON.stringify(packs));
  return { file, languages: Object.keys(packs) };
}

module.exports = { collectLanguagePacks, writeLanguagePacks };

if (require.main === module) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--relative-to");
  const relativeTo = i >= 0 ? args.splice(i, 2)[1] : undefined;
  const [extensionsDir, userDataDir] = args;
  if (!extensionsDir || !userDataDir) {
    console.error("usage: write-languagepacks.cjs <extensionsDir> <userDataDir> [--relative-to <dir>]");
    process.exit(2);
  }
  const res = writeLanguagePacks(extensionsDir, userDataDir, { relativeTo });
  console.log(`languagepacks.json: ${res.languages.join(", ") || "none"} -> ${res.file}`);
}
