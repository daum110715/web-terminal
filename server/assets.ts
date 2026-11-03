// The built web client is small, so it is held in memory with precompressed variants.
import fs from "node:fs";
import path from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};

interface Asset {
  type: string;
  body: Buffer;
  br?: Buffer;
  gzip?: Buffer;
  immutable: boolean;
}

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export class Assets {
  private files = new Map<string, Asset>();
  private readonly dist: string;

  constructor(dist: string) {
    this.dist = dist;
    this.reload();
  }

  /** Swaps in a fresh build; the previous files keep serving until it is read. */
  reload() {
    const files = new Map<string, Asset>();
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.set("/" + path.relative(this.dist, full).split(path.sep).join("/"), this.read(full));
      }
    };
    if (fs.existsSync(this.dist)) walk(this.dist);
    this.files = files;
  }

  private read(file: string): Asset {
    const type = TYPES[path.extname(file)] ?? "application/octet-stream";
    const body = fs.readFileSync(file);
    const compressible = /text|javascript|json|svg|manifest/.test(type) && body.length > 1024;
    return {
      type,
      body,
      // Vite fingerprints everything under assets/, so it can be cached forever.
      immutable: path.relative(this.dist, file).startsWith(`assets${path.sep}`),
      ...(compressible && {
        br: brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
        gzip: gzipSync(body, { level: 9 }),
      }),
    };
  }

  get ready() {
    return this.files.has("/index.html");
  }

  /** Serves a file, falling back to the app shell for client routes. */
  response(route: string, acceptEncoding = ""): Response {
    const asset = this.files.get(route) ?? (route.startsWith("/assets/") ? undefined : this.files.get("/index.html"));
    if (!asset) return new Response("Not found", { status: 404 });
    const headers = new Headers({
      "Content-Type": asset.type,
      "Cache-Control": asset.immutable ? "public, max-age=31536000, immutable" : "no-cache",
      Vary: "Accept-Encoding",
    });
    if (asset.type.startsWith("text/html")) headers.set("Content-Security-Policy", CSP);
    let body = asset.body;
    if (asset.br && /\bbr\b/.test(acceptEncoding)) {
      body = asset.br;
      headers.set("Content-Encoding", "br");
    } else if (asset.gzip && /\bgzip\b/.test(acceptEncoding)) {
      body = asset.gzip;
      headers.set("Content-Encoding", "gzip");
    }
    return new Response(new Uint8Array(body), { headers });
  }
}
