// The key bar: the keys a phone keyboard lacks. Ctrl and Alt latch for the next key.
import { h } from "./dom.ts";
import { t } from "./i18n.ts";

const KEYS: { label: string; send?: string; mod?: "ctrl" | "alt" }[] = [
  { label: "Esc", send: "\x1b" },
  { label: "Tab", send: "\t" },
  { label: "Ctrl", mod: "ctrl" },
  { label: "Alt", mod: "alt" },
  { label: "↑", send: "\x1b[A" },
  { label: "↓", send: "\x1b[B" },
  { label: "←", send: "\x1b[D" },
  { label: "→", send: "\x1b[C" },
  { label: "Home", send: "\x1b[H" },
  { label: "End", send: "\x1b[F" },
  { label: "PgUp", send: "\x1b[5~" },
  { label: "PgDn", send: "\x1b[6~" },
  { label: "^C", send: "\x03" },
  { label: "^D", send: "\x04" },
  { label: "^Z", send: "\x1a" },
  { label: "|", send: "|" },
  { label: "~", send: "~" },
  { label: "/", send: "/" },
  { label: "-", send: "-" },
];

const modifiers = { ctrl: false, alt: false };
const modButtons = new Map<"ctrl" | "alt", HTMLButtonElement>();

function paint() {
  for (const [mod, button] of modButtons) button.setAttribute("aria-pressed", String(modifiers[mod]));
}

/** Maps a key to what a terminal expects for Ctrl plus that key. */
function controlCode(key: string): string {
  if (key === " ") return "\x00";
  const code = key.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  return key;
}

/** Applies a latched Ctrl or Alt to the next thing typed, then releases it. */
export function applyModifiers(raw: string): string {
  if (!modifiers.ctrl && !modifiers.alt) return raw;
  let data = raw;
  if (modifiers.ctrl && data.length === 1) data = controlCode(data);
  if (modifiers.alt) data = "\x1b" + data;
  modifiers.ctrl = false;
  modifiers.alt = false;
  paint();
  return data;
}

export function buildKeyBar(actions: { send: (data: string) => void; paste: () => void; focus: () => void }): HTMLElement {
  // Keeps focus in the terminal, so the phone keyboard stays up.
  const keepFocus = (event: Event) => event.preventDefault();
  const key = (label: string, click: () => void, pressed?: boolean) =>
    h("button", {
      class: "key",
      text: label,
      attrs: { type: "button", ...(pressed !== undefined && { "aria-pressed": String(pressed) }) },
      on: {
        mousedown: keepFocus,
        click: () => {
          click();
          actions.focus();
        },
      },
    });
  const buttons = KEYS.map((entry) => {
    if (!entry.mod) return key(entry.label, () => actions.send(applyModifiers(entry.send!)));
    const mod = entry.mod;
    const button = key(
      entry.label,
      () => {
        modifiers[mod] = !modifiers[mod];
        paint();
      },
      false,
    );
    modButtons.set(mod, button);
    return button;
  });
  return h("div", { class: "keys" }, key(t("paste"), actions.paste), ...buttons);
}
