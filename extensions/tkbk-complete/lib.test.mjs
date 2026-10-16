import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const lib = require("./lib.js");

test("buildRequest: OpenAI-compatible for non-Claude models", () => {
  const r = lib.buildRequest({ baseUrl: "https://api.tkbk.online/v1/", apiKey: "cr_x", model: "deepseek-v4-pro", prefix: "a", suffix: "b", language: "js", fileName: "x.js", maxTokens: 64, stop: ["\n"] });
  assert.equal(r.protocol, "openai");
  assert.equal(r.url, "https://api.tkbk.online/v1/chat/completions");
  assert.equal(r.headers.authorization, "Bearer cr_x");
  assert.equal(r.body.model, "deepseek-v4-pro");
  assert.equal(r.body.messages[0].role, "system");
  assert.match(r.body.messages[1].content, /<PREFIX>\na\n<\/PREFIX>\n<SUFFIX>\nb\n<\/SUFFIX>/);
  assert.deepEqual(r.body.stop, ["\n"]);
  assert.equal(r.body.stream, false);
});

test("buildRequest: Anthropic Messages for Claude models", () => {
  const r = lib.buildRequest({ baseUrl: "https://api.tkbk.online/v1", apiKey: "cr_x", model: "claude-sonnet-5", prefix: "a", suffix: "", maxTokens: 64, stop: [] });
  assert.equal(r.protocol, "anthropic");
  assert.equal(r.url, "https://api.tkbk.online/v1/messages");
  assert.equal(r.headers["anthropic-version"], "2023-06-01");
  assert.equal(r.body.system, lib.SYSTEM_PROMPT);
  assert.equal(r.body.stop_sequences, undefined);
});

test("extractText handles both response shapes", () => {
  assert.equal(lib.extractText({ choices: [{ message: { content: "foo" } }] }, "openai"), "foo");
  assert.equal(lib.extractText({ content: [{ type: "text", text: "bar" }, { type: "tool_use" }] }, "anthropic"), "bar");
  assert.equal(lib.extractText({}, "openai"), "");
});

test("allowMultiline policy", () => {
  assert.equal(lib.allowMultiline("auto", "", ""), true);
  assert.equal(lib.allowMultiline("auto", "function f() {", ""), true);
  assert.equal(lib.allowMultiline("auto", "const x = ", ""), true);
  assert.equal(lib.allowMultiline("auto", "const x", ""), false);
  assert.equal(lib.allowMultiline("auto", "", "}"), false);
  assert.equal(lib.allowMultiline("never", "", ""), false);
  assert.equal(lib.allowMultiline("always", "x", "y"), true);
});

test("postProcess strips fences, echoes and duplicated closers", () => {
  assert.equal(lib.postProcess("```js\nreturn a + b;\n```", { lineBefore: "  ", lineAfter: "", multiline: false }), "return a + b;");
  // echo of the typed part of the line
  assert.equal(lib.postProcess("const sum = a + b;", { lineBefore: "const sum = ", lineAfter: "", multiline: false }), "a + b;");
  // single-line mode keeps only the first line
  assert.equal(lib.postProcess("foo();\nbar();", { lineBefore: "x.", lineAfter: "", multiline: false }), "foo();");
  // don't duplicate the closing bracket already after the cursor
  assert.equal(lib.postProcess("1, 2)", { lineBefore: "f(", lineAfter: ")", multiline: false }), "1, 2");
  // multiline keeps structure, trims trailing spaces
  assert.equal(lib.postProcess("\n  return 1;   \n}", { lineBefore: "function f() {", lineAfter: "", multiline: true }), "\n  return 1;\n}");
  // empty / whitespace
  assert.equal(lib.postProcess("   \n", { lineBefore: "", lineAfter: "", multiline: true }), "");
  // does not repeat following document lines
  assert.equal(lib.postProcess("x = 1\nreturn x", { lineBefore: "", lineAfter: "", multiline: true, suffix: "\nreturn x\n" }), "x = 1");
});

test("reuseFromPrevious returns the remainder when the user types through a suggestion", () => {
  const prev = { prefix: "const a = ", text: "foo(bar);" };
  assert.equal(lib.reuseFromPrevious(prev, "const a = fo"), "o(bar);");
  assert.equal(lib.reuseFromPrevious(prev, "const a = "), "foo(bar);");
  assert.equal(lib.reuseFromPrevious(prev, "const a = x"), null);
  assert.equal(lib.reuseFromPrevious(prev, "other"), null);
  assert.equal(lib.reuseFromPrevious(null, "x"), null);
});

test("LruCache evicts oldest", () => {
  const c = new lib.LruCache(2);
  c.set("a", 1);
  c.set("b", 2);
  c.get("a");
  c.set("c", 3);
  assert.equal(c.get("b"), undefined);
  assert.equal(c.get("a"), 1);
  assert.equal(c.get("c"), 3);
});

test("isSensitiveFile", () => {
  assert.equal(lib.isSensitiveFile("/p/.env"), true);
  assert.equal(lib.isSensitiveFile("C:\\p\\.env.local"), true);
  assert.equal(lib.isSensitiveFile("/p/server.pem"), true);
  assert.equal(lib.isSensitiveFile("/p/secrets.yaml"), true);
  assert.equal(lib.isSensitiveFile("/p/environment.ts"), false);
  assert.equal(lib.isSensitiveFile("/p/app.js"), false);
});

test("end-to-end against a mock gateway (both protocols)", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.setHeader("content-type", "application/json");
      if (req.url.endsWith("/chat/completions")) res.end(JSON.stringify({ choices: [{ message: { content: "```\nconsole.log(x);\n```" } }] }));
      else if (req.url.endsWith("/messages")) res.end(JSON.stringify({ content: [{ type: "text", text: "return x;" }] }));
      else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    for (const [model, expected] of [["deepseek-v4-pro", "console.log(x);"], ["claude-sonnet-5", "return x;"]]) {
      const r = lib.buildRequest({ baseUrl: base, apiKey: "cr_test", model, prefix: "const x = 1;\n", suffix: "", maxTokens: 32, stop: lib.stopSequences(true) });
      const res = await fetch(r.url, { method: "POST", headers: r.headers, body: JSON.stringify(r.body) });
      const text = lib.postProcess(lib.extractText(await res.json(), r.protocol), { lineBefore: "", lineAfter: "", multiline: true });
      assert.equal(text, expected);
    }
    assert.equal(seen.length, 2);
    assert.equal(seen[0].auth, "Bearer cr_test");
    assert.equal(seen[1].url, "/v1/messages");
  } finally {
    server.close();
  }
});

test("buildRequest: recent edits come before PREFIX and are optional", () => {
  const withEdits = lib.buildRequest({ apiKey: "k", model: "glm-5.3", prefix: "p", suffix: "s", maxTokens: 8, stop: [], recentEdits: "src/a.ts:3\nconst a = 1" });
  const body = withEdits.body.messages[1].content;
  assert.ok(body.indexOf("<RECENT_EDITS>") < body.indexOf("<PREFIX>"));
  assert.match(body, /src\/a\.ts:3\nconst a = 1/);
  const without = lib.buildRequest({ apiKey: "k", model: "glm-5.3", prefix: "p", suffix: "s", maxTokens: 8, stop: [], recentEdits: "" });
  assert.doesNotMatch(without.body.messages[1].content, /RECENT_EDITS/);
});

test("RecentEdits: newest first, deduped by file+line, expiring, excluding the current file", () => {
  const edits = new lib.RecentEdits({ limit: 3, maxAgeMs: 1000 });
  edits.record({ file: "a.ts", line: 1, snippet: "one" }, 0);
  edits.record({ file: "b.ts", line: 5, snippet: "five" }, 10);
  edits.record({ file: "a.ts", line: 1, snippet: "one-again" }, 20);
  edits.record({ file: "c.ts", line: 2, snippet: "   " }, 30);
  assert.equal(edits.format(40), "a.ts:1\none-again\n---\nb.ts:5\nfive");
  assert.equal(edits.format(40, "a.ts"), "b.ts:5\nfive");
  edits.record({ file: "d.ts", line: 1, snippet: "d" }, 50);
  edits.record({ file: "e.ts", line: 1, snippet: "e" }, 60);
  assert.equal(edits.items.length, 3);
  assert.equal(edits.format(2000), "");
});
