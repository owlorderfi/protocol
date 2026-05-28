import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicClient, http, type Address } from 'viem';
import {
  CHAINS,
  requireUniswapV3,
  getFeeTiers,
  isSupportedChainId,
  spotPriceScaledFromSqrtX96,
  UNISWAP_V3_FACTORY_ABI,
  UNISWAP_V3_POOL_ABI,
  type ChainIdType,
  type OrderType,
} from '@owlorderfi/shared';

const ZERO = '0x0000000000000000000000000000000000000000';

export interface QuoteResult {
  /** Spot price, tokenOut/tokenIn (or inverse for LIMIT_BUY) × 1e18, as a string. */
  priceScaled: string;
}

export interface TwapResult {
  /** Most recent 30s sub-interval TWAP, ×1e18, as a string (null if no pool). */
  current: string | null;
  /** Lowest sub-interval TWAP over the 5 min window. */
  min: string | null;
  /** Highest sub-interval TWAP. */
  max: string | null;
  /** Realized 30s volatility — stddev of log returns. Fraction (0.001 = 0.10%). */
  sigma30s: number | null;
  /** TWAP_30s minus TWAP_5min, as a percentage. Positive = uptrend. */
  trendPct: number | null;
  trend: 'up' | 'down' | 'sideways' | null;
  /** Number of sub-intervals (10 once loaded, 0 when unavailable). */
  samples: number;
}

export const EMPTY_TWAP: TwapResult = {
  current: null,
  min: null,
  max: null,
  sigma30s: null,
  trendPct: null,
  trend: null,
  samples: 0,
};

// TWAP smart-suggest config (volatility + trend for the order forms).
// Fixed 500 tier on purpose: it's the canonical liquid pool with a real
// observation buffer on our testnets; thinner tiers frequently have
// observationCardinality=1 and revert on observe(). 11 timestamps over
// 5 min → 10 sub-interval TWAPs at 30s each.
const TWAP_FEE = 500;
const SECONDS_AGOS = [300, 270, 240, 210, 180, 150, 120, 90, 60, 30, 0] as const;
const SUB_INTERVAL_SEC = 30;

/** Decode a TWAP tick to a maker-facing price ×1e18, same orientation as
 *  spotPriceScaledFromSqrtX96 (BUY/STOP store the inverse). Float math is
 *  fine here — this feeds a statistical σ/trend estimate, not money. */
function twapTickToPriceScaled(
  tick: number,
  tokenInIsToken0: boolean,
  tokenInDecimals: number,
  tokenOutDecimals: number,
  orderType: OrderType,
): bigint {
  const rawPrice = Math.pow(1.0001, tick);
  const dec0 = tokenInIsToken0 ? tokenInDecimals : tokenOutDecimals;
  const dec1 = tokenInIsToken0 ? tokenOutDecimals : tokenInDecimals;
  const humanRatioT1PerT0 = rawPrice * Math.pow(10, dec0 - dec1);
  const tokenOutPerTokenIn = tokenInIsToken0 ? humanRatioT1PerT0 : 1 / humanRatioT1PerT0;
  const oriented =
    orderType === 'LIMIT_BUY' || orderType === 'STOP_LOSS'
      ? 1 / tokenOutPerTokenIn
      : tokenOutPerTokenIn;
  return BigInt(Math.round(oriented * 1e18));
}

/** Population stddev of log returns. */
function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

/**
 * Server-side SPOT market price. Centralizes what used to be a per-browser
 * direct RPC call: with N users viewing the same pair, the browser path
 * fired N quotes; here a short-TTL cache collapses them to ~one RPC round
 * per (pair, orderType) per window, served to everyone. RPC uses the
 * server's configured endpoint (Infura primary) — reliable + off the
 * public-RPC flakiness path, and the key is NOT exposed in the web bundle.
 *
 * Uses the pool's `slot0` MARGINAL price — amount-independent. This is the
 * deliberate split the operator wanted: SPOT drives the trigger/display
 * (a 1-unit probe is fine for USDC but a 1-WETH/1-WBTC probe slips badly
 * on thin pools), while trade-size SLIPPAGE is a separate concern enforced
 * at execution (keeper slippage gate + signed minAmountOut). The keeper
 * decodes via the SAME shared helper so its trigger check and this display
 * price can never drift.
 *
 * Direct pools only (slot0 is per-pool). For a pair with no direct pool
 * (hub-route-only) this returns no price; all current pairs have a direct
 * pool. Picks the deepest (max-liquidity) live tier for the spot.
 */
@Injectable()
export class MarketService {
  // Direct pool addresses per pair. TTL'd (NOT permanent) so a deeper-tier
  // pool deployed later is picked up, and an empty result re-checks
  // instead of being cached forever.
  private readonly POOL_SET_TTL_MS = 5 * 60_000;
  private readonly livePools = new Map<string, { pools: Address[]; ts: number }>();
  // Short-TTL spot cache. Stores the in-flight Promise so concurrent
  // requests in the same window dedupe onto ONE RPC round. Failures evict
  // immediately so the next request retries.
  private readonly quoteCache = new Map<string, { promise: Promise<QuoteResult>; ts: number }>();
  private readonly QUOTE_TTL_MS = 8_000;
  // TWAP read is one observe() call; same promise-dedup + short-TTL pattern
  // as the spot quote so N users on a pair share ~one RPC round. The
  // fee-500 pool address is cached separately on the slower POOL_SET_TTL.
  private readonly twapCache = new Map<string, { promise: Promise<TwapResult>; ts: number }>();
  private readonly TWAP_TTL_MS = 10_000;
  private readonly twapPools = new Map<string, { pool: Address | null; ts: number }>();
  private lastSweepAt = 0;

  constructor(private readonly config: ConfigService) {}

  getQuote(params: {
    chainId: number;
    tokenIn: Address;
    tokenOut: Address;
    orderType: OrderType;
    tokenInDecimals: number;
    tokenOutDecimals: number;
  }): Promise<QuoteResult> {
    const { chainId, tokenIn, tokenOut, orderType } = params;
    this.maybeSweep();
    // No amount in the key — spot is amount-independent, so every caller on
    // a (pair, direction) shares one cached RPC round. Decimals ARE in the
    // key: they scale the price, so a caller passing different decimals must
    // not read a result computed for another's decimals.
    const key = this.cacheKey(params);
    const hit = this.quoteCache.get(key);
    if (hit && Date.now() - hit.ts < this.QUOTE_TTL_MS) return hit.promise;

    const promise = this.computeSpot(params);
    this.quoteCache.set(key, { promise, ts: Date.now() });
    promise.catch(() => {
      if (this.quoteCache.get(key)?.promise === promise) this.quoteCache.delete(key);
    });
    return promise;
  }

  getTwap(params: {
    chainId: number;
    tokenIn: Address;
    tokenOut: Address;
    orderType: OrderType;
    tokenInDecimals: number;
    tokenOutDecimals: number;
  }): Promise<TwapResult> {
    const { chainId, tokenIn, tokenOut, orderType } = params;
    this.maybeSweep();
    const key = this.cacheKey(params);
    const hit = this.twapCache.get(key);
    if (hit && Date.now() - hit.ts < this.TWAP_TTL_MS) return hit.promise;

    const promise = this.computeTwap(params);
    this.twapCache.set(key, { promise, ts: Date.now() });
    promise.catch(() => {
      if (this.twapCache.get(key)?.promise === promise) this.twapCache.delete(key);
    });
    return promise;
  }

  // Cache key for both quote + twap. Decimals included (they scale price).
  private cacheKey(p: {
    chainId: number;
    tokenIn: Address;
    tokenOut: Address;
    orderType: OrderType;
    tokenInDecimals: number;
    tokenOutDecimals: number;
  }): string {
    return (
      `${p.chainId}|${p.tokenIn.toLowerCase()}|${p.tokenOut.toLowerCase()}|${p.orderType}` +
      `|${p.tokenInDecimals}|${p.tokenOutDecimals}`
    );
  }

  // Sweep expired entries at most once per TTL window so the maps stay
  // bounded to ~distinct keys queried within a window. The pool-set maps
  // (livePools/twapPools) are swept too — without this an attacker spraying
  // junk token-pair addresses grows them unboundedly (the per-pair RPC is
  // already cached, but the entries must still expire).
  private maybeSweep(): void {
    const now = Date.now();
    if (now - this.lastSweepAt < this.QUOTE_TTL_MS) return;
    this.lastSweepAt = now;
    for (const [k, v] of this.quoteCache) {
      if (now - v.ts >= this.QUOTE_TTL_MS) this.quoteCache.delete(k);
    }
    for (const [k, v] of this.twapCache) {
      if (now - v.ts >= this.TWAP_TTL_MS) this.twapCache.delete(k);
    }
    for (const [k, v] of this.livePools) {
      if (now - v.ts >= this.POOL_SET_TTL_MS) this.livePools.delete(k);
    }
    for (const [k, v] of this.twapPools) {
      if (now - v.ts >= this.POOL_SET_TTL_MS) this.twapPools.delete(k);
    }
  }

  private async computeSpot(params: {
    chainId: number;
    tokenIn: Address;
    tokenOut: Address;
    orderType: OrderType;
    tokenInDecimals: number;
    tokenOutDecimals: number;
  }): Promise<QuoteResult> {
    const { chainId, tokenIn, tokenOut, orderType, tokenInDecimals, tokenOutDecimals } = params;
    const client = this.makeClient(chainId);
    const deployment = requireUniswapV3(chainId as ChainIdType);

    const pairKey = this.pairKey(chainId, tokenIn, tokenOut);
    const cached = this.livePools.get(pairKey);
    let pools: Address[];
    if (cached && Date.now() - cached.ts < this.POOL_SET_TTL_MS) {
      pools = cached.pools;
    } else {
      const feeTiers = getFeeTiers(deployment);
      const addrs = await Promise.all(
        feeTiers.map((fee) =>
          client.readContract({
            address: deployment.factory,
            abi: UNISWAP_V3_FACTORY_ABI,
            functionName: 'getPool',
            args: [tokenIn, tokenOut, fee],
          }),
        ),
      );
      pools = addrs.filter((a): a is Address => a !== ZERO);
      this.livePools.set(pairKey, { pools, ts: Date.now() });
    }
    if (pools.length === 0) throw new Error('No direct pool');

    // Read slot0 + liquidity for each live pool; pick the deepest for the
    // most representative spot (thin tiers can sit at a stale tick).
    const reads = await Promise.all(
      pools.map(async (pool) => {
        try {
          const [slot0, liquidity] = await Promise.all([
            client.readContract({ address: pool, abi: UNISWAP_V3_POOL_ABI, functionName: 'slot0' }),
            client.readContract({ address: pool, abi: UNISWAP_V3_POOL_ABI, functionName: 'liquidity' }),
          ]);
          return { sqrtPriceX96: slot0[0], liquidity };
        } catch {
          return null;
        }
      }),
    );
    let best: { sqrtPriceX96: bigint; liquidity: bigint } | null = null;
    for (const r of reads) {
      if (r && r.sqrtPriceX96 > 0n && (best === null || r.liquidity > best.liquidity)) best = r;
    }
    if (best === null) throw new Error('No pool liquidity');

    const priceScaled = spotPriceScaledFromSqrtX96({
      sqrtPriceX96: best.sqrtPriceX96,
      tokenInIsToken0: tokenIn.toLowerCase() < tokenOut.toLowerCase(),
      tokenInDecimals,
      tokenOutDecimals,
      orderType,
    });
    if (priceScaled <= 0n) throw new Error('Spot price unavailable');

    return { priceScaled: priceScaled.toString() };
  }

  private async computeTwap(params: {
    chainId: number;
    tokenIn: Address;
    tokenOut: Address;
    orderType: OrderType;
    tokenInDecimals: number;
    tokenOutDecimals: number;
  }): Promise<TwapResult> {
    const { chainId, tokenIn, tokenOut, orderType, tokenInDecimals, tokenOutDecimals } = params;
    const client = this.makeClient(chainId);
    const deployment = requireUniswapV3(chainId as ChainIdType);

    // Resolve the fee-500 pool address (cached on the slower pool-set TTL).
    const poolKey = this.pairKey(chainId, tokenIn, tokenOut);
    const cachedPool = this.twapPools.get(poolKey);
    let pool: Address | null;
    if (cachedPool && Date.now() - cachedPool.ts < this.POOL_SET_TTL_MS) {
      pool = cachedPool.pool;
    } else {
      const addr = await client.readContract({
        address: deployment.factory,
        abi: UNISWAP_V3_FACTORY_ABI,
        functionName: 'getPool',
        args: [tokenIn, tokenOut, TWAP_FEE],
      });
      pool = addr === ZERO ? null : addr;
      this.twapPools.set(poolKey, { pool, ts: Date.now() });
    }
    if (!pool) throw new Error('No TWAP pool at fee 500');

    const [tickCumulatives] = await client.readContract({
      address: pool,
      abi: UNISWAP_V3_POOL_ABI,
      functionName: 'observe',
      args: [SECONDS_AGOS as unknown as readonly number[]],
    });

    // 10 sub-interval TWAP ticks from 11 cumulative values.
    const ticks: number[] = [];
    for (let i = 0; i < tickCumulatives.length - 1; i++) {
      const delta = tickCumulatives[i + 1]! - tickCumulatives[i]!;
      ticks.push(Number(delta / BigInt(SUB_INTERVAL_SEC)));
    }
    if (ticks.length < 2) throw new Error('Insufficient TWAP observations');

    const tokenInIsToken0 = tokenIn.toLowerCase() < tokenOut.toLowerCase();
    const prices = ticks.map((t) =>
      twapTickToPriceScaled(t, tokenInIsToken0, tokenInDecimals, tokenOutDecimals, orderType),
    );

    let min = prices[0]!;
    let max = prices[0]!;
    for (const p of prices) {
      if (p < min) min = p;
      if (p > max) max = p;
    }
    const current = prices[prices.length - 1]!;

    const numeric = prices.map((p) => Number(p) / 1e18);
    const returns: number[] = [];
    for (let i = 1; i < numeric.length; i++) returns.push(Math.log(numeric[i]! / numeric[i - 1]!));
    const sigma30s = stddev(returns);

    const early = numeric[0]!;
    const late = numeric[numeric.length - 1]!;
    const trendPct = ((late - early) / early) * 100;
    let trend: 'up' | 'down' | 'sideways' = 'sideways';
    if (trendPct > 0.05) trend = 'up';
    else if (trendPct < -0.05) trend = 'down';

    return {
      current: current.toString(),
      min: min.toString(),
      max: max.toString(),
      sigma30s,
      trendPct,
      trend,
      samples: ticks.length,
    };
  }

  // Created per request — viem's generic types around cached clients
  // fight TypeScript (see ContractStateService for the same note).
  private makeClient(chainId: number) {
    if (!isSupportedChainId(chainId)) throw new Error(`Unsupported chainId ${chainId}`);
    const rpc = this.resolveRpc(chainId);
    const chain = CHAINS[chainId as ChainIdType];
    return createPublicClient({
      chain: {
        id: chain.id,
        name: chain.name,
        nativeCurrency: chain.nativeCurrency,
        rpcUrls: { default: { http: [rpc] } },
      } as never,
      transport: http(rpc, { retryCount: 1, timeout: 5_000 }),
    });
  }

  // First configured URL of CHAIN_<id>_RPC (Infura primary). Comma-list
  // tolerated; we take the first endpoint.
  private resolveRpc(chainId: number): string {
    const perChain = this.config.get<string>(`CHAIN_${chainId}_RPC`);
    const first = perChain?.split(',')[0]?.trim();
    if (first) return first;
    const info = CHAINS[chainId as ChainIdType];
    const fallback = info?.rpcUrls?.[0];
    if (fallback) return fallback;
    throw new Error(`No RPC configured for chain ${chainId}`);
  }

  private pairKey(chainId: number, a: Address, b: Address): string {
    const lo = a.toLowerCase();
    const hi = b.toLowerCase();
    return `${chainId}:${lo < hi ? `${lo}-${hi}` : `${hi}-${lo}`}`;
  }
}
