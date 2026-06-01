import { useGasPrice } from 'wagmi';
import { CHAINS, type ChainIdType } from '@owlorderfi/shared';

/**
 * Live gas-cost indicator data for the connected chain.
 *
 * Computes the break-even minimum order size that the keeper's gate
 * (`fee >= gas × SAFETY_MARGIN`) requires at the chain's CURRENT gas
 * price and the chain's stored `nativeUsdEstimate`. Lets the form show
 * "Polygon gas: 278 gwei · min profitable order ~$30" so users on a
 * spike-gas chain understand why a small order won't execute, without
 * having to read the keeper's break-even-skip logs.
 *
 * Returns null when:
 *   - the chain has no `nativeUsdEstimate` configured (testnets, mostly)
 *   - the gas price hasn't loaded yet
 *
 * NOT a substitute for the keeper's live break-even check; the keeper
 * does an actual Uniswap pool spot query and gas estimate. This is a
 * UI affordance, intentionally cheaper to compute.
 */
export interface GasIndicator {
  /** Current gas price as reported by the RPC, in gwei. */
  gwei: number;
  /** Estimated USD cost of a single executeOrder broadcast. */
  txCostUsd: number;
  /** Smallest order size (in USD) the keeper will broadcast at the
   *  current gas price — below it the protocol fee can't cover gas. */
  minOrderUsd: number;
  /** Loose elevation buckets for color-coding the indicator. */
  level: 'normal' | 'elevated' | 'spike';
}

// Mirror the keeper's safety margin (apps/keeper/src/breakeven.ts) and
// the platform default fee bps (signed by maker per order). Tweaking
// these here ONLY changes the displayed estimate, not actual gating.
const SAFETY_MARGIN = 1.5;
const DEFAULT_FEE_BPS = 30;
// Mirror the executeOrder gas estimate the keeper uses in its
// break-even computation (executor.ts:521). Live `estimateContractGas`
// values land around this on Base + Polygon today.
const TYPICAL_GAS_UNITS = 280_000;
// Mirror the keeper's GAS_HEADROOM_MULT (apps/keeper/src/chain.ts:
// computeGasPricing). The keeper bids maxFeePerGas = baseFee × HEADROOM +
// priority, so what it ACTUALLY pays is ~1.5× the raw basefee that
// useGasPrice returns. Without this multiplier the displayed Min order
// is ~33% too optimistic — a $1.70 order would pass the UI floor and
// then hit the keeper's break-even gate at execution time because the
// real fee budget never covered the headroom-padded gas. Surfaces the
// honest figure instead of one that quietly forces retries.
const GAS_HEADROOM_MULT = 1.5;

/**
 * Coarse elevation thresholds (USD per single execute tx). Tuned so:
 *   - Base @ normal 0.005 gwei → ~$0.003 → "normal"
 *   - Polygon @ normal 30 gwei → ~$0.003 → "normal"
 *   - Polygon @ 100 gwei spike → ~$0.01 → "elevated"
 *   - Polygon @ 300 gwei spike → ~$0.03 → "spike"
 */
const ELEVATED_TX_COST_USD = 0.01;
const SPIKE_TX_COST_USD = 0.03;

export function useGasIndicator(chainId: number): GasIndicator | null {
  const { data: gasPriceWei } = useGasPrice({ chainId });
  const info = CHAINS[chainId as ChainIdType];
  const nativeUsd = info?.nativeUsdEstimate;

  if (!nativeUsd || !gasPriceWei || gasPriceWei <= 0n) return null;

  // Apply the keeper's headroom multiplier so the displayed tx cost
  // reflects what the keeper will actually bid at execution, not the
  // raw basefee. See GAS_HEADROOM_MULT comment above.
  const effectiveGasWei =
    (gasPriceWei * BigInt(Math.round(GAS_HEADROOM_MULT * 100))) / 100n;
  // Number(BigInt × number) — gasPriceWei × TYPICAL_GAS_UNITS fits in
  // a double for all realistic gas-price ranges (max ~1e18 wei).
  const txCostNative = Number(effectiveGasWei * BigInt(TYPICAL_GAS_UNITS)) / 1e18;
  const txCostUsd = txCostNative * nativeUsd;
  // fee >= gas × SAFETY_MARGIN
  // sliceUsd × feeBps/10000 >= txCostUsd × SAFETY_MARGIN
  // sliceUsd >= txCostUsd × SAFETY_MARGIN × 10000 / feeBps
  const minOrderUsd = (txCostUsd * SAFETY_MARGIN * 10_000) / DEFAULT_FEE_BPS;
  const gwei = Number(gasPriceWei) / 1e9;

  const level: GasIndicator['level'] =
    txCostUsd >= SPIKE_TX_COST_USD
      ? 'spike'
      : txCostUsd >= ELEVATED_TX_COST_USD
        ? 'elevated'
        : 'normal';

  return { gwei, txCostUsd, minOrderUsd, level };
}
