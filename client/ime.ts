import type { Terminal } from "@xterm/xterm";
import { h } from "./dom.ts";

const DEL = "\x7f";

/**
 * Text that reaches the terminal through its textarea instead of as key presses:
 * input methods, voice typing, emoji pickers, phone keyboards.
 *
 * xterm.js reads such text from several places at once (composition end, an
 * insertText event, a textarea diff after keydown 229). Some input methods,
 * voice typing in particular, trigger more than one of them, and the same words
 * went out twice. Here the textarea is the only record: whatever changed in it
 * since the last send goes out once, as backspaces for what was removed and text
 * for what was added. An input method that rewrites what it already committed
 * (adding punctuation once a sentence is final) is mirrored the same way.
 *
 * xterm's composition view stays on one line and runs off the screen; the
 * preview here wraps like terminal text does, starting at the cursor.
 *
 * Space, capital letters and dead keys are the exception: xterm sends them from
 * its keypress handler and leaves the browser to type them into the textarea as
 * well, so that insertion is only recorded here, not sent again.
 */
export class TextInput {
  /** Textarea content the shell has already received. */
  private sent = "";
  private composing = false;
  /** The key xterm just sent from a keypress, until the textarea catches up with it. */
  private keyed: string | null = null;
  /** Normalized text from a DOM paste event while waiting for its matching input event. */
  private pasted: string | null = null;
  private readonly preview = h("div", { class: "ime", attrs: { "aria-hidden": "true" } });
  private readonly text = h("span");

  constructor(
    private readonly term: Terminal,
    mount: HTMLElement,
    private readonly emit: (data: string, typed: boolean) => void,
  ) {
    this.preview.append(this.text);
    this.preview.hidden = true;
    term.element?.querySelector(".xterm-screen")?.append(this.preview);

    // Capture on an ancestor runs before xterm's own listeners on the textarea,
    // so stopping propagation keeps xterm from sending the same text again.
    const on = <K extends keyof HTMLElementEventMap>(type: K, listener: (event: HTMLElementEventMap[K]) => void) =>
      mount.addEventListener(type, (event) => {
        if (event.target === term.textarea) listener(event);
      }, { capture: true });

    term.onKey(({ key, domEvent }) => {
      // xterm clears the textarea on Enter and Ctrl+C without firing an input event.
      if (key === "\r" || key === "\x03") this.sent = "";
      else if (domEvent.type === "keypress") this.keyed = key;
    });

    on("focus", () => {
      if (!this.composing) this.adopt();
    });
    on("blur", () => {
      this.composing = false;
      this.keyed = null;
      this.pasted = null;
      this.sent = "";
      this.show("");
    });
    on("paste", (event) => {
      if (!event.clipboardData) return;
      // xterm's paste handler runs next, sends text/plain if any, and empties the textarea.
      this.sent = "";
      const text = event.clipboardData.getData("text/plain");
      this.pasted = text ? text.replace(/\r\n?/g, "\n") : null;
    });
    on("compositionstart", (event) => {
      event.stopPropagation();
      this.pasted = null;
      if (!this.composing) this.adopt();
      this.composing = true;
      this.show("");
    });
    on("compositionupdate", (event) => {
      event.stopPropagation();
      this.show(event.data);
    });
    on("compositionend", (event) => {
      event.stopPropagation();
      this.composing = false;
      this.preview.hidden = true;
      this.flush();
    });
    on("beforeinput", (event) => {
      const type = event instanceof InputEvent ? event.inputType : "";
      if (type !== "insertFromPaste" && type !== "insertFromDrop") this.pasted = null;
      // Anything changed without an input event (xterm clears the textarea on
      // Enter, Ctrl+C, paste and blur) is a fresh start, not text to delete.
      if (!this.composing && !event.isComposing) this.adopt();
    });
    on("input", (event) => {
      event.stopPropagation();
      if (this.composing || (event instanceof InputEvent && event.isComposing)) return;
      const type = event instanceof InputEvent ? event.inputType : "";
      const keyed = this.keyed;
      const pasted = this.pasted;
      this.keyed = null;
      this.pasted = null;
      if (type === "insertFromPaste" || type === "insertFromDrop") {
        // xterm only handles DOM paste events; OS paste paths that insert straight
        // into the textarea (such as TSF / Win+V) bypass paste and arrive here.
        const change = this.diff();
        if (!change) return;
        if (pasted !== null && change.removed === 0 && change.added.replace(/\r\n?/g, "\n") === pasted) {
          this.sent = change.value;
        } else {
          this.flushPaste(change);
        }
      } else if (type === "insertText" && keyed !== null && (event as InputEvent).data === keyed) {
        // Already sent by xterm's keypress handler.
        this.adopt();
      } else {
        this.flush();
      }
    });
    on("keydown", (event) => {
      this.keyed = null;
      this.pasted = null;
      // Keys the input method is handling are its business, not keys to send.
      if (event.isComposing || event.keyCode === 229) {
        event.stopPropagation();
        return;
      }
      // Committed text goes out before the key that follows it, Enter included.
      if (!this.composing) this.flush();
    });
  }

  private adopt() {
    this.sent = this.term.textarea?.value ?? "";
  }

  private diff() {
    const value = this.term.textarea?.value ?? "";
    const sent = this.sent;
    if (value === sent) return null;
    let same = 0;
    const shorter = Math.min(value.length, sent.length);
    while (same < shorter && value[same] === sent[same]) same++;
    // Never split a surrogate pair.
    if (same > 0 && /[\uD800-\uDBFF]/.test(sent[same - 1]!)) same--;
    return { value, removed: [...sent.slice(same)].length, added: value.slice(same) };
  }

  private flush() {
    const change = this.diff();
    if (!change) return;
    this.sent = change.value;
    if (change.removed) this.emit(DEL.repeat(change.removed), false);
    if (change.added) this.emit(change.added.replace(/\r?\n/g, "\r"), true);
  }

  private flushPaste(change: { value: string; removed: number; added: string }) {
    if (change.removed) this.emit(DEL.repeat(change.removed), false);
    if (change.added) {
      this.term.paste(change.added);
      this.sent = "";
    } else {
      this.sent = change.value;
    }
  }

  private show(text: string) {
    this.text.textContent = text;
    this.preview.hidden = !text;
    if (text) this.place();
  }

  /** Lines up the preview with the cursor; it wraps at the screen edge and stays on screen. */
  private place() {
    const screen = this.preview.parentElement;
    if (!screen) return;
    const { term } = this;
    const width = screen.clientWidth;
    const height = screen.clientHeight;
    const cell = { width: width / term.cols, height: height / term.rows };
    const buffer = term.buffer.active;
    const row = Math.max(0, Math.min(term.rows - 1, buffer.baseY + buffer.cursorY - buffer.viewportY));
    const col = Math.min(buffer.cursorX, term.cols - 1);
    const style = this.preview.style;
    style.fontFamily = term.options.fontFamily ?? "";
    style.fontSize = `${term.options.fontSize}px`;
    style.lineHeight = `${cell.height}px`;
    style.textIndent = `${col * cell.width}px`;
    const top = row * cell.height;
    style.top = `${top}px`;
    const overflow = top + this.preview.offsetHeight - height;
    if (overflow > 0) style.top = `${Math.max(0, top - overflow)}px`;
  }
}
