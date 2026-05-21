import type { OrderType } from '@polyorder/shared';

const PRICE_SCALE = 10n ** 18n;

/**
 * Compute the expected amount of tokenOut at the moment a trigger is hit,
 * given the order's tokenIn amount and triggerPrice (scaled by 1e18).
 *
 * LIMIT_BUY:    triggerPrice = max tokenIn per 1 tokenOut
 *               → expectedOut = amountIn / triggerPrice
 * LIMIT_SELL/STOP_LOSS/TAKE_PROFIT:
 *               triggerPrice = min tokenOut per 1 tokenIn
 *               → expectedOut = amountIn × triggerPrice
 *
 * All values in raw bigint base units. Returns 0n if inputs are invalid
 * (e.g. triggerPrice = 0) — caller decides whether to surface as error.
 */
export function computeExpectedAmountOut(params: {
  orderType: OrderType;
  amountInRaw: bigint;
  triggerPriceScaled: bigint;
  tokenInDecimals: number;
  tokenOutDecimals: number;
}): bigint {
  const { orderType, amountInRaw, triggerPriceScaled, tokenInDecimals, tokenOutDecimals } = params;
  if (amountInRaw <= 0n || triggerPriceScaled <= 0n) return 0n;

  const inScale = 10n ** BigInt(tokenInDecimals);
  const outScale = 10n ** BigInt(tokenOutDecimals);

  if (orderType === 'LIMIT_BUY') {
    return (amountInRaw * PRICE_SCALE * outScale) / (triggerPriceScaled * inScale);
  }
  return (amountInRaw * triggerPriceScaled * outScale) / (PRICE_SCALE * inScale);
}

/**
 * Apply a slippage tolerance (percentage) to an expected output to get the
 * minAmountOut the contract will accept.
 *
 * @example
 * applySlippage(1000n, 0.5) → 995n   // 0.5% off
 * applySlippage(1000n, 1)   → 990n   // 1% off
 */
export function applySlippage(expectedOut: bigint, slippagePct: number): bigint {
  if (slippagePct < 0 || slippagePct >= 100) return 0n;
  // Convert to basis points (1% = 100 bps). Round so 0.05% → 5 bps works.
  const bps = BigInt(Math.round(slippagePct * 100));
  return (expectedOut * (10_000n - bps)) / 10_000n;
}

/**
 * Compute a "smart" trigger price suggestion from recent price history.
 *
 * Strategy:
 * - LIMIT_BUY / STOP_LOSS: target slightly below the recent low (catch a dip)
 * - LIMIT_SELL / TAKE_PROFIT: target slightly above the recent high (catch a bounce)
 *
 * The offset (in basis points off the historic extreme) controls
 * aggressiveness. 5 bps = 0.05% past the extreme = "tight, likely to hit
 * again soon". 50 bps = 0.5% = "patient, bigger discount, lower probability".
 *
 * Returns null when history has fewer than 2 samples (no fluctuation observed
 * yet) — caller can fall back to a static offset from spot.
 */
export function suggestTriggerPrice(params: {
  orderType: OrderType;
  current: bigint | null;
  min: bigint | null;
  max: bigint | null;
  samples: number;
  /** Basis points past the recent extreme (default 5 = 0.05%). */
  offsetBps?: number;
}): bigint | null {
  const { orderType, current, min, max, samples, offsetBps = 5 } = params;
  // Need real history; otherwise return null and caller can fall back.
  if (samples < 2 || min === null || max === null || current === null) return null;

  const bps = BigInt(offsetBps);
  const SCALE = 10_000n;

  if (orderType === 'LIMIT_BUY' || orderType === 'STOP_LOSS') {
    // Slightly below the recent low — wait for a dip
    return (min * (SCALE - bps)) / SCALE;
  }
  // LIMIT_SELL / TAKE_PROFIT — slightly above the recent high
  return (max * (SCALE + bps)) / SCALE;
}

/**
 * Static fallback when there's no price history yet. Offsets the current
 * spot price by `offsetBps` in the favorable direction for the order type.
 */
export function staticTriggerSuggestion(
  orderType: OrderType,
  current: bigint,
  offsetBps = 10, // 0.10% — typical 1-minute volatility for major pairs
): bigint {
  const bps = BigInt(offsetBps);
  const SCALE = 10_000n;
  if (orderType === 'LIMIT_BUY' || orderType === 'STOP_LOSS') {
    return (current * (SCALE - bps)) / SCALE;
  }
  return (current * (SCALE + bps)) / SCALE;
}

// ─── Smart trigger v2 (volatility + trend aware) ─────────────────────

/** Standard normal CDF via Abramowitz & Stegun (max error ~1.5e-7). */
function normalCdf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * ax);
  const y = 1.0 - (((((a5 * t + a4) * t + a3) * t + a2) * t) + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1.0 + sign * y);
}

/**
 * Approximate probability that a k-sigma barrier is touched within the
 * sampling window. Two-tailed first-passage estimate under Brownian motion.
 *
 *   k=0.5 → ~62%
 *   k=1   → ~32%
 *   k=2   → ~5%
 *   k=3   → ~0.3%
 */
function hitProbabilityForK(k: number): number {
  return 2 * (1 - normalCdf(k));
}

export type Aggressiveness = 'tight' | 'balanced' | 'patient';

/** k multiplier per aggressiveness. Higher k → bigger discount, lower fill chance. */
const K_BY_AGGRO: Record<Aggressiveness, number> = {
  tight: 1.0,
  balanced: 2.0,
  patient: 3.0,
};

export interface SmartSuggestion {
  priceScaled: bigint;
  /** Estimated probability of fill within the next ~30s, as a fraction 0-1. */
  probability: number;
  /** k×σ offset actually applied (after trend nudge), as a fraction. */
  effectiveOffset: number;
}

/**
 * Suggest a trigger price using realized volatility + trend awareness.
 *
 *  - LIMIT_BUY/STOP_LOSS: target = current × (1 - k × σ)
 *  - LIMIT_SELL/TAKE_PROFIT: target = current × (1 + k × σ)
 *
 * Trend nudge:
 *  - Counter-trend (e.g. BUY in a downtrend): pull target closer to spot
 *    so the order doesn't trail a falling price forever.
 *  - With-trend: keep / increase patience — the price is moving toward
 *    you anyway, you can afford a bigger discount.
 */
export function smartSuggestTrigger(params: {
  orderType: OrderType;
  current: bigint;
  sigma30s: number;
  trendPct: number; // % change between window endpoints
  aggressiveness: Aggressiveness;
}): SmartSuggestion {
  const { orderType, current, sigma30s, trendPct, aggressiveness } = params;
  const k = K_BY_AGGRO[aggressiveness];

  // Wants price to drop: LIMIT_BUY / STOP_LOSS
  const wantsLower = orderType === 'LIMIT_BUY' || orderType === 'STOP_LOSS';

  // Counter-trend = market moves AWAY from where we want price to go.
  // For BUY (wants lower), counter-trend is uptrend (trendPct > 0).
  // For SELL (wants higher), counter-trend is downtrend (trendPct < 0).
  const counterTrend = wantsLower ? trendPct > 0.05 : trendPct < -0.05;
  const withTrend = wantsLower ? trendPct < -0.05 : trendPct > 0.05;

  // Reduce k when counter-trend (target closer to spot, higher chance to fill).
  // Increase k slightly when with-trend (patience pays off, price moves to us).
  let kEffective = k;
  if (counterTrend) kEffective = Math.max(0.5, k * 0.5);
  else if (withTrend) kEffective = k * 1.1;

  const offset = kEffective * sigma30s;
  const currentNum = Number(current) / 1e18;
  const targetNum = wantsLower ? currentNum * (1 - offset) : currentNum * (1 + offset);
  const priceScaled = BigInt(Math.round(targetNum * 1e18));

  return {
    priceScaled,
    probability: hitProbabilityForK(kEffective),
    effectiveOffset: offset,
  };
}

/**
 * Inverse of computeExpectedAmountOut: given a Uniswap quote (amountIn → amountOut),
 * derive the current pool price scaled by 1e18 in the trigger-price convention.
 * Mirror of keeper's uniswap.ts:getUniswapQuote — kept in sync manually.
 */
export function computePriceFromQuote(params: {
  orderType: OrderType;
  amountInRaw: bigint;
  amountOutRaw: bigint;
  tokenInDecimals: number;
  tokenOutDecimals: number;
}): bigint {
  const { orderType, amountInRaw, amountOutRaw, tokenInDecimals, tokenOutDecimals } = params;
  if (amountInRaw <= 0n || amountOutRaw <= 0n) return 0n;

  const inScale = 10n ** BigInt(tokenInDecimals);
  const outScale = 10n ** BigInt(tokenOutDecimals);

  if (orderType === 'LIMIT_BUY') {
    return (amountInRaw * PRICE_SCALE * outScale) / (amountOutRaw * inScale);
  }
  return (amountOutRaw * PRICE_SCALE * inScale) / (amountInRaw * outScale);
}
