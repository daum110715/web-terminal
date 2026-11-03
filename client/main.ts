// Web terminal client: sign in, a row of shells, and a key bar for phones.
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type IDisposable } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

interface TerminalInfo {
  id: string;
  title: string;
  created: number;
  clients: number;
}

interface Session {
  id: string;
  term: Terminal;
  fit: FitAddon;
  mount: HTMLDivElement;
  socket: WebSocket | null;
  attempts: number;
  timer: number;
  closed: boolean;
  input: IDisposable;
  observer: ResizeObserver;
}

type Props = {
  class?: string;
  text?: string;
  attrs?: Record<string, string>;
  on?: Record<string, EventListener>;
};

class HttpFailure extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const LAST = "web-terminal:last";
const FONT = "web-terminal:font";
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
const encoder = new TextEncoder();

// Same palette as the console's terminal panel, on an opaque cream background
// (the translucent one renders black here).
const THEME = {
  background: "#fcfaf6",
  foreground: "#44403c",
  cursor: "#f59e0b",
  cursorAccent: "#fcfaf6",
  selectionBackground: "rgba(245, 158, 11, 0.25)",
  black: "#44403c",
  red: "#c0392b",
  green: "#3f7d20",
  yellow: "#9a6700",
  blue: "#2459c7",
  magenta: "#9d2fa8",
  cyan: "#137a8a",
  white: "#78716c",
  brightBlack: "#a8a29e",
  brightRed: "#d9480f",
  brightGreen: "#5c940d",
  brightYellow: "#b7791f",
  brightBlue: "#3b6fe0",
  brightMagenta: "#ae3ec9",
  brightCyan: "#1098ad",
  brightWhite: "#57534e",
};

const KEYS: { label: string; send?: string; mod?: "ctrl" | "alt" }[] = [
  { label: "Esc", send: "\x1b" },
  { label: "Tab", send: "\t" },
  { label: "Ctrl", mod: "ctrl" },
  { label: "Alt", mod: "alt" },
  { label: "↑", send: "\x1b[A" },
  { label: "↓", send: "\x1b[B" },
  { label: "←", send: "\x1b[D" },
  { label: "→", send: "\x1b[C" },
  { label: "Home", send: "\x1b[H" },
  { label: "End", send: "\x1b[F" },
  { label: "PgUp", send: "\x1b[5~" },
  { label: "PgDn", send: "\x1b[6~" },
  { label: "^C", send: "\x03" },
  { label: "^D", send: "\x04" },
  { label: "^Z", send: "\x1a" },
  { label: "|", send: "|" },
  { label: "~", send: "~" },
  { label: "/", send: "/" },
  { label: "-", send: "-" },
];

const app = document.getElementById("app")!;
const modifiers = { ctrl: false, alt: false };
const modButtons = new Map<"ctrl" | "alt", HTMLButtonElement>();
let terminals: TerminalInfo[] = [];
let currentId: string | null = null;
let session: Session | null = null;
let fontSize = readFontSize();
let tabsEl: HTMLElement;
let stageEl: HTMLElement;
let statusEl: HTMLElement;

// ------------------------------------------------------------ helpers

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Node[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [name, value] of Object.entries(props.attrs ?? {})) node.setAttribute(name, value);
  for (const [event, listener] of Object.entries(props.on ?? {})) node.addEventListener(event, listener);
  node.append(...children);
  return node;
}

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

function readFontSize(): number {
  try {
    const saved = Number(localStorage.getItem(FONT));
    if (saved >= 10 && saved <= 22) return saved;
  } catch {}
  return 14;
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function recall(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setStatus(text: string) {
  statusEl.textContent = text;
}

function handleError(error: unknown) {
  if (error instanceof HttpFailure && error.status === 401) return showLogin("Your session ended. Sign in again.");
  setStatus(error instanceof Error ? error.message : String(error));
}

/** Maps a key to what a terminal expects for Ctrl plus that key. */
function controlCode(key: string): string {
  if (key === " ") return "\x00";
  const code = key.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  return key;
}

// ------------------------------------------------------------ sign in

function showLogin(notice = "") {
  closeSession();
  currentId = null;
  terminals = [];
  const error = h("p", { class: "notice", attrs: { role: "alert" }, text: notice });
  const user = h("input", {
    attrs: { name: "username", autocomplete: "username", autocapitalize: "none", spellcheck: "false", required: "", maxlength: "200" },
  });
  const pass = h("input", {
    attrs: { name: "password", type: "password", autocomplete: "current-password", required: "", maxlength: "1000" },
  });
  const submit = h("button", { class: "primary", text: "Sign in", attrs: { type: "submit" } });
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
            showConsole(me.username);
          } catch (failure) {
            error.textContent = failure instanceof Error ? failure.message : String(failure);
            pass.value = "";
            pass.focus();
          } finally {
            submit.disabled = false;
          }
        },
      },
    },
    h("h1", { text: "Terminal" }),
    h("label", {}, h("span", { text: "Username" }), user),
    h("label", {}, h("span", { text: "Password" }), pass),
    error,
    submit,
  );
  app.replaceChildren(h("main", { class: "center" }, form));
  user.focus();
}

async function signOut() {
  await api("session", { method: "DELETE" }).catch(() => {});
  showLogin("Signed out.");
}

// ------------------------------------------------------------ console

function showConsole(name: string) {
  tabsEl = h("div", { class: "tabs", attrs: { role: "tablist", "aria-label": "Terminals" } });
  stageEl = h("div", { class: "stage" });
  statusEl = h("span", { class: "status", attrs: { role: "status" } });

  const keys = KEYS.map((key) => {
    if (key.mod) {
      const mod = key.mod;
      const button = h("button", {
        class: "key",
        text: key.label,
        attrs: { type: "button", "aria-pressed": "false" },
        on: {
          mousedown: (event) => event.preventDefault(),
          click: () => {
            modifiers[mod] = !modifiers[mod];
            paintModifiers();
            session?.term.focus();
          },
        },
      });
      modButtons.set(mod, button);
      return button;
    }
    return h("button", {
      class: "key",
      text: key.label,
      attrs: { type: "button" },
      on: {
        // Keeps focus in the terminal, so the phone keyboard stays up.
        mousedown: (event) => event.preventDefault(),
        click: () => {
          sendInput(key.send!);
          session?.term.focus();
        },
      },
    });
  });

  const header = h(
    "header",
    { class: "bar" },
    h("span", { class: "brand", text: "Terminal" }),
    h("span", { class: "who", text: name }),
    h("button", { class: "ghost", text: "A-", attrs: { type: "button", "aria-label": "Smaller text" }, on: { click: () => setFontSize(fontSize - 1) } }),
    h("button", { class: "ghost", text: "A+", attrs: { type: "button", "aria-label": "Larger text" }, on: { click: () => setFontSize(fontSize + 1) } }),
    h("button", { class: "ghost", text: "Sign out", attrs: { type: "button" }, on: { click: () => void signOut() } }),
  );

  app.replaceChildren(
    h("div", { class: "shell" }, header, tabsEl, stageEl, h("div", { class: "keys" }, ...keys), h("div", { class: "footer" }, statusEl)),
  );
  void ensureSession();
}

async function refresh(): Promise<TerminalInfo[]> {
  terminals = await api<TerminalInfo[]>("terminals");
  renderTabs();
  return terminals;
}

function renderTabs() {
  tabsEl.replaceChildren(
    ...terminals.map((terminal, index) =>
      h(
        "div",
        { class: terminal.id === currentId ? "tab on" : "tab" },
        h("button", {
          class: "tab-label",
          text: `${index + 1}. ${terminal.title}`,
          attrs: { type: "button", role: "tab", "aria-selected": String(terminal.id === currentId) },
          on: { click: () => select(terminal.id) },
        }),
        h("button", {
          class: "tab-close",
          text: "×",
          attrs: { type: "button", "aria-label": `End terminal ${index + 1}` },
          on: {
            click: (event) => {
              event.stopPropagation();
              void end(terminal.id);
            },
          },
        }),
      ),
    ),
    h("button", { class: "tab-new", text: "+", attrs: { type: "button", "aria-label": "New terminal", title: "New terminal" }, on: { click: () => void create() } }),
  );
}

async function ensureSession() {
  try {
    await refresh();
    const remembered = recall(LAST);
    const target = terminals.find((t) => t.id === remembered) ?? terminals[0];
    if (target) select(target.id);
    else await create();
  } catch (error) {
    handleError(error);
    renderStage();
  }
}

async function create() {
  try {
    const made = await api<TerminalInfo>("terminals", { method: "POST" });
    await refresh();
    select(made.id);
  } catch (error) {
    handleError(error);
  }
}

async function end(id: string) {
  try {
    await api(`terminals/${id}`, { method: "DELETE" });
  } catch (error) {
    if (!(error instanceof HttpFailure && error.status === 404)) return handleError(error);
  }
  await refresh().catch(handleError);
  if (id !== currentId) return;
  closeSession();
  currentId = null;
  const next = terminals[0];
  if (next) select(next.id);
  else renderStage();
}

function select(id: string) {
  if (session?.id === id && !session.closed) return;
  closeSession();
  currentId = id;
  remember(LAST, id);
  renderTabs();
  openSession(id);
}

function renderStage() {
  stageEl.replaceChildren(
    h(
      "div",
      { class: "empty" },
      h("p", { text: "No shell is running." }),
      h("button", { class: "primary", text: "Open a shell", attrs: { type: "button" }, on: { click: () => void create() } }),
    ),
  );
}

// ------------------------------------------------------------ shells

function openSession(id: string) {
  const mount = h("div", { class: "term" });
  stageEl.replaceChildren(mount);
  const term = new Terminal({
    fontFamily: MONO,
    fontSize,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    allowTransparency: true,
    macOptionIsMeta: true,
    theme: THEME,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  term.open(mount);

  const s: Session = {
    id,
    term,
    fit,
    mount,
    socket: null,
    attempts: 0,
    timer: 0,
    closed: false,
    input: term.onData((data) => sendInput(data)),
    observer: new ResizeObserver(() => requestAnimationFrame(() => fitAndSend(s))),
  };
  s.observer.observe(mount);
  session = s;
  setStatus("connecting");
  connect(s);
}

function closeSession() {
  const s = session;
  if (!s) return;
  s.closed = true;
  session = null;
  window.clearTimeout(s.timer);
  s.observer.disconnect();
  s.input.dispose();
  s.socket?.close(1000);
  s.term.dispose();
  s.mount.remove();
}

function fitAndSend(s: Session) {
  if (s.closed) return;
  try {
    s.fit.fit();
  } catch {
    return;
  }
  if (s.socket?.readyState === WebSocket.OPEN) s.socket.send(JSON.stringify({ type: "resize", cols: s.term.cols, rows: s.term.rows }));
}

function connect(s: Session) {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${scheme}//${location.host}/ws/terminals/${s.id}`);
  socket.binaryType = "arraybuffer";
  s.socket = socket;
  socket.onopen = () => {
    s.attempts = 0;
    setStatus("connected");
    fitAndSend(s);
  };
  socket.onmessage = (event) => s.term.write(new Uint8Array(event.data as ArrayBuffer));
  socket.onclose = (event) => {
    if (s.closed || socket !== s.socket) return;
    s.socket = null;
    if (event.code === 4000) {
      s.term.write("\r\n\x1b[2m[shell exited]\x1b[0m\r\n");
      setStatus("shell exited");
      void refresh().catch(handleError);
      return;
    }
    if (event.code === 4004) {
      s.term.write("\r\n\x1b[2m[this terminal no longer exists]\x1b[0m\r\n");
      setStatus("terminal gone");
      void refresh().catch(handleError);
      return;
    }
    if (s.attempts >= 6) {
      s.term.write("\r\n\x1b[2m[disconnected: pick the tab again to retry]\x1b[0m\r\n");
      setStatus("disconnected");
      return;
    }
    const delay = Math.min(16000, 1000 * 2 ** s.attempts);
    s.attempts++;
    setStatus(`reconnecting in ${delay / 1000}s`);
    s.timer = window.setTimeout(() => void retry(s), delay);
  };
}

async function retry(s: Session) {
  if (s.closed) return;
  try {
    await api("session");
  } catch (error) {
    if (error instanceof HttpFailure && error.status === 401) return showLogin("Your session ended. Sign in again.");
  }
  connect(s);
}

function sendInput(raw: string) {
  let data = raw;
  if (modifiers.ctrl && data.length === 1) data = controlCode(data);
  if (modifiers.alt) data = "\x1b" + data;
  if (modifiers.ctrl || modifiers.alt) {
    modifiers.ctrl = false;
    modifiers.alt = false;
    paintModifiers();
  }
  const socket = session?.socket;
  if (socket?.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
}

function paintModifiers() {
  for (const [mod, button] of modButtons) {
    button.classList.toggle("on", modifiers[mod]);
    button.setAttribute("aria-pressed", String(modifiers[mod]));
  }
}

function setFontSize(next: number) {
  fontSize = Math.min(22, Math.max(10, next));
  remember(FONT, String(fontSize));
  if (session) {
    session.term.options.fontSize = fontSize;
    fitAndSend(session);
  }
}

// ------------------------------------------------------------ start

async function boot() {
  try {
    const me = await api<{ username: string }>("session");
    showConsole(me.username);
  } catch (error) {
    if (error instanceof HttpFailure && error.status === 401) return showLogin();
    app.replaceChildren(h("main", { class: "center" }, h("p", { class: "notice", attrs: { role: "alert" }, text: "The terminal service is not answering. Reload to try again." })));
  }
}

void boot();
