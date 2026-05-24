import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
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
  },
});
