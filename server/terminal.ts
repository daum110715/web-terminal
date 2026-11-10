// Persistent server shells. A session outlives its viewers. The server keeps
// its own headless copy of each screen, so whoever attaches next gets a clean
// snapshot (screen, scrollback, cursor and modes) instead of a raw byte replay
// that could start mid-sequence or miss the modes a full-screen program set.
import { randomBytes } from "node:crypto";
import os from "node:os";
import pty, { type IPty } from "node-pty";
import headless, { type Terminal as Screen } from "@xterm/headless";
import serialize, { type SerializeAddon as Serializer } from "@xterm/addon-serialize";
import unicode11 from "@xterm/addon-unicode11";
import type { WebSocket } from "ws";
import { HttpError } from "./http-error.ts";

export interface TerminalInfo {
  id: string;
  /** What the tab shows: the given name, else the shell's own title, else the running program. */
  title: string;
  /** The name the user gave it, or "" when it has none. */
  name: string;
  created: number;
  clients: number;
}

export interface TerminalOptions {
  cols?: number;
  rows?: number;
  /** Whether the viewer's theme is dark; programs read it from COLORFGBG. */
  dark?: boolean;
}

const SCROLLBACK_LINES = 10_000;
const OPEN = 1;
const PING_MS = 30_000;

// Private modes the serializer leaves out, with their state after a reset.
// Without the mouse encoding (1006 or 1016) a restored screen
// reports the mouse in a format the program never asked for, and the mouse
// goes dead in tmux, vim and the rest. 25 is cursor visibility.
const EXTRA_MODES = new Map<number, boolean>([
  [12, false],
  [25, true],
  [1006, false],
  [1016, false],
]);

const clampCols = (cols: number) => Math.max(10, Math.min(500, Math.floor(cols)));
const clampRows = (rows: number) => Math.max(4, Math.min(200, Math.floor(rows)));

interface Session {
  id: string;
  process: IPty;
  screen: Screen;
  serializer: Serializer;
  /** Modes from EXTRA_MODES that differ from their reset state. */
  modes: Map<number, boolean>;
  /** The cursor shape the program chose (DECSCUSR), or 0 for the default. */
  cursorShape: number;
  created: number;
  name: string;
  title: string;
  clients: Set<WebSocket>;
  /** Viewers waiting for their snapshot, each with the output that arrived meanwhile. */
  joining: Map<WebSocket, Buffer[]>;
}

/** The environment a shell starts with: this server's, minus what only concerns the service. */
export function shellEnv(base: NodeJS.ProcessEnv, dark: boolean): Record<string, string> {
  const env: Record<string, string> = {};
  const drop = /^(WEB_TERMINAL_|INVOCATION_ID$|JOURNAL_STREAM$|NOTIFY_SOCKET$|SYSTEMD_EXEC_PID$|MEMORY_PRESSURE_|MANAGERPID$|NODE_OPTIONS$)/;
  for (const [key, value] of Object.entries(base)) if (value !== undefined && !drop.test(key)) env[key] = value;
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.TERM_PROGRAM = "web-terminal";
  // The oldest way to tell programs whether the background is dark or light.
  env.COLORFGBG = dark ? "15;0" : "0;15";
  // Without a UTF-8 locale, shells and full-screen programs mangle anything past ASCII.
  if (!/utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || "")) {
    delete env.LC_ALL;
    env.LANG = "C.UTF-8";
    env.LC_CTYPE = "C.UTF-8";
  }
  return env;
}

export class Terminals {
  private readonly sessions = new Map<string, Session>();
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  private info(session: Session): TerminalInfo {
    return {
      id: session.id,
      title: session.name || session.title || session.process.process,
      name: session.name,
      created: session.created,
      clients: session.clients.size,
    };
  }

  list(): TerminalInfo[] {
    return [...this.sessions.values()].map((session) => this.info(session));
  }

  create(options: TerminalOptions = {}): TerminalInfo {
    if (this.sessions.size >= this.max) throw new HttpError(409, `At most ${this.max} terminals can run at once`);
    const cols = clampCols(options.cols ?? 100);
    const rows = clampRows(options.rows ?? 30);
    const child = pty.spawn(process.env.SHELL || "/bin/bash", ["-l"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: os.homedir(),
      env: shellEnv(process.env, options.dark ?? false),
    });
    const screen = new headless.Terminal({ cols, rows, scrollback: SCROLLBACK_LINES, allowProposedApi: true });
    const serializer = new serialize.SerializeAddon();
    screen.loadAddon(serializer);
    // Character widths must match the browser's, or wide characters shift on replay.
    screen.loadAddon(new unicode11.Unicode11Addon());
    screen.unicode.activeVersion = "11";

    const session: Session = {
      id: randomBytes(12).toString("hex"),
      process: child,
      screen,
      serializer,
      modes: new Map(),
      cursorShape: 0,
      created: Date.now(),
      name: "",
      title: "",
      clients: new Set(),
      joining: new Map(),
    };
    child.onData((text) => {
      if (!this.sessions.has(session.id)) return;
      screen.write(text);
      const data = Buffer.from(text);
      for (const client of session.clients) client.send(data);
      for (const pending of session.joining.values()) pending.push(data);
    });
    child.onExit(() => this.retire(session));
    this.trackModes(session);
    screen.onTitleChange((title) => {
      session.title = title.slice(0, 200);
      if (!session.name) this.announce(session);
    });
    this.sessions.set(session.id, session);
    return this.info(session);
  }

  /** Records what the serializer does not, so a snapshot can restore it. */
  private trackModes(session: Session) {
    const { parser } = session.screen;
    const note = (params: (number | number[])[], on: boolean) => {
      for (const param of params) {
        if (typeof param !== "number" || !EXTRA_MODES.has(param)) continue;
        // Both encoding modes replace the active encoding; resetting either
        // returns it to legacy mode even if the other was previously enabled.
        if (param === 1006 || param === 1016) {
          session.modes.delete(1006);
          session.modes.delete(1016);
        }
        // The viewer's blink preference can differ from the headless default.
        if (param !== 12 && EXTRA_MODES.get(param) === on) session.modes.delete(param);
        else session.modes.set(param, on);
      }
      return false;
    };
    parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => note(params, true));
    parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => note(params, false));
    parser.registerCsiHandler({ intermediates: " ", final: "q" }, (params) => {
      session.cursorShape = typeof params[0] === "number" ? params[0] : 0;
      return false;
    });
    const reset = () => {
      session.modes.clear();
      session.cursorShape = 0;
      return false;
    };
    parser.registerEscHandler({ final: "c" }, reset);
    parser.registerCsiHandler({ intermediates: "!", final: "p" }, () => {
      // DECSTR shows the cursor but leaves mouse encoding and cursor style alone.
      session.modes.delete(25);
      return false;
    });
  }

  private snapshot(session: Session): string {
    let extra = "";
    for (const [mode, on] of session.modes) extra += `\x1b[?${mode}${on ? "h" : "l"}`;
    if (session.cursorShape) extra += `\x1b[${session.cursorShape} q`;
    return session.serializer.serialize() + extra;
  }

  private announce(session: Session) {
    const message = JSON.stringify({ type: "title", title: this.info(session).title });
    for (const client of session.clients) client.send(message);
  }

  rename(id: string, name: string): TerminalInfo {
    const session = this.sessions.get(id);
    if (!session) throw new HttpError(404, "Terminal not found");
    session.name = name.trim().slice(0, 40);
    this.announce(session);
    return this.info(session);
  }

  kill(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new HttpError(404, "Terminal not found");
    // Gone from the list at once, not when the process gets around to exiting.
    this.retire(session);
    session.process.kill();
  }

  private retire(session: Session) {
    if (!this.sessions.delete(session.id)) return;
    for (const client of [...session.clients, ...session.joining.keys()]) client.close(4000, "Shell exited");
    session.screen.dispose();
  }

  /**
   * Client to server: binary frames are keystrokes, text frames are JSON
   * control messages. Server to client: one JSON "snapshot" first, then
   * binary frames of live output, with JSON "title" messages in between.
   */
  attach(id: string, socket: WebSocket) {
    const session = this.sessions.get(id);
    if (!session) {
      socket.close(4004, "Terminal not found");
      return;
    }
    const pending: Buffer[] = [];
    session.joining.set(socket, pending);
    // The callback runs once everything written before it is on the screen.
    // Output that arrives later is not in the snapshot; it waits in `pending`.
    session.screen.write("", () => {
      if (!session.joining.delete(socket) || socket.readyState !== OPEN) return;
      socket.send(
        JSON.stringify({
          type: "snapshot",
          cols: session.screen.cols,
          rows: session.screen.rows,
          data: this.snapshot(session),
        }),
      );
      for (const data of pending) socket.send(data);
      session.clients.add(socket);
    });

    socket.on("message", (data, binary) => {
      if (binary) {
        // Bytes go through untouched: legacy mouse reports are not valid UTF-8.
        session.process.write(Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]));
        return;
      }
      try {
        const message = JSON.parse(String(data)) as { type: string; cols: number; rows: number };
        if (message.type !== "resize") return;
        const cols = clampCols(message.cols);
        const rows = clampRows(message.rows);
        if (cols === session.screen.cols && rows === session.screen.rows) return;
        session.process.resize(cols, rows);
        session.screen.resize(cols, rows);
      } catch {}
    });
    // Keeps idle connections open through proxies and notices the ones that died silently.
    let alive = true;
    socket.on("pong", () => (alive = true));
    const heartbeat = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, PING_MS);
    socket.on("close", () => {
      clearInterval(heartbeat);
      session.clients.delete(socket);
      session.joining.delete(socket);
    });
  }

  /** Ends every shell; for a clean shutdown and for tests. */
  close() {
    for (const session of [...this.sessions.values()]) {
      this.retire(session);
      session.process.kill();
    }
  }
}
