// Single-account authentication with a stateless signed session cookie.
// The cookie key is derived from the stored password hash, so changing the
// password signs every existing session out.
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
export const COOKIE = "rb_session";
const MAX_AGE = 90 * 86400;
const RENEW_BELOW = 60 * 86400;

interface Account {
  username: string;
  hash: string;
}

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
  return timingSafeEqual(actual, expected);
}

const digest = (value: string) => createHash("sha256").update(value).digest();

export class Auth {
  private readonly accountFile: string;
  private readonly keyFile: string;

  constructor(secretsDir: string) {
    fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    this.accountFile = path.join(secretsDir, "account.json");
    this.keyFile = path.join(secretsDir, "session.key");
    try {
      fs.writeFileSync(this.keyFile, randomBytes(32), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  // Read on every use so `npm run passwd` applies without a restart.
  private account(): Account | null {
    try {
      return JSON.parse(fs.readFileSync(this.accountFile, "utf8")) as Account;
    } catch {
      return null;
    }
  }

  async setAccount(username: string, password: string) {
    const account: Account = { username, hash: await hashPassword(password) };
    fs.writeFileSync(this.accountFile, JSON.stringify(account, null, 2) + "\n", { mode: 0o600 });
  }

  private signingKey(account: Account): Buffer {
    return createHmac("sha256", fs.readFileSync(this.keyFile)).update(account.hash).digest();
  }

  async login(username: string, password: string): Promise<string | null> {
    const account = this.account();
    if (!account) return null;
    const userOk = timingSafeEqual(digest(username), digest(account.username));
    const passwordOk = await verifyPassword(password, account.hash);
    return userOk && passwordOk ? this.issue(account) : null;
  }

  private issue(account: Account, now = Date.now()): string {
    const payload = `${Math.floor(now / 1000) + MAX_AGE}.${randomBytes(12).toString("base64url")}`;
    const signature = createHmac("sha256", this.signingKey(account)).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }

  /** Returns the username, plus a fresh token when the session should roll forward. */
  verify(token: string | undefined, now = Date.now()): { username: string; renewed?: string } | null {
    const account = this.account();
    if (!account || !token) return null;
    const split = token.lastIndexOf(".");
    if (split < 0) return null;
    const payload = token.slice(0, split);
    const expected = createHmac("sha256", this.signingKey(account)).update(payload).digest();
    const supplied = Buffer.from(token.slice(split + 1), "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
    const left = Number(payload.split(".")[0]) - Math.floor(now / 1000);
    if (!(left > 0)) return null;
    return { username: account.username, ...(left < RENEW_BELOW && { renewed: this.issue(account, now) }) };
  }

  static cookie(token: string | null, path = "/"): string {
    const value = token ?? "";
    const age = token ? MAX_AGE : 0;
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
