import { CHAINS, type ChainIdType } from '@owlorderfi/shared';
import { useGasIndicator } from '../hooks/useGasIndicator';
import { formatSmart } from '../lib/formatAmount';

/**
 * Live gas + minimum-order chip for the connected mainnet chain.
 *
 *   Polygon gas: 278 gwei · est tx ~$0.023 · Min order ~$12
 *
 * Wires the keeper's break-even math (fee >= gas × SAFETY_MARGIN) onto
 * the user's screen so they understand why a small order on a
 * spike-gas chain won't execute. Color-coded by elevation bucket
 * (green normal, amber elevated, rose spike).
 *
 * Renders nothing on testnets and while the gas price is loading.
 *
 * Mounted globally above the order tabs (inside WalletSummary) since
 * the readout is chain-level, not tab-specific — every order type
 * cares about the same gas-USD math.
 */
export function GasIndicator({ chainId }: { chainId: number }) {
  const info = CHAINS[chainId as ChainIdType];
  const indicator = useGasIndicator(chainId);

  if (!info || info.isTestnet || !indicator) return null;

  const dotColor =
    indicator.level === 'spike'
      ? 'bg-rose-400'
      : indicator.level === 'elevated'
        ? 'bg-amber-400'
        : 'bg-emerald-400';

  const nativeSym = info.nativeCurrency.symbol;
  const tooltip =
    `Live gas on ${info.name}. The Min order figure is the smallest order ` +
    `the keeper will broadcast — below it, the protocol fee (~30 bps) ` +
    `doesn't cover the gas the keeper has to pay, so the order keeps ` +
    `retrying until gas drops or you cancel. Computed from ${nativeSym} ` +
    `estimate $${info.nativeUsdEstimate}, a typical 280k-gas executeOrder ` +
    `tx, and a 1.5× headroom multiplier mirroring the keeper's ` +
    `maxFeePerGas bid (the raw basefee shown above is what RPC reports; ` +
    `the keeper pays ~50% more to absorb base-fee bumps on next blocks).`;

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400"
      title={tooltip}
    >
      <span className={`inline-flex h-2 w-2 rounded-full ${dotColor}`} aria-hidden />
      <span className="font-medium text-slate-300">{info.name} gas</span>
      <span className="font-mono">
        {indicator.gwei < 1 ? indicator.gwei.toFixed(3) : indicator.gwei.toFixed(0)} gwei
      </span>
      <span className="text-slate-500">est tx ~${formatSmart(indicator.txCostUsd)}</span>
      <span>
        Min order{' '}
        <span className="font-mono font-medium text-slate-200">
          ~${formatSmart(indicator.minOrderUsd)}
        </span>
      </span>
    </div>
  );
}
