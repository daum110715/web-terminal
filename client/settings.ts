// What the person has chosen, kept in this browser, and the panel that edits it.
import { h, recall, reconcile, remember } from "./dom.ts";
import { LANGUAGE_KEY, t, type Language } from "./i18n.ts";
import { importTheme, isTheme, THEMES, type Theme } from "./themes.ts";

export interface Settings {
  appearance: "system" | "light" | "dark";
  lightTheme: string;
  darkTheme: string;
  font: string;
  customFont: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: "block" | "bar" | "underline";
  cursorBlink: boolean;
  contrast: boolean;
  keyBar: "auto" | "on" | "off";
  customThemes: Theme[];
}

const DEFAULTS: Settings = {
  appearance: "system",
  lightTheme: "paper",
  darkTheme: "ink",
  font: "jetbrains",
  customFont: "",
  fontSize: 14,
  lineHeight: 1.2,
  cursorStyle: "block",
  cursorBlink: true,
  contrast: true,
  keyBar: "auto",
  customThemes: [],
};

export const FONTS: { id: string; name: string; family: string }[] = [
  { id: "jetbrains", name: "JetBrains Mono", family: '"JetBrains Mono"' },
  { id: "fira", name: "Fira Code", family: '"Fira Code"' },
  { id: "cascadia", name: "Cascadia Code", family: '"Cascadia Code"' },
  { id: "plex", name: "IBM Plex Mono", family: '"IBM Plex Mono"' },
  { id: "system", name: t("fontSystem"), family: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono"' },
  { id: "custom", name: t("fontCustom"), family: "" },
];

// After the chosen font: symbols and icons it lacks, then the system's CJK faces.
const FALLBACK =
  '"WT Symbols", "WT Nerd", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans Mono CJK SC", "Noto Sans CJK SC", "Source Han Sans SC", "WenQuanYi Micro Hei", monospace';

const KEY = "web-terminal:settings";
const SIZE = { min: 10, max: 24 };
const LINE = { min: 1, max: 1.6 };

function load(): Settings {
  const out = { ...DEFAULTS };
  try {
    const saved = JSON.parse(recall(KEY) ?? "{}") as Partial<Settings>;
    const pick = <K extends keyof Settings>(key: K, ok: (value: unknown) => boolean) => {
      if (ok(saved[key])) out[key] = saved[key] as Settings[K];
    };
    pick("appearance", (v) => v === "system" || v === "light" || v === "dark");
    pick("lightTheme", (v) => typeof v === "string");
    pick("darkTheme", (v) => typeof v === "string");
    pick("font", (v) => FONTS.some((font) => font.id === v));
    pick("customFont", (v) => typeof v === "string");
    pick("fontSize", (v) => typeof v === "number" && v >= SIZE.min && v <= SIZE.max);
    pick("lineHeight", (v) => typeof v === "number" && v >= LINE.min && v <= LINE.max);
    pick("cursorStyle", (v) => v === "block" || v === "bar" || v === "underline");
    pick("cursorBlink", (v) => typeof v === "boolean");
    pick("contrast", (v) => typeof v === "boolean");
    pick("keyBar", (v) => v === "auto" || v === "on" || v === "off");
    if (Array.isArray(saved.customThemes)) out.customThemes = saved.customThemes.filter(isTheme).slice(0, 30);
  } catch {}
  return out;
}

export const settings = load();

const listeners = new Set<() => void>();
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
systemDark.addEventListener("change", () => notify());

function notify() {
  for (const listener of listeners) listener();
}

/** Runs whenever a setting, or the system's light/dark preference, changes. */
export function onSettingsChange(listener: () => void, signal?: AbortSignal) {
  listeners.add(listener);
  signal?.addEventListener("abort", () => listeners.delete(listener), { once: true });
}

export function update(patch: Partial<Settings>) {
  Object.assign(settings, patch);
  remember(KEY, JSON.stringify(settings));
  notify();
}

export function allThemes(): Theme[] {
  return [...THEMES, ...settings.customThemes];
}

export function activeTheme(): Theme {
  const dark = settings.appearance === "system" ? systemDark.matches : settings.appearance === "dark";
  const themes = allThemes();
  const wanted = dark ? settings.darkTheme : settings.lightTheme;
  return themes.find((theme) => theme.id === wanted && theme.dark === dark) ?? themes.find((theme) => theme.dark === dark)!;
}

/** The first family in the stack: what has to be loaded before text is measured. */
export function primaryFont(): string {
  if (settings.font === "custom") {
    const name = settings.customFont.replace(/["'\\;{}]/g, "").trim();
    if (name) return `"${name}"`;
  }
  const font = FONTS.find((entry) => entry.id === settings.font && entry.family) ?? FONTS[0]!;
  return font.family;
}

export function fontFamily(): string {
  return `${primaryFont()}, ${FALLBACK}`;
}

/** Light pages need real help; dark ones only where text would vanish. */
export function contrastRatio(theme: Theme): number {
  if (!settings.contrast) return 1;
  return theme.dark ? 2.5 : 4.5;
}

// ------------------------------------------------------------ panel

function segmented<T extends string>(label: string, options: [T, string][], current: () => T, choose: (value: T) => void, signal: AbortSignal): HTMLElement {
  const buttons = options.map(([value, text]) =>
    h("button", {
      class: "seg",
      text,
      attrs: { type: "button", "aria-pressed": String(current() === value) },
      on: { click: () => choose(value) },
    }),
  );
  onSettingsChange(() => {
    for (const [i, button] of buttons.entries()) button.setAttribute("aria-pressed", String(options[i]![0] === current()));
  }, signal);
  return h("div", { class: "segs", attrs: { role: "group", "aria-label": label } }, ...buttons);
}

function row(label: string, control: Node): HTMLElement {
  return h("div", { class: "row" }, h("span", { class: "row-label", text: label }), control);
}

function stepper(label: string, read: () => string, step: (direction: 1 | -1) => void): HTMLElement {
  const value = h("output", { class: "step-value", text: read() });
  const button = (direction: 1 | -1) =>
    h("button", {
      class: "step",
      text: direction < 0 ? "−" : "+",
      attrs: { type: "button", "aria-label": `${label} ${direction < 0 ? t("smaller") : t("larger")}` },
      on: {
        click: () => {
          step(direction);
          value.textContent = read();
        },
      },
    });
  return h("div", { class: "stepper" }, button(-1), value, button(1));
}

function toggle(label: string, read: () => boolean, write: (value: boolean) => void): HTMLElement {
  const input = h("input", { attrs: { type: "checkbox", role: "switch" }, on: { change: () => write(input.checked) } });
  input.checked = read();
  return h("label", { class: "row switch" }, h("span", { class: "row-label", text: label }), input);
}

/** A theme shown the way it will look: a scrap of terminal in its own colors. */
function themeTile(theme: Theme, selected: boolean, choose: () => void, remove?: () => void): HTMLElement {
  const span = (text: string, color: string) => {
    const node = h("span", { text });
    node.style.color = color;
    return node;
  };
  const [, red, green, yellow, blue, magenta, cyan] = theme.ansi as [string, string, string, string, string, string, string];
  const sample = h(
    "span",
    { class: "tile-sample", attrs: { "aria-hidden": "true" } },
    h("span", {}, span("~/app ", blue), span("main ", magenta), span("$ ", green), span("ls", theme.foreground)),
    h("span", {}, span("src ", blue), span("run.sh ", green), span("notes ", theme.foreground), span("x.log", yellow)),
    h("span", {}, span("error ", red), span("0 ", theme.foreground), span("ok ", cyan), span("12", theme.foreground)),
  );
  sample.style.background = theme.background;
  const tile = h(
    "button",
    { class: "tile", attrs: { type: "button", "data-theme": theme.id, "aria-pressed": String(selected) }, on: { click: choose } },
    sample,
    h("span", { class: "tile-name", text: theme.name }),
  );
  if (!remove) return tile;
  return h(
    "div",
    { class: "tile-wrap" },
    tile,
    h("button", {
      class: "tile-remove",
      text: "×",
      attrs: { type: "button", "aria-label": t("removeTheme", { name: theme.name }) },
      on: { click: remove },
    }),
  );
}

export function buildPanel(account: string, actions: { close: () => void; signOut: () => void }, signal: AbortSignal): HTMLDialogElement {
  const lightTiles = h("div", { class: "tiles" });
  const darkTiles = h("div", { class: "tiles" });
  const themeArea = h("div", { class: "themes" },
    segmented<Settings["appearance"]>(t("theme"), [["system", t("system")], ["light", t("light")], ["dark", t("dark")]],
      () => settings.appearance, (appearance) => update({ appearance }), signal),
    h("h3", { text: t("light") }), lightTiles,
    h("h3", { text: t("dark") }), darkTiles,
  );
  const tiles = new Map<string, HTMLElement>();
  const paintThemes = () => {
    const active = activeTheme();
    const themes = allThemes();
    for (const id of tiles.keys()) if (!themes.some((theme) => theme.id === id)) tiles.delete(id);
    for (const theme of themes) {
      if (!tiles.has(theme.id)) tiles.set(theme.id, themeTile(theme, false, () => update({
        ...(theme.dark ? { darkTheme: theme.id } : { lightTheme: theme.id }),
        ...(theme.dark !== activeTheme().dark && { appearance: theme.dark ? "dark" : "light" }),
      }), theme.custom ? () => update({ customThemes: settings.customThemes.filter((entry) => entry.id !== theme.id) }) : undefined));
      const tile = tiles.get(theme.id)!;
      (tile.matches(".tile") ? tile : tile.querySelector(".tile")!).setAttribute("aria-pressed", String(theme.id === active.id));
    }
    reconcile(lightTiles, themes.filter((theme) => !theme.dark).map((theme) => tiles.get(theme.id)!));
    reconcile(darkTiles, themes.filter((theme) => theme.dark).map((theme) => tiles.get(theme.id)!));
  };
  paintThemes();
  onSettingsChange(paintThemes, signal);

  const importText = h("textarea", { attrs: { rows: "4", spellcheck: "false", placeholder: t("importHint"), "aria-label": t("importHint") } });
  const importNote = h("p", { class: "note", attrs: { role: "alert" } });
  const importer = h(
    "details",
    { class: "import" },
    h("summary", { text: t("importTheme") }),
    importText,
    importNote,
    h("button", {
      class: "plain",
      text: t("addTheme"),
      attrs: { type: "button" },
      on: {
        click: () => {
          try {
            const theme = importTheme(importText.value);
            importText.value = "";
            importNote.textContent = "";
            update({
              customThemes: [...settings.customThemes, theme].slice(-30),
              appearance: theme.dark ? "dark" : "light",
              ...(theme.dark ? { darkTheme: theme.id } : { lightTheme: theme.id }),
            });
          } catch (error) {
            const reason = error instanceof Error ? error.message : "";
            importNote.textContent = reason.startsWith("missing:") ? t("importMissing", { key: reason.slice(8) }) : t("importBadJson");
          }
        },
      },
    }),
  );

  const customFont = h("input", {
    class: "text",
    attrs: { type: "text", placeholder: t("fontName"), "aria-label": t("fontName"), spellcheck: "false", maxlength: "80" },
    on: { change: () => update({ customFont: customFont.value }) },
  });
  customFont.value = settings.customFont;
  customFont.hidden = settings.font !== "custom";
  const fontSelect = h(
    "select",
    {
      attrs: { "aria-label": t("font") },
      on: {
        change: () => {
          customFont.hidden = fontSelect.value !== "custom";
          update({ font: fontSelect.value });
        },
      },
    },
    ...FONTS.map((font) => h("option", { text: font.name, attrs: { value: font.id } })),
  );
  fontSelect.value = settings.font;

  const languageSelect = h(
    "select",
    {
      attrs: { "aria-label": t("language") },
      on: {
        change: () => {
          // The page's text is built once, so a new language starts it over. Shells keep running.
          if (languageSelect.value === "auto") {
            try {
              localStorage.removeItem(LANGUAGE_KEY);
            } catch {}
          } else remember(LANGUAGE_KEY, languageSelect.value);
          location.reload();
        },
      },
    },
    h("option", { text: t("auto"), attrs: { value: "auto" } }),
    h("option", { text: "中文", attrs: { value: "zh" } }),
    h("option", { text: "English", attrs: { value: "en" } }),
  );
  languageSelect.value = ((recall(LANGUAGE_KEY) as Language | null) ?? "auto") satisfies string;

  return h(
    "dialog",
    { class: "panel", attrs: { "aria-label": t("settings") } },
    h(
      "div",
      { class: "panel-head" },
      h("h2", { text: t("settings") }),
      h("button", { class: "plain", text: t("done"), attrs: { type: "button" }, on: { click: actions.close } }),
    ),
    h("section", {}, h("h2", { text: t("theme") }), themeArea, importer),
    h(
      "section",
      {},
      h("h2", { text: t("font") }),
      fontSelect,
      customFont,
      row(
        t("size"),
        stepper(
          t("size"),
          () => String(settings.fontSize),
          (direction) => update({ fontSize: Math.min(SIZE.max, Math.max(SIZE.min, settings.fontSize + direction)) }),
        ),
      ),
      row(
        t("lineHeight"),
        stepper(
          t("lineHeight"),
          () => settings.lineHeight.toFixed(1),
          (direction) => update({ lineHeight: Math.min(LINE.max, Math.max(LINE.min, Math.round((settings.lineHeight + direction * 0.1) * 10) / 10)) }),
        ),
      ),
    ),
    h(
      "section",
      {},
      h("h2", { text: t("cursor") }),
      segmented<Settings["cursorStyle"]>(
        t("cursor"),
        [
          ["block", t("block")],
          ["bar", t("bar")],
          ["underline", t("underline")],
        ],
        () => settings.cursorStyle,
        (cursorStyle) => update({ cursorStyle }),
        signal,
      ),
      toggle(t("blink"), () => settings.cursorBlink, (cursorBlink) => update({ cursorBlink })),
    ),
    h(
      "section",
      {},
      h("h2", { text: t("display") }),
      toggle(t("contrast"), () => settings.contrast, (contrast) => update({ contrast })),
      row(
        t("keyBar"),
        segmented<Settings["keyBar"]>(
          t("keyBar"),
          [
            ["auto", t("auto")],
            ["on", t("on")],
            ["off", t("off")],
          ],
          () => settings.keyBar,
          (keyBar) => update({ keyBar }),
          signal,
        ),
      ),
      row(t("language"), languageSelect),
    ),
    h(
      "section",
      { class: "account" },
      h("span", { class: "row-label", text: t("account", { name: account }) }),
      h("button", { class: "plain", text: t("signOut"), attrs: { type: "button" }, on: { click: actions.signOut } }),
    ),
  );
}
