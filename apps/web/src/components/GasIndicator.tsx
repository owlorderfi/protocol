import { CHAINS, type ChainIdType } from '@owlorderfi/shared';
import { useGasIndicator } from '../hooks/useGasIndicator';
import { formatSmart } from '../lib/formatAmount';

/**
 * Single-line live gas readout for the connected mainnet chain:
 *
 *   Gas: 278 gwei · min profitable order ~$30
 *
 * Wires the keeper's break-even math (fee >= gas × SAFETY_MARGIN) onto
 * the user's screen so they understand why a small order on a
 * spike-gas chain won't execute. Color-coded by elevation bucket:
 * green normal, amber elevated, rose spike.
 *
 * Renders nothing when the chain isn't a mainnet or has no native-USD
 * estimate configured (testnets typically skip).
 */
export function GasIndicator({ chainId }: { chainId: number }) {
  const info = CHAINS[chainId as ChainIdType];
  const indicator = useGasIndicator(chainId);

  // Skip rendering on testnets (no economic gating there) and while
  // the gas price is still loading.
  if (!info || info.isTestnet || !indicator) return null;

  const palette =
    indicator.level === 'spike'
      ? 'border-rose-700/40 bg-rose-900/15 text-rose-200'
      : indicator.level === 'elevated'
        ? 'border-amber-700/40 bg-amber-900/15 text-amber-200'
        : 'border-emerald-700/40 bg-emerald-900/15 text-emerald-200';

  const nativeSym = info.nativeCurrency.symbol;
  const tooltip =
    `Live gas on ${info.name}. The Min order figure is the smallest order ` +
    `the keeper will broadcast at the current gas price — below it, the ` +
    `protocol fee (~30 bps) doesn't cover the gas the keeper has to pay, ` +
    `so the order keeps retrying until gas drops or you cancel. Computed ` +
    `from ${nativeSym} estimate $${info.nativeUsdEstimate} and a typical ` +
    `280k-gas executeOrder tx.`;

  return (
    <div
      className={`mt-2 flex items-center justify-between rounded border px-3 py-2 text-xs ${palette}`}
      title={tooltip}
    >
      <span>
        <span className="font-mono">{indicator.gwei < 1 ? indicator.gwei.toFixed(3) : indicator.gwei.toFixed(0)} gwei</span>
        <span className="text-slate-400"> · est tx ~${formatSmart(indicator.txCostUsd)}</span>
      </span>
      <span>
        Min order{' '}
        <span className="font-mono font-medium">
          ~${formatSmart(indicator.minOrderUsd)}
        </span>
      </span>
    </div>
  );
}
