import { useQuery } from '@tanstack/react-query';
import type { OrderType } from '@polyorder/shared';
import { computePriceFromQuote } from '../lib/orderMath';
import { findToken } from '../lib/tokens';
import { env } from '../lib/env';
import { getReadClient, getUniswapV3 } from '../lib/chainConfig';

const FEE_TIERS = [100, 500, 3000, 10000] as const;
const ZERO = '0x0000000000000000000000000000000000000000';

const FACTORY_ABI = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'fee', type: 'uint24' },
    ],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

/**
 * Module-level cache of which fee tiers have a Uniswap V3 pool for a given
 * pair. Pool addresses are deterministic per (token0, token1, fee), so this
 * value never changes for the lifetime of the page — once we discover the
 * existing tiers we never need to ask again. Saves ~60ms on subsequent
 * useMarketPrice calls for pairs like USDC/WBTC where only 2 of 4 tiers
 * exist (the missing tiers' quoter errors used to dominate latency).
 */
const liveTiersCache = new Map<string, number[]>();

function pairKey(a: string, b: string): string {
  const lo = a.toLowerCase();
  const hi = b.toLowerCase();
  return lo < hi ? `${lo}-${hi}` : `${hi}-${lo}`;
}

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
] as const;

// Read from the same chain the keeper executes against — addresses come
// from the shared registry (chain-agnostic). VITE_POLYGON_RPC override
// in chainConfig.ts keeps the old "live mainnet display" escape hatch
// for chainId 137 specifically.

/**
 * Live market price for a pair, queried against real Polygon mainnet via a
 * public RPC. Iterates all four V3 fee tiers in parallel and picks the best
 * fill — same logic as the keeper.
 *
 * The local Anvil fork would always return its fork-time price, so it's a
 * bad source for a UI that should move with the market.
 */
export function useMarketPrice(
  orderType: OrderType,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
) {
  const tokenInInfo = findToken(env.chainId, tokenIn);
  const tokenOutInfo = findToken(env.chainId, tokenOut);
  const probeAmount = tokenInInfo ? 10n ** BigInt(tokenInInfo.decimals) : 0n;

  const { data, isLoading, error } = useQuery({
    queryKey: ['marketPrice', tokenIn, tokenOut, orderType, probeAmount.toString()],
    enabled: !!tokenInInfo && !!tokenOutInfo && tokenIn !== tokenOut && probeAmount > 0n,
    refetchInterval: 10_000,
    staleTime: 5_000,
    queryFn: async (): Promise<bigint> => {
      const readClient = getReadClient();
      const { factory, quoterV2 } = getUniswapV3();

      // First call for this pair: discover which fee tiers actually have a
      // pool, cache the result. Subsequent calls hit cache and skip the
      // tier-existence probe entirely.
      const key = pairKey(tokenIn, tokenOut);
      let liveTiers = liveTiersCache.get(key);
      if (!liveTiers) {
        const pools = await Promise.all(
          FEE_TIERS.map((fee) =>
            readClient.readContract({
              address: factory,
              abi: FACTORY_ABI,
              functionName: 'getPool',
              args: [tokenIn, tokenOut, fee],
            }),
          ),
        );
        liveTiers = FEE_TIERS.filter((_, i) => pools[i] !== ZERO);
        liveTiersCache.set(key, liveTiers);
      }
      if (liveTiers.length === 0) throw new Error('No pool / zero liquidity');

      const candidates = await Promise.all(
        liveTiers.map(async (fee) => {
          try {
            const result = await readClient.readContract({
              address: quoterV2,
              abi: QUOTER_ABI,
              functionName: 'quoteExactInputSingle',
              args: [{ tokenIn, tokenOut, amountIn: probeAmount, fee, sqrtPriceLimitX96: 0n }],
            });
            return result[0];
          } catch {
            return 0n;
          }
        }),
      );
      const bestAmountOut = candidates.reduce((a, b) => (a > b ? a : b), 0n);
      if (bestAmountOut === 0n) throw new Error('No pool / zero liquidity');
      return bestAmountOut;
    },
  });

  if (!tokenInInfo || !tokenOutInfo || data === undefined) {
    return { priceScaled: null, error: error ?? null, isLoading };
  }

  const priceScaled = computePriceFromQuote({
    orderType,
    amountInRaw: probeAmount,
    amountOutRaw: data,
    tokenInDecimals: tokenInInfo.decimals,
    tokenOutDecimals: tokenOutInfo.decimals,
  });

  return { priceScaled, error: null, isLoading: false };
}
