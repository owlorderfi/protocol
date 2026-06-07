import type { OrderType } from '@owlorderfi/shared';

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
 * Probability that a k-sigma barrier is touched within the window, including
 * drift. Uses the standard first-passage approximation for Brownian motion
 * with drift over a single window where σ is already the per-window stddev.
 *
 * Sign convention: positive `driftToward` means price is moving toward the
 * barrier (favorable for the order). Negative = moving away.
 *
 *   k=0.5, no drift → ~62%
 *   k=2,   no drift → ~5%
 *   k=3,   drift toward at 2×σ → ~95%+ (drift overshoots barrier in expectation)
 *   k=1,   drift away at 1×σ → near-0% (market running from us)
 */
function hitProbabilityWithDrift(k: number, driftToward: number, sigma: number): number {
  if (sigma <= 0) return 0;
  // Effective barrier distance in σ units, shifted by how much drift covers it.
  // Drift toward target reduces the effective barrier; drift away inflates it.
  const effectiveK = k - driftToward / sigma;
  const p = 2 * (1 - normalCdf(effectiveK));
  return Math.min(1, Math.max(0, p));
}

export type Aggressiveness = 'tight' | 'balanced' | 'patient';

/** k multiplier per aggressiveness. Higher k → bigger discount, lower fill chance. */
const K_BY_AGGRO: Record<Aggressiveness, number> = {
  tight: 1.0,
  balanced: 2.0,
  patient: 3.0,
};

/** Time horizon (in seconds) over which we estimate fill probability. */
export type Horizon = 30 | 300 | 3600;

/**
 * Scale a 30s realized vol to a horizon T using √T scaling (i.i.d. BM
 * approximation). For very long T the assumption breaks down but it's the
 * standard linear-time-volatility model and serves as a reasonable estimate.
 */
function sigmaAtHorizon(sigma30s: number, horizonSec: Horizon): number {
  return sigma30s * Math.sqrt(horizonSec / 30);
}

/**
 * Drift projected to horizon T using a trend measured over a window W.
 *
 * Match-window principle: we ONLY project trend within the window it was
 * measured over. Extrapolating a 5-min trend to 1h or a 1h trend to 1d is
 * fortune-telling — at best 30-40% predictive on autocorrelation; at
 * worst dangerously over-confident on noise.
 *
 * So:
 *   - horizon ≤ window: linear projection (drift = trendPct × T/W)
 *   - horizon > window: drift = 0 (we don't pretend to know)
 *
 * Caller picks the right trend for the horizon:
 *   - horizon 30s/5m → 5m trend (window=300)
 *   - horizon 1h    → 1h trend  (window=3600), or fall back to 5m and get 0
 */
function driftAtHorizon(
  trendPct: number,
  trendWindowSec: number,
  horizonSec: Horizon,
): number {
  if (trendWindowSec <= 0 || horizonSec > trendWindowSec) return 0;
  return (trendPct / 100) * (horizonSec / trendWindowSec);
}

export interface SmartSuggestion {
  priceScaled: bigint;
  /** Estimated probability of fill within the chosen horizon, fraction 0-1. */
  probability: number;
  /** Total fractional distance from spot to target (`(spot - target) / spot`). */
  effectiveOffset: number;
}

/**
 * Suggest a trigger price using realized volatility + drift-aware math.
 *
 * The user picks k via the aggressiveness pill (1 / 2 / 3 σ effective barrier
 * past the drift-projected price). We honour that exactly:
 *
 *   target = current × (1 - (k × σ_T + driftToward))    for BUY/STOP_LOSS
 *   target = current × (1 + (k × σ_T + driftToward))    for SELL/TAKE_PROFIT
 *
 * `driftToward` is the fractional move the market is expected to make toward
 * the barrier in T seconds; favorable trend adds to the offset (you get a
 * bigger discount AND still need k σ of noise to hit), unfavorable trend
 * subtracts. No heuristic ×0.5 / ×1.1 nudges — math is exact.
 */
export function smartSuggestTrigger(params: {
  orderType: OrderType;
  current: bigint;
  sigma30s: number;
  /** Trend measured at the window matching `horizonSec` (caller selects). */
  trendPct: number;
  /** Window over which `trendPct` was measured. driftAtHorizon zeroes the
   *  drift if `horizonSec > trendWindowSec` (no extrapolation). */
  trendWindowSec: number;
  aggressiveness: Aggressiveness;
  horizonSec: Horizon;
}): SmartSuggestion {
  const { orderType, current, sigma30s, trendPct, trendWindowSec, aggressiveness, horizonSec } = params;
  const k = K_BY_AGGRO[aggressiveness];

  const sigmaT = sigmaAtHorizon(sigma30s, horizonSec);
  const driftT = driftAtHorizon(trendPct, trendWindowSec, horizonSec);

  const wantsLower = orderType === 'LIMIT_BUY' || orderType === 'STOP_LOSS';
  const driftToward = wantsLower ? -driftT : driftT;

  // Drift-aware offset: user wants k×σ_T effective barrier past where the
  // market would naturally drift to in T seconds. So total offset from spot
  // is the random k×σ buffer PLUS the drift coverage.
  let offset = k * sigmaT + driftToward;
  // Clamp to sane range so a wild trend extrapolation can't produce
  // a 5,000% suggestion or a negative offset.
  offset = Math.max(0.0001, Math.min(0.5, offset));

  const currentNum = Number(current) / 1e18;
  const targetNum = wantsLower ? currentNum * (1 - offset) : currentNum * (1 + offset);
  const priceScaled = BigInt(Math.round(targetNum * 1e18));

  return {
    priceScaled,
    probability: hitProbabilityWithDrift(k, driftToward, sigmaT),
    effectiveOffset: offset,
  };
}

/**
 * Live fill-probability estimate for an arbitrary trigger price (whatever the
 * user has typed or picked). Same drift-aware Brownian motion model as
 * smartSuggestTrigger, but takes the trigger as input instead of producing
 * one. Recompute on every twap refresh + on every keystroke in the form.
 */
export function computeFillProbability(params: {
  orderType: OrderType;
  currentScaled: bigint;
  triggerPriceHuman: number;
  sigma30s: number;
  trendPct: number;
  trendWindowSec: number;
  horizonSec: Horizon;
}): { probability: number; offsetPct: number } | null {
  const { orderType, currentScaled, triggerPriceHuman, sigma30s, trendPct, trendWindowSec, horizonSec } = params;
  if (sigma30s <= 0 || triggerPriceHuman <= 0) return null;

  const currentNum = Number(currentScaled) / 1e18;
  if (currentNum <= 0) return null;

  const wantsLower = orderType === 'LIMIT_BUY' || orderType === 'STOP_LOSS';
  const delta = wantsLower
    ? (currentNum - triggerPriceHuman) / currentNum
    : (triggerPriceHuman - currentNum) / currentNum;

  if (delta <= 0) return { probability: 1, offsetPct: 0 };

  const sigmaT = sigmaAtHorizon(sigma30s, horizonSec);
  const driftT = driftAtHorizon(trendPct, trendWindowSec, horizonSec);
  const driftToward = wantsLower ? -driftT : driftT;
  const k = delta / sigmaT;

  return {
    probability: hitProbabilityWithDrift(k, driftToward, sigmaT),
    offsetPct: delta * 100,
  };
}
