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
