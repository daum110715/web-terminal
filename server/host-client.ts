// The web server's side of the shell host (host.ts): the same calls as
// Terminals, over the host's Unix socket, and a relay that joins a browser's
// socket to a shell. Restarting the web server only drops the relays; the
// browser reconnects and the host sends it a fresh snapshot.
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import WebSocket from "ws";
import { HttpError } from "./http-error.ts";
import { logger } from "./log.ts";
import type { TerminalInfo, TerminalOptions } from "./terminal.ts";

const log = logger("host-client");
const PING_MS = 30_000;

const query = (owners: readonly string[]) => new URLSearchParams(owners.map((owner) => ["owner", owner])).toString();

/** Whether a shell host is listening on this socket. */
export function hostAnswers(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({ socketPath, path: "/terminals", method: "GET", timeout: 2000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

// Close codes a socket may not send itself; the browser treats 1011 as a dropped
// connection and reconnects.
const sendable = (code: number) => (code === 1000 || (code >= 3000 && code < 5000) ? code : 1011);

export class HostClient {
  private readonly socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  /**
   * Starts a host beside this server when none is running, as with `npm start`.
   * Under systemd the host has its own unit and is already up; a host started
   * here lives in this server's group and ends with it, as shells used to.
   */
  async ensure() {
    if (await hostAnswers(this.socketPath)) return;
    log.warn("no shell host was running, starting one; run web-terminal-host.service so shells survive restarts");
    spawn(process.execPath, [path.join(import.meta.dirname, "host.ts")], { stdio: "inherit" });
    for (let i = 0; i < 100; i++) {
      if (await hostAnswers(this.socketPath)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("The shell host did not start");
  }

  private request<T>(method: string, route: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { socketPath: this.socketPath, method, path: route, headers: body === undefined ? {} : { "Content-Type": "application/json" } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            let data: { error?: string } = {};
            try {
              data = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { error?: string };
            } catch {}
            const status = res.statusCode ?? 500;
            if (status >= 400) reject(new HttpError(status, data.error ?? "The shell host failed"));
            else resolve(data as T);
          });
        },
      );
      req.on("error", () => reject(new HttpError(503, "The shell host is not running")));
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  list(owners: readonly string[]): Promise<TerminalInfo[]> {
    return this.request("GET", `/terminals?${query(owners)}`);
  }

  create(options: TerminalOptions, owner: string): Promise<TerminalInfo> {
    return this.request("POST", "/terminals", { options, owner });
  }

  rename(id: string, name: string, owners: readonly string[]): Promise<TerminalInfo> {
    return this.request("PATCH", `/terminals/${encodeURIComponent(id)}?${query(owners)}`, { name });
  }

  async kill(id: string, owners: readonly string[]): Promise<void> {
    await this.request("DELETE", `/terminals/${encodeURIComponent(id)}?${query(owners)}`);
  }

  /** Joins a browser's socket to a shell. Frames pass through both ways untouched. */
  attach(id: string, browser: WebSocket, owners: readonly string[]) {
    const host = new WebSocket(`ws+unix://${this.socketPath}:/terminals/${id}?${query(owners)}`, { perMessageDeflate: false });
    const early: [WebSocket.RawData, boolean][] = [];
    browser.on("message", (data, binary) => {
      if (host.readyState === WebSocket.OPEN) host.send(data, { binary });
      else if (host.readyState === WebSocket.CONNECTING) early.push([data, binary]);
    });
    host.on("open", () => {
      for (const [data, binary] of early.splice(0)) host.send(data, { binary });
    });
    host.on("message", (data, binary) => {
      if (browser.readyState === WebSocket.OPEN) browser.send(data, { binary });
    });
    host.on("close", (code, reason) => browser.close(sendable(code), reason));
    host.on("error", () => {});
    // Keeps idle connections open through proxies and notices the ones that died silently.
    let alive = true;
    browser.on("pong", () => (alive = true));
    const heartbeat = setInterval(() => {
      if (!alive) return browser.terminate();
      alive = false;
      browser.ping();
    }, PING_MS);
    browser.on("close", () => {
      clearInterval(heartbeat);
      if (host.readyState === WebSocket.OPEN) host.close();
      else host.terminate();
    });
  }
}
