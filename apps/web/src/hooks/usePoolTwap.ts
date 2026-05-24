import { useQuery } from '@tanstack/react-query';
import { useChainId } from 'wagmi';
import type { OrderType } from '@owlorderfi/shared';
import { findToken } from '../lib/tokens';
import { getReadClient, getUniswapV3 } from '../lib/chainConfig';

const DEFAULT_FEE = 500;

// 11 timestamps spanning 5 minutes → 10 sub-interval TWAPs at 30s each.
// Enough density for a reasonable stddev estimate without paying for too
// large an observation buffer on the pool.
const SECONDS_AGOS = [300, 270, 240, 210, 180, 150, 120, 90, 60, 30, 0] as const;
const SUB_INTERVAL_SEC = 30;

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

// Same rationale as useMarketPrice: read TWAP from the chain the keeper
// trades on so σ + trend reflect the price the keeper will see.
// Per-chain client + factory address come from chainConfig (no hardcode).

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

export type TrendDirection = 'up' | 'down' | 'sideways';

export interface PoolTwap {
  /** Most recent TWAP (last 30s window). */
  current: bigint | null;
  /** Lowest sub-interval TWAP over the 5 min window. */
  min: bigint | null;
  /** Highest sub-interval TWAP. */
  max: bigint | null;
  /**
   * Realized 30s volatility — stddev of log returns across the 10 sub-intervals.
   * Expressed as a fraction (0.001 = 0.10%).
   */
  sigma30s: number | null;
  /** TWAP_30s minus TWAP_5min as a percentage. Positive = uptrend. */
  trendPct: number | null;
  trend: TrendDirection | null;
  /** Number of sub-intervals (always 10 once loaded). */
  samples: number;
  error: Error | null;
  isLoading: boolean;
}

/** Population stddev — n-1 denominator is fine too but we have only 9 returns. */
function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

/**
 * Reads Uniswap V3 pool.observe() against real Polygon mainnet, computes
 * sub-interval TWAPs across a 5 min window, and derives realized 30s
 * volatility + trend direction. Single RPC call refreshed every 10s.
 */
export function usePoolTwap(
  orderType: OrderType,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
): PoolTwap {
  const chainId = useChainId();
  const tokenInInfo = findToken(chainId, tokenIn);
  const tokenOutInfo = findToken(chainId, tokenOut);

  const { data, error, isLoading } = useQuery({
    queryKey: ['poolTwap', chainId, tokenIn.toLowerCase(), tokenOut.toLowerCase(), orderType, DEFAULT_FEE],
    enabled: !!tokenInInfo && !!tokenOutInfo && tokenIn !== tokenOut,
    refetchInterval: 10_000,
    staleTime: 5_000,
    queryFn: async () => {
      const readClient = getReadClient(chainId);
      const { factory } = getUniswapV3(chainId);
      const poolAddr = await readClient.readContract({
        address: factory,
        abi: FACTORY_ABI,
        functionName: 'getPool',
        args: [tokenIn, tokenOut, DEFAULT_FEE],
      });
      if (poolAddr === '0x0000000000000000000000000000000000000000') {
        throw new Error(`No Uniswap V3 pool at fee ${DEFAULT_FEE} for this pair`);
      }

      const [tickCumulatives] = await readClient.readContract({
        address: poolAddr,
        abi: POOL_ABI,
        functionName: 'observe',
        args: [SECONDS_AGOS as unknown as readonly number[]],
      });

      // Derive 10 TWAP ticks (30s each) from 11 cumulative values.
      // Indices: tickCumulatives[i] is t=(-secondsAgos[i]); pairs (i, i+1).
      const twapTicks: number[] = [];
      for (let i = 0; i < tickCumulatives.length - 1; i++) {
        const delta = tickCumulatives[i + 1] - tickCumulatives[i];
        twapTicks.push(Number(delta / BigInt(SUB_INTERVAL_SEC)));
      }

      const tokenInIsToken0 = tokenIn.toLowerCase() < tokenOut.toLowerCase();
      const prices = twapTicks.map((t) =>
        tickToPriceScaled(t, tokenInIsToken0, tokenInInfo!.decimals, tokenOutInfo!.decimals, orderType),
      );

      // min / max over the window
      let min = prices[0];
      let max = prices[0];
      for (const p of prices) {
        if (p < min) min = p;
        if (p > max) max = p;
      }
      const current = prices[prices.length - 1];

      // 30s realized volatility — stddev of log returns across the sub-intervals.
      const numericPrices = prices.map((p) => Number(p) / 1e18);
      const returns: number[] = [];
      for (let i = 1; i < numericPrices.length; i++) {
        returns.push(Math.log(numericPrices[i] / numericPrices[i - 1]));
      }
      const sigma30s = stddev(returns);

      // Trend = recent TWAP vs early TWAP. Use the first and last sub-intervals.
      const earlyPrice = numericPrices[0];
      const latePrice = numericPrices[numericPrices.length - 1];
      const trendPct = ((latePrice - earlyPrice) / earlyPrice) * 100;

      let trend: TrendDirection = 'sideways';
      if (trendPct > 0.05) trend = 'up';
      else if (trendPct < -0.05) trend = 'down';

      return { current, min, max, sigma30s, trendPct, trend };
    },
  });

  if (!data) {
    return {
      current: null,
      min: null,
      max: null,
      sigma30s: null,
      trendPct: null,
      trend: null,
      samples: 0,
      error: (error as Error | null) ?? null,
      isLoading,
    };
  }
  return { ...data, samples: 10, error: null, isLoading: false };
}
