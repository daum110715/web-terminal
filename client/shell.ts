// One tab: an xterm.js terminal and the socket that feeds it. A shell stays
// alive while its tab is in the background, so switching tabs is instant.
import { ClipboardAddon, type IClipboardProvider } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { h } from "./dom.ts";
import { activeTheme, contrastRatio, fontFamily, primaryFont, settings } from "./settings.ts";
import { toXterm } from "./themes.ts";
import { TouchScroll } from "./touch-scroll.ts";

export type ShellStatus = "connecting" | "connected" | "reconnecting";

export interface ShellHost {
  /** Applies the key bar's Ctrl and Alt to what was typed. */
  transform(data: string): string;
  status(shell: Shell): void;
  title(shell: Shell, title: string): void;
  /** Output arrived while the tab was in the background. */
  activity(shell: Shell): void;
  /** The shell exited or no longer exists on the server. */
  gone(shell: Shell): void;
  /** The server refused the session cookie. */
  unauthorized(): void;
}

const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const encoder = new TextEncoder();
const shells = new Set<Shell>();

// Programs may copy with OSC 52 (tmux, vim, and others do); none may read the clipboard.
const clipboard: IClipboardProvider = {
  readText: () => Promise.resolve(""),
  writeText: (_selection, text) => navigator.clipboard.writeText(text).catch(() => {}),
};

/** Waits for the chosen font, so the first measurement of a cell is the right one. */
export async function fontsReady(): Promise<void> {
  const primary = primaryFont();
  const wait = Promise.all([
    document.fonts.load(`${settings.fontSize}px ${primary}`),
    document.fonts.load(`bold ${settings.fontSize}px ${primary}`),
    document.fonts.load(`${settings.fontSize}px "WT Symbols"`, "⏺"),
  ]).catch(() => {});
  await Promise.race([wait, new Promise((resolve) => setTimeout(resolve, 2500))]);
}

// A font that arrives after text was drawn (an italic, the icon font) leaves
// stale glyphs in the renderer's cache; redraw once it is in.
document.fonts.addEventListener("loadingdone", () => {
  for (const shell of shells) shell.fontsChanged();
});

let iconsRequested = false;

/** Fetches the icon font the first time a private-use character goes by. */
function watchForIcons(bytes: Uint8Array) {
  if (iconsRequested) return;
  for (let i = 0; i < bytes.length - 1; i++) {
    const lead = bytes[i]!;
    if (lead < 0xee) continue;
    const next = bytes[i + 1]!;
    // U+E000-EFFF, U+F000-F8FF, and plane 15.
    if (lead === 0xee || (lead === 0xef && next >= 0x80 && next <= 0xa3) || (lead === 0xf3 && next >= 0xb0)) {
      iconsRequested = true;
      void document.fonts.load('14px "WT Nerd"', "").catch(() => {});
      return;
    }
  }
}

function retryAll() {
  for (const shell of shells) shell.retryNow();
}
window.addEventListener("online", retryAll);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") retryAll();
});

export class Shell {
  readonly id: string;
  readonly term: Terminal;
  status: ShellStatus = "connecting";
  private readonly mount: HTMLDivElement;
  private readonly host: ShellHost;
  private readonly fit = new FitAddon();
  private readonly observer: ResizeObserver;
  private readonly touchScroll: TouchScroll;
  private webgl: WebglAddon | null = null;
  private socket: WebSocket | null = null;
  private attempts = 0;
  private timer = 0;
  private closed = false;
  private visible = false;
  private dark = activeTheme().dark;
  /** Whether the program asked to be told when the color scheme changes (mode 2031). */
  private schemeReports = false;

  constructor(id: string, stage: HTMLElement, host: ShellHost) {
    this.id = id;
    this.host = host;
    this.mount = h("div", { class: "term" });
    this.mount.hidden = true;
    stage.append(this.mount);

    const theme = activeTheme();
    const term = new Terminal({
      allowProposedApi: true,
      fontFamily: fontFamily(),
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      fontWeight: "400",
      fontWeightBold: "700",
      cursorStyle: settings.cursorStyle,
      cursorBlink: settings.cursorBlink,
      cursorInactiveStyle: "outline",
      scrollback: 10_000,
      macOptionIsMeta: true,
      theme: toXterm(theme),
      // Lifts text that would be hard to read against its background, which is
      // what lets programs written for dark terminals work on a light one.
      minimumContrastRatio: contrastRatio(theme),
      // Bold is a weight, not a second palette.
      drawBoldTextInBrightColors: false,
      // Box drawing, blocks and powerline shapes are drawn, not taken from a font, so they always join up.
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,
    });
    this.term = term;
    term.loadAddon(this.fit);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new ClipboardAddon(undefined, clipboard));
    // The width table programs and tmux expect; the built-in one predates emoji.
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.open(this.mount);
    this.touchScroll = new TouchScroll(term);
    this.startWebgl();

    term.onData((data) => this.send(this.host.transform(data)));
    // Legacy mouse reports contain bytes that must not be encoded as UTF-8.
    term.onBinary((data) => {
      if (this.socket?.readyState === WebSocket.OPEN)
        this.socket.send(Uint8Array.from(data, (char) => char.charCodeAt(0)));
    });
    term.attachCustomKeyEventHandler((event) => this.handleKey(event));
    this.answerSchemeQueries();

    this.observer = new ResizeObserver(() => requestAnimationFrame(() => this.fitAndSend()));
    this.observer.observe(this.mount);
    shells.add(this);
    this.connect();
  }

  private startWebgl() {
    try {
      const webgl = new WebglAddon();
      // The browser can take the context away (sleep, GPU reset); the DOM renderer takes over.
      webgl.onContextLoss(() => {
        webgl.dispose();
        this.webgl = null;
      });
      this.term.loadAddon(webgl);
      this.webgl = webgl;
    } catch {
      this.webgl = null;
    }
  }

  /** Returns false for keys the terminal must not handle itself. */
  private handleKey(event: KeyboardEvent): boolean {
    const plain = !event.ctrlKey && !event.altKey && !event.metaKey;
    // Shift+Enter is a line break in most chat-style programs; plain terminals send the same as Enter.
    if (event.key === "Enter" && event.shiftKey && plain) {
      if (event.type === "keydown") {
        event.preventDefault();
        this.send("\x1b\r");
      }
      return false;
    }
    if (IS_MAC || !event.ctrlKey || event.altKey || event.metaKey) return true;
    // Ctrl+V would arrive as a literal ^V; leave it to the browser, which fires a real paste.
    if (event.code === "KeyV") return false;
    // Ctrl+C copies when text is selected and interrupts otherwise; Ctrl+Shift+C always copies.
    if (event.code === "KeyC" && (event.shiftKey || this.term.hasSelection())) {
      if (event.type === "keydown") {
        event.preventDefault();
        const text = this.term.getSelection();
        if (text) void navigator.clipboard.writeText(text).catch(() => {});
        this.term.clearSelection();
      }
      return false;
    }
    return true;
  }

  /**
   * Mode 2031: a program can ask whether the terminal is dark or light and be
   * told when that changes. xterm.js does not know the mode, so it is answered here.
   */
  private answerSchemeQueries() {
    const has = (params: (number | number[])[], mode: number) => params.some((param) => param === mode);
    const report = () => this.send(`\x1b[?997;${this.dark ? 1 : 2}n`);
    const { parser } = this.term;
    parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
      if (has(params, 2031)) this.schemeReports = true;
      return false;
    });
    parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      if (has(params, 2031)) this.schemeReports = false;
      return false;
    });
    parser.registerCsiHandler({ prefix: "?", final: "n" }, (params) => {
      if (params[0] !== 996) return false;
      report();
      return true;
    });
    parser.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, (params) => {
      if (params[0] !== 2031) return false;
      this.send(`\x1b[?2031;${this.schemeReports ? 1 : 2}$y`);
      return true;
    });
  }

  send(data: string) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(encoder.encode(data));
  }

  paste(text: string) {
    this.term.paste(text);
  }

  focus() {
    this.term.focus();
  }

  show() {
    this.visible = true;
    this.mount.hidden = false;
    this.fitAndSend();
    this.term.focus();
  }

  hide() {
    this.touchScroll.stop();
    this.visible = false;
    this.mount.hidden = true;
  }

  /** Picks up changed settings: theme, font, cursor. */
  applySettings() {
    const theme = activeTheme();
    const { options } = this.term;
    options.theme = toXterm(theme);
    options.minimumContrastRatio = contrastRatio(theme);
    options.fontFamily = fontFamily();
    options.fontSize = settings.fontSize;
    options.lineHeight = settings.lineHeight;
    options.cursorStyle = settings.cursorStyle;
    options.cursorBlink = settings.cursorBlink;
    this.fitAndSend();
    if (theme.dark !== this.dark) {
      this.dark = theme.dark;
      if (this.schemeReports) this.send(`\x1b[?997;${this.dark ? 1 : 2}n`);
    }
  }

  fontsChanged() {
    // Same stack, different string: makes xterm measure the cell again.
    const family = fontFamily();
    this.term.options.fontFamily = this.term.options.fontFamily === family ? `${family} ` : family;
    this.webgl?.clearTextureAtlas();
    this.fitAndSend();
  }

  private fitAndSend() {
    // A hidden tab has no size; fitting it would shrink its shell to nothing.
    if (this.closed || !this.visible || !this.mount.clientWidth) return;
    try {
      this.fit.fit();
    } catch {
      return;
    }
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify({ type: "resize", cols: this.term.cols, rows: this.term.rows }));
  }

  private setStatus(status: ShellStatus) {
    this.status = status;
    this.host.status(this);
  }

  private connect() {
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${scheme}//${location.host}/ws/terminals/${this.id}`);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onmessage = (event) => {
      if (socket !== this.socket) return;
      if (typeof event.data === "string") return this.control(event.data);
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      watchForIcons(bytes);
      this.term.write(bytes);
      if (!this.visible) this.host.activity(this);
    };
    socket.onclose = (event) => {
      if (this.closed || socket !== this.socket) return;
      this.socket = null;
      if (event.code === 4000 || event.code === 4004) return this.host.gone(this);
      const delay = Math.min(15_000, 500 * 2 ** this.attempts);
      this.attempts++;
      this.setStatus("reconnecting");
      this.timer = window.setTimeout(() => void this.retry(), delay);
    };
  }

  private control(text: string) {
    let message: { type?: string; cols?: number; rows?: number; data?: string; title?: string };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }
    if (message.type === "title" && typeof message.title === "string") this.host.title(this, message.title);
    if (message.type !== "snapshot" || typeof message.data !== "string") return;
    // The snapshot was laid out at the server's size: take that size, draw it, then fit to this window.
    this.attempts = 0;
    this.term.reset();
    if (message.cols && message.rows) this.term.resize(message.cols, message.rows);
    this.term.write(message.data, () => {
      this.setStatus("connected");
      this.fitAndSend();
    });
  }

  private async retry() {
    if (this.closed || this.socket) return;
    try {
      const res = await fetch("/api/session", { credentials: "same-origin", cache: "no-store" });
      if (res.status === 401) return this.host.unauthorized();
    } catch {}
    if (!this.closed && !this.socket) this.connect();
  }

  /** Skips the wait when the network or the page comes back. */
  retryNow() {
    if (this.closed || this.socket || this.status !== "reconnecting") return;
    window.clearTimeout(this.timer);
    void this.retry();
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    shells.delete(this);
    window.clearTimeout(this.timer);
    this.observer.disconnect();
    this.touchScroll.dispose();
    this.socket?.close(1000);
    this.socket = null;
    this.term.dispose();
    this.mount.remove();
  }
}
