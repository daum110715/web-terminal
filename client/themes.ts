// Color themes. Every palette here is honest: black is dark and white is
// light in both light and dark themes, because programs paint backgrounds
// with them too. Readability on a light page comes from the terminal's
// minimum contrast setting, not from swapping colors around.
import type { ITheme } from "@xterm/xterm";

export interface Theme {
  id: string;
  name: string;
  dark: boolean;
  /** The page's highlight color: the active tab, focus rings, switches. */
  accent: string;
  background: string;
  foreground: string;
  cursor: string;
  selection: string;
  /** black red green yellow blue magenta cyan white, then their bright versions. */
  ansi: string[];
  custom?: boolean;
}

const theme = (
  id: string,
  name: string,
  dark: boolean,
  accent: string,
  background: string,
  foreground: string,
  cursor: string,
  selection: string,
  ansi: string,
): Theme => ({ id, name, dark, accent, background, foreground, cursor, selection, ansi: ansi.split(" ") });

export const THEMES: Theme[] = [
  theme(
    "paper", "Paper", false, "#e08a00", "#fcfaf6", "#44403c", "#f59e0b", "#f59e0b40",
    "#44403c #c0392b #3f7d20 #9a6700 #2459c7 #9d2fa8 #137a8a #e7e2d9 #8a847e #d9480f #5c940d #b7791f #3b6fe0 #ae3ec9 #1098ad #ffffff",
  ),
  theme(
    "github-light", "GitHub Light", false, "#0969da", "#ffffff", "#1f2328", "#0969da", "#0969da33",
    "#24292f #cf222e #116329 #7d4e00 #0969da #8250df #1b7c83 #d0d7de #57606a #a40e26 #1a7f37 #9a6700 #218bff #a475f9 #3192aa #f6f8fa",
  ),
  theme(
    "latte", "Catppuccin Latte", false, "#8839ef", "#eff1f5", "#4c4f69", "#dc8a78", "#7c7f9340",
    "#5c5f77 #d20f39 #40a02b #df8e1d #1e66f5 #ea76cb #179299 #acb0be #6c6f85 #d20f39 #40a02b #df8e1d #1e66f5 #ea76cb #179299 #bcc0cc",
  ),
  theme(
    "one-light", "One Light", false, "#4078f2", "#fafafa", "#383a42", "#526fff", "#526fff33",
    "#383a42 #e45649 #50a14f #c18401 #4078f2 #a626a4 #0184bc #d3d4d8 #696c77 #e45649 #50a14f #c18401 #4078f2 #a626a4 #0184bc #ffffff",
  ),
  theme(
    "ink", "Ink", true, "#f5a524", "#1f2128", "#dcd7cc", "#f5a524", "#f5a52447",
    "#2b2e37 #e5786d #9bc26b #e6c15c #7aa7e8 #c792d6 #6cc4c0 #cfc9bd #5c6170 #f29489 #b3d685 #f2d37a #9bbdf0 #d9aee6 #8bd8d3 #f5f1e8",
  ),
  theme(
    "one-dark", "One Dark", true, "#61afef", "#282c34", "#abb2bf", "#528bff", "#3e4451",
    "#3f4451 #e06c75 #98c379 #e5c07b #61afef #c678dd #56b6c2 #abb2bf #5c6370 #e06c75 #98c379 #e5c07b #61afef #c678dd #56b6c2 #ffffff",
  ),
  theme(
    "mocha", "Catppuccin Mocha", true, "#cba6f7", "#1e1e2e", "#cdd6f4", "#f5e0dc", "#585b70",
    "#45475a #f38ba8 #a6e3a1 #f9e2af #89b4fa #f5c2e7 #94e2d5 #bac2de #585b70 #f38ba8 #a6e3a1 #f9e2af #89b4fa #f5c2e7 #94e2d5 #a6adc8",
  ),
  theme(
    "tokyo-night", "Tokyo Night", true, "#7aa2f7", "#1a1b26", "#c0caf5", "#c0caf5", "#283457",
    "#15161e #f7768e #9ece6a #e0af68 #7aa2f7 #bb9af7 #7dcfff #a9b1d6 #414868 #f7768e #9ece6a #e0af68 #7aa2f7 #bb9af7 #7dcfff #c0caf5",
  ),
  theme(
    "dracula", "Dracula", true, "#bd93f9", "#282a36", "#f8f8f2", "#f8f8f2", "#44475a",
    "#21222c #ff5555 #50fa7b #f1fa8c #bd93f9 #ff79c6 #8be9fd #f8f8f2 #6272a4 #ff6e6e #69ff94 #ffffa5 #d6acff #ff92df #a4ffff #ffffff",
  ),
  theme(
    "nord", "Nord", true, "#88c0d0", "#2e3440", "#d8dee9", "#d8dee9", "#434c5e",
    "#3b4252 #bf616a #a3be8c #ebcb8b #81a1c1 #b48ead #88c0d0 #e5e9f0 #4c566a #bf616a #a3be8c #ebcb8b #81a1c1 #b48ead #8fbcbb #eceff4",
  ),
  theme(
    "gruvbox", "Gruvbox Dark", true, "#fabd2f", "#282828", "#ebdbb2", "#ebdbb2", "#504945",
    "#3c3836 #cc241d #98971a #d79921 #458588 #b16286 #689d6a #a89984 #928374 #fb4934 #b8bb26 #fabd2f #83a598 #d3869b #8ec07c #ebdbb2",
  ),
];

const ANSI_NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

export function toXterm(t: Theme): ITheme {
  const out: Record<string, string> = {
    background: t.background,
    foreground: t.foreground,
    cursor: t.cursor,
    cursorAccent: t.background,
    selectionBackground: t.selection,
  };
  ANSI_NAMES.forEach((name, i) => {
    out[name] = t.ansi[i]!;
    out[`bright${name[0]!.toUpperCase()}${name.slice(1)}`] = t.ansi[i + 8]!;
  });
  return out as ITheme;
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function luminance(hex: string): number {
  const full = hex.length === 4 ? [...hex.slice(1)].map((c) => c + c).join("") : hex.slice(1, 7);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(full.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Reads a color scheme in Windows Terminal's JSON format, the one most theme
 * collections publish. Throws with a message naming what is missing.
 */
export function importTheme(text: string): Theme {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("json");
  }
  if (!raw || typeof raw !== "object") throw new Error("json");
  const color = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === "string" && HEX.test(value.trim())) return value.trim();
    }
    return undefined;
  };
  const need = (...keys: string[]): string => {
    const value = color(...keys);
    if (!value) throw new Error(`missing:${keys[0]}`);
    return value;
  };
  const background = need("background");
  const foreground = need("foreground");
  const ansi = [
    ...ANSI_NAMES.map((name) => need(name, name === "magenta" ? "purple" : name)),
    ...ANSI_NAMES.map((name) => {
      const key = `bright${name[0]!.toUpperCase()}${name.slice(1)}`;
      return need(key, name === "magenta" ? "brightPurple" : key);
    }),
  ];
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 40) : "Custom";
  return {
    id: `custom-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name,
    dark: luminance(background) < 0.4,
    accent: color("accent") ?? ansi[4]!,
    background,
    foreground,
    cursor: color("cursorColor", "cursor") ?? foreground,
    selection: color("selectionBackground", "selection") ?? `${foreground.slice(0, 7)}44`,
    ansi,
    custom: true,
  };
}

/** Whether a stored value is a usable theme; guards against stale or hand-edited storage. */
export function isTheme(value: unknown): value is Theme {
  const t = value as Theme;
  return (
    !!t &&
    typeof t.id === "string" &&
    typeof t.name === "string" &&
    typeof t.dark === "boolean" &&
    [t.accent, t.background, t.foreground, t.cursor, t.selection].every((c) => typeof c === "string" && HEX.test(c)) &&
    Array.isArray(t.ansi) &&
    t.ansi.length === 16 &&
    t.ansi.every((c) => typeof c === "string" && HEX.test(c))
  );
}
