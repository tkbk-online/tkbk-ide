import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { collectLanguagePacks, writeLanguagePacks } = require("./langpack.cjs");

function fakeExtensions() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkbk-lp-"));
  const ext = path.join(dir, "ext", "ms-ceintl.vscode-language-pack-ru-1.131.0");
  fs.mkdirSync(path.join(ext, "translations", "extensions"), { recursive: true });
  fs.writeFileSync(
    path.join(ext, "package.json"),
    JSON.stringify({
      name: "vscode-language-pack-ru",
      publisher: "MS-CEINTL",
      version: "1.131.0",
      contributes: {
        localizations: [
          {
            languageId: "ru",
            languageName: "Russian",
            localizedLanguageName: "русский",
            translations: [
              { id: "vscode", path: "./translations/main.i18n.json" },
              { id: "vscode.git", path: "./translations/extensions/vscode.git.i18n.json" },
            ],
          },
        ],
      },
    }),
  );
  fs.mkdirSync(path.join(dir, "ext", "eamodio.gitlens-1.0.0"));
  fs.writeFileSync(path.join(dir, "ext", "eamodio.gitlens-1.0.0", "package.json"), JSON.stringify({ name: "gitlens", publisher: "eamodio", version: "1.0.0" }));
  return dir;
}

test("collectLanguagePacks mirrors VS Code's cache format and hash", () => {
  const dir = fakeExtensions();
  const packs = collectLanguagePacks(path.join(dir, "ext"));
  assert.deepEqual(Object.keys(packs), ["ru"]);
  const ru = packs.ru;
  assert.equal(ru.label, "русский");
  assert.deepEqual(ru.extensions, [{ extensionIdentifier: { id: "ms-ceintl.vscode-language-pack-ru" }, version: "1.131.0" }]);
  const expected = crypto.createHash("md5").update("ms-ceintl.vscode-language-pack-ru").update("1.131.0").digest("hex");
  assert.equal(ru.hash, expected);
  assert.equal(expected, "e75c90b69373540eee138c89a17ed8ad", "same hash VS Code 1.140 wrote for this pack");
  assert.ok(path.isAbsolute(ru.translations.vscode));
  assert.ok(ru.translations.vscode.endsWith(path.join("translations", "main.i18n.json")));
  assert.ok(ru.translations["vscode.git"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("writeLanguagePacks supports relative paths for portable builds", () => {
  const dir = fakeExtensions();
  const res = writeLanguagePacks(path.join(dir, "ext"), path.join(dir, "user-data"), { relativeTo: dir });
  const json = JSON.parse(fs.readFileSync(res.file, "utf8"));
  assert.deepEqual(res.languages, ["ru"]);
  assert.equal(json.ru.translations.vscode, path.join("ext", "ms-ceintl.vscode-language-pack-ru-1.131.0", "translations", "main.i18n.json"));
  fs.rmSync(dir, { recursive: true, force: true });
});
