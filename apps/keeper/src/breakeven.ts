/**
 * Per-slice break-even gate for scheduled (DCA / TWAP) executions.
 *
 * Why this lives in the keeper (not the contract):
 *   The contract has no oracle, so the maker signs a slice without
 *   knowing the gas environment at execution time. The keeper sees
 *   the live `maxFeePerGas` right before broadcast. If gas would eat
 *   more than the fee earned, we'd rather skip and retry later than
 *   ship a tx that nets a loss for the keeper operator.
 *
 * Frontend has a parallel cap (`MIN_SLICE_USD` in feeTiers.ts) that
 * refuses to even create the order if the per-slice value is too
 * small. That covers the "design-time" mistake. This module covers
 * the "execution-time" surprise: gas spiked between sign and
 * execution, or the token price collapsed and a previously-OK slice
 * is now sub-economic.
 *
 * Method:
 *   1. Estimate USD value of the slice (use stable side if either
 *      token is one; otherwise we can't price it, so we let it
 *      through — the global gas cap is still a safety net).
 *   2. Compute fee USD = sliceUsd × feeBps/10000.
 *   3. Compute gas USD = estimatedGasUnits × maxFeePerGas (wei) ×
 *      nativeUsdPrice / 1e18.
 *   4. Require fee >= gas × MARGIN (1.5x) to absorb price drift,
 *      tokenOut decimals quirks, ETH/POL price staleness in our
 *      hardcoded constants.
 *
 * Native USD prices are HARDCODED for now (refresh in source when
 * markets drift materially). A proper Chainlink-feed-based oracle
 * is overkill until volumes justify it; the 50% margin absorbs ~1.5x
 * drift cleanly.
 */

const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'BUSD', 'USDP', 'USDS', 'FRAX', 'LUSD']);

/**
 * Approximate USD price of the chain's native gas token. Refresh in
 * source when these drift > ~30% from market (the break-even margin
 * absorbs the rest). Falls back to 3000 (ETH-ish) for unknown chains.
 */
const NATIVE_USD_PRICE: Record<number, number> = {
  1: 3000,        // Ethereum mainnet (ETH)
  8453: 3000,     // Base mainnet (ETH)
  84532: 3000,    // Base Sepolia (ETH; testnet but same denom math)
  10: 3000,       // Optimism (ETH)
  42161: 3000,    // Arbitrum (ETH)
  137: 0.5,       // Polygon (POL)
  80002: 0.5,     // Polygon Amoy (POL)
  31337: 0.5,     // Anvil (assumed Polygon fork — adjust if you fork ETH)
};

/** Require fee revenue to exceed gas cost by this much. Absorbs ETH
 *  price drift, gas estimation error, and post-broadcast price moves. */
const SAFETY_MARGIN = 1.5;

/**
 * Chain IDs treated as testnets. Break-even doesn't apply there —
 * faucet ETH is free, fees are play-money, and slices are tiny by
 * design (you don't get $5 from a faucet). Mirrors the
 * `isTestnet: true` entries in `packages/shared/src/constants/chains.ts`
 * — keep these two lists in lockstep when adding chains.
 */
const TESTNET_CHAIN_IDS = new Set<number>([
  84532,  // Base Sepolia
  80002,  // Polygon Amoy
  31337,  // Anvil local
  11155111, // Sepolia (placeholder for the day we add it)
]);

export interface BreakEvenInput {
  chainId: number;
  feeBps: number;
  amountInHuman: number;
  amountOutHuman: number;
  tokenInSymbol: string;
  tokenOutSymbol: string;
  estimatedGasUnits: bigint;
  /** Effective gas price wei (EIP-1559 maxFeePerGas). */
  gasPriceWei: bigint;
}

export interface BreakEvenResult {
  profitable: boolean;
  /** Whether we could price the slice in USD at all (false → check skipped). */
  priced: boolean;
  feeUsd: number | null;
  gasUsd: number;
  reason: string | null;
}

export function checkBreakEven(input: BreakEvenInput): BreakEvenResult {
  // ─── Testnet bypass ──────────────────────────────────────────
  // Testnet faucets don't cost real money; refusing slices because
  // "fee can't cover gas" is meaningless when both sides are zero.
  // The fee tier validation + global gas cap still apply.
  if (TESTNET_CHAIN_IDS.has(input.chainId)) {
    return {
      profitable: true,
      priced: false,
      feeUsd: null,
      gasUsd: 0,
      reason: 'testnet — break-even check skipped',
    };
  }

  // ─── Native gas cost in USD ──────────────────────────────────
  const nativeUsd = NATIVE_USD_PRICE[input.chainId] ?? 3000;
  // gas_units × wei_per_unit / 1e18 = native_token amount
  const gasNative = Number(input.estimatedGasUnits * input.gasPriceWei) / 1e18;
  const gasUsd = gasNative * nativeUsd;

  // ─── Slice value in USD ──────────────────────────────────────
  // Prefer stable side; either gives us USD anchor.
  let sliceUsd: number | null = null;
  if (STABLE_SYMBOLS.has(input.tokenInSymbol)) {
    sliceUsd = input.amountInHuman;
  } else if (STABLE_SYMBOLS.has(input.tokenOutSymbol)) {
    sliceUsd = input.amountOutHuman;
  }

  if (sliceUsd === null) {
    // Can't price — let it through. Global MAX_FEE_PER_GAS_GWEI cap
    // is still active as a coarser safety net.
    return {
      profitable: true,
      priced: false,
      feeUsd: null,
      gasUsd,
      reason: 'unpriced (no stable side); deferring to global gas cap',
    };
  }

  const feeUsd = (sliceUsd * input.feeBps) / 10_000;
  const profitable = feeUsd >= gasUsd * SAFETY_MARGIN;

  return {
    profitable,
    priced: true,
    feeUsd,
    gasUsd,
    reason: profitable
      ? null
      : `Fee $${feeUsd.toFixed(4)} < gas $${gasUsd.toFixed(4)} × ${SAFETY_MARGIN} margin — skip until gas drops`,
  };
}
