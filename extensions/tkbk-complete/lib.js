// Pure helpers for TKBK Tab (no vscode dependency) — unit-tested with node:test.
"use strict";

const SYSTEM_PROMPT = [
  "You are a code completion engine inside an IDE.",
  "You receive the text before the cursor (PREFIX) and after the cursor (SUFFIX), and sometimes the developer's RECENT_EDITS in other places of the project for context.",
  "Return ONLY the code to insert at the cursor: no explanations, no markdown fences, no repetition of PREFIX or SUFFIX.",
  "Match the language, indentation and style of the surrounding code. Keep it short: finish the current statement or block.",
  "If nothing useful can be inserted, return an empty string.",
].join(" ");

const FENCE_RE = /^\s*```[a-zA-Z0-9_+-]*\s*\n?|\n?\s*```\s*$/g;

function isClaudeModel(model) {
  return /^claude/i.test(String(model || ""));
}

/**
 * Build the request for the TKBK gateway. Returns { url, headers, body }.
 * The static system prompt goes first and the dynamic parts last so the gateway's
 * prompt cache keeps hitting on the stable prefix.
 */
function buildRequest({ baseUrl, apiKey, model, prefix, suffix, language, fileName, maxTokens, stop, recentEdits }) {
  const base = String(baseUrl || "https://api.tkbk.online/v1").replace(/\/+$/, "");
  const recent = recentEdits && recentEdits.trim() ? ["<RECENT_EDITS>", recentEdits.trim(), "</RECENT_EDITS>", ""] : [];
  const user = [
    `File: ${fileName || "untitled"} (${language || "text"})`,
    "",
    ...recent,
    "<PREFIX>",
    prefix,
    "</PREFIX>",
    "<SUFFIX>",
    suffix,
    "</SUFFIX>",
    "",
    "Insert at cursor:",
  ].join("\n");
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
    "user-agent": "tkbk-ide-complete/0.1.0",
  };
  if (isClaudeModel(model)) {
    headers["anthropic-version"] = "2023-06-01";
    headers["x-api-key"] = apiKey;
    return {
      protocol: "anthropic",
      url: `${base}/messages`,
      headers,
      body: {
        model,
        max_tokens: maxTokens,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: user }],
        stop_sequences: stop && stop.length ? stop : undefined,
        metadata: { user_id: "tkbk-ide-tab" },
      },
    };
  }
  return {
    protocol: "openai",
    url: `${base}/chat/completions`,
    headers,
    body: {
      model,
      max_tokens: maxTokens,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: user },
      ],
      stop: stop && stop.length ? stop : undefined,
      stream: false,
    },
  };
}

/** Extract completion text from a gateway response of either protocol. */
function extractText(json, protocol) {
  if (!json) return "";
  if (protocol === "anthropic" || Array.isArray(json.content)) {
    return (json.content || [])
      .filter((c) => c && c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("");
  }
  const choice = json.choices && json.choices[0];
  if (!choice) return "";
  if (choice.message && typeof choice.message.content === "string") return choice.message.content;
  if (typeof choice.text === "string") return choice.text;
  return "";
}

/** Decide whether a multi-line completion is appropriate for this cursor position. */
function allowMultiline(policy, lineBefore, lineAfter) {
  if (policy === "always") return true;
  if (policy === "never") return false;
  if (lineAfter.trim() !== "") return false; // text after the cursor on the same line: stay single-line
  const before = lineBefore.trim();
  if (before === "") return true;
  return /[{(\[:,=>]$|=>$|\b(then|do|else|try|finally)$/.test(before);
}

function longestOverlap(a, b) {
  // longest suffix of a that is a prefix of b
  const max = Math.min(a.length, b.length);
  for (let n = max; n > 0; n--) {
    if (a.endsWith(b.slice(0, n))) return n;
  }
  return 0;
}

/**
 * Clean the model output into an insertable snippet.
 * @param {string} raw model text
 * @param {{lineBefore:string, lineAfter:string, multiline:boolean, suffix?:string}} ctx
 */
function postProcess(raw, ctx) {
  let text = String(raw || "").replace(/\r\n/g, "\n");
  text = text.replace(FENCE_RE, "");
  text = text.replace(/<\/?(PREFIX|SUFFIX|CURSOR)>/g, "");
  if (!text.trim()) return "";

  // Models often echo the current line: drop the overlap with what is already typed.
  const lineBefore = ctx.lineBefore || "";
  if (lineBefore.trim()) {
    const trimmedBefore = lineBefore.trimStart();
    if (text.startsWith(lineBefore)) text = text.slice(lineBefore.length);
    else if (text.startsWith(trimmedBefore)) text = text.slice(trimmedBefore.length);
    else {
      const n = longestOverlap(lineBefore, text);
      if (n >= 3) text = text.slice(n);
    }
  }
  if (lineBefore.trim() === "" && lineBefore.length && text.startsWith(lineBefore)) {
    // cursor sits after indentation already present in the editor
    text = text.slice(lineBefore.length);
  }

  // Leading newline when the cursor is on a non-empty line usually means "model wanted a new line";
  // keep it only in multiline mode.
  if (!ctx.multiline) {
    text = text.replace(/^\n+/, "");
    const nl = text.indexOf("\n");
    if (nl >= 0) text = text.slice(0, nl);
  } else {
    text = text.replace(/^\n{2,}/, "\n");
  }

  // Don't duplicate what already follows the cursor on this line (e.g. closing brackets).
  const lineAfter = ctx.lineAfter || "";
  if (lineAfter.trim()) {
    const after = lineAfter.trimEnd();
    if (text.endsWith(after)) text = text.slice(0, text.length - after.length);
    else {
      const n = longestOverlap(text, after);
      if (n > 0 && /^[)\]}>"'`;,]+$/.test(after.slice(0, n))) text = text.slice(0, text.length - n);
    }
  }
  // Don't repeat the following lines of the document verbatim.
  if (ctx.multiline && ctx.suffix) {
    const nextLines = ctx.suffix.replace(/^[^\n]*\n?/, "").split("\n").slice(0, 3).join("\n").trim();
    if (nextLines && text.trim().endsWith(nextLines)) {
      text = text.trimEnd();
      text = text.slice(0, text.length - nextLines.length).trimEnd();
    }
  }
  text = text.replace(/[ \t]+$/gm, "");
  if (!text.trim()) return "";
  return text;
}

/** Small LRU cache keyed by string. */
class LruCache {
  constructor(limit = 64) {
    this.limit = limit;
    this.map = new Map();
  }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
  }
}

/**
 * If the user typed a few characters that match the beginning of a previous completion
 * produced for a shorter prefix, return the remaining part instead of asking again.
 */
function reuseFromPrevious(prev, prefix) {
  if (!prev || !prefix.startsWith(prev.prefix)) return null;
  const typed = prefix.slice(prev.prefix.length);
  if (!typed || typed.includes("\n")) return typed === "" ? prev.text : null;
  if (!prev.text.startsWith(typed)) return null;
  const rest = prev.text.slice(typed.length);
  return rest.trim() ? rest : null;
}

/**
 * The developer's latest edits across files: a few short snippets the model sees as
 * extra context ("what am I in the middle of"). Deduplicated by file + line, newest first,
 * forgotten after `maxAgeMs`.
 */
class RecentEdits {
  constructor({ limit = 5, maxAgeMs = 5 * 60_000, snippetChars = 240 } = {}) {
    this.limit = limit;
    this.maxAgeMs = maxAgeMs;
    this.snippetChars = snippetChars;
    this.items = [];
  }
  /** @param {{file:string, line:number, snippet:string}} edit */
  record(edit, now = Date.now()) {
    const snippet = String(edit.snippet || "").replace(/\s+$/, "");
    if (!snippet.trim()) return;
    const key = `${edit.file}:${edit.line}`;
    this.items = this.items.filter((it) => it.key !== key);
    this.items.unshift({ key, file: edit.file, line: edit.line, snippet: snippet.slice(0, this.snippetChars), at: now });
    this.items = this.items.slice(0, this.limit);
  }
  /** Compact block for the prompt; `excludeFile` drops edits in the file being completed. */
  format(now = Date.now(), excludeFile) {
    this.items = this.items.filter((it) => now - it.at <= this.maxAgeMs);
    return this.items
      .filter((it) => !excludeFile || it.file !== excludeFile)
      .map((it) => `${it.file}:${it.line}\n${it.snippet}`)
      .join("\n---\n");
  }
  clear() {
    this.items = [];
  }
}

const SENSITIVE_FILE_RE = /(^|[\\/])(\.env(\..*)?|.*\.(pem|key|p12|pfx|kdbx)|id_rsa.*|secrets?\.(json|ya?ml|toml))$/i;

function isSensitiveFile(fileName) {
  return SENSITIVE_FILE_RE.test(String(fileName || ""));
}

function stopSequences(multiline) {
  return multiline ? ["</SUFFIX>", "<SUFFIX>", "```"] : ["\n", "</SUFFIX>", "```"];
}

module.exports = {
  SYSTEM_PROMPT,
  buildRequest,
  extractText,
  allowMultiline,
  postProcess,
  LruCache,
  reuseFromPrevious,
  isSensitiveFile,
  isClaudeModel,
  stopSequences,
  longestOverlap,
  RecentEdits,
};
