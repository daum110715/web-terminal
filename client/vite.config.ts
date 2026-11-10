import { defineConfig } from "vite";

export default defineConfig({
  build: {
    // Small fonts would otherwise be inlined as data: URLs, which the page's
    // Content-Security-Policy (font-src 'self') rightly refuses.
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 800,
  },
});
