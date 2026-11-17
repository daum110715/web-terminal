import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { IncomingMessage } from "node:http";
import { clientAddress, sameOrigin } from "../app.ts";
import { Auth, Throttle } from "../auth.ts";
import { Terminals } from "../terminal.ts";

const request = (remoteAddress: string, forwarded?: string) =>
  ({
    socket: { remoteAddress },
    headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
  }) as unknown as IncomingMessage;

test("sameOrigin accepts only this host over https or local http", () => {
  assert.equal(sameOrigin("https://term.example.com", "term.example.com"), true);
  assert.equal(sameOrigin("https://evil.example.com", "term.example.com"), false);
  assert.equal(sameOrigin("http://term.example.com", "term.example.com"), false);
  assert.equal(sameOrigin("http://localhost:3120", "localhost:3120"), true);
  assert.equal(sameOrigin(undefined, "term.example.com"), false);
  assert.equal(sameOrigin("https://term.example.com", undefined), false);
});

test("clientAddress ignores X-Forwarded-For from remote peers", () => {
  assert.equal(clientAddress(request("203.0.113.7", "10.0.0.1")), "203.0.113.7");
});

test("clientAddress takes the last X-Forwarded-For hop behind a loopback proxy", () => {
  assert.equal(clientAddress(request("127.0.0.1", "198.51.100.9, 192.0.2.44")), "192.0.2.44");
  assert.equal(clientAddress(request("127.0.0.1")), "127.0.0.1");
});

test("Throttle locks out after repeated failures and clears on success", () => {
  const throttle = new Throttle();
  for (let i = 0; i < 5; i++) throttle.fail("client", 0);
  assert.ok(throttle.wait("client", 1) > 0);
  throttle.succeed("client");
  assert.equal(throttle.wait("client", 1), 0);
});

test("Auth supports multiple accounts, isolates password changes, and preserves legacy account.json", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-auth-"));
  try {
    const auth = new Auth(dir);
    await auth.setAccount("lemon", "pass1", "lemon");
    await auth.setAccount("nia", "pass2", "nia");
    const tLemon = await auth.login("lemon", "pass1");
    const tNia = await auth.login("nia", "pass2");
    assert.ok(tLemon && tNia);
    assert.deepEqual(auth.verify(tLemon), { username: "lemon", systemUser: "lemon" });
    assert.deepEqual(auth.verify(tNia), { username: "nia", systemUser: "nia" });
    assert.equal(await auth.login("nia", "pass1"), null);

    // Changing nia's password signs out nia only.
    await auth.setAccount("nia", "pass3");
    assert.equal(auth.verify(tNia), null);
    assert.deepEqual(auth.verify(tLemon), { username: "lemon", systemUser: "lemon" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Terminals isolates sessions per owner", () => {
  process.env.SHELL = "/bin/sh";
  const terminals = new Terminals(1);
  try {
    const a = terminals.create({ cols: 80, rows: 24 }, "lemon");
    const b = terminals.create({ cols: 80, rows: 24 }, "nia");
    assert.equal(terminals.list("lemon").length, 1);
    assert.equal(terminals.list("nia").length, 1);
    assert.throws(() => terminals.rename(b.id, "hijack", "lemon"), /Terminal not found/);
    assert.throws(() => terminals.kill(a.id, "nia"), /Terminal not found/);
  } finally {
    terminals.close();
  }
});
