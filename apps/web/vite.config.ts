import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  // The SPA is served under /app (the static landing owns /). `base` rewrites
  // every asset URL to /app/…, and `outDir` nests the build under dist/app so
  // the deploy tree is: dist/index.html (landing) + dist/app/* (SPA). Caddy
  // serves /app* from dist-prod/app and / from dist-prod. See
  // scripts/build-landing.mjs + ops/ops/Caddyfile.
  base: '/app/',
  build: {
    outDir: 'dist/app',
    emptyOutDir: true,
  },
  plugins: [react()],
  resolve: {
    alias: {
      // Import @owlorderfi/shared straight from its TypeScript source instead of
      // the CommonJS dist/. Avoids ESM/CJS interop issues with re-exports.
      '@owlorderfi/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    host: true, // bind to all interfaces so it's reachable over LAN
    // Dev only: proxy /api → the local dev API so the browser talks ONLY to
    // the Vite origin. Removes the need for a second (flaky) VSCode
    // port-forward for the API and sidesteps CORS — Vite runs on the server,
    // so it reaches the dev API locally. Inert in prod builds (no dev server).
    // Set VITE_DEV_API_PROXY to override the target port.
    proxy: {
      '/api': {
        target: process.env.VITE_DEV_API_PROXY ?? 'http://localhost:4101',
        changeOrigin: true,
      },
    },
  },
});
