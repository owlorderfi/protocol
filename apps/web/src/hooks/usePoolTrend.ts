import { useQuery } from '@tanstack/react-query';
import { useChainId } from 'wagmi';
import { api } from '../lib/api';

interface TrendResponse {
  trendPct: number | null;
  sampleCount: number;
  oldestTs: string | null;
  latestTs: string | null;
  available: boolean;
}

/**
 * Longer-horizon (1h+) trend for a pair, derived server-side from the
 * pool spot snapshot table (every-5-min cron in the API). Used by
 * Smart Suggest's 1h-horizon Wait pill to project drift over a window
 * that matches the user's intent — the existing `usePoolTwap` 5-minute
 * trend isn't valid for 1h projection (extrapolating short-term trend
 * to hours is fortune-telling, not math).
 *
 * Returns `null` for `trendPct` (or `available: false`) whenever:
 *   - The pair isn't in the snapshot set (operator hasn't whitelisted it)
 *   - We haven't accumulated enough history yet (`horizonSec` of samples)
 *   - The DB read errors
 *
 * The caller's smartSuggestTrigger handles `available=false` by zeroing
 * drift for that horizon, falling back to a pure σ-based offset.
 */
export function usePoolTrend(
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  horizonSec: number,
) {
  const chainId = useChainId();

  const { data, isLoading } = useQuery<TrendResponse>({
    // Lowercase addresses match the API's normalised storage so callers
    // passing checksummed (forms) vs lowercased (order rows) share a
    // single cache entry.
    queryKey: [
      'poolTrend',
      chainId,
      tokenIn.toLowerCase(),
      tokenOut.toLowerCase(),
      horizonSec,
    ],
    enabled:
      tokenIn !== tokenOut &&
      Number.isFinite(horizonSec) &&
      horizonSec >= 300 &&
      horizonSec <= 86400,
    // 60s: the underlying snapshot is 5min granularity anyway, so anything
    // finer is just polling for nothing.
    refetchInterval: 60_000,
    queryFn: async () => {
      const q = new URLSearchParams({
        chainId: String(chainId),
        tokenIn,
        tokenOut,
        horizonSec: String(horizonSec),
      });
      // Public endpoint — auth:false so a stale JWT isn't sent on market data.
      try {
        return await api<TrendResponse>(`/market/trend?${q.toString()}`, { auth: false });
      } catch {
        return { trendPct: null, sampleCount: 0, oldestTs: null, latestTs: null, available: false };
      }
    },
  });

  return {
    trendPct: data?.trendPct ?? null,
    sampleCount: data?.sampleCount ?? 0,
    available: data?.available ?? false,
    isLoading,
  };
}
