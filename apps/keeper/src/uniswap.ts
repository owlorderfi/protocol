import { encodeFunctionData, type Address } from 'viem';
import { createClients } from './chain';
import type { OrderTypeStr } from './price';

// ─── Uniswap V3 addresses on Polygon (same code on the Anvil fork) ────
// QuoterV2 — returns a quote without state changes; the ABI marks it `view`
// here so viem's readContract is happy (the on-chain function is declared
// nonpayable, but it never mutates state).
const QUOTER_V2: Address = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';
const SWAP_ROUTER_02: Address = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';

// Fee tier in basis-points (× 100). 500 = 0.05% — most liquid for USDC/WETH on Polygon.
// TODO Phase 3: iterate {100, 500, 3000, 10000} to find the best fill.
const DEFAULT_FEE = 500;

const PRICE_SCALE = 10n ** 18n;

// Chains where the Uniswap V3 contracts above exist (Polygon mainnet + our
// local fork of it). Anvil under Amoy or any other chain would silently fail.
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
   * Current price scaled by 1e18, in the trigger-price convention used by
   * the schema docs: amount of "quote token" per 1 "base token", regardless
   * of swap direction. For a USDC/WETH pair this is always ~$3000e18 when
   * ETH costs ~$3000.
   */
  currentPriceScaled: bigint;
}

/**
 * Quote a swap via Uniswap V3 QuoterV2 + compute the current price scaled by 1e18.
 *
 * The returned `currentPriceScaled` matches the triggerPrice convention used by
 * `isTriggerConditionMet`, so trigger comparison stays in one place.
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
  if (!SUPPORTED_CHAIN_IDS.has(params.chainId)) {
    throw new Error(
      `Uniswap V3 not configured for chainId ${params.chainId}. ` +
        `Supported: ${[...SUPPORTED_CHAIN_IDS].join(', ')}`,
    );
  }

  const { publicClient } = createClients();

  // Quote the actual amountIn from the order — same price the swap will hit.
  let amountOut: bigint;
  try {
    const result = await publicClient.readContract({
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
    amountOut = result[0];
  } catch (err) {
    throw new Error(
      `Uniswap V3 quote failed for ${params.tokenIn}/${params.tokenOut} ` +
        `at fee tier ${DEFAULT_FEE}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (amountOut === 0n) {
    throw new Error(
      `Uniswap returned 0 amountOut — pool may not exist for ${params.tokenIn}/${params.tokenOut} at fee ${DEFAULT_FEE}`,
    );
  }

  // Compute "quote per base" scaled by 1e18. Direction depends on which side
  // of the swap the quote token sits on:
  //   LIMIT_BUY  (USDC→WETH): amountIn=USDC, amountOut=WETH
  //     → price = (amountIn × outScale) / (amountOut × inScale) × 1e18
  //   non-BUY    (WETH→USDC): amountIn=WETH, amountOut=USDC
  //     → price = (amountOut × inScale)  / (amountIn  × outScale) × 1e18
  const inScale = 10n ** BigInt(params.tokenInDecimals);
  const outScale = 10n ** BigInt(params.tokenOutDecimals);

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
