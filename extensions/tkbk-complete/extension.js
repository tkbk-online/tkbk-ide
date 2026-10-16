// TKBK Tab — inline code completions through the TKBK gateway (built-in extension of TKBK IDE).
"use strict";

const vscode = require("vscode");
const crypto = require("crypto");
const lib = require("./lib");

const SECRET_KEY = "tkbk.apiKey";
const AGENT_ID = "tkbk-online.tkbk-agent";
const CATALOG = ["deepseek-v4-pro", "glm-5.3", "gpt-6.1-sol", "grok-4.7", "claude-sonnet-5", "claude-opus-5-5", "claude-fable-5-1"];

let output;
let status;
let keyCache = { value: null, at: 0 };
let failures = 0;
let pausedUntil = 0;
let warnedNoKey = false;
let lastCompletion = null;
const cache = new lib.LruCache(64);
const recentEdits = new lib.RecentEdits();

const cfg = () => vscode.workspace.getConfiguration("tkbk.completion");
const log = (...a) => output && output.appendLine(`[${new Date().toISOString()}] ${a.join(" ")}`);

async function getApiKey(context) {
  if (keyCache.value && Date.now() - keyCache.at < 60_000) return keyCache.value;
  let key = (await context.secrets.get(SECRET_KEY)) || "";
  if (!key) {
    // Reuse the key entered in TKBK Agent when the agent exposes it through its API.
    try {
      const agent = vscode.extensions.getExtension(AGENT_ID);
      const api = agent && agent.isActive ? agent.exports : undefined;
      if (api && typeof api.getApiKey === "function") key = (await api.getApiKey()) || "";
      else if (api && typeof api.getTkbkApiKey === "function") key = (await api.getTkbkApiKey()) || "";
    } catch {
      key = "";
    }
  }
  if (!key) key = process.env.TKBK_API_KEY || "";
  keyCache = { value: key, at: Date.now() };
  return key;
}

function updateStatus(state) {
  if (!status) return;
  const enabled = cfg().get("enabled", true);
  const model = cfg().get("model", "deepseek-v4-pro");
  if (!enabled) {
    status.text = "$(circle-slash) TKBK Tab";
    status.tooltip = "Tab-автодополнение выключено. Нажмите, чтобы включить.";
    status.backgroundColor = undefined;
  } else if (state === "nokey") {
    status.text = "$(key) TKBK Tab";
    status.tooltip = "Для Tab-автодополнения нужен ключ TKBK. Нажмите, чтобы указать.";
    status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  } else if (state === "busy") {
    status.text = "$(loading~spin) TKBK Tab";
    status.tooltip = `Запрос к шлюзу TKBK (${model})…`;
    status.backgroundColor = undefined;
  } else if (state === "error") {
    status.text = "$(warning) TKBK Tab";
    status.tooltip = "Шлюз TKBK не ответил. Подробности — в журнале «TKBK Tab».";
    status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  } else {
    status.text = "$(sparkle) TKBK Tab";
    status.tooltip = `Tab-автодополнение включено · ${model}. Нажмите для настроек.`;
    status.backgroundColor = undefined;
  }
}

function sleep(ms, token) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(true), ms);
    token.onCancellationRequested(() => {
      clearTimeout(t);
      resolve(false);
    });
  });
}

async function requestCompletion(params, token) {
  const req = lib.buildRequest(params);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg().get("timeoutMs", 8000));
  const sub = token.onCancellationRequested(() => controller.abort());
  try {
    const res = await fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body), signal: controller.signal });
    if (res.status === 401 || res.status === 403) {
      keyCache = { value: null, at: 0 };
      throw Object.assign(new Error(`auth ${res.status}`), { auth: true });
    }
    if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => "")}`.slice(0, 300));
    const json = await res.json();
    return lib.extractText(json, req.protocol);
  } finally {
    clearTimeout(timeout);
    sub.dispose();
  }
}

function createProvider(context) {
  return {
    async provideInlineCompletionItems(document, position, ctx, token) {
      const conf = cfg();
      if (!conf.get("enabled", true)) return [];
      if (Date.now() < pausedUntil) return [];
      if (!["file", "untitled", "vscode-notebook-cell", "vscode-userdata"].includes(document.uri.scheme)) return [];
      if (conf.get("disabledLanguages", []).includes(document.languageId)) return [];
      if (lib.isSensitiveFile(document.fileName)) return [];

      const line = document.lineAt(position.line);
      const lineBefore = line.text.slice(0, position.character);
      const lineAfter = line.text.slice(position.character);
      if (line.text.length > 2000) return [];

      const contextChars = conf.get("contextChars", 6000);
      const fullPrefix = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
      const prefix = fullPrefix.slice(-contextChars);
      const endPos = document.positionAt(document.offsetAt(position) + Math.floor(contextChars / 4));
      const suffix = document.getText(new vscode.Range(position, endPos));

      const multiline = lib.allowMultiline(conf.get("multiline", "auto"), lineBefore, lineAfter);
      const toItems = (text) => (text ? [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))] : []);

      // 1) typed-through reuse, 2) exact cache
      const reused = lib.reuseFromPrevious(lastCompletion, prefix);
      if (reused) return toItems(reused);
      const model = conf.get("model", "deepseek-v4-pro");
      const key = crypto.createHash("sha1").update(model + "\u0000" + prefix + "\u0000" + suffix + (multiline ? "m" : "s")).digest("hex");
      const cached = cache.get(key);
      if (cached !== undefined) return toItems(cached);

      if (ctx.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
        const ok = await sleep(conf.get("debounceMs", 150), token);
        if (!ok || token.isCancellationRequested) return [];
      }

      const apiKey = await getApiKey(context);
      if (!apiKey) {
        updateStatus("nokey");
        if (!warnedNoKey) {
          warnedNoKey = true;
          vscode.window
            .showInformationMessage("Tab-автодополнение TKBK: укажите ключ cr_…, чтобы включить подсказки.", "Указать ключ", "Выключить подсказки")
            .then((pick) => {
              if (pick === "Указать ключ") vscode.commands.executeCommand("tkbk.completion.setApiKey");
              if (pick === "Выключить подсказки") conf.update("enabled", false, vscode.ConfigurationTarget.Global);
            });
        }
        return [];
      }

      updateStatus("busy");
      try {
        const raw = await requestCompletion(
          {
            baseUrl: conf.get("baseUrl"),
            apiKey,
            model,
            prefix,
            suffix,
            language: document.languageId,
            fileName: vscode.workspace.asRelativePath(document.uri),
            recentEdits: recentEdits.format(Date.now(), vscode.workspace.asRelativePath(document.uri)),
            maxTokens: multiline ? conf.get("maxTokens", 160) : Math.min(conf.get("maxTokens", 160), 64),
            stop: lib.stopSequences(multiline),
          },
          token,
        );
        if (token.isCancellationRequested) return [];
        const text = lib.postProcess(raw, { lineBefore, lineAfter, multiline, suffix });
        failures = 0;
        updateStatus("ok");
        cache.set(key, text);
        if (text) lastCompletion = { prefix, text };
        return toItems(text);
      } catch (err) {
        if (err && err.name === "AbortError") return [];
        failures++;
        log("error:", err && err.message ? err.message : String(err));
        if (err && err.auth) {
          updateStatus("nokey");
          pausedUntil = Date.now() + 60_000;
          vscode.window.showWarningMessage("Шлюз TKBK не принял ключ для автодополнения.", "Указать ключ").then((p) => {
            if (p) vscode.commands.executeCommand("tkbk.completion.setApiKey");
          });
        } else {
          updateStatus("error");
          if (failures >= 3) pausedUntil = Date.now() + 30_000;
        }
        return [];
      }
    },
  };
}

async function fetchModels(context) {
  const key = await getApiKey(context);
  const base = String(cfg().get("baseUrl")).replace(/\/+$/, "");
  const ids = new Set(CATALOG);
  if (key) {
    try {
      const res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` } });
      if (res.ok) {
        const json = await res.json();
        for (const m of json.data || []) if (m && m.id) ids.add(m.id);
      }
    } catch (err) {
      log("models:", err.message);
    }
  }
  return [...ids];
}

function activate(context) {
  output = vscode.window.createOutputChannel("TKBK Tab");
  status = vscode.window.createStatusBarItem("tkbk.completion", vscode.StatusBarAlignment.Right, 150);
  status.name = "TKBK Tab";
  status.command = "tkbk.completion.menu";
  status.show();
  context.subscriptions.push(output, status);

  context.subscriptions.push(
    // Remember what the developer just edited elsewhere: 2 lines around each change.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== "file" || lib.isSensitiveFile(e.document.fileName)) return;
      for (const change of e.contentChanges) {
        const line = change.range.start.line;
        const from = Math.max(0, line - 1);
        const to = Math.min(e.document.lineCount - 1, line + 1);
        const snippet = e.document.getText(new vscode.Range(from, 0, to, e.document.lineAt(to).text.length));
        recentEdits.record({ file: vscode.workspace.asRelativePath(e.document.uri), line: line + 1, snippet });
      }
    }),
    vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, createProvider(context)),
    vscode.commands.registerCommand("tkbk.completion.setApiKey", async () => {
      const value = await vscode.window.showInputBox({
        title: "Ключ TKBK для автодополнения",
        prompt: "Ключ хранится в защищённом хранилище редактора и используется только для запросов к шлюзу TKBK.",
        placeHolder: "cr_…",
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => (v && v.trim().length < 8 ? "Слишком короткий ключ" : undefined),
      });
      if (value === undefined) return;
      await context.secrets.store(SECRET_KEY, value.trim());
      keyCache = { value: null, at: 0 };
      pausedUntil = 0;
      warnedNoKey = false;
      updateStatus("ok");
      vscode.window.showInformationMessage("Ключ сохранён. Подсказки появятся при вводе кода; принять — Tab.");
    }),
    vscode.commands.registerCommand("tkbk.completion.clearApiKey", async () => {
      await context.secrets.delete(SECRET_KEY);
      keyCache = { value: null, at: 0 };
      updateStatus("nokey");
    }),
    vscode.commands.registerCommand("tkbk.completion.toggle", async () => {
      const enabled = cfg().get("enabled", true);
      await cfg().update("enabled", !enabled, vscode.ConfigurationTarget.Global);
      updateStatus(enabled ? "off" : "ok");
    }),
    vscode.commands.registerCommand("tkbk.completion.selectModel", async () => {
      const current = cfg().get("model");
      const models = await fetchModels(context);
      const pick = await vscode.window.showQuickPick(
        models.map((id) => ({ label: id, description: id === current ? "текущая" : CATALOG.includes(id) ? "каталог TKBK" : "из шлюза" })),
        { title: "Модель для Tab-автодополнения", placeHolder: "Быстрые модели дают лучшие подсказки: deepseek-v4-pro, glm-5.3" },
      );
      if (!pick) return;
      await cfg().update("model", pick.label, vscode.ConfigurationTarget.Global);
      cache.map.clear();
      lastCompletion = null;
      updateStatus("ok");
    }),
    vscode.commands.registerCommand("tkbk.completion.showLog", () => output.show(true)),
    vscode.commands.registerCommand("tkbk.completion.menu", async () => {
      const enabled = cfg().get("enabled", true);
      const hasKey = !!(await getApiKey(context));
      const items = [
        { label: enabled ? "$(circle-slash) Выключить подсказки" : "$(sparkle) Включить подсказки", cmd: "tkbk.completion.toggle" },
        { label: hasKey ? "$(key) Заменить ключ TKBK" : "$(key) Указать ключ TKBK", cmd: "tkbk.completion.setApiKey" },
        { label: `$(list-selection) Модель: ${cfg().get("model")}`, cmd: "tkbk.completion.selectModel" },
        { label: "$(output) Журнал запросов", cmd: "tkbk.completion.showLog" },
        { label: "$(settings-gear) Все настройки TKBK Tab", cmd: "workbench.action.openSettings", args: "tkbk.completion" },
      ];
      const pick = await vscode.window.showQuickPick(items, { title: "TKBK Tab — автодополнение" });
      if (pick) vscode.commands.executeCommand(pick.cmd, pick.args);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("tkbk.completion")) {
        cache.map.clear();
        lastCompletion = null;
        pausedUntil = 0;
        updateStatus("ok");
      }
    }),
  );

  getApiKey(context).then((k) => updateStatus(k ? "ok" : "nokey"));
}

function deactivate() {}

module.exports = { activate, deactivate };
