// Web terminal client: sign in, a strip of tabs, the shells, and settings.
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "@fontsource/jetbrains-mono/400-italic.css";
import "@fontsource/jetbrains-mono/700-italic.css";
import "@fontsource/fira-code/400.css";
import "@fontsource/fira-code/700.css";
import "@fontsource/cascadia-code/400.css";
import "@fontsource/cascadia-code/700.css";
import "@fontsource/cascadia-code/400-italic.css";
import "@fontsource/cascadia-code/700-italic.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/700.css";
import "@fontsource/ibm-plex-mono/400-italic.css";
import "@fontsource/ibm-plex-mono/700-italic.css";
import "@xterm/xterm/css/xterm.css";
import "./fonts.css";
import "./style.css";
import { afterPointer, h, icon, recall, reconcile, remember } from "./dom.ts";
import { language, t } from "./i18n.ts";
import { applyModifiers, buildKeyBar } from "./keys.ts";
import { activeTheme, buildPanel, fontFamily, onSettingsChange, settings } from "./settings.ts";
import { fontsReady, Shell, type ShellHost } from "./shell.ts";

interface TerminalInfo {
  id: string;
  title: string;
  name: string;
  created: number;
  clients: number;
}

class HttpFailure extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const LAST = "web-terminal:last";
const app = document.getElementById("app")!;
const coarse = window.matchMedia("(pointer: coarse)");

let terminals: TerminalInfo[] = [];
const shells = new Map<string, Shell>();
const unread = new Set<string>();
let currentId: string | null = null;
/** The tab whose close button is waiting for its second click. */
let closingId: string | null = null;
let closingTimer = 0;
let creating = false;
const deleting = new Set<string>();
const tabViews = new Map<string, { element: HTMLElement; label: HTMLButtonElement; close: HTMLButtonElement }>();
let tabsPending = false;
let panelEvents: AbortController | null = null;
let notice = "";
let noticeTimer = 0;
let consoleEl: HTMLElement | null = null;
let tabsEl: HTMLElement;
let stageEl: HTMLElement;
let emptyEl: HTMLElement;
let statusEl: HTMLElement;
let keysEl: HTMLElement;
let newButton: HTMLButtonElement;
let openButton: HTMLButtonElement;

// ------------------------------------------------------------ helpers

/** Calls the same-origin API. Failures carry the server's own message. */
async function api<T>(route: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api/${route}`, {
    method: init.method ?? "GET",
    headers: init.body === undefined ? {} : { "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: "same-origin",
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new HttpFailure(res.status, data.error ?? `Request failed (${res.status})`);
  return data as T;
}

/** The page wears the terminal's colors, so the two read as one surface. */
function paintChrome() {
  const theme = activeTheme();
  const root = document.documentElement;
  root.style.setProperty("--bg", theme.background);
  root.style.setProperty("--fg", theme.foreground);
  root.style.setProperty("--accent", theme.accent);
  root.style.setProperty("--ok", theme.ansi[2]!);
  root.style.setProperty("--bad", theme.ansi[1]!);
  root.style.setProperty("--mono", fontFamily());
  root.style.colorScheme = theme.dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.background);
}

function showKeys() {
  if (keysEl) keysEl.hidden = !(settings.keyBar === "on" || (settings.keyBar === "auto" && coarse.matches));
}

/** Shows a short message where the connection state sits, then lets it go. */
function flash(text: string) {
  notice = text;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => {
    notice = "";
    paintStatus();
  }, 4000);
  paintStatus();
}

function paintStatus() {
  if (!consoleEl) return;
  const shell = currentId ? shells.get(currentId) : undefined;
  const state = shell?.status ?? "idle";
  statusEl.dataset.state = state;
  statusEl.lastElementChild!.textContent = notice || (state === "connecting" || state === "reconnecting" ? t(state) : "");
  statusEl.title = state === "connected" ? t("connected") : "";
}

function handleError(error: unknown) {
  if (error instanceof HttpFailure && error.status === 401) return showLogin(t("signInAgain"));
  if (error instanceof HttpFailure && error.status === 409) return flash(t("limit", { n: /\d+/.exec(error.message)?.[0] ?? "" }));
  flash(error instanceof Error ? error.message : String(error));
}

// ------------------------------------------------------------ sign in

function showLogin(message = "") {
  panelEvents?.abort();
  panelEvents = null;
  tabViews.clear();
  for (const shell of shells.values()) shell.dispose();
  shells.clear();
  unread.clear();
  consoleEl = null;
  currentId = null;
  terminals = [];
  const error = h("p", { class: "note", attrs: { role: "alert" }, text: message });
  const user = h("input", {
    attrs: { name: "username", autocomplete: "username", autocapitalize: "none", spellcheck: "false", required: "", maxlength: "200" },
  });
  const pass = h("input", {
    attrs: { name: "password", type: "password", autocomplete: "current-password", required: "", maxlength: "1000" },
  });
  const submit = h("button", { class: "primary", text: t("signIn"), attrs: { type: "submit" } });
  const form = h(
    "form",
    {
      class: "login",
      on: {
        submit: async (event) => {
          event.preventDefault();
          submit.disabled = true;
          error.textContent = "";
          try {
            const me = await api<{ username: string }>("session", { method: "POST", body: { username: user.value, password: pass.value } });
            await showConsole(me.username);
          } catch (failure) {
            const status = failure instanceof HttpFailure ? failure.status : 0;
            const text = failure instanceof Error ? failure.message : String(failure);
            error.textContent =
              status === 401 ? t("badLogin") : status === 429 ? t("tooMany", { n: /\d+/.exec(text)?.[0] ?? "" }) : status ? text : t("unreachable");
            pass.value = "";
            pass.focus();
          } finally {
            submit.disabled = false;
          }
        },
      },
    },
    h("h1", {}, h("span", { class: "prompt", text: "❯", attrs: { "aria-hidden": "true" } }), h("span", { text: t("title") })),
    h("label", {}, h("span", { text: t("username") }), user),
    h("label", {}, h("span", { text: t("password") }), pass),
    error,
    submit,
  );
  app.replaceChildren(h("main", { class: "center" }, form));
  user.focus();
}

async function signOut() {
  await api("session", { method: "DELETE" }).catch(() => {});
  showLogin(t("signedOut"));
}

// ------------------------------------------------------------ console

const host: ShellHost = {
  transform: applyModifiers,
  status: (shell) => {
    if (shell.id === currentId) paintStatus();
  },
  title: (shell, title) => {
    const info = terminals.find((terminal) => terminal.id === shell.id);
    if (!info || info.title === title) return;
    info.title = title;
    renderTabs();
  },
  activity: (shell) => {
    if (unread.has(shell.id)) return;
    unread.add(shell.id);
    renderTabs();
  },
  gone: () => void refresh().then(settle).catch(handleError),
  unauthorized: () => showLogin(t("signInAgain")),
};

async function showConsole(name: string) {
  panelEvents?.abort();
  panelEvents = new AbortController();
  tabViews.clear();
  tabsEl = h("div", { class: "tabs", attrs: { role: "tablist", "aria-label": t("title") } });
  newButton = h("button", {
    class: "tool", attrs: { type: "button", "aria-label": t("newTerminal"), title: t("newTerminal") },
    on: { click: () => void create() },
  }, icon("plus"));
  tabsEl.append(newButton);
  openButton = h("button", { class: "primary", text: t("openShell"), attrs: { type: "button" }, on: { click: () => void create() } });
  emptyEl = h(
    "div",
    { class: "empty" },
    h("p", { text: t("noShell") }),
    openButton,
  );
  emptyEl.hidden = true;
  stageEl = h("div", { class: "stage" }, emptyEl);
  statusEl = h("span", { class: "status", attrs: { role: "status" } }, h("i", { class: "dot" }), h("span", {}));
  keysEl = buildKeyBar({
    send: (data) => current()?.key(data),
    paste: () => void pasteClipboard(),
    focus: () => current()?.focus(),
  });
  showKeys();

  const close = () => {
    panel.close();
    current()?.focus();
  };
  const panel = buildPanel(name, { close, signOut: () => void signOut() }, panelEvents.signal);
  panel.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  const outside = (event: MouseEvent) => {
    const rect = panel.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX >= rect.right || event.clientY < rect.top || event.clientY >= rect.bottom;
  };
  let backdropDown = false;
  panel.addEventListener("pointerdown", (event) => { backdropDown = outside(event); });
  panel.addEventListener("click", (event) => {
    if (backdropDown && outside(event)) close();
    backdropDown = false;
  });
  const settingsButton = h(
    "button",
    {
      class: "tool",
      attrs: { type: "button", "aria-label": t("settings"), title: t("settings") },
      on: { click: () => panel.showModal() },
    },
    icon("sliders"),
  );
  const root = h(
    "div",
    { class: "app" },
    h("header", { class: "strip" }, tabsEl, statusEl, settingsButton),
    stageEl,
    keysEl,
    panel,
  );
  consoleEl = root;
  app.replaceChildren(root);

  await fontsReady();
  try {
    await refresh();
    settle();
    if (!terminals.length) await create();
  } catch (error) {
    handleError(error);
  }
}

/** Shell titles are usually "user@host: path"; the path is the part worth a tab's width. */
function shortTitle(title: string): string {
  const path = /^[^\s@]+@[^\s:]+:\s*(.+)$/.exec(title)?.[1] ?? title;
  const parts = path.split("/");
  return /^[~/]/.test(path) && parts.length > 3 ? `…/${parts.slice(-2).join("/")}` : path;
}

function shown(terminal: TerminalInfo): string {
  return terminal.name || shortTitle(terminal.title);
}

function current(): Shell | undefined {
  return currentId ? shells.get(currentId) : undefined;
}

async function refresh() {
  terminals = await api<TerminalInfo[]>("terminals");
  for (const [id, shell] of shells) {
    if (terminals.some((terminal) => terminal.id === id)) continue;
    shell.dispose();
    shells.delete(id);
    unread.delete(id);
  }
  if (currentId && !terminals.some((terminal) => terminal.id === currentId)) currentId = null;
  renderTabs();
}

/** Makes sure a tab is showing: the current one, the last used, or the first. */
function settle() {
  if (!consoleEl) return;
  if (currentId) return;
  const remembered = recall(LAST);
  const target = terminals.find((terminal) => terminal.id === remembered) ?? terminals[0];
  if (target) return select(target.id);
  emptyEl.hidden = false;
  paintStatus();
}

function select(id: string) {
  const changed = currentId !== id;
  if (currentId !== id) current()?.hide();
  currentId = id;
  unread.delete(id);
  remember(LAST, id);
  let shell = shells.get(id);
  if (!shell) {
    shell = new Shell(id, stageEl, host);
    shells.set(id, shell);
  }
  emptyEl.hidden = true;
  shell.show();
  renderTabs();
  if (changed) tabViews.get(id)?.element.scrollIntoView({ block: "nearest", inline: "nearest" });
  paintStatus();
}

async function create() {
  if (creating) return;
  creating = true;
  newButton.disabled = true;
  openButton.disabled = true;
  try {
    const size = current()?.term;
    const made = await api<TerminalInfo>("terminals", {
      method: "POST",
      body: { dark: activeTheme().dark, ...(size && { cols: size.cols, rows: size.rows }) },
    });
    await refresh();
    select(made.id);
  } catch (error) {
    handleError(error);
  } finally {
    creating = false;
    newButton.disabled = false;
    openButton.disabled = false;
  }
}

/** The close button asks once more before ending a shell and whatever runs in it. */
async function end(id: string) {
  if (deleting.has(id)) return;
  if (closingId !== id) {
    closingId = id;
    window.clearTimeout(closingTimer);
    closingTimer = window.setTimeout(() => {
      closingId = null;
      renderTabs();
    }, 3000);
    return renderTabs();
  }
  closingId = null;
  window.clearTimeout(closingTimer);
  deleting.add(id);
  renderTabs();
  try {
    await api(`terminals/${id}`, { method: "DELETE" });
  } catch (error) {
    if (!(error instanceof HttpFailure && error.status === 404)) return handleError(error);
  } finally {
    deleting.delete(id);
    renderTabs();
  }
  await refresh().then(settle).catch(handleError);
}

function startRename(info: TerminalInfo, label: HTMLElement) {
  if (!label.isConnected) return;
  const input = h("input", { class: "tab-rename", attrs: { type: "text", maxlength: "40", "aria-label": t("renameHint") } });
  input.value = shown(info);
  let finished = false;
  const finish = async (save: boolean, restoreFocus = false) => {
    if (finished) return;
    finished = true;
    input.readOnly = true;
    const name = input.value.trim();
    if (save && name !== shown(info)) {
      try {
        Object.assign(info, await api<TerminalInfo>(`terminals/${info.id}`, { method: "PATCH", body: { name } }));
      } catch (error) {
        handleError(error);
      }
    }
    afterPointer(() => {
      const focus = restoreFocus && document.activeElement === input;
      input.replaceWith(label);
      renderTabs();
      if (focus) current()?.focus();
    });
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      void finish(event.key === "Enter", true);
    }
  });
  input.addEventListener("blur", () => void finish(true));
  label.replaceWith(input);
  input.focus();
  input.select();
}

function renderTabs() {
  if (!consoleEl || tabsPending) return;
  tabsPending = true;
  afterPointer(() => {
    tabsPending = false;
    if (!consoleEl) return;
    for (const [id] of tabViews) if (!terminals.some((terminal) => terminal.id === id)) tabViews.delete(id);
    const elements = terminals.map((terminal) => {
      const on = terminal.id === currentId;
      let view = tabViews.get(terminal.id);
      if (!view) {
        const id = terminal.id;
        const label = h("button", {
          class: "tab-label",
          attrs: { type: "button", role: "tab", title: t("renameHint") },
          on: {
            click: () => select(id),
            dblclick: () => {
              const info = terminals.find((entry) => entry.id === id);
              if (info) startRename(info, label);
            },
          },
        });
        const close = h("button", {
          class: "tab-close", attrs: { type: "button" },
          on: { click: () => void end(id) },
        }, icon("close"));
        view = { element: h("div", { class: "tab", attrs: { "data-terminal": id } }, label, close), label, close };
        tabViews.set(id, view);
      }
      view.element.className = `tab${on ? " on" : ""}${unread.has(terminal.id) && !on ? " unread" : ""}`;
      if (view.label.textContent !== shown(terminal)) view.label.textContent = shown(terminal);
      view.label.setAttribute("aria-selected", String(on));
      view.close.setAttribute("aria-label", `${t("closeTerminal")} ${shown(terminal)}`);
      view.close.disabled = deleting.has(terminal.id);
      const confirming = closingId === terminal.id;
      if (view.close.classList.contains("confirm") !== confirming) {
        view.close.className = confirming ? "tab-close confirm" : "tab-close";
        view.close.replaceChildren(confirming ? document.createTextNode(t("confirmClose")) : icon("close"));
      }
      return view.element;
    });
    reconcile(tabsEl, [...elements, newButton]);
  });
}

/** The key bar's Paste key, for phones that have no Ctrl+V. */
async function pasteClipboard() {
  const shell = current();
  if (!shell) return;
  try {
    const text = await navigator.clipboard.readText();
    if (text) shell.paste(text);
  } catch {
    flash(t("clipboardDenied"));
  }
}

// ------------------------------------------------------------ start

onSettingsChange(() => {
  paintChrome();
  showKeys();
  for (const shell of shells.values()) shell.applySettings();
});
coarse.addEventListener("change", showKeys);

// A phone's on-screen keyboard covers the page instead of resizing it; follow
// the part that is actually visible so the prompt stays above the keyboard.
const viewport = window.visualViewport;
if (viewport) {
  const follow = () => {
    const root = document.documentElement;
    if (viewport.scale !== 1) return root.style.removeProperty("--app-height");
    root.style.setProperty("--app-height", `${viewport.height}px`);
    window.scrollTo(0, 0);
  };
  viewport.addEventListener("resize", follow);
  viewport.addEventListener("scroll", follow);
  follow();
}

async function boot() {
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  document.title = t("title");
  paintChrome();
  try {
    const me = await api<{ username: string }>("session");
    await showConsole(me.username);
  } catch (error) {
    if (error instanceof HttpFailure && error.status === 401) return showLogin();
    app.replaceChildren(
      h(
        "main",
        { class: "center" },
        h(
          "div",
          { class: "login" },
          h("p", { class: "note", attrs: { role: "alert" }, text: t("unreachable") }),
          h("button", { class: "primary", text: t("retry"), attrs: { type: "button" }, on: { click: () => location.reload() } }),
        ),
      ),
    );
  }
}

void boot();
