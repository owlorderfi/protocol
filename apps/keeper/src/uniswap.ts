import { encodeFunctionData, encodePacked, type Address, type Hex } from 'viem';
import { createClients } from './chain';

// ─── Uniswap V3 addresses on Polygon (same on the Anvil fork) ─────────
const QUOTER_V2: Address = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';
const SWAP_ROUTER_02: Address = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';

// Hub tokens used as intermediate hops when no direct pool exists or
// a routed path gives a better fill. Picked for being the deepest pools
// on Polygon. WMATIC could be added but USDC + WETH cover ~95% of routes.
const HUB_TOKENS: Address[] = [
  '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // USDC native
  '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', // WETH
];

// Uniswap V3 fee tiers (1/1_000_000 units).
const FEE_TIERS = [100, 500, 3000, 10000] as const;

// For multi-hop we don't iterate every fee × fee combo (16 each direction).
// Use 0.05% (500) as the intermediate hop fee — most liquid hub pools sit there.
const HOP_FEE = 500;

const PRICE_SCALE = 10n ** 18n;
const SUPPORTED_CHAIN_IDS = new Set([137, 31337]);

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
  chainId: number;
  tokenIn: Address;
  tokenOut: Address;
  amountInRaw: bigint;
  tokenInDecimals: number;
  tokenOutDecimals: number;
}): Promise<Quote> {
  if (!SUPPORTED_CHAIN_IDS.has(params.chainId)) {
    throw new Error(
      `Uniswap V3 not configured for chainId ${params.chainId}. ` +
        `Supported: ${[...SUPPORTED_CHAIN_IDS].join(', ')}`,
    );
  }

  const { publicClient } = createClients();

  // ─── Direct routes at every fee tier ────────────────────────────────
  const directProbes = FEE_TIERS.map(async (fee) => {
    try {
      const r = await publicClient.readContract({
        address: QUOTER_V2,
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

  // ─── 2-hop routes through hub tokens (one combo per hub, fee=500) ──
  const tokenInLower = params.tokenIn.toLowerCase();
  const tokenOutLower = params.tokenOut.toLowerCase();
  const hopProbes = HUB_TOKENS.filter(
    (h) => h.toLowerCase() !== tokenInLower && h.toLowerCase() !== tokenOutLower,
  ).map(async (hub) => {
    try {
      const tokens = [params.tokenIn, hub, params.tokenOut];
      const fees = [HOP_FEE, HOP_FEE];
      const path = encodePath(tokens, fees);
      const r = await publicClient.readContract({
        address: QUOTER_V2,
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
        `(tried 4 direct fee tiers + ${HUB_TOKENS.length} hubs)`,
    );
  }

  // Pick the route with the most tokenOut. amountOut is bigint so comparing
  // by direct subtraction works.
  let best = candidates[0];
  for (const c of candidates) {
    if (c.amountOut > best.amountOut) best = c;
  }

  // Price math is identical regardless of routing — only depends on the
  // overall amountIn / amountOut ratio (decimal-adjusted). Unified convention
  // is tokenIn-per-tokenOut, irrespective of trigger direction.
  const inScale = 10n ** BigInt(params.tokenInDecimals);
  const outScale = 10n ** BigInt(params.tokenOutDecimals);
  const currentPriceScaled =
    (params.amountInRaw * PRICE_SCALE * outScale) / (best.amountOut * inScale);

  const route: Route =
    best.kind === 'direct'
      ? { kind: 'direct', fee: best.fee }
      : { kind: 'multihop', path: best.path, tokens: best.tokens, fees: best.fees };

  return { amountOut: best.amountOut, currentPriceScaled, route };
}

/** Build calldata for the picked route — single-hop or multi-hop. */
export function buildSwapCalldata(params: {
  tokenIn: Address;
  tokenOut: Address;
  route: Route;
  amountInRaw: bigint;
  minAmountOutRaw: bigint;
  recipient: Address;
}): { aggregator: Address; calldata: Hex } {
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
  return { aggregator: SWAP_ROUTER_02, calldata };
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
