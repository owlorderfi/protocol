/**
 * Token → USD pricing service for break-even math.
 *
 * Whenever we want to know "how much is this order worth in USD?" or
 * "how much does X gas cost in USD?", we need a real-time USD anchor
 * for each token involved. Hard-coding (ETH=$3000, etc.) drifted ~30%
 * out of date — a problem because the break-even gate then uses an
 * inflated gas-USD cost and skips orders that are actually profitable.
 *
 * Strategy: query the token-vs-USDC Uniswap V3 pool spot for any
 * non-stable token, cache for 5 minutes, fall back to the last known
 * value (or a hard-coded floor) if RPC misbehaves. Reuses the same
 * pool-spot path the keeper already uses for trigger checks, so no
 * new infrastructure or auth-required oracle.
 *
 * Stable shortcut: USDC/USDT/DAI/etc. are pinned at $1.0 without an
 * RPC call. The list mirrors `STABLE_SYMBOLS` in breakeven.ts.
 *
 * Sanity clamp: a fresh quote that differs from the cached value by
 * more than 5× (either direction) is treated as a glitch and ignored,
 * keeping the cached value alive. Flash-crash-shaped spikes shouldn't
 * be propagated into break-even decisions before a human looks.
 */

import { type Address } from 'viem';
import { CHAINS, type ChainIdType } from '@owlorderfi/shared';
import { getSpotPriceScaled } from './uniswap';
import { getErc20Symbol } from './erc20';
import { log } from './logger';

const TTL_MS = 5 * 60_000; // 5 minutes — price moves slowly relative to this
const SANITY_FACTOR = 5; // ignore a fresh quote that's >5× off vs cached

const STABLE_SYMBOLS = new Set([
  'USDC', 'USDT', 'DAI', 'BUSD', 'USDP', 'USDS', 'FRAX', 'LUSD',
]);

interface CacheEntry {
  usd: number;
  ts: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Fallback hard-coded USD floor per chain. Last-resort when the pool query
 * fails AND there's no cached value. Picked conservatively: it's better to
 * over-estimate gas cost (and skip a borderline-profitable order) than to
 * under-estimate and let an attack-shaped order through.
 */
const FALLBACK_NATIVE_USD: Record<number, number> = {
  137: 0.5, // Polygon — POL
  8453: 2500, // Base — ETH conservative (~latest at time of writing 2026-05)
  84532: 2500, // Base Sepolia — same
  421614: 2500, // Arb Sepolia
  11155420: 2500, // Op Sepolia
  31337: 2500, // Anvil
  // 80002: Amoy — no Uniswap, no break-even check
};

/**
 * Look up the USDC address for a chain (the reference stable for spot
 * queries). Pulled from the chain's `uniswapV3.hubTokens[0]` — that slot
 * is conventionally USDC in our registry. Returns null when the chain
 * has no Uniswap V3 deployment (the caller falls back to hard-coded).
 */
function getUsdcAddress(chainId: number): Address | null {
  const v3 = CHAINS[chainId as ChainIdType]?.uniswapV3;
  if (!v3 || !v3.hubTokens || v3.hubTokens.length === 0) return null;
  // hubTokens[0] is USDC by convention (see chains.ts registry comments).
  return v3.hubTokens[0] as Address;
}

/**
 * Look up the wrapped-native address for a chain. Used by getNativeUsdPrice
 * to query the native/USDC pool.
 */
function getWrappedNativeAddress(chainId: number): Address | null {
  return (CHAINS[chainId as ChainIdType]?.wrappedNative ?? null) as Address | null;
}

/**
 * Approximate decimals lookup. USDC is always 6; for the token we want to
 * price the caller supplies the value (already cached elsewhere). Avoids
 * an extra RPC per price-fetch in the hot path.
 */
const USDC_DECIMALS = 6;

/**
 * Inner uncached fetch — quote the token/USDC pool for spot price.
 * Returns price as "USD per 1 token" in human units.
 */
async function fetchTokenUsdViaPool(
  chainId: number,
  tokenAddr: Address,
  tokenDecimals: number,
): Promise<number> {
  const usdcAddr = getUsdcAddress(chainId);
  if (!usdcAddr) throw new Error(`no USDC reference for chain ${chainId}`);
  if (tokenAddr.toLowerCase() === usdcAddr.toLowerCase()) return 1.0;

  // LIMIT_SELL = token → USDC quote. Result is scaled-1e18 representing
  // "USDC out per 1 token in" in canonical (decimal-adjusted) form.
  const spotScaled = await getSpotPriceScaled({
    orderType: 'LIMIT_SELL',
    chainId,
    tokenIn: tokenAddr,
    tokenOut: usdcAddr,
    tokenInDecimals: tokenDecimals,
    tokenOutDecimals: USDC_DECIMALS,
  });
  return Number(spotScaled) / 1e18;
}

/**
 * Apply sanity clamp + cache update.
 */
function commitPrice(key: string, fresh: number, cached: CacheEntry | undefined): number {
  if (cached !== undefined) {
    const ratio = fresh / cached.usd;
    if (ratio > SANITY_FACTOR || ratio < 1 / SANITY_FACTOR) {
      log.warn(
        `[usdPrice] ${key} — fresh=${fresh.toFixed(4)} vs cached=${cached.usd.toFixed(4)} ratio=${ratio.toFixed(2)} — ignoring (>${SANITY_FACTOR}× jump)`,
      );
      return cached.usd;
    }
  }
  cache.set(key, { usd: fresh, ts: Date.now() });
  return fresh;
}

/**
 * USD price for an arbitrary ERC-20 on a given chain. Returns null when
 * the token has no Uniswap V3 / USDC reference pool AND no cached value
 * (caller must decide what to do — typically skip the USD-based check
 * and fall back to a coarser safeguard).
 */
export async function getTokenUsdPrice(
  chainId: number,
  tokenAddr: Address,
  tokenDecimals: number,
): Promise<number | null> {
  const key = `${chainId}:${tokenAddr.toLowerCase()}`;
  const cached = cache.get(key);
  const fresh = cached && Date.now() - cached.ts < TTL_MS;
  if (fresh) return cached!.usd;

  // Stable shortcut — no RPC needed.
  try {
    const symbol = await getErc20Symbol(tokenAddr);
    if (STABLE_SYMBOLS.has(symbol)) {
      cache.set(key, { usd: 1.0, ts: Date.now() });
      return 1.0;
    }
  } catch {
    // Symbol read failed — proceed to pool query.
  }

  try {
    const fresh = await fetchTokenUsdViaPool(chainId, tokenAddr, tokenDecimals);
    return commitPrice(key, fresh, cached);
  } catch (err) {
    if (cached !== undefined) {
      log.warn(
        `[usdPrice] ${key} — pool query failed, serving stale (${Math.round((Date.now() - cached.ts) / 60000)}min old): ${String(err).slice(0, 120)}`,
      );
      return cached.usd;
    }
    log.warn(
      `[usdPrice] ${key} — no cache, no pool: ${String(err).slice(0, 120)}`,
    );
    return null;
  }
}

/**
 * Native-token USD price for a chain (ETH on Base/Arb/Op, POL on Polygon).
 * Wraps getTokenUsdPrice on the chain's wrapped-native address, with a
 * conservative hard-coded fallback if everything fails.
 */
export async function getNativeUsdPrice(chainId: number): Promise<number> {
  const wrapped = getWrappedNativeAddress(chainId);
  const fallback = FALLBACK_NATIVE_USD[chainId] ?? 3000;
  if (!wrapped) return fallback;
  // Native wrapped tokens are always 18 decimals on EVM L1/L2 chains.
  const usd = await getTokenUsdPrice(chainId, wrapped, 18);
  return usd ?? fallback;
}
