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
