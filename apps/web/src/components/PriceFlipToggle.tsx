import { usePriceFlip } from '../lib/PriceFlipContext';

/**
 * Single global ⇄ toggle. Flips the displayed direction of every price in
 * the app (forms + order tables) at once. Purely a view preference — does
 * not change any order or what gets signed. Default shows the numéraire
 * orientation ("1 WETH = X USDC"); toggled shows the inverse everywhere.
 */
export function PriceFlipToggle() {
  const { flipped, toggleFlipped } = usePriceFlip();
  return (
    <button
      type="button"
      onClick={toggleFlipped}
      title="Flip how all prices are shown (display only — does not change any order)"
      className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition ${
        flipped
          ? 'border-cyan-700/50 bg-cyan-950/40 text-cyan-200'
          : 'border-slate-700 bg-slate-900/40 text-slate-300 hover:border-slate-600'
      }`}
    >
      <span aria-hidden>⇄</span>
      Flip prices
    </button>
  );
}
