// Downloads everything the build needs into .cache/:
//  - the VSCodium release archive for the target platform (+ sha256 check)
//  - marketplace .vsix files from Open VSX (version matched to the editor engine)
//  - the TKBK Agent .vsix (local path, env TKBK_AGENT_VSIX or latest GitHub release)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_RELEASE,
  CACHE_DIR,
  MARKETPLACE_EXTENSIONS,
  PLATFORMS,
  VSCODIUM_VERSION,
  hostPlatform,
} from "./config.mjs";
import { compareSemver, download, fetchJson, log, parseSemver, readJson, satisfiesEngine, sha256File } from "./lib.mjs";

const GH = "https://github.com";
const GH_API = "https://api.github.com";

function ghHeaders() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return token ? { authorization: `Bearer ${token}` } : {};
}

export async function fetchVSCodium(platform, version = VSCODIUM_VERSION) {
  const spec = PLATFORMS[platform];
  if (!spec) throw new Error(`unknown platform ${platform}`);
  const name = spec.archive(version);
  const dir = path.join(CACHE_DIR, "vscodium", version);
  const file = path.join(dir, name);
  const shaFile = file + ".sha256";
  const base = `${GH}/VSCodium/vscodium/releases/download/${version}/`;
  if (!fs.existsSync(shaFile)) await download(base + name + ".sha256", shaFile);
  const expected = fs.readFileSync(shaFile, "utf8").trim().split(/\s+/)[0].toLowerCase();
  if (!fs.existsSync(file) || sha256File(file) !== expected) {
    log("downloading", name);
    await download(base + name, file);
  }
  const actual = sha256File(file);
  if (actual !== expected) throw new Error(`sha256 mismatch for ${name}: ${actual} != ${expected}`);
  log("vscodium ok", name);
  return file;
}

/** Pick the newest Open VSX version whose engines.vscode is satisfied by `editorVersion`. */
export function pickVersion(allVersions, metaByVersion, editorVersion) {
  const versions = Object.keys(allVersions)
    .filter((v) => parseSemver(v))
    .sort((a, b) => compareSemver(parseSemver(b), parseSemver(a)));
  for (const v of versions) {
    const engine = metaByVersion(v);
    if (!engine || satisfiesEngine(engine, editorVersion)) return v;
  }
  return null;
}

export async function fetchMarketplace(editorVersion = VSCODIUM_VERSION) {
  const results = [];
  for (const ext of MARKETPLACE_EXTENSIONS) {
    const dir = path.join(CACHE_DIR, "openvsx");
    fs.mkdirSync(dir, { recursive: true });
    const metaUrl = `https://open-vsx.org/api/${ext.namespace}/${ext.name}`;
    const latest = await fetchJson(metaUrl);
    let version = ext.version || latest.version;
    let meta = latest;
    if (!ext.version && ext.matchEngine) {
      const cache = new Map();
      const metas = new Map([[latest.version, latest]]);
      // Fetch metadata lazily, newest first, until one satisfies the engine.
      const candidates = Object.keys(latest.allVersions || {})
        .filter((v) => parseSemver(v))
        .sort((a, b) => compareSemver(parseSemver(b), parseSemver(a)));
      version = null;
      for (const v of candidates) {
        if (!metas.has(v)) metas.set(v, await fetchJson(`${metaUrl}/${v}`));
        const m = metas.get(v);
        const engine = m.engines?.vscode || "*";
        cache.set(v, engine);
        if (satisfiesEngine(engine, editorVersion)) {
          version = v;
          meta = m;
          break;
        }
      }
      if (!version) throw new Error(`no version of ${ext.id} supports VS Code ${editorVersion}`);
    }
    const fileName = `${ext.namespace}.${ext.name}-${version}.vsix`;
    const file = path.join(dir, fileName);
    if (!fs.existsSync(file)) {
      const url = meta.files?.download || `${metaUrl}/${version}/file/${fileName}`;
      log("downloading", fileName);
      await download(url, file);
    }
    log("marketplace ok", fileName, "engine", meta.engines?.vscode);
    results.push({ id: ext.id, version, file, engine: meta.engines?.vscode, license: meta.license });
  }
  return results;
}

export async function fetchAgentVsix(explicitPath) {
  const candidate = explicitPath || process.env.TKBK_AGENT_VSIX;
  if (candidate) {
    if (!fs.existsSync(candidate)) throw new Error(`agent vsix not found: ${candidate}`);
    log("agent vsix", candidate);
    return path.resolve(candidate);
  }
  const dir = path.join(CACHE_DIR, "agent");
  fs.mkdirSync(dir, { recursive: true });
  const rel = await fetchJson(`${GH_API}/repos/${AGENT_RELEASE.repo}/releases/latest`, { headers: ghHeaders() });
  const asset = (rel.assets || []).find((a) => AGENT_RELEASE.assetPattern.test(a.name));
  if (!asset) throw new Error(`no .vsix asset in latest release of ${AGENT_RELEASE.repo}`);
  const file = path.join(dir, asset.name);
  if (!fs.existsSync(file) || fs.statSync(file).size !== asset.size) {
    log("downloading", asset.name, "from", rel.tag_name);
    await download(asset.browser_download_url, file, { headers: ghHeaders() });
  }
  log("agent vsix", file);
  return file;
}

export async function fetchAll({ platform = hostPlatform(), codiumVersion = VSCODIUM_VERSION, agentVsix } = {}) {
  const [codiumArchive, marketplace, agent] = await Promise.all([
    fetchVSCodium(platform, codiumVersion),
    fetchMarketplace(codiumVersion),
    fetchAgentVsix(agentVsix),
  ]);
  return { codiumArchive, marketplace, agentVsix: agent };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  fetchAll({ platform: get("--platform"), codiumVersion: get("--codium"), agentVsix: get("--agent-vsix") })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

export { readJson };
