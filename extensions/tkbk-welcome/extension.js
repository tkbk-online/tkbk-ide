// TKBK IDE welcome extension (built-in).
// - Welcome page (webview) with: login via Telegram bot, buy key, setup.
// - First run: installs bundled marketplace extensions (language pack, GitLens) if missing,
//   switches the UI locale to Russian when the language pack is present.
// - Status bar entry "TKBK".
"use strict";

const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");

const FALLBACK_LINKS = {
  homepage: "https://tkbk.online",
  login: "https://tkbk.online/login",
  buy: "https://tkbk.online/buy",
  docs: "https://tkbk.online/docs",
  skills: "https://github.com/tkbk-online/skills",
  agentExtensionId: "tkbk-online.tkbk-agent",
  agentViewContainer: "workbench.view.extension.tkbk-agent-ActivityBar",
};

const STATE_BUNDLED = "tkbk.bundledInstalled.v1";
const STATE_LOCALE = "tkbk.localePrompted.v1";
const STATE_FIRST_RUN = "tkbk.firstRunDone.v1";
const RU_PACK = "MS-CEINTL.vscode-language-pack-ru";

/** @type {vscode.WebviewPanel | undefined} */
let panel;

function readProduct() {
  try {
    const product = JSON.parse(fs.readFileSync(path.join(vscode.env.appRoot, "product.json"), "utf8"));
    return product;
  } catch {
    return {};
  }
}

function links() {
  const product = readProduct();
  return { ...FALLBACK_LINKS, ...(product.tkbk || {}) };
}

function openExternal(url) {
  return vscode.env.openExternal(vscode.Uri.parse(url));
}

async function openAgent() {
  const l = links();
  const agent = vscode.extensions.getExtension(l.agentExtensionId);
  if (!agent) {
    const pick = await vscode.window.showWarningMessage(
      "TKBK Agent не найден среди расширений. Установить комплект TKBK заново?",
      "Установить",
      "Отмена",
    );
    if (pick === "Установить") await vscode.commands.executeCommand("tkbk.installBundled");
    return;
  }
  try {
    await vscode.commands.executeCommand(l.agentViewContainer);
  } catch {
    await vscode.commands.executeCommand("workbench.view.extensions");
  }
}

function bundledManifest() {
  const dir = path.join(vscode.env.appRoot, "bundled-extensions");
  const file = path.join(dir, "manifest.json");
  if (!fs.existsSync(file)) return { dir, items: [] };
  try {
    return { dir, items: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    return { dir, items: [] };
  }
}

/** Installs bundled .vsix files that are not installed yet. Returns ids installed now. */
async function installBundled({ force = false } = {}) {
  const { dir, items } = bundledManifest();
  const installed = [];
  for (const item of items) {
    const present = vscode.extensions.getExtension(item.id);
    if (present && !force) continue;
    const vsix = path.join(dir, item.file);
    if (!fs.existsSync(vsix)) continue;
    try {
      await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(vsix), {
        donotSync: true,
      });
      installed.push(item.id);
    } catch (err) {
      console.error("[tkbk-welcome] install failed", item.id, err);
    }
  }
  return installed;
}

function argvJsonPath() {
  if (process.env.VSCODE_PORTABLE) return path.join(process.env.VSCODE_PORTABLE, "argv.json");
  const product = readProduct();
  return path.join(os.homedir(), product.dataFolderName || ".tkbk-ide", "argv.json");
}

/** Sets "locale": "ru" in argv.json unless a locale is already configured. Returns true when changed. */
function ensureRussianLocale() {
  const file = argvJsonPath();
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    text = "";
  }
  if (/"locale"\s*:/.test(text)) return false;
  let data = {};
  if (text.trim()) {
    try {
      data = JSON.parse(text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));
    } catch {
      data = {};
    }
  }
  data.locale = "ru";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, "\t") + "\n");
  return true;
}

async function firstRun(context) {
  const { items } = bundledManifest();
  const stamp = JSON.stringify(items.map((i) => `${i.id}@${i.version}`));
  let installedNow = [];
  if (context.globalState.get(STATE_BUNDLED) !== stamp) {
    installedNow = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "TKBK IDE: установка комплекта расширений…" },
      () => installBundled(),
    );
    await context.globalState.update(STATE_BUNDLED, stamp);
  }
  const ruInstalled = installedNow.includes(RU_PACK) || !!vscode.extensions.getExtension(RU_PACK);
  const isRussian = vscode.env.language.toLowerCase().startsWith("ru");
  if (ruInstalled && !isRussian && !context.globalState.get(STATE_LOCALE)) {
    await context.globalState.update(STATE_LOCALE, true);
    ensureRussianLocale();
    // VS Code's own picker writes argv.json and offers a real restart (extensions cannot relaunch the app).
    const pick = await vscode.window.showInformationMessage(
      "Русский интерфейс уже установлен. Выберите «русский» в списке и перезапустите TKBK IDE.",
      "Выбрать язык и перезапустить",
      "Позже",
    );
    if (pick === "Выбрать язык и перезапустить") await vscode.commands.executeCommand("workbench.action.configureLocale");
  }
}

function nonce() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function renderHtml(webview, extensionUri) {
  const logo = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "logo.png"));
  const l = links();
  const agent = vscode.extensions.getExtension(l.agentExtensionId);
  const product = readProduct();
  const n = nonce();
  const agentLine = agent
    ? `TKBK Agent ${agent.packageJSON.version} встроен в редактор. Ключ вводится в его панели.`
    : "TKBK Agent не найден. Установите комплект заново через команду «TKBK IDE: Установить комплект расширений заново».";
  const showOnStartup = vscode.workspace.getConfiguration("tkbk.welcome").get("showOnStartup", true);
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'nonce-${n}'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TKBK IDE</title>
<style nonce="${n}">
  :root {
    --accent: #c4f58a;
    --accent-soft: #d6efb5;
    --accent-deep: #96c460;
    --ink: #17191d;
    --line: #292c32;
    --muted: #959aa5;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 0;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    font-family: var(--vscode-font-family);
    font-size: 14px;
    line-height: 1.55;
  }
  .wrap { max-width: 880px; margin: 0 auto; padding: 48px 32px 64px; }
  header { display: flex; align-items: center; gap: 20px; margin-bottom: 8px; }
  header img { width: 72px; height: 72px; border-radius: 16px; }
  h1 { font-size: 30px; margin: 0; letter-spacing: -0.01em; }
  .sub { color: var(--muted); margin: 0 0 32px; font-size: 15px; }
  .sub b { color: var(--accent); font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
  .card {
    background: var(--vscode-editorWidget-background, var(--ink));
    border: 1px solid var(--vscode-widget-border, var(--line));
    border-radius: 14px;
    padding: 20px;
    display: flex; flex-direction: column; gap: 10px;
  }
  .card .n { color: var(--accent); font-size: 12px; letter-spacing: .12em; text-transform: uppercase; }
  .card h2 { margin: 0; font-size: 17px; }
  .card p { margin: 0; color: var(--muted); flex: 1; }
  button {
    font: inherit; cursor: pointer; border: 0; border-radius: 10px; padding: 10px 14px; font-weight: 600;
    background: var(--accent); color: #08090b;
  }
  button:hover { background: var(--accent-soft); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button.secondary { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-widget-border, var(--line)); }
  button.secondary:hover { border-color: var(--accent); }
  .status {
    margin-top: 28px; padding: 14px 18px; border-radius: 12px;
    border: 1px dashed var(--vscode-widget-border, var(--line)); color: var(--muted);
  }
  .status .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; background: ${agent ? "var(--accent)" : "#ed9d91"}; }
  .links { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 24px; }
  footer { margin-top: 36px; display: flex; justify-content: space-between; align-items: center; color: var(--muted); font-size: 12px; gap: 16px; flex-wrap: wrap; }
  label { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
  kbd { font: inherit; font-size: 12px; padding: 1px 6px; border-radius: 6px; border: 1px solid var(--vscode-widget-border, var(--line)); background: var(--vscode-editor-background); color: var(--vscode-foreground); }
  input[type=checkbox] { accent-color: var(--accent); }
  @media (prefers-reduced-motion: no-preference) {
    .card { transition: border-color .2s ease; }
    .card:hover { border-color: var(--accent-deep); }
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <img src="${logo}" alt="">
    <div>
      <h1>TKBK IDE</h1>
    </div>
  </header>
  <p class="sub">Редактор с агентом TKBK внутри. Один ключ <b>cr_…</b> открывает все модели каталога TKBK, оплата в рублях.</p>

  <div class="grid">
    <section class="card">
      <span class="n">Шаг 1</span>
      <h2>Войти через Telegram-бота</h2>
      <p>Вход на tkbk.online без пароля и почты: бот подтверждает аккаунт и показывает ключи, баланс и лимиты.</p>
      <button data-cmd="login">Войти через Telegram-бота</button>
    </section>
    <section class="card">
      <span class="n">Шаг 2</span>
      <h2>Купить ключ</h2>
      <p>Ключ приходит в Telegram сразу после оплаты. Пополнение и перевыпуск — в кабинете.</p>
      <button data-cmd="buy">Купить ключ</button>
    </section>
    <section class="card">
      <span class="n">Шаг 3</span>
      <h2>Подключение</h2>
      <p>Откройте TKBK Agent в боковой панели, вставьте ключ — модель по умолчанию уже выбрана из каталога TKBK.</p>
      <button data-cmd="setup">Открыть TKBK Agent</button>
    </section>
  </div>

  <div class="status"><span class="dot"></span>${escapeHtml(agentLine)}</div>

  <div class="grid" style="margin-top:16px">
    <section class="card">
      <span class="n">Tab</span>
      <h2>Автодополнение кода</h2>
      <p>Серые подсказки при вводе, принимаются клавишей Tab. Работают через шлюз TKBK на быстрой модели каталога; ключ тот же <b>cr_…</b>.</p>
      <button class="secondary" data-cmd="tabkey">Указать ключ для подсказок</button>
    </section>
    <section class="card">
      <span class="n">Клавиши</span>
      <h2>Как в Cursor</h2>
      <p><kbd>Ctrl+L</kbd> — чат с агентом (с выделением — добавить код), <kbd>Ctrl+I</kbd> — улучшить выделенное, <kbd>Ctrl+Shift+I</kbd> — новая задача, <kbd>Ctrl+Alt+H</kbd> — эта страница.</p>
      <button class="secondary" data-cmd="layout">Агент справа / слева</button>
    </section>
  </div>

  <div class="links">
    <button class="secondary" data-cmd="docs">Документация</button>
    <button class="secondary" data-cmd="skills">Скилы TKBK</button>
    <button class="secondary" data-cmd="walkthrough">Пошаговое знакомство</button>
    <button class="secondary" data-cmd="extensions">Расширения (Open VSX)</button>
  </div>

  <footer>
    <label><input type="checkbox" id="startup" ${showOnStartup ? "checked" : ""}> Показывать при запуске</label>
    <span>${escapeHtml(product.nameLong || "TKBK IDE")} ${escapeHtml(product.version || "")} · на базе VSCodium · tkbk.online</span>
  </footer>
</div>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  document.querySelectorAll("button[data-cmd]").forEach((b) => {
    b.addEventListener("click", () => vscode.postMessage({ type: "cmd", cmd: b.dataset.cmd }));
  });
  document.getElementById("startup").addEventListener("change", (e) => {
    vscode.postMessage({ type: "startup", value: e.target.checked });
  });
</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function openWelcome(context) {
  if (panel) {
    panel.reveal();
    panel.webview.html = renderHtml(panel.webview, context.extensionUri);
    return;
  }
  panel = vscode.window.createWebviewPanel("tkbk.welcome", "TKBK IDE: начало работы", vscode.ViewColumn.One, {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    retainContextWhenHidden: false,
  });
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "logo.png");
  panel.webview.html = renderHtml(panel.webview, context.extensionUri);
  panel.onDidDispose(() => {
    panel = undefined;
  });
  panel.webview.onDidReceiveMessage(async (msg) => {
    const l = links();
    if (msg.type === "startup") {
      await vscode.workspace
        .getConfiguration("tkbk.welcome")
        .update("showOnStartup", !!msg.value, vscode.ConfigurationTarget.Global);
      return;
    }
    if (msg.type !== "cmd") return;
    switch (msg.cmd) {
      case "login":
        return vscode.commands.executeCommand("tkbk.openLogin");
      case "buy":
        return vscode.commands.executeCommand("tkbk.openBuy");
      case "setup":
        return vscode.commands.executeCommand("tkbk.openSetup");
      case "docs":
        return vscode.commands.executeCommand("tkbk.openDocs");
      case "skills":
        return vscode.commands.executeCommand("tkbk.openSkills");
      case "walkthrough":
        return vscode.commands.executeCommand("workbench.action.openWalkthrough", "tkbk-online.tkbk-welcome#tkbk.gettingStarted", false);
      case "extensions":
        return vscode.commands.executeCommand("workbench.view.extensions");
      case "tabkey":
        return vscode.commands.executeCommand("tkbk.completion.setApiKey");
      case "layout": {
        const pick = await vscode.window.showQuickPick(
          [
            { label: "$(layout-sidebar-right) Агент справа (как в Cursor)", where: "right" },
            { label: "$(layout-sidebar-left) Агент слева (в основной панели)", where: "left" },
          ],
          { title: "Где показывать TKBK Agent" },
        );
        if (pick) await moveAgent(pick.where);
        return;
      }
      default:
        return openExternal(l.homepage);
    }
  });
}

const AGENT_VIEW_ID = "tkbk-agent.SidebarProvider";
const RIGHT_CONTAINER = "workbench.view.extension.tkbk-agent-right";

/** Resolves to the activated agent extension, or undefined (not installed / disabled in a restricted workspace). */
async function agentReady() {
  const l = links();
  const ext = vscode.extensions.getExtension(l.agentExtensionId);
  if (!ext) return undefined;
  try {
    if (!ext.isActive) await ext.activate();
  } catch {
    return undefined;
  }
  return ext;
}

/** Move the agent's webview view between the primary side bar (its own container) and the secondary side bar. */
async function moveAgent(where, { quiet = false } = {}) {
  const l = links();
  if (!(await agentReady())) {
    if (!quiet) {
      vscode.window.showWarningMessage(
        "TKBK Agent сейчас недоступен (не установлен или папка открыта в ограниченном режиме). Доверьте папку и повторите.",
      );
    }
    return false;
  }
  const destinationId = where === "right" ? RIGHT_CONTAINER : l.agentViewContainer;
  await vscode.commands.executeCommand("vscode.moveViews", { viewIds: [AGENT_VIEW_ID], destinationId });
  if (where === "right") await vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar").then(undefined, () => {});
  return true;
}

/**
 * First start: put the agent on the right (Cursor-like). In a restricted workspace the agent is disabled,
 * so keep retrying when the extension set changes (folder trusted → extension host restarts/enables).
 */
function scheduleFirstRunLayout(context) {
  const l = links();
  let done = false;
  const attempt = async () => {
    if (done) return;
    const right = vscode.workspace.getConfiguration("tkbk.layout").get("agentRight", true);
    try {
      const ok = right ? await moveAgent("right", { quiet: true }) : !!(await agentReady());
      if (!ok) return;
      if (!right) await vscode.commands.executeCommand(l.agentViewContainer);
      done = true;
      await context.globalState.update(STATE_FIRST_RUN, true);
      // Explorer on the left, agent on the right, welcome page in the middle.
      await vscode.commands.executeCommand("workbench.view.explorer").then(undefined, () => {});
      vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup").then(undefined, () => {});
    } catch (err) {
      console.error("[tkbk-welcome] layout failed", err);
    }
  };
  setTimeout(attempt, 1500);
  const sub = vscode.extensions.onDidChange(() => setTimeout(attempt, 1000));
  context.subscriptions.push(sub);
  setTimeout(() => sub.dispose(), 10 * 60 * 1000);
}

/** Other bundled extensions open their own pages on first start; keep the TKBK page in front for a while. */
function keepWelcomeInFront(context) {
  const until = Date.now() + 90_000;
  let reveals = 0;
  const isForeignWebview = (tab) =>
    tab && tab.input instanceof vscode.TabInputWebview && !String(tab.input.viewType).includes("tkbk.welcome");
  const sub = vscode.window.tabGroups.onDidChangeTabs((e) => {
    if (!panel || Date.now() > until || reveals >= 6) return sub.dispose();
    // Only react to webview pages other extensions open by themselves (GitLens welcome, etc.).
    if (!e.opened.some(isForeignWebview)) return;
    reveals++;
    setTimeout(() => panel && !panel.active && panel.reveal(vscode.ViewColumn.One, false), 600);
  });
  context.subscriptions.push(sub);
  setTimeout(() => sub.dispose(), 95_000);
}

function activate(context) {
  const l = links();
  context.subscriptions.push(
    vscode.commands.registerCommand("tkbk.layout.agentRight", () => moveAgent("right")),
    vscode.commands.registerCommand("tkbk.layout.agentLeft", () => moveAgent("left")),
    vscode.commands.registerCommand("tkbk.welcome.open", () => openWelcome(context)),
    vscode.commands.registerCommand("tkbk.openLogin", () => openExternal(links().login)),
    vscode.commands.registerCommand("tkbk.openBuy", () => openExternal(links().buy)),
    vscode.commands.registerCommand("tkbk.openDocs", () => openExternal(links().docs)),
    vscode.commands.registerCommand("tkbk.openSkills", () => openExternal(links().skills)),
    vscode.commands.registerCommand("tkbk.openSetup", () => openAgent()),
    vscode.commands.registerCommand("tkbk.installBundled", async () => {
      const ids = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "TKBK IDE: установка комплекта расширений…" },
        () => installBundled({ force: true }),
      );
      vscode.window.showInformationMessage(
        ids.length ? `Установлено: ${ids.join(", ")}. Перезапустите TKBK IDE.` : "Комплект уже установлен.",
      );
    }),
  );

  const status = vscode.window.createStatusBarItem("tkbk.status", vscode.StatusBarAlignment.Left, 10000);
  status.name = "TKBK IDE";
  status.text = "$(home) TKBK";
  status.tooltip = "TKBK IDE: начало работы";
  status.command = "tkbk.welcome.open";
  status.show();
  context.subscriptions.push(status);

  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri) {
        // tkbk-ide://tkbk-online.tkbk-welcome/welcome
        if (uri.path.replace(/^\//, "") === "setup") return openAgent();
        return openWelcome(context);
      },
    }),
  );

  firstRun(context).catch((err) => console.error("[tkbk-welcome] first run failed", err));

  const show = vscode.workspace.getConfiguration("tkbk.welcome").get("showOnStartup", true);
  const hasEditors = vscode.window.visibleTextEditors.length > 0;
  if (show && !hasEditors) openWelcome(context); // don't steal focus from a restored project

  // Very first start: TKBK Agent next to the welcome page (on the right unless tkbk.layout.agentRight is off),
  // and the TKBK page stays in front of pages other extensions open on their first start.
  if (!context.globalState.get(STATE_FIRST_RUN)) {
    scheduleFirstRunLayout(context);
    if (show && !hasEditors) keepWelcomeInFront(context);
  }
}

function deactivate() {}

module.exports = { activate, deactivate, ensureRussianLocale, escapeHtml };
