// Small DOM helpers shared by the client's modules.

export type Props = {
  class?: string;
  text?: string;
  attrs?: Record<string, string>;
  on?: Record<string, EventListener>;
};

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Node[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [name, value] of Object.entries(props.attrs ?? {})) node.setAttribute(name, value);
  for (const [event, listener] of Object.entries(props.on ?? {})) node.addEventListener(event, listener);
  node.append(...children);
  return node;
}

const PATHS = {
  plus: "M8 3v10M3 8h10",
  close: "M4 4l8 8M12 4l-8 8",
  sliders: "M2 5h6M12 5h2M2 11h2M8 11h6M10 3v4M6 9v4",
} as const;

/** A 16px line icon that takes the color of the text around it. */
export function icon(name: keyof typeof PATHS): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", PATHS[name]);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linecap", "round");
  svg.append(path);
  return svg;
}

export function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

export function recall(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
