// update.json for the built-in updater (extensions/tkbk-welcome/updater.js), built in the release job:
//
//   node build/update-manifest.mjs --dir artifacts --tag v0.3.0 [--out artifacts/update.json]
//
// Fails when the tag does not match package.json, so a release can never announce a version
// the binaries inside it do not carry.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { TKBK_IDE_VERSION } from "./config.mjs";
import { readJson, sha256File, writeJson } from "./lib.mjs";

const require = createRequire(import.meta.url);
const { ASSET_URL_PREFIX, classifyAsset, validateManifest } = require("../extensions/tkbk-welcome/update-lib.js");

export function buildManifest({ dir, tag, version = TKBK_IDE_VERSION, now = new Date() }) {
  if (tag.replace(/^v/, "") !== version) throw new Error(`tag ${tag} does not match package.json version ${version}`);
  const files = fs.readdirSync(dir).sort();
  const assets = {};
  for (const name of files) {
    const key = classifyAsset(name);
    if (!key) continue;
    if (assets[key]) throw new Error(`two files for ${key}: ${assets[key].name}, ${name}`);
    if (!name.includes(version)) throw new Error(`${name} is not built for ${version}`);
    const file = path.join(dir, name);
    assets[key] = {
      name,
      url: `${ASSET_URL_PREFIX}${tag}/${encodeURIComponent(name)}`,
      sha256: sha256File(file),
      size: fs.statSync(file).size,
    };
  }
  if (!Object.keys(assets).length) throw new Error(`no TKBK IDE artifacts in ${dir}`);
  // Versions of VSCodium and TKBK Agent from build/build.mjs summaries (build-<platform>.json).
  const summaries = files.filter((f) => /^build-.+\.json$/.test(f)).map((f) => readJson(path.join(dir, f)));
  const first = summaries[0] || {};
  return validateManifest({
    schema: 1,
    version,
    published: now.toISOString(),
    releaseUrl: `https://github.com/tkbk-online/tkbk-ide/releases/tag/${tag}`,
    vscodium: first.vscodium || null,
    agent: first.agent ? first.agent.version : null,
    assets,
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dir = path.resolve(get("--dir") || "dist");
  const tag = get("--tag") || process.env.GITHUB_REF_NAME;
  if (!tag) throw new Error("--tag is required");
  const out = path.resolve(get("--out") || path.join(dir, "update.json"));
  const manifest = buildManifest({ dir, tag });
  writeJson(out, manifest);
  console.log(`update.json → ${out}: ${manifest.version}, ${Object.keys(manifest.assets).join(", ")}`);
}
