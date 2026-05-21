import { getConfig } from './config';
import { log } from './logger';

export type OrderTypeStr = 'LIMIT_BUY' | 'LIMIT_SELL' | 'STOP_LOSS' | 'TAKE_PROFIT';

export interface TokenPricesUSD {
  [addressLower: string]: number;
}

// ─── TTL cache ────────────────────────────────────────────────────
// Many orders share token pairs (e.g. lots of USDC/ETH orders). Without a cache,
// each processOrder() makes its own 1inch call → rate-limit pressure + latency.
// TTL kept short so triggers stay responsive.
interface CacheEntry {
  price: number;
  expiresAt: number;
}
const PRICE_CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 1500; // 1.5s — short enough to keep prices fresh

/** Exposed for tests — clears the in-memory price cache. */
export function _resetPriceCache(): void {
  PRICE_CACHE.clear();
}

async function fetchFromOneInch(
  addresses: string[],
  apiKey: string,
  chainId: number,
): Promise<TokenPricesUSD> {
  const url = `https://api.1inch.dev/price/v1.1/${chainId}?addresses=${addresses.join(',')}&currency=USD`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) {
    throw new Error(`1inch price API ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as Record<string, string>;
  return Object.fromEntries(
    Object.entries(data).map(([addr, price]) => [addr.toLowerCase(), parseFloat(price)]),
  );
}

/**
 * Fetch USD prices for tokens.
 *
 * When ONEINCH_API_KEY is not set, returns mock prices (all = 1 USD).
 * config.ts refuses to start with DRY_RUN=false and no API key, so this
 * fallback only fires in safe dry-run / local-Anvil testing.
 */
export async function getTokenPricesUSD(tokenAddresses: string[]): Promise<TokenPricesUSD> {
  const config = getConfig();
  const lowered = tokenAddresses.map((a) => a.toLowerCase());

  if (!config.ONEINCH_API_KEY) {
    log.warn('[price] ONEINCH_API_KEY unset — returning mock prices (DRY_RUN required to be here)');
    return Object.fromEntries(lowered.map((a) => [a, 1]));
  }

  // Pull from cache where possible
  const now = Date.now();
  const result: TokenPricesUSD = {};
  const stale: string[] = [];
  for (const addr of lowered) {
    const c = PRICE_CACHE.get(addr);
    if (c && c.expiresAt > now) result[addr] = c.price;
    else stale.push(addr);
  }

  if (stale.length === 0) return result;

  // Fetch missing/expired in a single API call
  const fresh = await fetchFromOneInch(stale, config.ONEINCH_API_KEY, config.CHAIN_ID);
  const expiresAt = now + CACHE_TTL_MS;
  for (const [addr, price] of Object.entries(fresh)) {
    PRICE_CACHE.set(addr, { price, expiresAt });
    result[addr] = price;
  }

  return result;
}

/**
 * Compute current price scaled by 1e18, in the units triggerPrice was signed in.
 *
 * Convention (matches @polyorder/shared schema docs):
 *   LIMIT_BUY   → price of tokenOut in tokenIn units  (how much tokenIn per 1 tokenOut)
 *                 = priceTokenOutUSD / priceTokenInUSD * 1e18
 *   Others      → price of tokenIn in tokenOut units  (how much tokenOut per 1 tokenIn)
 *                 = priceTokenInUSD / priceTokenOutUSD * 1e18
 */
export function computeCurrentPriceScaled(
  orderType: OrderTypeStr,
  priceTokenInUSD: number,
  priceTokenOutUSD: number,
): bigint {
  if (priceTokenInUSD <= 0 || priceTokenOutUSD <= 0) {
    throw new Error(`Invalid prices: in=${priceTokenInUSD}, out=${priceTokenOutUSD}`);
  }
  const ratio =
    orderType === 'LIMIT_BUY'
      ? priceTokenOutUSD / priceTokenInUSD
      : priceTokenInUSD / priceTokenOutUSD;
  return BigInt(Math.round(ratio * 1e18));
}

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

const ORDER_TYPE_SET = new Set<OrderTypeStr>(['LIMIT_BUY', 'LIMIT_SELL', 'STOP_LOSS', 'TAKE_PROFIT']);

export function parseOrderType(s: string): OrderTypeStr {
  if (ORDER_TYPE_SET.has(s as OrderTypeStr)) return s as OrderTypeStr;
  throw new Error(`Invalid orderType from DB: '${s}'`);
}
