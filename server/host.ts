// The shell host: owns every shell and its screen copy, and outlives the web
// server. The web server reaches it over a Unix socket that only this account
// can open, so restarting the web side (sign-in, API, client) never ends a
// shell. Only a change to this file or terminal.ts needs a host restart.
//
// Plain HTTP for the calls (GET/POST /terminals, PATCH/DELETE /terminals/:id,
// owners as repeated ?owner=) and a WebSocket per viewer at /terminals/:id that
// speaks exactly the browser protocol in terminal.ts; the web server relays it.
import fs from "node:fs";
import http, { type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { config } from "./config.ts";
import { HttpError, statusOf } from "./http-error.ts";
import { errorMessage, logger } from "./log.ts";
import { Terminals, type TerminalOptions } from "./terminal.ts";
import { hostAnswers } from "./host-client.ts";

const log = logger("host");
const socketPath = config.paths.socket;

// One that answers belongs to a running host; leave it be. A clean exit keeps
// systemd (Restart=on-failure) from starting this one again and again.
if (await hostAnswers(socketPath)) {
  log.info(`a shell host is already running on ${socketPath}`);
  process.exit(0);
}

const terminals = new Terminals(config.limits.terminals);

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Bad request");
  }
}

const server = http.createServer(async (req, res) => {
  let status = 200;
  let result: unknown;
  try {
    const url = new URL(req.url ?? "/", "http://host");
    const owners = url.searchParams.getAll("owner");
    const match = /^\/terminals(?:\/([a-f0-9]{24}))?$/.exec(url.pathname);
    if (!match) throw new HttpError(404, "Not found");
    const id = match[1];
    if (!id && req.method === "GET") result = terminals.list(owners);
    else if (!id && req.method === "POST") {
      const body = await readJson(req);
      result = terminals.create(body.options as TerminalOptions, String(body.owner));
    } else if (id && req.method === "PATCH") result = terminals.rename(id, String((await readJson(req)).name ?? ""), owners);
    else if (id && req.method === "DELETE") {
      terminals.kill(id, owners);
      result = { ok: true };
    } else throw new HttpError(405, "Method not allowed");
  } catch (error) {
    status = statusOf(error);
    if (!(error instanceof HttpError)) log.error(req.method, req.url, errorMessage(error));
    result = { error: error instanceof HttpError ? error.message : "Something went wrong" };
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result));
});

const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1 * 2 ** 20 });
server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const url = new URL(req.url ?? "/", "http://host");
  const match = /^\/terminals\/([a-f0-9]{24})$/.exec(url.pathname);
  if (!match) return socket.destroy();
  sockets.handleUpgrade(req, socket, head, (ws) => terminals.attach(match[1]!, ws, url.searchParams.getAll("owner")));
});

fs.rmSync(socketPath, { force: true });
server.listen(socketPath, () => {
  fs.chmodSync(socketPath, 0o600);
  log.info(`listening on ${socketPath}`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    terminals.close();
    server.close();
    fs.rmSync(socketPath, { force: true });
    process.exit(0);
  });
