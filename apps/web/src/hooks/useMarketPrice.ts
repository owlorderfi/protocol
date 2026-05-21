import { useReadContract } from 'wagmi';
import type { OrderType } from '@polyorder/shared';
import { computePriceFromQuote } from '../lib/orderMath';
import { findToken } from '../lib/tokens';
import { env } from '../lib/env';

// Uniswap V3 QuoterV2 on Polygon (same on the Anvil fork). Hardcoded here
// rather than fetched from a registry — single address, no per-chain split
// needed until we add another chain.
const QUOTER_V2 = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e' as const;
const DEFAULT_FEE = 500;

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

/**
 * Live market price for a pair via Uniswap V3 quoter.
 *
 * Returns the price in the same convention used by triggerPrice (scaled 1e18,
 * "quote token per base token"). Refreshes every 10s.
 */
export function useMarketPrice(
  orderType: OrderType,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
) {
  const tokenInInfo = findToken(env.chainId, tokenIn);
  const tokenOutInfo = findToken(env.chainId, tokenOut);

  // Always quote 1 unit of tokenIn. Pool reads pure, no slippage from a single
  // quote — exact pool mid price.
  const probeAmount = tokenInInfo ? 10n ** BigInt(tokenInInfo.decimals) : 0n;

  const { data, isLoading, error } = useReadContract({
    address: QUOTER_V2,
    abi: QUOTER_ABI,
    functionName: 'quoteExactInputSingle',
    args: [
      {
        tokenIn,
        tokenOut,
        amountIn: probeAmount,
        fee: DEFAULT_FEE,
        sqrtPriceLimitX96: 0n,
      },
    ],
    query: {
      enabled: !!tokenInInfo && !!tokenOutInfo && tokenIn !== tokenOut,
      refetchInterval: 10_000,
      staleTime: 5_000,
    },
  });

  if (!tokenInInfo || !tokenOutInfo || !data) {
    return { priceScaled: null, error, isLoading };
  }

  const amountOut = data[0];
  if (amountOut === 0n) {
    return { priceScaled: null, error: new Error('No pool / zero liquidity'), isLoading: false };
  }

  const priceScaled = computePriceFromQuote({
    orderType,
    amountInRaw: probeAmount,
    amountOutRaw: amountOut,
    tokenInDecimals: tokenInInfo.decimals,
    tokenOutDecimals: tokenOutInfo.decimals,
  });

  return { priceScaled, error: null, isLoading: false };
}
