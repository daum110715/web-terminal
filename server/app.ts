// The HTTP side: sign-in, the list of shells, and the built client.
import type { HttpBindings } from "@hono/node-server";
import type { IncomingMessage } from "node:http";
import { Hono } from "hono";
import { z } from "zod";
import { errorMessage, logger } from "./log.ts";
import type { Assets } from "./assets.ts";
import { Auth, MAX_ACCOUNTS, type Session, type Throttle } from "./auth.ts";
import { HttpError, statusOf } from "./http-error.ts";
import type { TerminalInfo, TerminalOptions } from "./terminal.ts";

const log = logger("term");

/** The shells: Terminals itself in tests, the shell host's client in the server. */
export interface TerminalStore {
  list(owners: readonly string[]): TerminalInfo[] | Promise<TerminalInfo[]>;
  create(options: TerminalOptions, owner: string): TerminalInfo | Promise<TerminalInfo>;
  rename(id: string, name: string, owners: readonly string[]): TerminalInfo | Promise<TerminalInfo>;
  kill(id: string, owners: readonly string[]): void | Promise<void>;
}

export interface TermServices {
  auth: Auth;
  throttle: Throttle;
  terminals: TerminalStore;
  assets: Assets;
}

type Env = { Bindings: HttpBindings; Variables: { session: Session } };

const credentials = z.object({
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(1000),
});

const SECURITY_HEADERS = {
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

/** Mutations and WebSockets must come from this host's own pages. */
export function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host) return false;
  try {
    const url = new URL(origin);
    return url.host === host && (url.protocol === "https:" || ["localhost", "127.0.0.1"].includes(url.hostname));
  } catch {
    return false;
  }
}

/**
 * The address to rate-limit on. Caddy runs on this host and appends the real
 * client to X-Forwarded-For, so the last entry is the one it wrote; earlier
 * entries came from the client and can be anything.
 */
export function clientAddress(req: IncomingMessage): string {
  const direct = req.socket.remoteAddress ?? "";
  if (!/^(127\.|::1$|::ffff:127\.)/.test(direct)) return direct;
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",").pop()?.trim() ?? "";
  return forwarded || direct;
}

const terminalOptions = z.object({
  cols: z.number().finite().optional(),
  rows: z.number().finite().optional(),
  dark: z.boolean().optional(),
  /** Which signed-in account the shell belongs to; the first one when left out. */
  account: z.string().min(1).max(200).optional(),
});

const terminalName = z.object({ name: z.string().max(200) });

const owners = (session: Session) => session.accounts.map((account) => account.username);

/** Who the page is signed in as. The first account is the one used on the sign-in page. */
const sessionInfo = (session: Session) => ({ username: session.accounts[0]?.username ?? "", accounts: owners(session) });

async function readCredentials(c: { req: { json: () => Promise<unknown> } }) {
  const parsed = credentials.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) throw new HttpError(400, "Enter a username and password");
  return parsed.data;
}

export function createTermApp({ auth, throttle, terminals, assets }: TermServices) {
  const app = new Hono<Env>();
  const api = new Hono<Env>();

  app.use(async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(name, value);
  });

  app.onError((error, c) => {
    const status = statusOf(error);
    if (!(error instanceof HttpError) && status >= 500) log.error(c.req.method, c.req.path, errorMessage(error));
    // Only our own messages reach the client; anything else is logged, not echoed.
    const message = error instanceof HttpError ? error.message : status === 404 ? "Not found" : "Something went wrong";
    return c.json({ error: message }, status as 400);
  });

  api.use(async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!["GET", "HEAD"].includes(c.req.method) && !sameOrigin(c.req.header("origin"), c.req.header("host")))
      throw new HttpError(403, "Requests must come from this site");
    await next();
  });

  api.post("/session", async (c) => {
    const key = clientAddress(c.env.incoming);
    const wait = throttle.wait(key);
    if (wait) throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil(wait / 1000)} seconds`);
    const { username, password } = await readCredentials(c);
    const token = await auth.login(username, password);
    if (!token) {
      throttle.fail(key);
      throw new HttpError(401, "Incorrect username or password");
    }
    throttle.succeed(key);
    // Accounts this browser is already signed in to stay signed in, so the
    // settings panel can add one more. Signing in again to one of them only
    // replaces its token, in place.
    const signedIn = auth.verify(token)!.accounts[0]!.username;
    const before = auth.verify(Auth.read(c.req.header("cookie")));
    const tokens = before?.tokens ?? [];
    const at = before ? before.accounts.findIndex((account) => account.username === signedIn) : -1;
    if (at >= 0) tokens[at] = token;
    else if (tokens.length >= MAX_ACCOUNTS) throw new HttpError(409, `At most ${MAX_ACCOUNTS} accounts can be signed in at once`);
    else tokens.push(token);
    const session = auth.verify(Auth.join(tokens))!;
    c.header("Set-Cookie", Auth.cookie(session.tokens));
    return c.json(sessionInfo(session));
  });

  api.delete("/session", (c) => {
    c.header("Set-Cookie", Auth.cookie([]));
    return c.json({ ok: true });
  });

  api.use(async (c, next) => {
    const session = auth.verify(Auth.read(c.req.header("cookie")));
    if (!session) throw new HttpError(401, "Sign in to continue");
    if (session.changed) c.header("Set-Cookie", Auth.cookie(session.tokens));
    c.set("session", session);
    await next();
  });

  api.get("/session", (c) => c.json(sessionInfo(c.get("session"))));
  // Signs this browser out of one account and keeps the others. Its shells keep running.
  api.delete("/session/:account", (c) => {
    const session = c.get("session");
    const keep = session.accounts.map((account) => account.username !== c.req.param("account"));
    const left: Session = {
      accounts: session.accounts.filter((_, index) => keep[index]),
      tokens: session.tokens.filter((_, index) => keep[index]),
      changed: true,
    };
    c.header("Set-Cookie", Auth.cookie(left.tokens));
    return c.json(sessionInfo(left));
  });
  api.get("/terminals", async (c) => c.json(await terminals.list(owners(c.get("session")))));
  api.post("/terminals", async (c) => {
    const options = terminalOptions.safeParse(await c.req.json().catch(() => ({})));
    const { account, ...size }: z.infer<typeof terminalOptions> = options.success ? options.data : {};
    const session = c.get("session");
    const owner = account === undefined ? session.accounts[0] : session.accounts.find((entry) => entry.username === account);
    if (!owner) throw new HttpError(403, "Sign in to that account first");
    return c.json(await terminals.create({ ...size, ...(owner.systemUser ? { systemUser: owner.systemUser } : {}) }, owner.username));
  });
  api.patch("/terminals/:id", async (c) => {
    const body = terminalName.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) throw new HttpError(400, "Give the terminal a name of up to 200 characters");
    return c.json(await terminals.rename(c.req.param("id"), body.data.name, owners(c.get("session"))));
  });
  api.delete("/terminals/:id", async (c) => {
    await terminals.kill(c.req.param("id"), owners(c.get("session")));
    return c.json({ ok: true });
  });

  app.route("/api", api);
  app.get("*", (c) => {
    const pathname = new URL(c.req.url).pathname;
    if (pathname.startsWith("/api/")) throw new HttpError(404, "Not found");
    return assets.response(pathname, c.req.header("accept-encoding") ?? "");
  });

  return app;
}
