import { encodeFunctionData, encodePacked, type Address, type Hex } from 'viem';
import {
  getFeeTiers,
  requireUniswapV3,
  type ChainIdType,
} from '@polyorder/shared';
import { createClients } from './chain';
import type { OrderTypeStr } from './price';

// All chain-specific addresses (QuoterV2, SwapRouter02, hub tokens,
// inner hop fee) live in @polyorder/shared/constants/chains.ts. Pull
// them with `requireUniswapV3(chainId)` at the call sites below.
const PRICE_SCALE = 10n ** 18n;

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
  {
    type: 'function',
    name: 'quoteExactInput',
    stateMutability: 'view',
    inputs: [
      { name: 'path', type: 'bytes' },
      { name: 'amountIn', type: 'uint256' },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96AfterList', type: 'uint160[]' },
      { name: 'initializedTicksCrossedList', type: 'uint32[]' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

const SWAP_ROUTER_ABI = [
  {
    type: 'function',
    name: 'exactInputSingle',
    stateMutability: 'payable',
    inputs: [
      {
        type: 'tuple',
        name: 'params',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'exactInput',
    stateMutability: 'payable',
    inputs: [
      {
        type: 'tuple',
        name: 'params',
        components: [
          { name: 'path', type: 'bytes' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const;

export type Route =
  | { kind: 'direct'; fee: number }
  | { kind: 'multihop'; path: Hex; tokens: Address[]; fees: number[] };

export interface Quote {
  amountOut: bigint;
  currentPriceScaled: bigint;
  route: Route;
}

/**
 * Encode a Uniswap V3 path:
 *   token0 (20B) | fee0 (3B) | token1 (20B) | fee1 (3B) | ... | tokenN (20B)
 */
function encodePath(tokens: Address[], fees: number[]): Hex {
  if (tokens.length !== fees.length + 1) {
    throw new Error(`Path tokens (${tokens.length}) must equal fees (${fees.length}) + 1`);
  }
  const types: ('address' | 'uint24')[] = [];
  const values: (Address | number)[] = [];
  for (let i = 0; i < tokens.length; i++) {
    types.push('address');
    values.push(tokens[i]);
    if (i < fees.length) {
      types.push('uint24');
      values.push(fees[i]);
    }
  }
  return encodePacked(types, values);
}

/**
 * Multi-route quote: tries every direct fee tier in parallel, plus a 2-hop
 * route through each hub token (at the hub fee tier). Picks the path with
 * the highest amountOut. Returns null when no route returns liquidity.
 */
export async function getUniswapQuote(params: {
  orderType: OrderTypeStr;
  chainId: number;
  tokenIn: Address;
  tokenOut: Address;
  amountInRaw: bigint;
  tokenInDecimals: number;
  tokenOutDecimals: number;
}): Promise<Quote> {
  // Throws with a clear message if the chain has no official Uniswap V3
  // deployment (e.g., Polygon Amoy). Boot-time misconfig surfaces here,
  // not as a cryptic RPC failure further down.
  const chainCfg = requireUniswapV3(params.chainId as ChainIdType);
  const feeTiers = getFeeTiers(chainCfg);

  const { publicClient } = createClients();

  // ─── Direct routes at every fee tier ────────────────────────────────
  const directProbes = feeTiers.map(async (fee) => {
    try {
      const r = await publicClient.readContract({
        address: chainCfg.quoterV2,
        abi: QUOTER_ABI,
        functionName: 'quoteExactInputSingle',
        args: [
          {
            tokenIn: params.tokenIn,
            tokenOut: params.tokenOut,
            amountIn: params.amountInRaw,
            fee,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });
      const out = r[0];
      return out > 0n ? ({ kind: 'direct' as const, fee, amountOut: out } as const) : null;
    } catch {
      return null;
    }
  });

  // ─── 2-hop routes through hub tokens (one combo per hub, hopFee) ──
  const tokenInLower = params.tokenIn.toLowerCase();
  const tokenOutLower = params.tokenOut.toLowerCase();
  const hopProbes = chainCfg.hubTokens
    .filter((h) => h.toLowerCase() !== tokenInLower && h.toLowerCase() !== tokenOutLower)
    .map(async (hub) => {
      try {
        const tokens: Address[] = [params.tokenIn, hub, params.tokenOut];
        const fees = [chainCfg.hopFee, chainCfg.hopFee];
        const path = encodePath(tokens, fees);
        const r = await publicClient.readContract({
          address: chainCfg.quoterV2,
          abi: QUOTER_ABI,
          functionName: 'quoteExactInput',
          args: [path, params.amountInRaw],
        });
        const out = r[0];
        return out > 0n
          ? ({ kind: 'multihop' as const, path, tokens, fees, amountOut: out } as const)
          : null;
      } catch {
        return null;
      }
    });

  const candidates = (await Promise.all([...directProbes, ...hopProbes])).filter(
    (c): c is NonNullable<typeof c> => c !== null,
  );
  if (candidates.length === 0) {
    throw new Error(
      `No Uniswap V3 route found for ${params.tokenIn} → ${params.tokenOut} ` +
        `(tried ${feeTiers.length} direct fee tiers + ${chainCfg.hubTokens.length} hubs)`,
    );
  }

  // Pick the route with the most tokenOut. amountOut is bigint so comparing
  // by direct subtraction works.
  let best = candidates[0];
  for (const c of candidates) {
    if (c.amountOut > best.amountOut) best = c;
  }

  // Price math is identical regardless of routing — only depends on the
  // overall amountIn / amountOut ratio (decimal-adjusted).
  const inScale = 10n ** BigInt(params.tokenInDecimals);
  const outScale = 10n ** BigInt(params.tokenOutDecimals);
  const currentPriceScaled =
    params.orderType === 'LIMIT_BUY'
      ? (params.amountInRaw * PRICE_SCALE * outScale) / (best.amountOut * inScale)
      : (best.amountOut * PRICE_SCALE * inScale) / (params.amountInRaw * outScale);

  const route: Route =
    best.kind === 'direct'
      ? { kind: 'direct', fee: best.fee }
      : { kind: 'multihop', path: best.path, tokens: best.tokens, fees: best.fees };

  return { amountOut: best.amountOut, currentPriceScaled, route };
}

/** Build calldata for the picked route — single-hop or multi-hop. */
export function buildSwapCalldata(params: {
  chainId: number;
  tokenIn: Address;
  tokenOut: Address;
  route: Route;
  amountInRaw: bigint;
  minAmountOutRaw: bigint;
  recipient: Address;
}): { aggregator: Address; calldata: Hex } {
  const chainCfg = requireUniswapV3(params.chainId as ChainIdType);
  let calldata: Hex;
  if (params.route.kind === 'direct') {
    calldata = encodeFunctionData({
      abi: SWAP_ROUTER_ABI,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn: params.tokenIn,
          tokenOut: params.tokenOut,
          fee: params.route.fee,
          recipient: params.recipient,
          amountIn: params.amountInRaw,
          amountOutMinimum: params.minAmountOutRaw,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
  } else {
    calldata = encodeFunctionData({
      abi: SWAP_ROUTER_ABI,
      functionName: 'exactInput',
      args: [
        {
          path: params.route.path,
          recipient: params.recipient,
          amountIn: params.amountInRaw,
          amountOutMinimum: params.minAmountOutRaw,
        },
      ],
    });
  }
  return { aggregator: chainCfg.swapRouter02, calldata };
}

/** Short human description of a route — for logging / DB feeTier display. */
export function describeRoute(route: Route): string {
  if (route.kind === 'direct') {
    return `direct@${route.fee}`;
  }
  // Show fees joined by → between hops, e.g. "USDC→WETH→WBTC via 500/500"
  return `multihop[${route.fees.join('/')}]`;
}

/** Best-effort fee for DB persistence. Direct: that fee. Multihop: first hop fee. */
export function routeFeeForDb(route: Route): number {
  return route.kind === 'direct' ? route.fee : route.fees[0];
}
