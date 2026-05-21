import { useQuery } from '@tanstack/react-query';
import { createPublicClient, http, type Address } from 'viem';
import { polygon } from 'viem/chains';
import type { OrderType } from '@polyorder/shared';
import { findToken } from '../lib/tokens';
import { env } from '../lib/env';

// Uniswap V3 Factory on Polygon (same code on the Anvil fork).
const FACTORY_V3: Address = '0x1F98431c8aD98523631AE4a59f267346ea31F984';

// Fixed fee tier for the TWAP read. 500 (0.05%) is the most liquid for major
// USD/asset pairs on Polygon. Multi-tier iteration could go here later, but
// it's not worth the RPC roundtrips for an advisory UI suggestion.
const DEFAULT_FEE = 500;

const SECONDS_AGOS = [60, 30, 10, 0] as const;

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

const POOL_ABI = [
  {
    type: 'function',
    name: 'observe',
    stateMutability: 'view',
    inputs: [{ name: 'secondsAgos', type: 'uint32[]' }],
    outputs: [
      { name: 'tickCumulatives', type: 'int56[]' },
      { name: 'secondsPerLiquidityCumulativeX128s', type: 'uint160[]' },
    ],
  },
] as const;

const polygonReadClient = createPublicClient({
  chain: polygon,
  transport: http(import.meta.env.VITE_POLYGON_RPC ?? 'https://polygon-rpc.com'),
});

/**
 * Convert a Uniswap V3 tick to our priceScaled convention (matches
 * computePriceFromQuote / triggerPrice — "USDC per WETH"-style, scaled 1e18).
 *
 *   raw_price = 1.0001^tick  ←  amount of token1 (raw) per token0 (raw)
 *   human_t1_per_t0 = raw_price × 10^(dec0 - dec1)
 *
 * Then mirror computePriceFromQuote's branch on orderType:
 *   LIMIT_BUY → tokenIn per tokenOut (= 1 / tokenOut_per_tokenIn)
 *   else      → tokenOut per tokenIn
 */
function tickToPriceScaled(
  tick: number,
  tokenInIsToken0: boolean,
  tokenInDecimals: number,
  tokenOutDecimals: number,
  orderType: OrderType,
): bigint {
  const rawPrice = Math.pow(1.0001, tick);
  const dec0 = tokenInIsToken0 ? tokenInDecimals : tokenOutDecimals;
  const dec1 = tokenInIsToken0 ? tokenOutDecimals : tokenInDecimals;
  const humanRatio_t1_per_t0 = rawPrice * Math.pow(10, dec0 - dec1);
  const tokenOutPerTokenIn = tokenInIsToken0 ? humanRatio_t1_per_t0 : 1 / humanRatio_t1_per_t0;
  const priceForConvention = orderType === 'LIMIT_BUY' ? 1 / tokenOutPerTokenIn : tokenOutPerTokenIn;
  return BigInt(Math.round(priceForConvention * 1e18));
}

export interface PoolTwap {
  /** Most recent TWAP price (last 10s window), scaled 1e18 per trigger convention. */
  current: bigint | null;
  /** Lowest sub-interval TWAP within the 60s window. */
  min: bigint | null;
  /** Highest sub-interval TWAP within the 60s window. */
  max: bigint | null;
  /** Number of sub-intervals we computed (always 3 when loaded). */
  samples: number;
  error: Error | null;
  isLoading: boolean;
}

/**
 * Reads Uniswap V3 pool.observe() against real Polygon mainnet for the
 * tokenIn/tokenOut pair and returns the 60s price range expressed in our
 * trigger-price convention. Refreshes every 10s.
 *
 * Available from the first call — no client-side polling history required.
 */
export function usePoolTwap(
  orderType: OrderType,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
): PoolTwap {
  const tokenInInfo = findToken(env.chainId, tokenIn);
  const tokenOutInfo = findToken(env.chainId, tokenOut);

  const { data, error, isLoading } = useQuery({
    queryKey: ['poolTwap', tokenIn.toLowerCase(), tokenOut.toLowerCase(), orderType, DEFAULT_FEE],
    enabled: !!tokenInInfo && !!tokenOutInfo && tokenIn !== tokenOut,
    refetchInterval: 10_000,
    staleTime: 5_000,
    queryFn: async (): Promise<{ current: bigint; min: bigint; max: bigint }> => {
      // 1. Resolve the pool address for this pair + fee tier.
      const poolAddr = await polygonReadClient.readContract({
        address: FACTORY_V3,
        abi: FACTORY_ABI,
        functionName: 'getPool',
        args: [tokenIn, tokenOut, DEFAULT_FEE],
      });
      if (poolAddr === '0x0000000000000000000000000000000000000000') {
        throw new Error(`No Uniswap V3 pool at fee ${DEFAULT_FEE} for this pair`);
      }

      // 2. Read cumulative ticks at [60s ago, 30s ago, 10s ago, now].
      const [tickCumulatives] = await polygonReadClient.readContract({
        address: poolAddr,
        abi: POOL_ABI,
        functionName: 'observe',
        args: [SECONDS_AGOS as unknown as readonly number[]],
      });

      // 3. TWAP tick over a sub-interval = Δcumulative / Δtime.
      //    Sub-intervals: [60s-30s] (30s window), [30s-10s] (20s), [10s-now] (10s)
      const twap60_30 = Number((tickCumulatives[1] - tickCumulatives[0]) / 30n);
      const twap30_10 = Number((tickCumulatives[2] - tickCumulatives[1]) / 20n);
      const twap10_0 = Number((tickCumulatives[3] - tickCumulatives[2]) / 10n);

      // 4. Convert each tick to our priceScaled (depends on token ordering in pool).
      const tokenInIsToken0 = tokenIn.toLowerCase() < tokenOut.toLowerCase();
      const prices = [twap60_30, twap30_10, twap10_0].map((tick) =>
        tickToPriceScaled(
          tick,
          tokenInIsToken0,
          tokenInInfo!.decimals,
          tokenOutInfo!.decimals,
          orderType,
        ),
      );

      let min = prices[0];
      let max = prices[0];
      for (const p of prices) {
        if (p < min) min = p;
        if (p > max) max = p;
      }
      // Use the most recent sub-interval TWAP as "current spot-ish".
      return { current: prices[prices.length - 1], min, max };
    },
  });

  if (!data) {
    return {
      current: null,
      min: null,
      max: null,
      samples: 0,
      error: (error as Error | null) ?? null,
      isLoading,
    };
  }
  return { ...data, samples: 3, error: null, isLoading: false };
}
