/**
 * Dedicated Tailwind config for the static landing page.
 *
 * Separate from tailwind.config.js (the app's PostCSS build) on purpose:
 * scanning only landing/index.html keeps landing.css tiny — it ships zero
 * of the app's component classes. Stock theme; the gradients/colours used
 * are all default palette tokens.
 *
 * CommonJS (.cjs) so the standalone `tailwindcss` CLI loads it without the
 * ESM/jiti dance triggered by the package's "type": "module".
 *
 * @type {import('tailwindcss').Config}
 */
module.exports = {
  content: ['./landing/*.html'],
  theme: { extend: {} },
  plugins: [],
};
