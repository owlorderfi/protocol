import { useQuery } from '@tanstack/react-query';
import { createPublicClient, http } from 'viem';
import { polygon } from 'viem/chains';
import { computePriceFromQuote } from '../lib/orderMath';
import { findToken } from '../lib/tokens';
import { env } from '../lib/env';

// Uniswap V3 contracts on Polygon mainnet. Same addresses on our Anvil fork,
// but the fork's state is frozen at the block we forked from — quoter would
// always return the same number. For a *live* price ribbon we read from a
// real Polygon RPC instead, decoupled from the user's wallet chain.
const QUOTER_V2 = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e' as const;
const FEE_TIERS = [100, 500, 3000, 10000] as const;

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

// Read from the SAME chain the keeper executes against. On a fresh Anvil
// fork the price ≈ mainnet; the longer the fork runs, the more it drifts
// from real mainnet. Reading the live mainnet price here was tempting for
// the "feel live" effect, but caused UI vs keeper disagreement of >1% on
// stale forks — confusing because the keeper would happily fill orders
// at a trigger the UI said hadn't been reached yet.
//
// VITE_POLYGON_RPC stays in .env as an escape hatch: set it to a mainnet
// RPC if you want the old "live mainnet display" behaviour back.
const readClient = createPublicClient({
  chain: polygon,
  transport: http(import.meta.env.VITE_POLYGON_RPC ?? `http://${typeof window !== 'undefined' ? window.location.hostname : '127.0.0.1'}:8545`),
});

/**
 * Live market price for a pair, queried against real Polygon mainnet via a
 * public RPC. Iterates all four V3 fee tiers in parallel and picks the best
 * fill — same logic as the keeper.
 *
 * The local Anvil fork would always return its fork-time price, so it's a
 * bad source for a UI that should move with the market.
 */
export function useMarketPrice(
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
) {
  const tokenInInfo = findToken(env.chainId, tokenIn);
  const tokenOutInfo = findToken(env.chainId, tokenOut);
  const probeAmount = tokenInInfo ? 10n ** BigInt(tokenInInfo.decimals) : 0n;

  const { data, isLoading, error } = useQuery({
    queryKey: ['marketPrice', tokenIn, tokenOut, probeAmount.toString()],
    enabled: !!tokenInInfo && !!tokenOutInfo && tokenIn !== tokenOut && probeAmount > 0n,
    refetchInterval: 10_000,
    staleTime: 5_000,
    queryFn: async (): Promise<bigint> => {
      const candidates = await Promise.all(
        FEE_TIERS.map(async (fee) => {
          try {
            const result = await readClient.readContract({
              address: QUOTER_V2,
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
    amountInRaw: probeAmount,
    amountOutRaw: data,
    tokenInDecimals: tokenInInfo.decimals,
    tokenOutDecimals: tokenOutInfo.decimals,
  });

  return { priceScaled, error: null, isLoading: false };
}
