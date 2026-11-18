// What a background tab's program is doing, for the mark on its tab: working,
// finished, or waiting for you. Coding agents tell the terminal different
// things, so three kinds of evidence feed one answer:
// - OSC 9;4 progress (Grok, Antigravity, opencode, Claude Code): set while
//   working, cleared when done.
// - Notifications (OSC 9, 777, 99) and the bell: the program wants you.
// - Output itself: a spinner or streamed text keeps arriving while an agent
//   works, and stops when it is done. This covers Codex, programs inside
//   tmux and plain commands, which send neither of the above. A single redraw,
//   such as tmux updating its clock, is not work.
// Whether a program that stopped is done or waiting is read off the bottom of
// the screen: the agents' approval prompts share a handful of phrasings.
import type { Terminal } from "@xterm/xterm";

export type Activity = "idle" | "running" | "done" | "waiting";

/** Output that keeps coming for this long is work, not a one-off redraw. */
const STEADY_MS = 700;
/** This much quiet after work means it stopped. */
const QUIET_MS = 3000;
/** While a program reports progress, only this much quiet overrides it (it may have died without clearing it). */
const STALE_PROGRESS_MS = 60_000;
/** Lets the last frame land before the screen is read. */
const SETTLE_MS = 400;
/** Approval prompts end the screen's text; lines further up may hold answered ones. */
const PROMPT_LINES = 15;

// Approval and choice prompts of Claude Code, Codex, Grok, Antigravity and
// opencode, and the usual yes/no forms.
const ASKING = new RegExp(
  [
    "Do you want to (proceed|make this edit|create|allow|delete|overwrite|run)",
    "Would you like to (run|make|grant|send|proceed|allow)",
    "Yes, (proceed|allow)",
    "Allow (once|always)",
    "Allow [A-Za-z ]{2,40}\\?",
    "Run this command\\?",
    "Apply this change\\?",
    "Permission required",
    "Waiting for (your )?(approval|confirmation|permission|input)",
    "(needs|requires) your (approval|permission|input|confirmation)",
    "Approval requested",
    "Enter to (select|confirm)",
    "\\[[yY]/[nN]\\]",
    "\\([yY]/[nN]\\)",
  ].join("|"),
  "i",
);
// Notification text that asks for something rather than reporting it is finished.
const ASKING_NOTE = /permission|approv|confirm|needs? your|waiting for your/i;

export class ActivityWatch {
  state: Activity = "idle";
  private readonly term: Terminal;
  private readonly changed: (state: Activity) => void;
  private visible = false;
  /** The program said it is working (OSC 9;4) and has not said it stopped. */
  private progress = false;
  private burstStart = 0;
  private lastOutput = -Infinity;
  private quietTimer = 0;
  private settleTimer = 0;

  constructor(term: Terminal, changed: (state: Activity) => void) {
    this.term = term;
    this.changed = changed;
    term.parser.registerOscHandler(9, (data) => this.osc9(data));
    term.parser.registerOscHandler(777, (data) => {
      if (data.startsWith("notify;")) this.notify(data.slice(7));
      return true;
    });
    term.parser.registerOscHandler(99, (data) => {
      this.notify(data.slice(data.indexOf(";") + 1));
      return true;
    });
    term.onBell(() => this.notify(""));
  }

  /** Live output arrived; a snapshot does not count. */
  output() {
    if (this.visible) return;
    const now = performance.now();
    if (now - this.lastOutput > QUIET_MS) this.burstStart = now;
    this.lastOutput = now;
    if (now - this.burstStart >= STEADY_MS) this.set("running");
    if (!this.quietTimer) this.quietTimer = window.setTimeout(() => this.quiet(), QUIET_MS);
  }

  /** A fresh snapshot was drawn: a prompt already on screen is still waiting. */
  restored() {
    if (!this.visible && this.state === "idle" && this.asking()) this.set("waiting");
  }

  /** The tab came to the front or went to the back. What happened while it showed was seen. */
  shown(visible: boolean) {
    this.visible = visible;
    this.burstStart = 0;
    this.lastOutput = -Infinity;
    window.clearTimeout(this.settleTimer);
    this.set(!visible && this.progress ? "running" : "idle");
  }

  dispose() {
    window.clearTimeout(this.quietTimer);
    window.clearTimeout(this.settleTimer);
  }

  private quiet() {
    this.quietTimer = 0;
    const left = this.lastOutput + (this.progress ? STALE_PROGRESS_MS : QUIET_MS) - performance.now();
    if (left > 0) {
      this.quietTimer = window.setTimeout(() => this.quiet(), left);
      return;
    }
    this.progress = false;
    if (this.state === "running") this.settle("");
  }

  // ConEmu's OSC 9;N commands; 9;4 is progress (0 clear, 1 set, 2 error, 3 busy, 4 paused).
  // Anything without a number in front is an iTerm2-style notification.
  private osc9(data: string): boolean {
    const progress = /^4;(\d)/.exec(data);
    if (progress) {
      const state = Number(progress[1]);
      const working = state === 1 || state === 3;
      const was = this.progress;
      this.progress = working;
      if (this.visible) return true;
      if (working) {
        window.clearTimeout(this.settleTimer);
        this.set("running");
      } else if (was || state === 2 || state === 4) this.settle("");
      return true;
    }
    if (!/^\d+;/.test(data)) this.notify(data);
    return true;
  }

  private notify(text: string) {
    this.progress = false;
    if (!this.visible) this.settle(text);
  }

  private settle(note: string) {
    window.clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => {
      if (this.visible) return;
      this.set(ASKING_NOTE.test(note) || this.asking() ? "waiting" : "done");
    }, SETTLE_MS);
  }

  private asking(): boolean {
    const buffer = this.term.buffer.active;
    const line = (y: number) => buffer.getLine(y)?.translateToString(true) ?? "";
    // A screen that is not full yet ends above its bottom row.
    let last = buffer.baseY + this.term.rows - 1;
    while (last > buffer.baseY && !line(last).trim()) last--;
    let text = "";
    for (let y = Math.max(0, last - PROMPT_LINES + 1); y <= last; y++) text += `${line(y)}\n`;
    return ASKING.test(text);
  }

  private set(state: Activity) {
    if (this.state === state) return;
    this.state = state;
    this.changed(state);
  }
}
