import type { OrderType } from '../schemas/order.js';

const PRICE_SCALE = 10n ** 18n;

/**
 * Derive a maker-facing price (×1e18) from a realized/quoted swap pair
 * (amountIn → amountOut), in the SAME order-type-dependent direction the
 * rest of the stack uses, so it's directly comparable to `triggerPrice`:
 *
 *   - LIMIT_SELL / TAKE_PROFIT → tokenOut per tokenIn   (canonical)
 *   - LIMIT_BUY  / STOP_LOSS   → tokenIn  per tokenOut   (inverse)
 *
 * This is the AMOUNT-dependent price (it bakes in the trade's slippage),
 * the counterpart to [[spot-price-decoder]]'s amount-INDEPENDENT spot. Use
 * this for "what did this fill actually cost?" (realized fill price) and
 * the keeper's execution-time quote, NOT for the trigger/display price.
 *
 * Pure bigint math, in shared, so the keeper (execution quote) and the web
 * (realized fill-price display) decode identically and can't drift — they
 * previously held two hand-copied versions of this formula.
 */
export function priceScaledFromAmounts(params: {
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

  // BUY-side stores the inverse (tokenIn per tokenOut); everything else is
  // canonical (tokenOut per tokenIn). Matches spotPriceScaledFromSqrtX96.
  if (orderType === 'LIMIT_BUY' || orderType === 'STOP_LOSS') {
    return (amountInRaw * PRICE_SCALE * outScale) / (amountOutRaw * inScale);
  }
  return (amountOutRaw * PRICE_SCALE * inScale) / (amountInRaw * outScale);
}
