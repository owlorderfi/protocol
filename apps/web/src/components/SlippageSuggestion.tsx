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

  if (twap.sigma30s === null || twap.sigma30s <= 0) return null;

  const sigmaPct = twap.sigma30s * 100;
  const keeperBufferPct =
    (CHAINS[chainId as ChainIdType]?.keeperSlippageBufferBps ?? 50) / 100;
  const sigmaSuggestion = Math.max(0.1, Math.min(2, sigmaPct * 3));
  const suggested = Math.max(0.1, Math.min(2, sigmaPct * 3 + keeperBufferPct));
  const tooLow = currentSlippagePct < suggested * 0.7;
  // Floor the high-threshold at 1.2× the keeper-safe suggestion so pressing
  // Apply never trips it; manual widening past +20% still gets flagged.
  const tooHigh = currentSlippagePct > Math.max(sigmaSuggestion * 3, suggested * 1.2);

  return (
    <div className="mt-2 flex items-center justify-between text-sm">
      <span className={tooLow ? 'text-amber-300' : tooHigh ? 'text-rose-300' : 'text-slate-400'}>
        {tooLow && '⚠ may revert: '}
        {tooHigh && '⚠ sandwich risk: '}
        Suggested {suggested.toFixed(2)}% (σ₃₀ₛ × 3 + {keeperBufferPct.toFixed(2)}% keeper buffer)
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
