import { useQuery } from '@tanstack/react-query';
import { useChainId } from 'wagmi';
import type { OrderType } from '@owlorderfi/shared';
import { findToken } from '../lib/tokens';
import { api } from '../lib/api';

interface QuoteResponse {
  priceScaled: string | null;
}

/**
 * Live SPOT market price for a pair, via the API's cached `/market/quote`
 * endpoint (reads the pool's slot0 marginal price server-side over Infura,
 * cached + shared across all users). Amount-INDEPENDENT by design: the
 * displayed/trigger price is the spot, while trade-size slippage is a
 * separate concern handled at execution. This is why there's no probe
 * amount — a fixed unit probe is fine for USDC but slips badly for a
 * 1-WETH/1-WBTC quote on thin pools.
 *
 * priceScaled orientation matches the keeper (same shared decoder):
 * tokenOut/tokenIn for SELL/TAKE_PROFIT, the inverse for BUY/STOP_LOSS.
 */
export function useMarketPrice(
  orderType: OrderType,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
) {
  const chainId = useChainId();
  const tokenInInfo = findToken(chainId, tokenIn);
  const tokenOutInfo = findToken(chainId, tokenOut);

  const { data, isLoading, error } = useQuery({
    // Lowercase the addresses so callers passing checksummed (forms) and
    // lowercased (order rows from the API) addresses share one cache entry.
    // Decimals are part of the result (they scale the price), so key on them.
    queryKey: [
      'marketPrice',
      chainId,
      tokenIn.toLowerCase(),
      tokenOut.toLowerCase(),
      orderType,
      tokenInInfo?.decimals,
      tokenOutInfo?.decimals,
    ],
    enabled: !!tokenInInfo && !!tokenOutInfo && tokenIn !== tokenOut,
    refetchInterval: 10_000,
    staleTime: 5_000,
    queryFn: async (): Promise<bigint> => {
      const q = new URLSearchParams({
        chainId: String(chainId),
        tokenIn,
        tokenOut,
        orderType,
        tokenInDecimals: String(tokenInInfo!.decimals),
        tokenOutDecimals: String(tokenOutInfo!.decimals),
      });
      // Public endpoint — auth:false so a stale JWT isn't sent (and the
      // 401-clear path can't fire) on what is just market data.
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
