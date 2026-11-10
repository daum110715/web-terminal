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

const clampCols = (cols: number) => Math.max(10, Math.min(500, Math.floor(cols)));
const clampRows = (rows: number) => Math.max(4, Math.min(200, Math.floor(rows)));

interface Session {
  id: string;
  process: IPty;
  screen: Screen;
  serializer: Serializer;
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
    screen.onTitleChange((title) => {
      session.title = title.slice(0, 200);
      if (!session.name) this.announce(session);
    });
    this.sessions.set(session.id, session);
    return this.info(session);
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
          data: session.serializer.serialize(),
        }),
      );
      for (const data of pending) socket.send(data);
      session.clients.add(socket);
    });

    socket.on("message", (data, binary) => {
      if (binary) {
        session.process.write(Buffer.isBuffer(data) ? data.toString() : Buffer.concat(data as Buffer[]).toString());
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
    socket.on("close", () => {
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
