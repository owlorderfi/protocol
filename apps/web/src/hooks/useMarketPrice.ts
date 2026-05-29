import { useQuery } from '@tanstack/react-query';
import { useChainId } from 'wagmi';
import { findToken } from '../lib/tokens';
import { api } from '../lib/api';

interface QuoteResponse {
  priceScaled: string | null;
}

/**
 * Live CANONICAL spot price for a pair, via the API's cached
 * `/market/quote` endpoint (reads the pool's slot0 marginal price
 * server-side over Infura, cached + shared across all users).
 *
 * Returns the canonical price = tokenOut per tokenIn, ×1e18, ALWAYS — no
 * order-type orientation. Orientation for display is a single, separate
 * step (`displayPrice` in priceFloor); the order-type orientation only
 * matters for the trigger comparison, which is the keeper/contract's job,
 * not the display's. Amount-independent by design (spot, not a sized quote).
 */
export function useMarketPrice(tokenIn: `0x${string}`, tokenOut: `0x${string}`) {
  const chainId = useChainId();
  const tokenInInfo = findToken(chainId, tokenIn);
  const tokenOutInfo = findToken(chainId, tokenOut);

  const { data, isLoading, error } = useQuery({
    // Lowercase the addresses so callers passing checksummed (forms) and
    // lowercased (order rows from the API) addresses share one cache entry.
    // Decimals are part of the result (they scale the price).
    queryKey: [
      'marketPrice',
      chainId,
      tokenIn.toLowerCase(),
      tokenOut.toLowerCase(),
      tokenInInfo?.decimals,
      tokenOutInfo?.decimals,
    ],
    enabled: !!tokenInInfo && !!tokenOutInfo && tokenIn !== tokenOut,
    // 15s: the "Now" banner stays responsive without hammering the API.
    // Upstream RPC is deduped by the market service's 8s quote cache.
    refetchInterval: 15_000,
    staleTime: 5_000,
    queryFn: async (): Promise<bigint> => {
      const q = new URLSearchParams({
        chainId: String(chainId),
        tokenIn,
        tokenOut,
        // LIMIT_SELL = the API's canonical orientation (tokenOut per tokenIn).
        orderType: 'LIMIT_SELL',
        tokenInDecimals: String(tokenInInfo!.decimals),
        tokenOutDecimals: String(tokenOutInfo!.decimals),
      });
      // Public endpoint — auth:false so a stale JWT isn't sent on market data.
      const resp = await api<QuoteResponse>(`/market/quote?${q.toString()}`, { auth: false });
      if (!resp.priceScaled) throw new Error('No pool / zero liquidity');
      return BigInt(resp.priceScaled);
    },
  });

  if (!tokenInInfo || !tokenOutInfo || data === undefined) {
    return { priceScaled: null, error: error ?? null, isLoading };
  }
  return { priceScaled: data, error: null, isLoading: false };
}
