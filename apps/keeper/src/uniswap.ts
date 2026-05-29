import { encodeFunctionData, encodePacked, type Address, type Hex } from 'viem';
import {
  getFeeTiers,
  requireUniswapV3,
  spotPriceScaledFromSqrtX96,
  UNISWAP_V3_FACTORY_ABI,
  UNISWAP_V3_POOL_ABI,
  type ChainIdType,
} from '@owlorderfi/shared';
import { createClients } from './chain';
import type { OrderTypeStr } from './price';

// All chain-specific addresses (QuoterV2, SwapRouter02, hub tokens,
// inner hop fee) live in @owlorderfi/shared/constants/chains.ts. Pull
// them with `requireUniswapV3(chainId)` at the call sites below.

const QUOTER_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'view',
    inputs: [
      {
        type: 'tuple',
        name: 'params',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'quoteExactInput',
    stateMutability: 'view',
    inputs: [
      { name: 'path', type: 'bytes' },
      { name: 'amountIn', type: 'uint256' },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96AfterList', type: 'uint160[]' },
      { name: 'initializedTicksCrossedList', type: 'uint32[]' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

const SWAP_ROUTER_ABI = [
  {
    type: 'function',
    name: 'exactInputSingle',
    stateMutability: 'payable',
    inputs: [
      {
        type: 'tuple',
        name: 'params',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'exactInput',
    stateMutability: 'payable',
    inputs: [
      {
        type: 'tuple',
        name: 'params',
        components: [
          { name: 'path', type: 'bytes' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const;

export type Route =
  | { kind: 'direct'; fee: number }
  | { kind: 'multihop'; path: Hex; tokens: Address[]; fees: number[] };

export interface Quote {
  amountOut: bigint;
  route: Route;
}

// ─── Route cache ────────────────────────────────────────────────────
// The winning route (which fee tier / hub path) for a pair is stable over
// short windows. Re-running full discovery — one eth_call per fee tier +
// one per hub, every quote — is the keeper's single biggest RPC cost.
// Cache the winner per (chain, tokenIn, tokenOut) for a TTL; on a hit we
// quote ONLY that route (1 call instead of ~6). If the cached route stops
// returning liquidity (pool drained / a better tier appeared) or the TTL
// lapses, we fall back to full discovery and re-cache.
// 5 min TTL. Longer = fewer full re-discovery bursts (each fires one
// eth_call per fee tier + per hub, and tiers/hubs with no pool revert —
// e.g. ~31% of Arbitrum-sepolia probes "fail" this way). Staleness risk
// is bounded: a cached route that drains to 0 liquidity is invalidated
// immediately on the next quote, and the slippage-gate re-quote at
// execution always reflects current pool state regardless of TTL.
const ROUTE_TTL_MS = 5 * 60_000;
const routeCache = new Map<string, { route: Route; ts: number }>();

function routeCacheKey(chainId: number, tokenIn: Address, tokenOut: Address): string {
  return `${chainId}|${tokenIn.toLowerCase()}|${tokenOut.toLowerCase()}`;
}

// Negative cache: fee tiers + hub tokens that discovery already probed and
// found to have no usable route. Those probes hit QuoterV2 and REVERT when
// no pool exists — the bulk of the keeper's "failed" eth_calls on testnet,
// where most tiers/hubs are empty (~12-31% of probes). Skipping known-dead
// candidates on the next full discovery cuts those reverts. TTL'd (same
// cadence as the route cache) so a newly-deployed pool is eventually
// re-probed; a transiently-illiquid pool just gets skipped until the TTL
// lapses, which is harmless — the winning route is cached separately and
// the slippage gate re-quotes live at execution.
const DEAD_CANDIDATE_TTL_MS = ROUTE_TTL_MS;
const deadCandidateCache = new Map<string, { fees: Set<number>; hubs: Set<string>; ts: number }>();

function getDeadCandidates(key: string): { fees: Set<number>; hubs: Set<string> } {
  const hit = deadCandidateCache.get(key);
  if (hit && Date.now() - hit.ts < DEAD_CANDIDATE_TTL_MS) return hit;
  const fresh = { fees: new Set<number>(), hubs: new Set<string>(), ts: Date.now() };
  deadCandidateCache.set(key, fresh);
  return fresh;
}

/** Test hook — clears the route + dead-candidate caches between cases. */
export function _resetRouteCache(): void {
  routeCache.clear();
  deadCandidateCache.clear();
}

/**
 * Quote a single known route. Returns amountOut, or 0n if the route
 * reverted / has no liquidity (caller treats 0 as "cached route stale").
 */
async function quoteRoute(
  route: Route,
  quoterV2: Address,
  params: { tokenIn: Address; tokenOut: Address; amountInRaw: bigint },
): Promise<bigint> {
  const { publicClient } = createClients();
  try {
    if (route.kind === 'direct') {
      const r = await publicClient.readContract({
        address: quoterV2,
        abi: QUOTER_ABI,
        functionName: 'quoteExactInputSingle',
        args: [
          {
            tokenIn: params.tokenIn,
            tokenOut: params.tokenOut,
            amountIn: params.amountInRaw,
            fee: route.fee,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });
      return r[0];
    }
    const r = await publicClient.readContract({
      address: quoterV2,
      abi: QUOTER_ABI,
      functionName: 'quoteExactInput',
      args: [route.path, params.amountInRaw],
    });
    return r[0];
  } catch {
    return 0n;
  }
}

/**
 * Encode a Uniswap V3 path:
 *   token0 (20B) | fee0 (3B) | token1 (20B) | fee1 (3B) | ... | tokenN (20B)
 */
function encodePath(tokens: Address[], fees: number[]): Hex {
  if (tokens.length !== fees.length + 1) {
    throw new Error(`Path tokens (${tokens.length}) must equal fees (${fees.length}) + 1`);
  }
  const types: ('address' | 'uint24')[] = [];
  const values: (Address | number)[] = [];
  for (let i = 0; i < tokens.length; i++) {
    types.push('address');
    values.push(tokens[i]);
    if (i < fees.length) {
      types.push('uint24');
      values.push(fees[i]);
    }
  }
  return encodePacked(types, values);
}

// ─── Spot price (slot0) ─────────────────────────────────────────────
// The trigger check uses the pool's MARGINAL price (amount-independent),
// NOT an amount-quote — a fixed probe is fine for USDC but slips badly
// for a 1-WETH/1-WBTC quote on thin pools. Trade-size slippage is checked
// separately at execution (slippage gate + signed minAmountOut). Decoded
// via the shared helper so this matches the API's display price exactly.
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

// Deepest live direct pool per pair. TTL'd (NOT permanent) so a deeper-tier
// pool deployed later gets picked up, and an empty result re-checks instead
// of throwing forever. Same 5-min cadence as poolCache.ts.
//
// We cache the CHOSEN pool address, not just the live set: the deepest pool
// is stable over minutes, so between evaluations we read only its slot0 (1
// eth_call/poll) instead of slot0+liquidity across every live tier (2×N).
// That was the keeper's biggest steady RPC cost AND a source of "failed"
// eth_calls — a created-but-uninitialized secondary tier reverts slot0 on
// every poll. Re-evaluation (full getPool + slot0/liquidity scan) happens
// only on TTL lapse or if the cached pool's slot0 goes bad.
const POOL_SET_TTL_MS = 5 * 60_000;
const bestSpotPoolCache = new Map<string, { pool: Address; ts: number }>();

/** Read a pool's slot0 sqrtPriceX96; null if it reverts / is uninitialized. */
async function readSqrtPrice(pool: Address): Promise<bigint | null> {
  const { publicClient } = createClients();
  try {
    const slot0 = await publicClient.readContract({
      address: pool,
      abi: UNISWAP_V3_POOL_ABI,
      functionName: 'slot0',
    });
    const sqrtPriceX96 = slot0[0] as bigint;
    return sqrtPriceX96 > 0n ? sqrtPriceX96 : null;
  } catch {
    return null;
  }
}

/**
 * Spot price (tokenOut/tokenIn × 1e18, oriented by orderType) from the
 * deepest live direct pool's slot0. Throws if no direct pool / no
 * liquidity. Amount-independent — the trade-size slippage check stays at
 * the execution slippage gate.
 */
export async function getSpotPriceScaled(params: {
  orderType: OrderTypeStr;
  chainId: number;
  tokenIn: Address;
  tokenOut: Address;
  tokenInDecimals: number;
  tokenOutDecimals: number;
}): Promise<bigint> {
  const chainCfg = requireUniswapV3(params.chainId as ChainIdType);
  const { publicClient } = createClients();
  const key = `${params.chainId}|${params.tokenIn.toLowerCase()}|${params.tokenOut.toLowerCase()}`;

  const orient = (sqrtPriceX96: bigint): bigint => {
    const priceScaled = spotPriceScaledFromSqrtX96({
      sqrtPriceX96,
      tokenInIsToken0: params.tokenIn.toLowerCase() < params.tokenOut.toLowerCase(),
      tokenInDecimals: params.tokenInDecimals,
      tokenOutDecimals: params.tokenOutDecimals,
      orderType: params.orderType,
    });
    if (priceScaled <= 0n) throw new Error('Spot price unavailable');
    return priceScaled;
  };

  // Fast path: read only the cached deepest pool's slot0 (1 call).
  const cached = bestSpotPoolCache.get(key);
  if (cached && Date.now() - cached.ts < POOL_SET_TTL_MS) {
    const sqrt = await readSqrtPrice(cached.pool);
    if (sqrt !== null) return orient(sqrt);
    bestSpotPoolCache.delete(key); // pool went bad — re-evaluate below
  }

  // Re-evaluate: probe every fee tier (getPool never reverts — returns zero
  // for a non-existent tier) and pick the deepest live pool.
  const feeTiers = getFeeTiers(chainCfg);
  const addrs = await Promise.all(
    feeTiers.map((fee) =>
      publicClient.readContract({
        address: chainCfg.factory,
        abi: UNISWAP_V3_FACTORY_ABI,
        functionName: 'getPool',
        args: [params.tokenIn, params.tokenOut, fee],
      }),
    ),
  );
  const pools = addrs.filter((a): a is Address => a !== ZERO_ADDR);
  if (pools.length === 0) throw new Error('No Uniswap V3 route found (no direct pool for spot)');

  const reads = await Promise.all(
    pools.map(async (pool) => {
      try {
        const [slot0, liquidity] = await Promise.all([
          publicClient.readContract({ address: pool, abi: UNISWAP_V3_POOL_ABI, functionName: 'slot0' }),
          publicClient.readContract({ address: pool, abi: UNISWAP_V3_POOL_ABI, functionName: 'liquidity' }),
        ]);
        return { pool, sqrtPriceX96: slot0[0] as bigint, liquidity: liquidity as bigint };
      } catch {
        return null;
      }
    }),
  );
  let best: { pool: Address; sqrtPriceX96: bigint; liquidity: bigint } | null = null;
  for (const r of reads) {
    if (r && r.sqrtPriceX96 > 0n && (best === null || r.liquidity > best.liquidity)) best = r;
  }
  // Include the recognized substring so the keeper's dead-pair handling
  // catches an all-empty-liquidity pair (re-checks after the 5-min TTL).
  if (best === null) throw new Error('No Uniswap V3 route found (no pool liquidity for spot)');

  bestSpotPoolCache.set(key, { pool: best.pool, ts: Date.now() });
  return orient(best.sqrtPriceX96);
}

/**
 * Multi-route quote: tries every direct fee tier in parallel, plus a 2-hop
 * route through each hub token (at the hub fee tier). Picks the path with
 * the highest amountOut. Returns null when no route returns liquidity.
 */
export async function getUniswapQuote(params: {
  orderType: OrderTypeStr;
  chainId: number;
  tokenIn: Address;
  tokenOut: Address;
  amountInRaw: bigint;
  tokenInDecimals: number;
  tokenOutDecimals: number;
}): Promise<Quote> {
  // Throws with a clear message if the chain has no official Uniswap V3
  // deployment (e.g., Polygon Amoy). Boot-time misconfig surfaces here,
  // not as a cryptic RPC failure further down.
  const chainCfg = requireUniswapV3(params.chainId as ChainIdType);
  const feeTiers = getFeeTiers(chainCfg);

  const { publicClient } = createClients();

  // ─── Fast path: cached route ────────────────────────────────────────
  // Quote only the previously-winning route (1 call). Stale/empty → fall
  // through to full discovery below.
  const cacheKey = routeCacheKey(params.chainId, params.tokenIn, params.tokenOut);
  const cached = routeCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < ROUTE_TTL_MS) {
    const out = await quoteRoute(cached.route, chainCfg.quoterV2, params);
    if (out > 0n) {
      return { amountOut: out, route: cached.route };
    }
    routeCache.delete(cacheKey); // cached route dried up — re-discover
  }

  // Skip tiers/hubs already known (within the TTL) to have no pool, so we
  // don't re-fire QuoterV2 probes that just revert. Candidates that come
  // back empty here are recorded as dead for the next discovery.
  const dead = getDeadCandidates(cacheKey);

  // ─── Direct routes at every (not-known-dead) fee tier ───────────────
  const directProbes = feeTiers
    .filter((fee) => !dead.fees.has(fee))
    .map(async (fee) => {
      try {
        const r = await publicClient.readContract({
          address: chainCfg.quoterV2,
          abi: QUOTER_ABI,
          functionName: 'quoteExactInputSingle',
          args: [
            {
              tokenIn: params.tokenIn,
              tokenOut: params.tokenOut,
              amountIn: params.amountInRaw,
              fee,
              sqrtPriceLimitX96: 0n,
            },
          ],
        });
        const out = r[0];
        if (out > 0n) return { kind: 'direct' as const, fee, amountOut: out } as const;
        dead.fees.add(fee);
        return null;
      } catch {
        dead.fees.add(fee);
        return null;
      }
    });

  // ─── 2-hop routes through (not-known-dead) hub tokens ──────────────
  const tokenInLower = params.tokenIn.toLowerCase();
  const tokenOutLower = params.tokenOut.toLowerCase();
  const hopProbes = chainCfg.hubTokens
    .filter((h) => h.toLowerCase() !== tokenInLower && h.toLowerCase() !== tokenOutLower)
    .filter((h) => !dead.hubs.has(h.toLowerCase()))
    .map(async (hub) => {
      try {
        const tokens: Address[] = [params.tokenIn, hub, params.tokenOut];
        const fees = [chainCfg.hopFee, chainCfg.hopFee];
        const path = encodePath(tokens, fees);
        const r = await publicClient.readContract({
          address: chainCfg.quoterV2,
          abi: QUOTER_ABI,
          functionName: 'quoteExactInput',
          args: [path, params.amountInRaw],
        });
        const out = r[0];
        if (out > 0n) return { kind: 'multihop' as const, path, tokens, fees, amountOut: out } as const;
        dead.hubs.add(hub.toLowerCase());
        return null;
      } catch {
        dead.hubs.add(hub.toLowerCase());
        return null;
      }
    });

  const candidates = (await Promise.all([...directProbes, ...hopProbes])).filter(
    (c): c is NonNullable<typeof c> => c !== null,
  );
  if (candidates.length === 0) {
    throw new Error(
      `No Uniswap V3 route found for ${params.tokenIn} → ${params.tokenOut} ` +
        `(tried ${feeTiers.length} direct fee tiers + ${chainCfg.hubTokens.length} hubs)`,
    );
  }

  // Pick the route with the most tokenOut. amountOut is bigint so comparing
  // by direct subtraction works.
  let best = candidates[0];
  for (const c of candidates) {
    if (c.amountOut > best.amountOut) best = c;
  }

  const route: Route =
    best.kind === 'direct'
      ? { kind: 'direct', fee: best.fee }
      : { kind: 'multihop', path: best.path, tokens: best.tokens, fees: best.fees };

  // Cache the winning route so the next quote on this pair skips discovery.
  routeCache.set(cacheKey, { route, ts: Date.now() });

  return { amountOut: best.amountOut, route };
}

/** Build calldata for the picked route — single-hop or multi-hop. */
export function buildSwapCalldata(params: {
  chainId: number;
  tokenIn: Address;
  tokenOut: Address;
  route: Route;
  amountInRaw: bigint;
  minAmountOutRaw: bigint;
  recipient: Address;
}): { aggregator: Address; calldata: Hex } {
  const chainCfg = requireUniswapV3(params.chainId as ChainIdType);
  let calldata: Hex;
  if (params.route.kind === 'direct') {
    calldata = encodeFunctionData({
      abi: SWAP_ROUTER_ABI,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn: params.tokenIn,
          tokenOut: params.tokenOut,
          fee: params.route.fee,
          recipient: params.recipient,
          amountIn: params.amountInRaw,
          amountOutMinimum: params.minAmountOutRaw,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
  } else {
    calldata = encodeFunctionData({
      abi: SWAP_ROUTER_ABI,
      functionName: 'exactInput',
      args: [
        {
          path: params.route.path,
          recipient: params.recipient,
          amountIn: params.amountInRaw,
          amountOutMinimum: params.minAmountOutRaw,
        },
      ],
    });
  }
  return { aggregator: chainCfg.swapRouter02, calldata };
}

/** Short human description of a route — for logging / DB feeTier display. */
export function describeRoute(route: Route): string {
  if (route.kind === 'direct') {
    return `direct@${route.fee}`;
  }
  // Show fees joined by → between hops, e.g. "USDC→WETH→WBTC via 500/500"
  return `multihop[${route.fees.join('/')}]`;
}

/** Best-effort fee for DB persistence. Direct: that fee. Multihop: first hop fee. */
export function routeFeeForDb(route: Route): number {
  return route.kind === 'direct' ? route.fee : route.fees[0];
}
