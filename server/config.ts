import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const state = (...parts: string[]) => path.join(root, "var", ...parts);

export const config = {
  root,
  // Listens on loopback only; a reverse proxy with TLS sits in front of it.
  port: Number(process.env.WEB_TERMINAL_PORT ?? 3120),
  paths: {
    secrets: state("secrets"),
    dist: path.join(root, "client", "dist"),
  },
  limits: {
    terminals: 4,
  },
} as const;
