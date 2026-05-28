import { usePriceConvention } from '../lib/PriceConventionContext';

/**
 * Global price-display convention switch. Sits outside the tab strip so
 * it governs every form + the orders table at once. The transient
 * per-pair ⇄ flip (DisplayFlipContext) still works on top for one-off
 * inversions.
 */
export function PriceConventionToggle() {
  const { convention, setConvention } = usePriceConvention();

  const options: Array<{ value: 'market' | 'swap'; label: string; title: string }> = [
    {
      value: 'market',
      label: 'Market',
      title: 'Price the asset in the more fundamental unit (USD > BTC > ETH). "1 WETH = 3000 USDC" regardless of swap direction.',
    },
    {
      value: 'swap',
      label: 'Swap',
      title: 'Pure trade direction: "1 tokenIn = X tokenOut". Flips with the swap.',
    },
  ];

  return (
    <div className="flex items-center gap-2 text-xs text-slate-400">
      <span className="uppercase tracking-wider">Price view</span>
      <div className="inline-flex overflow-hidden rounded-lg border border-slate-700">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setConvention(opt.value)}
            title={opt.title}
            className={`px-3 py-1 font-medium transition ${
              convention === opt.value
                ? 'bg-cyan-500/20 text-cyan-200'
                : 'bg-slate-950 text-slate-400 hover:bg-slate-800'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
