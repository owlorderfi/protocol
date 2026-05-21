import { encodeFunctionData, type Address } from 'viem';
import { createClients } from './chain';
import type { OrderTypeStr } from './price';

// ─── Uniswap V3 addresses on Polygon (same code in Anvil fork) ─────
// QuoterV2 — view-like quotes via revert-based pattern
const QUOTER_V2: Address = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';
// SwapRouter02 — universal swap router; no deadline param in exactInputSingle
const SWAP_ROUTER_02: Address = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';

// Fee tier in basis-points (× 100). 500 = 0.05% — most liquid for USDC/WETH on Polygon.
// TODO Phase 3: iterate {100, 500, 3000, 10000} to find best fill.
const DEFAULT_FEE = 500;

const PRICE_SCALE = 10n ** 18n;

const QUOTER_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable', // marked nonpayable but called via eth_call
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
] as const;

export interface Quote {
  /** Expected raw amountOut for the order's amountIn at current pool state. */
  amountOut: bigint;
  /**
   * Current price scaled by 1e18, in the same units as the order's triggerPrice.
   * For both LIMIT_BUY and LIMIT_SELL: this is "amount of tokenIn per 1 tokenOut"
   * (e.g. USDC per WETH ≈ 3000e18 when ETH = $3000).
   */
  currentPriceScaled: bigint;
}

/**
 * Quote a swap via Uniswap V3 QuoterV2 + compute the current price scaled by 1e18.
 *
 * The returned `currentPriceScaled` matches the triggerPrice convention used by
 * `isTriggerConditionMet` (no-op replacement for the old 1inch-USD-based math).
 */
export async function getUniswapQuote(params: {
  orderType: OrderTypeStr;
  tokenIn: Address;
  tokenOut: Address;
  amountInRaw: bigint;
  tokenInDecimals: number;
  tokenOutDecimals: number;
}): Promise<Quote> {
  const { publicClient } = createClients();

  // Quote the actual amountIn from the order — this is what we'll execute,
  // so the trigger check uses the same price the swap will hit.
  const result = await publicClient.simulateContract({
    address: QUOTER_V2,
    abi: QUOTER_ABI,
    functionName: 'quoteExactInputSingle',
    args: [
      {
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        amountIn: params.amountInRaw,
        fee: DEFAULT_FEE,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  const amountOut = result.result[0];

  // Compute "tokenIn per 1 tokenOut" (the asset-price convention used by triggers).
  // For LIMIT_BUY (USDC→WETH): pay amountIn USDC, get amountOut WETH.
  //   price = amountIn / amountOut, decimal-adjusted, × 1e18.
  // For non-buy (WETH→USDC): pay amountIn WETH, get amountOut USDC.
  //   price = amountOut / amountIn, decimal-adjusted, × 1e18.
  const inScale = 10n ** BigInt(params.tokenInDecimals);
  const outScale = 10n ** BigInt(params.tokenOutDecimals);

  if (amountOut === 0n) {
    throw new Error('Uniswap quote returned 0 — pool may not exist for this pair/fee');
  }

  const currentPriceScaled =
    params.orderType === 'LIMIT_BUY'
      ? (params.amountInRaw * PRICE_SCALE * outScale) / (amountOut * inScale)
      : (amountOut * PRICE_SCALE * inScale) / (params.amountInRaw * outScale);

  return { amountOut, currentPriceScaled };
}

/** Build calldata for SwapRouter02.exactInputSingle. */
export function buildSwapCalldata(params: {
  tokenIn: Address;
  tokenOut: Address;
  amountInRaw: bigint;
  minAmountOutRaw: bigint;
  recipient: Address;
}): { aggregator: Address; calldata: `0x${string}` } {
  const calldata = encodeFunctionData({
    abi: SWAP_ROUTER_ABI,
    functionName: 'exactInputSingle',
    args: [
      {
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        fee: DEFAULT_FEE,
        recipient: params.recipient,
        amountIn: params.amountInRaw,
        amountOutMinimum: params.minAmountOutRaw,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  return { aggregator: SWAP_ROUTER_02, calldata };
}
