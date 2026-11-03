import assert from "node:assert/strict";
import { test } from "node:test";
import type { IncomingMessage } from "node:http";
import { clientAddress, sameOrigin } from "../app.ts";
import { Throttle } from "../auth.ts";

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
