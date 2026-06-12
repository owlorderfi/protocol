/**
 * Order pricing math — canonical, shared by the web (deriving minAmountOut
 * for the user to sign) and the API (re-deriving it to enforce a bound at
 * creation). Keeping one implementation prevents the web and the server
 * from disagreeing about what a given triggerPrice + slippage implies.
 *
 * All amounts are raw bigint base units; triggerPrice is human price scaled
 * by 1e18 (tokenOut per tokenIn for sells, tokenIn per tokenOut for buys).
 */

import type { OrderType } from '../schemas/index.js';

const PRICE_SCALE = 10n ** 18n;

/**
 * Hard ceiling on how far below the trigger-implied output a signed
 * minAmountOut may sit (i.e. the maximum slippage tolerance). 10% = 1000
 * bps. The on-chain floor (minPriceScaled, derived from minAmountOut) is
 * the ONLY price protection the contract enforces — maxSlippageBps is
 * signed but never read on-chain — so an over-loose minAmountOut lets the
 * keeper fill legally far below the price the maker thinks they set. Both
 * the web slippage input and the API creation guard clamp to this.
 *
 * 10% leaves room for genuinely thin tokens (a feature use-case) to fill
 * while still rejecting the absurd 30–50% "limit" that isn't really a
 * limit. Tighten if fill data shows it's never needed.
 */
export const MAX_SLIPPAGE_BPS = 1000n;

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
 * Lowest minAmountOut acceptable for a given expected output — i.e.
 * expectedOut minus MAX_SLIPPAGE_BPS. A signed minAmountOut below this is
 * rejected at order creation. Returns 0n for a non-positive expectedOut so
 * callers skip the bound when the trigger is unset/invalid (other
 * validation handles that case).
 */
export function minAmountOutFloor(expectedOut: bigint): bigint {
  if (expectedOut <= 0n) return 0n;
  return (expectedOut * (10_000n - MAX_SLIPPAGE_BPS)) / 10_000n;
}
