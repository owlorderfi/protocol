import { useChainId } from 'wagmi';
import { CHAINS, type ChainIdType } from '@owlorderfi/shared';
import { usePoolTwap } from '../hooks/usePoolTwap';

interface Props {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  currentSlippagePct: number;
  onApply: (suggested: number) => void;
  disabled?: boolean;
}

// Slippage suggestion hint surfaced across Limit / DCA / TWAP / Ladder forms.
// Same math everywhere because the failure modes are identical per-fill:
//   - `tooLow`: keeper gate aborts if minOut is within its buffer of the
//     re-quote, so the floor for "won't revert" is σ × 3 + keeperBuffer.
//   - `tooHigh`: sandwich risk depends only on slack between user slippage
//     and natural market move (σ × 3). The keeper buffer is OUR concern, not
//     a sandwich-bot's. So the MEV warning fires at > 3× sigma-only suggestion,
//     ignoring the buffer. Otherwise our buffer would hide real MEV risk.
// usePoolTwap shares its React Query cache key, so calling it here on top of
// the form's own twap usage is a no-op network-wise.
export function SlippageSuggestion({
  tokenIn,
  tokenOut,
  currentSlippagePct,
  onApply,
  disabled = false,
}: Props) {
  const chainId = useChainId();
  const twap = usePoolTwap('LIMIT_SELL', tokenIn, tokenOut);
  const keeperBufferPct =
    (CHAINS[chainId as ChainIdType]?.keeperSlippageBufferBps ?? 50) / 100;

  // Quiet-pool fallback. Direct Uniswap V3 pools on thin pairs
  // (USDC/LINK, USDC/AAVE on Polygon — most LINK and AAVE volume
  // actually routes via WETH in production aggregator paths) report
  // identical observe() samples → σ collapses to 0. Same shape when
  // the API can't fetch (sigma30s === null). Either way, surfacing
  // a blank hint reads as "broken" to a first-time user. Instead,
  // show a sensible default — keeper buffer + a baseline 30 bps —
  // so the user has a starting point and an Apply button. The label
  // makes the fallback honest: we couldn't measure volatility, so
  // this isn't a "real" suggestion, it's a safe default.
  // Coalesce null to 0 so downstream math stays straightforward and TS narrows.
  const sigma = twap.sigma30s ?? 0;
  const isQuietPool = sigma <= 0;
  const sigmaPct = sigma * 100;
  const sigmaSuggestion = Math.max(0.1, Math.min(2, sigmaPct * 3));
  // Baseline 0.30% sits at the median realised σ × 3 for active
  // mainnet pairs we've observed during testing — high enough to clear
  // most quiet-pool fills, low enough to not invite sandwiching.
  const QUIET_POOL_DEFAULT_PCT = 0.3;
  const suggested = isQuietPool
    ? Math.max(QUIET_POOL_DEFAULT_PCT, keeperBufferPct + 0.1)
    : Math.max(0.1, Math.min(2, sigmaPct * 3 + keeperBufferPct));
  const tooLow = currentSlippagePct < suggested * 0.7;
  // tooHigh stays σ-derived — on a quiet pool we have no real ceiling
  // to compare against, so we skip the sandwich warning entirely
  // (would either fire constantly or never; both are noise).
  const tooHigh = !isQuietPool && currentSlippagePct > Math.max(sigmaSuggestion * 3, suggested * 1.2);

  return (
    <div className="mt-2 flex items-center justify-between text-sm">
      <span className={tooLow ? 'text-amber-300' : tooHigh ? 'text-rose-300' : 'text-slate-400'}>
        {tooLow && '⚠ may revert: '}
        {tooHigh && '⚠ sandwich risk: '}
        {isQuietPool ? (
          <>
            Suggested {suggested.toFixed(2)}% (pool quiet — default offered, adjust if needed)
          </>
        ) : (
          <>
            Suggested {suggested.toFixed(2)}% (σ₃₀ₛ × 3 + {keeperBufferPct.toFixed(2)}% keeper buffer)
          </>
        )}
      </span>
      {Math.abs(currentSlippagePct - suggested) > 0.05 && (
        <button
          type="button"
          onClick={() => onApply(parseFloat(suggested.toFixed(2)))}
          disabled={disabled}
          className="rounded border border-slate-700 px-2 py-0.5 text-xs text-cyan-300 hover:bg-slate-800 disabled:opacity-50"
        >
          Apply
        </button>
      )}
    </div>
  );
}
