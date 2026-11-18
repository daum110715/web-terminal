// Multi-account authentication with stateless signed session cookies.
// Each token is signed with a key derived from its account's password hash,
// so changing one user's password only signs out that user's sessions.
// One browser can be signed in to several accounts: the cookie carries one
// token per account, and each token is checked on its own.
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  length: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 2 ** 20 };
export const COOKIE = "wt_session";
const MAX_AGE = 90 * 86400;
const RENEW_BELOW = 60 * 86400;
/** How many accounts one browser can be signed in to at once. */
export const MAX_ACCOUNTS = 8;
// Tokens are base64url and dots, so this never occurs inside one.
const SEPARATOR = "~";
// Used to equalize timing when a login names an unknown user.
const DUMMY_HASH = "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export interface Account {
  username: string;
  hash: string;
  systemUser?: string;
}

export interface SessionIdentity {
  username: string;
  systemUser?: string;
}

/** The accounts a cookie signs in to, in the order they were added. */
export interface Session {
  accounts: SessionIdentity[];
  /** One valid token per account, renewed where due, in the same order. */
  tokens: string[];
  /** True when the cookie no longer matches `tokens` and should be sent again. */
  changed: boolean;
}

const identity = (account: Account): SessionIdentity => ({
  username: account.username,
  ...(account.systemUser ? { systemUser: account.systemUser } : {}),
});

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 32, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, N, r, p, salt, key] = stored.split("$");
  if (algorithm !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "base64url");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64url"), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const digest = (value: string) => createHash("sha256").update(value).digest();

export class Auth {
  private readonly accountsFile: string;
  private readonly legacyAccountFile: string;
  private readonly keyFile: string;

  constructor(secretsDir: string) {
    fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    this.accountsFile = path.join(secretsDir, "accounts.json");
    this.legacyAccountFile = path.join(secretsDir, "account.json");
    this.keyFile = path.join(secretsDir, "session.key");
    try {
      fs.writeFileSync(this.keyFile, randomBytes(32), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  // Read on every use so `npm run passwd` applies without a restart.
  private accounts(): Account[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.accountsFile, "utf8")) as { accounts?: Account[] } | Account[];
      const list = Array.isArray(parsed) ? parsed : parsed.accounts;
      if (Array.isArray(list)) return list.filter((item) => item && typeof item.username === "string" && typeof item.hash === "string");
    } catch {}
    try {
      const legacy = JSON.parse(fs.readFileSync(this.legacyAccountFile, "utf8")) as Account;
      if (legacy && typeof legacy.username === "string" && typeof legacy.hash === "string") return [legacy];
    } catch {}
    return [];
  }

  private findAccount(username: string): Account | null {
    const target = digest(username);
    let matched: Account | null = null;
    for (const account of this.accounts()) {
      if (timingSafeEqual(digest(account.username), target)) matched = account;
    }
    return matched;
  }

  listAccounts(): Array<{ username: string; systemUser?: string }> {
    return this.accounts().map(identity);
  }

  async setAccount(username: string, password: string, systemUser?: string) {
    const accounts = this.accounts();
    const hash = await hashPassword(password);
    const index = accounts.findIndex((item) => item.username === username);
    const previous = index >= 0 ? accounts[index] : undefined;
    const resolvedSystemUser = systemUser === undefined ? previous?.systemUser : systemUser || undefined;
    const next: Account = { username, hash, ...(resolvedSystemUser ? { systemUser: resolvedSystemUser } : {}) };
    if (index >= 0) accounts[index] = next;
    else accounts.push(next);
    fs.writeFileSync(this.accountsFile, JSON.stringify({ accounts }, null, 2) + "\n", { mode: 0o600 });
  }

  removeAccount(username: string): boolean {
    const accounts = this.accounts();
    const next = accounts.filter((item) => item.username !== username);
    if (next.length === accounts.length) return false;
    fs.writeFileSync(this.accountsFile, JSON.stringify({ accounts: next }, null, 2) + "\n", { mode: 0o600 });
    return true;
  }

  private signingKey(account: Account): Buffer {
    return createHmac("sha256", fs.readFileSync(this.keyFile)).update(account.hash).digest();
  }

  async login(username: string, password: string): Promise<string | null> {
    const account = this.findAccount(username);
    if (!account) {
      await verifyPassword(password, DUMMY_HASH);
      return null;
    }
    const passwordOk = await verifyPassword(password, account.hash);
    return passwordOk ? this.issue(account) : null;
  }

  private issue(account: Account, now = Date.now()): string {
    const userPart = Buffer.from(account.username, "utf8").toString("base64url");
    const payload = `${userPart}.${Math.floor(now / 1000) + MAX_AGE}.${randomBytes(12).toString("base64url")}`;
    const signature = createHmac("sha256", this.signingKey(account)).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }

  /**
   * Checks every token in a cookie and keeps the valid ones, one per account.
   * A token that expired or whose account changed its password drops out
   * without signing the browser out of the others.
   */
  verify(value: string | undefined, now = Date.now()): Session | null {
    if (!value) return null;
    const pieces = value.split(SEPARATOR);
    const session: Session = { accounts: [], tokens: [], changed: pieces.length > MAX_ACCOUNTS };
    for (const token of pieces.slice(0, MAX_ACCOUNTS)) {
      const checked = this.check(token, now);
      if (!checked || session.accounts.some((entry) => entry.username === checked.account.username)) {
        session.changed = true;
        continue;
      }
      session.accounts.push(identity(checked.account));
      session.tokens.push(checked.renewed ?? token);
      if (checked.renewed) session.changed = true;
    }
    return session.accounts.length ? session : null;
  }

  /** One token: its account, plus a fresh token when it should roll forward. */
  private check(token: string, now: number): { account: Account; renewed?: string } | null {
    const split = token.lastIndexOf(".");
    if (split < 0) return null;
    const payload = token.slice(0, split);
    const parts = payload.split(".");
    if (parts.length !== 3 || !parts[0]) return null;
    const account = this.findAccount(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (!account) return null;
    const expected = createHmac("sha256", this.signingKey(account)).update(payload).digest();
    const supplied = Buffer.from(token.slice(split + 1), "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
    const left = Number(parts[1]) - Math.floor(now / 1000);
    if (!(left > 0)) return null;
    return { account, ...(left < RENEW_BELOW && { renewed: this.issue(account, now) }) };
  }

  static join(tokens: readonly string[]): string {
    return tokens.join(SEPARATOR);
  }

  static cookie(tokens: readonly string[], path = "/"): string {
    const value = Auth.join(tokens);
    const age = value ? MAX_AGE : 0;
    return `${COOKIE}=${value}; Path=${path}; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
  }

  static read(cookieHeader: string | undefined): string | undefined {
    const match = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(cookieHeader ?? "");
    return match?.[1];
  }
}

/** Exponential lockout per client address after repeated failures. */
export class Throttle {
  private readonly entries = new Map<string, { failures: number; until: number }>();

  wait(key: string, now = Date.now()): number {
    const entry = this.entries.get(key);
    return entry ? Math.max(0, entry.until - now) : 0;
  }

  fail(key: string, now = Date.now()) {
    const entry = this.entries.get(key) ?? { failures: 0, until: 0 };
    entry.failures++;
    if (entry.failures >= 5) entry.until = now + Math.min(15 * 60_000, 30_000 * 2 ** (entry.failures - 5));
    this.entries.set(key, entry);
    if (this.entries.size > 10_000) this.entries.clear();
  }

  succeed(key: string) {
    this.entries.delete(key);
  }
}
