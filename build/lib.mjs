// Small helpers shared by the build scripts. No third-party dependencies.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

export function log(...args) {
  console.log("[tkbk-ide]", ...args);
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, "\t") + "\n");
}

/**
 * Merge brand overrides into product.json.
 * - `null` deletes a key.
 * - `{ "$append": [...] }` appends unique items to an array.
 * - `{ "$prepend": [...] }` prepends items to an array.
 * - plain objects are replaced (not deep-merged) to keep behaviour predictable.
 */
export function mergeProduct(base, overrides) {
  const out = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) {
      delete out[key];
    } else if (value && typeof value === "object" && !Array.isArray(value) && ("$append" in value || "$prepend" in value)) {
      const current = Array.isArray(out[key]) ? out[key] : [];
      const pre = value.$prepend ?? [];
      const post = (value.$append ?? []).filter((item) => !current.some((c) => JSON.stringify(c) === JSON.stringify(item)));
      out[key] = [...pre, ...current, ...post];
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Replace all occurrences of each [from, to] pair in a text file. Throws if a `from` is missing when required. */
export function patchText(file, replacements, { required = true } = {}) {
  let text = fs.readFileSync(file, "utf8");
  for (const [from, to] of replacements) {
    if (!text.includes(from)) {
      if (required) throw new Error(`patchText: "${from}" not found in ${file}`);
      continue;
    }
    text = text.split(from).join(to);
  }
  fs.writeFileSync(file, text);
  return text;
}

export function sha256File(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

export async function download(url, dest, { headers = {} } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { headers: { "user-agent": "tkbk-ide-build", ...headers }, redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`download failed ${res.status} ${url}`);
  const tmp = dest + ".part";
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
  return dest;
}

export async function fetchJson(url, { headers = {} } = {}) {
  const res = await fetch(url, { headers: { "user-agent": "tkbk-ide-build", accept: "application/json", ...headers } });
  if (!res.ok) throw new Error(`fetch failed ${res.status} ${url}`);
  return res.json();
}

/** bsdtar on Windows (System32), tar elsewhere. bsdtar handles .zip and .tar.gz for both directions. */
export function tarBinary() {
  if (process.platform === "win32") {
    const sys = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    if (fs.existsSync(sys)) return sys;
  }
  return "tar";
}

export function extractArchive(archive, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === "darwin" && archive.endsWith(".zip")) {
    // ditto keeps symlinks, resource forks and permissions of .app bundles intact
    run("ditto", ["-x", "-k", archive, destDir]);
    return;
  }
  // GNU tar (Linux) does not read zip containers (.zip, .vsix); bsdtar on Windows and macOS does.
  if (process.platform === "linux" && /\.(zip|vsix)$/i.test(archive)) {
    run("unzip", ["-q", "-o", archive, "-d", destDir]);
    return;
  }
  run(tarBinary(), ["-xf", archive, "-C", destDir]);
}

/** Create .zip / .tar.gz of `entries` (relative names) inside `cwd`. */
export function createArchive(archive, cwd, entries) {
  fs.rmSync(archive, { force: true });
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  if (process.platform === "darwin" && archive.endsWith(".zip")) {
    if (entries.length !== 1) throw new Error("ditto zip supports a single top-level entry");
    run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", path.join(cwd, entries[0]), archive]);
    return;
  }
  if (archive.endsWith(".zip")) {
    run(tarBinary(), ["-a", "-cf", archive, "-C", cwd, ...entries]);
  } else if (archive.endsWith(".tar.gz")) {
    run(tarBinary(), ["-czf", archive, "-C", cwd, ...entries]);
  } else {
    throw new Error(`unknown archive type: ${archive}`);
  }
}

export function run(cmd, args, opts = {}) {
  log("$", cmd, ...args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)));
  const res = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`${cmd} exited with ${res.status}`);
}

export function runCapture(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts });
}

export function copyDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true, force: true });
}

export function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

/** Simple semver range check for "^x.y.z" / ">=x.y.z" / "*" against a version. */
export function satisfiesEngine(range, version) {
  const v = parseSemver(version);
  if (!v) return false;
  const r = range.trim();
  if (r === "*" || r === "") return true;
  const m = r.match(/^(\^|>=|~)?\s*(\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  const [, op = "^", a, b, c] = m;
  const need = [Number(a), Number(b), Number(c)];
  if (compareSemver(v, need) < 0) return false;
  if (op === ">=") return true;
  if (op === "~") return v[0] === need[0] && v[1] === need[1];
  return v[0] === need[0];
}

export function parseSemver(s) {
  const m = String(s).match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}
