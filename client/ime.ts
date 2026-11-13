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
 */
export class TextInput {
  /** Textarea content the shell has already received. */
  private sent = "";
  private composing = false;
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

    on("compositionstart", (event) => {
      event.stopPropagation();
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
      // Anything changed without an input event (xterm clears the textarea on
      // Enter, Ctrl+C, paste and blur) is a fresh start, not text to delete.
      if (!this.composing && !event.isComposing) this.adopt();
    });
    on("input", (event) => {
      event.stopPropagation();
      if (this.composing || (event instanceof InputEvent && event.isComposing)) return;
      const type = event instanceof InputEvent ? event.inputType : "";
      // xterm's paste handler already sent it.
      if (type === "insertFromPaste" || type === "insertFromDrop") this.adopt();
      else this.flush();
    });
    on("keydown", (event) => {
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

  private flush() {
    const value = this.term.textarea?.value ?? "";
    const sent = this.sent;
    if (value === sent) return;
    let same = 0;
    const shorter = Math.min(value.length, sent.length);
    while (same < shorter && value[same] === sent[same]) same++;
    // Never split a surrogate pair.
    if (same > 0 && /[\uD800-\uDBFF]/.test(sent[same - 1]!)) same--;
    this.sent = value;
    const removed = [...sent.slice(same)].length;
    const added = value.slice(same).replace(/\r?\n/g, "\r");
    if (removed) this.emit(DEL.repeat(removed), false);
    if (added) this.emit(added, true);
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
