import { useQuery } from '@tanstack/react-query';
import { useChainId } from 'wagmi';
import type { OrderType } from '@owlorderfi/shared';
import { findToken } from '../lib/tokens';
import { api } from '../lib/api';

export type TrendDirection = 'up' | 'down' | 'sideways';

export interface PoolTwap {
  /** Most recent TWAP (last 30s window). */
  current: bigint | null;
  /** Lowest sub-interval TWAP over the 5 min window. */
  min: bigint | null;
  /** Highest sub-interval TWAP. */
  max: bigint | null;
  /** Realized 30s volatility — stddev of log returns (0.001 = 0.10%). */
  sigma30s: number | null;
  /** TWAP_30s minus TWAP_5min as a percentage. Positive = uptrend. */
  trendPct: number | null;
  trend: TrendDirection | null;
  /** Number of sub-intervals (10 once loaded). */
  samples: number;
  error: Error | null;
  isLoading: boolean;
}

interface TwapResponse {
  current: string | null;
  min: string | null;
  max: string | null;
  sigma30s: number | null;
  trendPct: number | null;
  trend: TrendDirection | null;
  samples: number;
}

type TwapData = Omit<PoolTwap, 'error' | 'isLoading'>;

/**
 * Live TWAP volatility + trend for a pair, via the API's cached
 * `/market/twap` endpoint. The pool's `observe()` buffer is read
 * server-side over Infura, cached + shared across all users — same
 * rationale as useMarketPrice: previously each browser fired its own
 * observe() call; now N users on a pair collapse to ~one RPC round per
 * window. Orientation matches the keeper/spot decoder (BUY/STOP store the
 * inverse). The σ/trend feed the order forms' smart-suggest.
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
    queryKey: ['poolTwap', chainId, tokenIn.toLowerCase(), tokenOut.toLowerCase(), orderType],
    enabled: !!tokenInInfo && !!tokenOutInfo && tokenIn !== tokenOut,
    refetchInterval: 10_000,
    staleTime: 5_000,
    queryFn: async (): Promise<TwapData> => {
      const q = new URLSearchParams({
        chainId: String(chainId),
        tokenIn,
        tokenOut,
        orderType,
        tokenInDecimals: String(tokenInInfo!.decimals),
        tokenOutDecimals: String(tokenOutInfo!.decimals),
      });
      // Public endpoint — auth:false (market data, no JWT).
      const resp = await api<TwapResponse>(`/market/twap?${q.toString()}`, { auth: false });
      if (resp.current === null) throw new Error('No TWAP pool / insufficient observations');
      return {
        current: BigInt(resp.current),
        min: resp.min === null ? null : BigInt(resp.min),
        max: resp.max === null ? null : BigInt(resp.max),
        sigma30s: resp.sigma30s,
        trendPct: resp.trendPct,
        trend: resp.trend,
        samples: resp.samples,
      };
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
  return { ...data, error: null, isLoading: false };
}
