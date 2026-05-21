export type OrderTypeStr = 'LIMIT_BUY' | 'LIMIT_SELL' | 'STOP_LOSS' | 'TAKE_PROFIT';

const ORDER_TYPE_SET = new Set<OrderTypeStr>(['LIMIT_BUY', 'LIMIT_SELL', 'STOP_LOSS', 'TAKE_PROFIT']);

export function parseOrderType(s: string): OrderTypeStr {
  if (ORDER_TYPE_SET.has(s as OrderTypeStr)) return s as OrderTypeStr;
  throw new Error(`Invalid orderType from DB: '${s}'`);
}

/**
 * Check whether a current pool price meets the trigger condition for the order.
 * Both prices are scaled by 1e18 in "tokenIn per 1 tokenOut" units —
 * see uniswap.ts:getUniswapQuote for the convention.
 */
export function isTriggerConditionMet(
  orderType: OrderTypeStr,
  currentPriceScaled: bigint,
  triggerPrice: bigint,
): boolean {
  switch (orderType) {
    case 'LIMIT_BUY':
      return currentPriceScaled <= triggerPrice;
    case 'LIMIT_SELL':
      return currentPriceScaled >= triggerPrice;
    case 'STOP_LOSS':
      return currentPriceScaled <= triggerPrice;
    case 'TAKE_PROFIT':
      return currentPriceScaled >= triggerPrice;
  }
}
