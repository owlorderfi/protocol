/**
 * Brand pitch above the app. Two lines, no CTAs — the right column already
 * is the CTA. Visible always (auth'd or not) so the value prop stays
 * front-and-center for returning users too.
 */
export function Hero() {
  return (
    <div className="text-center">
      <h2 className="bg-gradient-to-r from-fuchsia-400 to-cyan-300 bg-clip-text text-3xl font-semibold tracking-tight text-transparent sm:text-4xl">
        Swap with limit orders
      </h2>
      <p className="mt-2 text-base text-slate-400 sm:text-lg">Get a better rate.</p>
    </div>
  );
}
