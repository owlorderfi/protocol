import { useQuery } from '@tanstack/react-query';
import { useChainId } from 'wagmi';
import { getFeeTiers, type OrderType } from '@owlorderfi/shared';
import { computePriceFromQuote } from '../lib/orderMath';
import { findToken } from '../lib/tokens';
import { getReadClient, getUniswapV3 } from '../lib/chainConfig';

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

// Key includes chainId so two chains with the same address pair (e.g.
// canonical WETH 0x4200… exists on Base AND Optimism) don't contaminate
// each other's tier discovery.
function pairKey(chainId: number, a: string, b: string): string {
  const lo = a.toLowerCase();
  const hi = b.toLowerCase();
  return `${chainId}:${lo < hi ? `${lo}-${hi}` : `${hi}-${lo}`}`;
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
// from the shared registry per active chainId, RPC defaults via the
// chain registry with per-chain VITE_CHAIN_<id>_RPC overrides.

/**
 * Live market price for a pair, queried against the wallet's active
 * chain. Iterates the V3 fee tiers for that chain in parallel and picks
 * the best fill — same logic as the keeper, so UI matches keeper's view.
 *
 * On Anvil the fork's state is frozen at fork-time, so price won't move
 * naturally — that's a known limitation of the dev environment, not
 * this hook.
 */
export function useMarketPrice(
  orderType: OrderType,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  /**
   * Override the probe amount (in raw token-in units) used to quote
   * the pool. Default is 1 unit of tokenIn (10^decimals). For thin
   * testnet pools where 1 WETH would drain multiple ticks and return
   * a misleading "wrecked" price, callers should pass the actual
   * trade size they care about — typically the order's per-slice
   * amount. With a representative probe, the returned priceScaled
   * matches what an actual slice would execute at, and the floor-
   * vs-market colour bands in the UI become honest.
   *
   * Pass 0n / undefined to fall back to the 1-unit default.
   */
  probeOverrideRaw?: bigint,
) {
  const chainId = useChainId();
  const tokenInInfo = findToken(chainId, tokenIn);
  const tokenOutInfo = findToken(chainId, tokenOut);
  const defaultProbe = tokenInInfo ? 10n ** BigInt(tokenInInfo.decimals) : 0n;
  const probeAmount = probeOverrideRaw && probeOverrideRaw > 0n ? probeOverrideRaw : defaultProbe;

  const { data, isLoading, error } = useQuery({
    queryKey: ['marketPrice', chainId, tokenIn, tokenOut, orderType, probeAmount.toString()],
    enabled: !!tokenInInfo && !!tokenOutInfo && tokenIn !== tokenOut && probeAmount > 0n,
    refetchInterval: 10_000,
    staleTime: 5_000,
    queryFn: async (): Promise<bigint> => {
      const readClient = getReadClient(chainId);
      const deployment = getUniswapV3(chainId);
      const { factory, quoterV2 } = deployment;
      const feeTiers = getFeeTiers(deployment);

      // First call for this pair: discover which fee tiers actually have a
      // pool, cache the result. Subsequent calls hit cache and skip the
      // tier-existence probe entirely.
      const key = pairKey(chainId, tokenIn, tokenOut);
      let liveTiers = liveTiersCache.get(key);
      if (!liveTiers) {
        const pools = await Promise.all(
          feeTiers.map((fee) =>
            readClient.readContract({
              address: factory,
              abi: FACTORY_ABI,
              functionName: 'getPool',
              args: [tokenIn, tokenOut, fee],
            }),
          ),
        );
        liveTiers = feeTiers.filter((_, i) => pools[i] !== ZERO);
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
