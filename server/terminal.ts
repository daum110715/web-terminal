// Persistent server shells. A session outlives its viewers and replays
// recent output to whoever attaches next.
import { randomBytes } from "node:crypto";
import os from "node:os";
import pty, { type IPty } from "node-pty";
import type { WebSocket } from "ws";
export interface TerminalInfo {
  id: string;
  title: string;
  created: number;
  clients: number;
}
import { HttpError } from "./http-error.ts";

const SCROLLBACK_BYTES = 512 * 1024;
const IDLE_MS = 12 * 3600_000;

interface Session {
  id: string;
  process: IPty;
  created: number;
  idleSince: number;
  clients: Set<WebSocket>;
  history: Buffer[];
  historyBytes: number;
}

export class Terminals {
  private readonly sessions = new Map<string, Session>();
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
    setInterval(() => this.reap(), 60_000).unref();
  }

  list(): TerminalInfo[] {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      title: s.process.process,
      created: s.created,
      clients: s.clients.size,
    }));
  }

  create(): TerminalInfo {
    if (this.sessions.size >= this.max) throw new HttpError(409, `At most ${this.max} terminals can run at once`);
    const shell = process.env.SHELL || "/bin/bash";
    const child = pty.spawn(shell, ["-l"], {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: os.homedir(),
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    });
    const session: Session = {
      id: randomBytes(12).toString("hex"),
      process: child,
      created: Date.now(),
      idleSince: Date.now(),
      clients: new Set(),
      history: [],
      historyBytes: 0,
    };
    child.onData((text) => {
      const data = Buffer.from(text);
      session.history.push(data);
      session.historyBytes += data.length;
      while (session.historyBytes > SCROLLBACK_BYTES && session.history.length > 1)
        session.historyBytes -= session.history.shift()!.length;
      for (const client of session.clients) client.send(data);
    });
    child.onExit(() => {
      this.sessions.delete(session.id);
      for (const client of session.clients) client.close(4000, "Shell exited");
    });
    this.sessions.set(session.id, session);
    return this.list().find((t) => t.id === session.id)!;
  }

  kill(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new HttpError(404, "Terminal not found");
    session.process.kill();
  }

  has(id: string) {
    return this.sessions.has(id);
  }

  /** Binary frames are keystrokes; text frames are JSON control messages. */
  attach(id: string, socket: WebSocket) {
    const session = this.sessions.get(id);
    if (!session) {
      socket.close(4004, "Terminal not found");
      return;
    }
    session.clients.add(socket);
    socket.send(Buffer.concat(session.history));
    socket.on("message", (data, binary) => {
      if (binary) {
        session.process.write(Buffer.isBuffer(data) ? data.toString() : Buffer.concat(data as Buffer[]).toString());
        return;
      }
      try {
        const message = JSON.parse(String(data)) as { type: string; cols: number; rows: number };
        if (message.type === "resize")
          session.process.resize(
            Math.max(10, Math.min(500, Math.floor(message.cols))),
            Math.max(4, Math.min(200, Math.floor(message.rows))),
          );
      } catch {}
    });
    socket.on("close", () => {
      session.clients.delete(socket);
      session.idleSince = Date.now();
    });
  }

  private reap() {
    const now = Date.now();
    for (const session of this.sessions.values())
      if (!session.clients.size && now - session.idleSince > IDLE_MS) session.process.kill();
  }
}
