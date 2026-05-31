/**
 * Token → USD pricing service for break-even math.
 *
 * Whenever we want to know "how much is this order worth in USD?" or
 * "how much does X gas cost in USD?", we need a real-time USD anchor
 * for each token involved. Hard-coding (ETH=$3000, etc.) drifted ~30%
 * out of date — a problem because the break-even gate then uses an
 * inflated gas-USD cost and skips orders that are actually profitable.
 *
 * Strategy: query the token-vs-USDC Uniswap V3 pool **TWAP** (5-min
 * cumulative tick via `observe()`) for any non-stable token, cache for
 * 5 minutes, fall back to the last known value (or a hard-coded floor)
 * if RPC misbehaves. Reuses the keeper's existing pool discovery (the
 * deepest direct pool) but reads `observe()` instead of `slot0` so a
 * single-block manipulation can't shift the anchor. Falls back to
 * slot0 only when `observe()` reverts (pool too newly initialized to
 * have 5 minutes of history).
 *
 * Stable allowlist: the canonical chain stable (`usdReferenceToken`)
 * and a small set of well-known stable addresses are pinned at $1.0
 * without an RPC call. Address-based (not symbol-based) so a malicious
 * token can't game the shortcut by self-reporting `symbol() == "USDC"`.
 *
 * Sanity bands:
 *   - On a refresh against an existing cached value, a fresh quote that
 *     differs by >5× is treated as a glitch and ignored.
 *   - On a first-ever fetch with no cache, the fresh quote must land
 *     in [fallback / 5, fallback × 5] for known-native tokens, or
 *     [1e-9, 1e9] USD/token for arbitrary tokens. Anything outside is
 *     treated as oracle corruption and rejected.
 */

import { type Address } from 'viem';
import { CHAINS, type ChainIdType, UNISWAP_V3_POOL_ABI } from '@owlorderfi/shared';
import { getDeepestSpotPool } from './uniswap';
import { createClients } from './chain';
import { log } from './logger';

const TTL_MS = 5 * 60_000; // 5 minutes — price moves slowly relative to this
const SANITY_FACTOR = 5; // ignore a fresh quote that's >5× off vs cached
const TWAP_WINDOW_SEC = 300; // 5-minute TWAP — flash-loan resistant

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
 *
 * Also seeds the first-fetch sanity band: a fresh native quote must land
 * within [fallback / SANITY_FACTOR, fallback × SANITY_FACTOR] when no
 * cache exists yet, or it's rejected as oracle corruption.
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
 * Address-based stable allowlist. Lower-cased. Used to short-circuit
 * the pool query for well-known $1-pegged tokens without an RPC round
 * trip. Strictly address-based (NOT symbol-based) so an arbitrary token
 * can't game the shortcut by self-reporting `symbol() == "USDC"`.
 *
 * The chain's `usdReferenceToken` is implicitly included via getUsdReferenceToken
 * — it doesn't need to appear here as well.
 */
const STABLE_ADDRESSES = new Set<string>([
  // Base mainnet
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC (Circle native)
  '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', // USDT
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', // DAI (DSR-bridged)
  // Polygon
  '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', // USDC (Circle native)
  '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', // USDT
  '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063', // DAI
  // Testnet USDCs (Circle)
  '0x036cbd53842c5426634e7929541ec2318f3dcf7e', // Base Sepolia USDC
  '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d', // Arb Sepolia USDC
  '0x5fd84259d66cd46123540766be93dfe6d43130d7', // Op Sepolia USDC
]);

/**
 * Look up the canonical USD reference token (USDC) for a chain. Pulled from
 * the explicit `usdReferenceToken` field in the shared registry — was
 * previously derived from `hubTokens[0]` and silently broke on chains that
 * order it `[WETH, USDC]` instead of `[USDC, WETH]` (every OP-stack chain
 * + Base mainnet). Returns null when the chain has no V3 deployment or
 * no usdReferenceToken set (the caller falls back to hard-coded).
 */
function getUsdReferenceToken(chainId: number): Address | null {
  const v3 = CHAINS[chainId as ChainIdType]?.uniswapV3;
  return (v3?.usdReferenceToken ?? null) as Address | null;
}

/**
 * Look up the wrapped-native address for a chain. Used by getNativeUsdPrice
 * to query the native/USDC pool.
 */
function getWrappedNativeAddress(chainId: number): Address | null {
  return (CHAINS[chainId as ChainIdType]?.wrappedNative ?? null) as Address | null;
}

const USDC_DECIMALS = 6;

/**
 * Detect whether a token is a known stable (canonical chain USDC or one
 * of the well-known stable addresses). Address-based — not gameable by
 * symbol spoofing.
 */
function isKnownStable(chainId: number, tokenAddr: Address): boolean {
  const lower = tokenAddr.toLowerCase();
  if (STABLE_ADDRESSES.has(lower)) return true;
  const ref = getUsdReferenceToken(chainId);
  if (ref && ref.toLowerCase() === lower) return true;
  return false;
}

/**
 * Convert a Uniswap V3 tick to a human-units price ratio `tokenOut per
 * tokenIn`, scaled ×1e18. JS doubles give ~15-digit precision; for the
 * tick range of real pools (-200k..+200k) that's ~1e-9 relative error,
 * well below the 5% SANITY_FACTOR our break-even math tolerates.
 *
 * Pool tick is in token1/token0 raw-units frame. We orient via
 * `tokenInIsToken0` and re-scale for decimals.
 */
function tickToCanonicalScaled(
  tick: number,
  tokenInIsToken0: boolean,
  decIn: number,
  decOut: number,
): bigint {
  // Pool frame: price (token1 / token0) in raw units = 1.0001^tick
  // Canonical = tokenOut / tokenIn in HUMAN units
  //   if tokenIn = token0: canonical_human = (token1/token0)_raw × 10^(decIn - decOut)
  //   if tokenIn = token1: canonical_human = (token0/token1)_raw × 10^(decIn - decOut)
  //                                        = 1.0001^(-tick) × 10^(decIn - decOut)
  const orientedTick = tokenInIsToken0 ? tick : -tick;
  const ratio = Math.pow(1.0001, orientedTick) * Math.pow(10, decIn - decOut);
  if (!isFinite(ratio) || ratio <= 0) return 0n;
  return BigInt(Math.floor(ratio * 1e18));
}

/**
 * Inner uncached fetch — TWAP-quote the token/USDC pool.
 * Returns price as "USD per 1 token" in human units.
 * Throws on missing pool / observe() revert with no slot0 fallback.
 */
async function fetchTokenUsdViaPool(
  chainId: number,
  tokenAddr: Address,
  tokenDecimals: number,
): Promise<number> {
  const usdAddr = getUsdReferenceToken(chainId);
  if (!usdAddr) throw new Error(`no USD reference for chain ${chainId}`);
  if (tokenAddr.toLowerCase() === usdAddr.toLowerCase()) return 1.0;

  const pool = await getDeepestSpotPool(chainId, tokenAddr, usdAddr);
  if (!pool) throw new Error(`no Uniswap V3 pool for ${tokenAddr} / USDC on chain ${chainId}`);

  const { publicClient } = createClients();

  // Try 5-min TWAP first (flash-loan resistant). If the pool's observation
  // cardinality is too low (newly initialized), observe() reverts — fall
  // back to slot0 with a warn log.
  let tick: number;
  try {
    const [tickCumulatives] = await publicClient.readContract({
      address: pool,
      abi: UNISWAP_V3_POOL_ABI,
      functionName: 'observe',
      args: [[TWAP_WINDOW_SEC, 0]],
    });
    // tickCumulatives is [int56 at -300s, int56 at now]
    const delta = tickCumulatives[1] - tickCumulatives[0];
    // Floor toward negative infinity (BigInt division truncates toward 0,
    // so for negative deltas we adjust by 1 if there's a remainder — keeps
    // the tick semantically right for the "mean" interpretation).
    const window = BigInt(TWAP_WINDOW_SEC);
    let meanTick = delta / window;
    if (delta < 0n && delta % window !== 0n) meanTick -= 1n;
    tick = Number(meanTick);
  } catch {
    log.warn(
      `[usdPrice] observe() reverted on pool ${pool} (low cardinality?) — falling back to slot0`,
    );
    const slot0 = await publicClient.readContract({
      address: pool,
      abi: UNISWAP_V3_POOL_ABI,
      functionName: 'slot0',
    });
    tick = Number(slot0[1]); // slot0.tick
  }

  // Compute canonical "USDC out per 1 token in" in human units, scaled 1e18.
  const tokenInIsToken0 = tokenAddr.toLowerCase() < usdAddr.toLowerCase();
  const canonicalScaled = tickToCanonicalScaled(
    tick,
    tokenInIsToken0,
    tokenDecimals,
    USDC_DECIMALS,
  );
  if (canonicalScaled <= 0n) throw new Error(`tick-derived price <= 0 (tick=${tick})`);
  return Number(canonicalScaled) / 1e18;
}

/**
 * Apply sanity clamp + cache update.
 *   - With a prior cached entry: refresh accepted only within ±SANITY_FACTOR×.
 *   - With no prior entry (first-ever fetch): the fresh value is checked
 *     against `firstFetchBand`. If outside, rejected (returns null), forcing
 *     the caller to fall back to its own conservative default. Prevents an
 *     attacker who manipulates a pool BEFORE any honest fetch from poisoning
 *     the cache with an extreme value.
 */
function commitPrice(
  key: string,
  fresh: number,
  cached: CacheEntry | undefined,
  firstFetchBand: [number, number],
): number | null {
  if (cached !== undefined) {
    const ratio = fresh / cached.usd;
    if (ratio > SANITY_FACTOR || ratio < 1 / SANITY_FACTOR) {
      log.warn(
        `[usdPrice] ${key} — fresh=${fresh.toFixed(4)} vs cached=${cached.usd.toFixed(4)} ratio=${ratio.toFixed(2)} — ignoring (>${SANITY_FACTOR}× jump)`,
      );
      return cached.usd;
    }
  } else {
    const [lo, hi] = firstFetchBand;
    if (!isFinite(fresh) || fresh < lo || fresh > hi) {
      log.warn(
        `[usdPrice] ${key} — first-fetch ${fresh} outside sanity band [${lo}, ${hi}] — rejecting (likely oracle manipulation)`,
      );
      return null;
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

  // Stable address shortcut — no RPC needed.
  if (isKnownStable(chainId, tokenAddr)) {
    cache.set(key, { usd: 1.0, ts: Date.now() });
    return 1.0;
  }

  // First-fetch sanity band: for the chain's wrapped-native token,
  // require the fresh quote near FALLBACK_NATIVE_USD. For any other
  // token, fall back to a coarse "obviously not zero, obviously not
  // a trillion" range.
  const wrapped = getWrappedNativeAddress(chainId);
  const isNative = wrapped && wrapped.toLowerCase() === tokenAddr.toLowerCase();
  const band: [number, number] = isNative
    ? (() => {
        const fb = FALLBACK_NATIVE_USD[chainId] ?? 3000;
        return [fb / SANITY_FACTOR, fb * SANITY_FACTOR];
      })()
    : [1e-9, 1e9];

  try {
    const freshUsd = await fetchTokenUsdViaPool(chainId, tokenAddr, tokenDecimals);
    return commitPrice(key, freshUsd, cached, band);
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
