import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
// The account and the session key live here; override it to keep them elsewhere.
const data = process.env.WEB_TERMINAL_DATA ? path.resolve(process.env.WEB_TERMINAL_DATA) : path.join(root, "var");

export const config = {
  root,
  // Listens on loopback only; a reverse proxy with TLS sits in front of it.
  port: Number(process.env.WEB_TERMINAL_PORT ?? 3120),
  paths: {
    secrets: path.join(data, "secrets"),
    dist: path.join(root, "client", "dist"),
  },
  limits: {
    terminals: Math.max(1, Number(process.env.WEB_TERMINAL_MAX ?? 8) || 8),
  },
} as const;
