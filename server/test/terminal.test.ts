import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { WebSocket } from "ws";
import { shellEnv, Terminals } from "../terminal.ts";

/** Stands in for a browser: records what the server sends. */
class Viewer extends EventEmitter {
  readyState = 1;
  frames: (string | Buffer)[] = [];
  send(data: string | Buffer) {
    this.frames.push(data);
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
  type(text: string) {
    this.emit("message", Buffer.from(text), true);
  }
  get output() {
    return this.frames.filter((frame) => Buffer.isBuffer(frame)).join("");
  }
  get snapshot() {
    const first = this.frames[0];
    assert.equal(typeof first, "string");
    return JSON.parse(first as string) as { type: string; cols: number; rows: number; data: string };
  }
}

const until = async (ready: () => boolean) => {
  for (let i = 0; i < 100 && !ready(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(ready(), "timed out");
};

test("a late viewer gets the screen and the modes a full-screen program set", async () => {
  process.env.SHELL = "/bin/sh";
  const terminals = new Terminals(2);
  try {
    const { id } = terminals.create({ cols: 80, rows: 24 });
    const first = new Viewer();
    terminals.attach(id, first as unknown as WebSocket);
    await until(() => first.frames.length > 0);
    assert.equal(first.snapshot.type, "snapshot");
    // Alternate screen, mouse reporting and bracketed paste, as tmux or vim would set them.
    first.type("printf '\\033[?1049h\\033[?1000h\\033[?2004hMARK'\n");
    await until(() => first.output.includes("\x1b[?2004hMARK"));

    const second = new Viewer();
    terminals.attach(id, second as unknown as WebSocket);
    await until(() => second.frames.length > 0);
    const { cols, rows, data } = second.snapshot;
    assert.deepEqual([cols, rows], [80, 24]);
    assert.match(data, /MARK/);
    assert.match(data, /\x1b\[\?1049h/);
    assert.match(data, /\x1b\[\?1000h/);
    assert.match(data, /\x1b\[\?2004h/);
  } finally {
    terminals.close();
  }
});

test("shellEnv tells programs the background and guarantees a UTF-8 locale", () => {
  const light = shellEnv({ LANG: "C", WEB_TERMINAL_PORT: "1", HOME: "/home/x" }, false);
  assert.equal(light.COLORFGBG, "0;15");
  assert.equal(light.LANG, "C.UTF-8");
  assert.equal(light.WEB_TERMINAL_PORT, undefined);
  assert.equal(light.HOME, "/home/x");
  const dark = shellEnv({ LANG: "zh_CN.UTF-8" }, true);
  assert.equal(dark.COLORFGBG, "15;0");
  assert.equal(dark.LANG, "zh_CN.UTF-8");
});
