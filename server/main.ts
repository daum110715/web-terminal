// Web terminal: the HTTP API, the static client and the shell sockets.
import { serve, type HttpBindings } from "@hono/node-server";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { config } from "./config.ts";
import { logger } from "./log.ts";
import { Assets } from "./assets.ts";
import { Auth, Throttle } from "./auth.ts";
import { Terminals } from "./terminal.ts";
import { createTermApp, sameOrigin } from "./app.ts";

const log = logger("web-terminal");

const auth = new Auth(config.paths.secrets);
const terminals = new Terminals(config.limits.terminals);
const assets = new Assets(config.paths.dist);
const app = createTermApp({ auth, throttle: new Throttle(), terminals, assets });

const server = serve(
  { fetch: (request, env) => app.fetch(request, env as HttpBindings), hostname: "127.0.0.1", port: config.port },
  (info) => log.info(`listening on http://${info.address}:${info.port}/`),
);

const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1 * 2 ** 20 });

server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const refuse = (status: string) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  if (!sameOrigin(req.headers.origin, req.headers.host)) return refuse("403 Forbidden");
  if (!auth.verify(Auth.read(req.headers.cookie))) return refuse("401 Unauthorized");
  const match = /^\/ws\/terminals\/([a-f0-9]{24})$/.exec(new URL(req.url ?? "/", "http://localhost").pathname);
  if (!match) return refuse("404 Not Found");
  sockets.handleUpgrade(req, socket, head, (ws) => terminals.attach(match[1]!, ws));
});

for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
