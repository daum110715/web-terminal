import type { Terminal } from "@xterm/xterm";

/** Touch panning for xterm's virtual viewport, which only handles mouse wheels. */
export class TouchScroll {
  private readonly events = new AbortController();
  private readonly element: HTMLElement;
  private readonly screen: HTMLElement;
  private finger: { id: number; x: number; y: number; lastY: number; time: number; dragging: boolean } | null = null;
  private remainder = 0;
  private velocity = 0;
  private frame = 0;

  constructor(private readonly term: Terminal) {
    this.element = term.element!;
    this.screen = this.element.querySelector<HTMLElement>(".xterm-screen")!;
    const { signal } = this.events;
    this.element.addEventListener("touchstart", (event) => {
      this.stop();
      if (event.touches.length !== 1 || (event.target instanceof Element && event.target.closest(".scrollbar"))) return;
      const touch = event.touches[0]!;
      this.finger = { id: touch.identifier, x: touch.clientX, y: touch.clientY, lastY: touch.clientY, time: event.timeStamp, dragging: false };
    }, { passive: true, signal });
    this.element.addEventListener("touchmove", (event) => this.move(event), { passive: false, signal });
    this.element.addEventListener("touchend", (event) => {
      const finger = this.finger;
      this.finger = null;
      if (!finger?.dragging) return;
      // A swipe must not become a tap that focuses the input or clicks a TUI.
      event.preventDefault();
      if (event.timeStamp - finger.time < 100) this.coast(finger.x, finger.lastY);
    }, { passive: false, signal });
    this.element.addEventListener("touchcancel", () => this.stop(), { signal });
    this.element.addEventListener("keydown", () => this.stop(), { signal });
    document.addEventListener("touchstart", (event) => {
      if (event.target instanceof Node && !this.element.contains(event.target)) this.stop();
    }, { passive: true, signal });
    document.addEventListener("visibilitychange", () => this.stop(), { signal });
  }

  private move(event: TouchEvent) {
    const finger = this.finger;
    if (!finger) return;
    if (event.touches.length !== 1 || event.touches[0]!.identifier !== finger.id) return this.stop();
    const touch = event.touches[0]!;
    if (!finger.dragging) {
      const dy = touch.clientY - finger.y;
      const dx = touch.clientX - finger.x;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
      if (Math.abs(dx) > Math.abs(dy)) return this.stop();
      finger.dragging = true;
    }
    event.preventDefault();
    const delta = finger.lastY - touch.clientY;
    const elapsed = Math.max(1, event.timeStamp - finger.time);
    this.velocity = Math.max(-3, Math.min(3, delta / elapsed));
    this.scroll(delta, touch.clientX, touch.clientY);
    finger.lastY = touch.clientY;
    finger.time = event.timeStamp;
  }

  private scroll(pixels: number, x: number, y: number): boolean {
    const rect = this.screen.getBoundingClientRect();
    const height = rect.height / this.term.rows;
    if (!height) return false;
    this.remainder += pixels / height;
    const lines = Math.trunc(this.remainder);
    if (!lines) return true;
    this.remainder -= lines;
    if (this.term.modes.mouseTrackingMode === "none" && this.term.buffer.active.type === "normal") {
      const before = this.term.buffer.active.viewportY;
      this.term.scrollLines(lines);
      return this.term.buffer.active.viewportY !== before;
    }
    // Let xterm choose the mouse encoding or alternate-screen arrow keys,
    // exactly as it would for a real wheel. Each event represents one line.
    for (let i = 0; i < Math.abs(lines); i++) {
      this.screen.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaMode: WheelEvent.DOM_DELTA_LINE,
        deltaY: Math.sign(lines),
        clientX: Math.max(rect.left + 1, Math.min(rect.right - 1, x)),
        clientY: Math.max(rect.top + 1, Math.min(rect.bottom - 1, y)),
      }));
    }
    return true;
  }

  private coast(x: number, y: number) {
    let last = performance.now();
    const buffer = this.term.buffer.active;
    const mode = this.term.modes.mouseTrackingMode;
    const tick = (now: number) => {
      this.frame = 0;
      if (this.term.buffer.active !== buffer || this.term.modes.mouseTrackingMode !== mode) return;
      const elapsed = Math.min(32, now - last);
      last = now;
      this.velocity *= Math.exp(-elapsed / 200);
      if (Math.abs(this.velocity) < 0.02 || !this.scroll(this.velocity * elapsed, x, y)) return;
      this.frame = requestAnimationFrame(tick);
    };
    if (Math.abs(this.velocity) >= 0.02) this.frame = requestAnimationFrame(tick);
  }

  stop() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.finger = null;
    this.remainder = 0;
    this.velocity = 0;
  }

  dispose() {
    this.stop();
    this.events.abort();
  }
}
