#!/usr/bin/env node
/**
 * Build the static landing page into dist/ alongside the SPA.
 *
 * Runs AFTER `vite build` (which writes the SPA to dist/app via the
 * base:'/app/' + outDir config). This step adds the landing at the deploy
 * root so the final tree is:
 *
 *   dist/
 *     index.html        ← landing (this script)
 *     landing.css       ← Tailwind compiled for landing/index.html only
 *     favicon.ico, …    ← copied to root so the landing (served at /) finds them
 *     app/index.html    ← SPA (vite)
 *     app/assets/…       ← SPA bundles (vite)
 *
 * deploy-web.sh then rsyncs the whole dist/ → dist-prod/ (--delete mirror),
 * and Caddy serves /app* from dist-prod/app and / from dist-prod.
 *
 * Zero JS ships with the landing — only HTML + the compiled CSS.
 */
import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const webRoot = dirname(fileURLToPath(import.meta.url));
const dist = join(webRoot, 'dist');
const run = (cmd) => execSync(cmd, { cwd: webRoot, stdio: 'inherit' });

mkdirSync(dist, { recursive: true });

// 1. Compile a minimal stylesheet from landing/index.html's classes only.
run(
  'pnpm exec tailwindcss -c tailwind.landing.config.cjs ' +
    '-i landing/landing.css -o dist/landing.css --minify',
);

// 2. Static HTML pages at the deploy root (landing + legal docs).
//    Served by Caddy's catch-all with `try_files {path} {path}.html /index.html`
//    so /terms resolves to terms.html (extension-less URLs).
for (const page of ['index.html', 'terms.html', 'privacy.html']) {
  copyFileSync(join(webRoot, 'landing', page), join(dist, page));
}

// 3. Favicons at the root too — the landing references /favicon.ico etc.,
//    and the SPA shell (served from /app/) also uses absolute /favicon.ico.
//    Vite copies public/ into dist/app; this mirrors them to the root.
for (const f of [
  'favicon.ico',
  'icon-16.png',
  'icon-32.png',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
]) {
  copyFileSync(join(webRoot, 'public', f), join(dist, f));
}

console.log('landing: built dist/index.html + dist/landing.css + favicons');
