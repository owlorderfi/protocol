import type { OrderType } from '../schemas/order.js';

const PRICE_SCALE = 10n ** 18n;

/**
 * Decode a Uniswap V3 pool `slot0.sqrtPriceX96` into a maker-facing price,
 * scaled ×1e18, in the SAME order-type-dependent direction the rest of the
 * stack uses (so it's directly comparable to the signed `triggerPrice`):
 *
 *   - LIMIT_SELL / TAKE_PROFIT → tokenOut per tokenIn   (canonical)
 *   - LIMIT_BUY  / STOP_LOSS   → tokenIn  per tokenOut   (inverse)
 *
 * This is the pool's MARGINAL (spot) price — independent of trade size, so
 * it sidesteps the "what probe amount?" problem entirely (a fixed unit is
 * fine for USDC but a 1-WETH or 1-WBTC probe slips badly on thin pools).
 * Trade-size slippage is a separate concern, enforced at execution via the
 * keeper's slippage gate + the signed minAmountOut.
 *
 * Uniswap orders a pool's tokens by address: token0 < token1. `slot0`'s
 * price is token1 per token0 (in raw units). The caller passes
 * `tokenInIsToken0` (= tokenIn address < tokenOut address) so we can map
 * the pool's token0/token1 frame onto the order's in/out frame.
 *
 * Pure bigint math — lives in shared so the keeper (trigger check) and the
 * API (display quote) decode identically and can never drift.
 */
export function spotPriceScaledFromSqrtX96(params: {
  sqrtPriceX96: bigint;
  tokenInIsToken0: boolean;
  tokenInDecimals: number;
  tokenOutDecimals: number;
  orderType: OrderType;
}): bigint {
  const { sqrtPriceX96, tokenInIsToken0, tokenInDecimals, tokenOutDecimals, orderType } = params;
  if (sqrtPriceX96 <= 0n) return 0n;

  const dec0 = tokenInIsToken0 ? tokenInDecimals : tokenOutDecimals;
  const dec1 = tokenInIsToken0 ? tokenOutDecimals : tokenInDecimals;

  // price (token1 per token0), human, ×1e18:
  //   = (sqrtPriceX96^2 / 2^192) × 10^dec0 / 10^dec1 × 1e18
  const numerator = sqrtPriceX96 * sqrtPriceX96 * PRICE_SCALE * 10n ** BigInt(dec0);
  const denominator = (1n << 192n) * 10n ** BigInt(dec1);
  const price1per0Scaled = numerator / denominator;
  if (price1per0Scaled <= 0n) return 0n;

  // Canonical = tokenOut per tokenIn.
  //   tokenIn = token0 → canonical = token1/token0 = price1per0
  //   tokenIn = token1 → canonical = token0/token1 = 1 / price1per0
  const canonicalScaled = tokenInIsToken0
    ? price1per0Scaled
    : (PRICE_SCALE * PRICE_SCALE) / price1per0Scaled;
  if (canonicalScaled <= 0n) return 0n;

  // Orient to the order-type direction (BUY/STOP store the inverse).
  if (orderType === 'LIMIT_BUY' || orderType === 'STOP_LOSS') {
    return (PRICE_SCALE * PRICE_SCALE) / canonicalScaled;
  }
  return canonicalScaled;
}
