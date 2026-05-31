/**
 * Per-slice break-even gate for scheduled (DCA / TWAP) executions and
 * the limit-order economic floor.
 *
 * Why this lives in the keeper (not the contract):
 *   The contract has no oracle, so the maker signs a slice without
 *   knowing the gas environment at execution time. The keeper sees
 *   the live `maxFeePerGas` right before broadcast. If gas would eat
 *   more than the fee earned, we'd rather skip and retry later than
 *   ship a tx that nets a loss for the keeper operator.
 *
 * (Previously the frontend had a static `MIN_SLICE_USD` floor in
 * feeTiers.ts that mirrored this from the design-time side. It was
 * removed once dynamic USD anchors landed here — at $5 it rejected
 * perfectly viable $1-3 slices on Base where the live break-even is
 * ~$1.50 at 0.006 gwei. This module is now the single source of truth
 * for the economic gate.)
 *
 * Method:
 *   1. Estimate USD value of the slice using caller-supplied live USD
 *      anchors (`tokenInUsd`, `tokenOutUsd` from usdPrice.ts).
 *   2. Compute fee USD = sliceUsd × feeBps/10000.
 *   3. Compute gas USD = estimatedGasUnits × maxFeePerGas (wei) ×
 *      nativeUsd / 1e18.
 *   4. Require fee >= gas × MARGIN (1.5x) to absorb price drift,
 *      tokenOut decimals quirks, and quote staleness.
 *
 * Fail-closed on mainnet: any chain with `minLimitOrderUsd` set is
 * treated as production. If we can't price the order at all (no live
 * USD anchor for either side AND no known stable address), the gate
 * REJECTS rather than passing. Otherwise an attacker can pick a thin
 * pair with no USDC reference and silently bypass the entire check.
 */

import { CHAINS, type ChainIdType } from '@owlorderfi/shared';

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
 * Treat any chain flagged `isTestnet: true` in the shared registry as
 * exempt from break-even. Faucet ETH is free, fees are play-money, and
 * slices are tiny by design (you don't get $5 from a faucet). Reading
 * from CHAINS eliminates the per-chain-add maintenance — when we added
 * Arb & OP Sepolia, this list silently went stale and started rejecting
 * testnet TWAP slices. Single source of truth fixes that class of bug.
 */
function isTestnetChain(chainId: number): boolean {
  return CHAINS[chainId as ChainIdType]?.isTestnet ?? false;
}

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
  /**
   * Live native-token USD price (e.g. ETH/USD on Base). Caller fetches
   * via getNativeUsdPrice from usdPrice.ts. Undefined → fall back to the
   * legacy hard-coded table (kept as a stale-conservative safety net so
   * the keeper still works on chains where the dynamic source is broken).
   */
  nativeUsd?: number;
  /**
   * Live USD prices for the order's tokens (per 1 human-unit). Lets
   * priceOrderUsd handle pairs where neither side is a stable (e.g.
   * WETH → cbBTC): use either side's USD value times amount to anchor.
   * Undefined → fall back to the stable-symbol shortcut.
   */
  tokenInUsd?: number | null;
  tokenOutUsd?: number | null;
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
  if (isTestnetChain(input.chainId)) {
    return {
      profitable: true,
      priced: false,
      feeUsd: null,
      gasUsd: 0,
      reason: 'testnet — break-even check skipped',
    };
  }

  // ─── Native gas cost in USD ──────────────────────────────────
  // Prefer the caller-supplied dynamic price (queried from the chain's
  // WETH/USDC pool by getNativeUsdPrice). Falls back to the legacy hard-
  // coded table only when the caller couldn't get a fresh value AND has
  // no cached one. The legacy values are intentionally stale-conservative
  // (over-estimate gas cost slightly rather than under-estimate it).
  const nativeUsd = input.nativeUsd ?? NATIVE_USD_PRICE[input.chainId] ?? 3000;
  // gas_units × wei_per_unit / 1e18 = native_token amount
  const gasNative = Number(input.estimatedGasUnits * input.gasPriceWei) / 1e18;
  const gasUsd = gasNative * nativeUsd;

  // ─── Slice value in USD ──────────────────────────────────────
  // Three anchors, in order of preference:
  //   1. Live USD price for either token (passed by caller from
  //      getTokenUsdPrice). Handles non-stable pairs like WETH → cbBTC.
  //   2. Stable-symbol shortcut for legacy paths that don't pass USD.
  //   3. null → caller couldn't anchor; fall through to global gas cap.
  let sliceUsd: number | null = null;
  if (input.tokenInUsd != null) {
    sliceUsd = input.amountInHuman * input.tokenInUsd;
  } else if (input.tokenOutUsd != null) {
    sliceUsd = input.amountOutHuman * input.tokenOutUsd;
  } else if (STABLE_SYMBOLS.has(input.tokenInSymbol)) {
    sliceUsd = input.amountInHuman;
  } else if (STABLE_SYMBOLS.has(input.tokenOutSymbol)) {
    sliceUsd = input.amountOutHuman;
  }

  if (sliceUsd === null) {
    // Can't price the slice in USD. On mainnet (chains with
    // `minLimitOrderUsd` set) this is a hard fail: the gate would
    // otherwise silently pass, and an attacker could choose a thin
    // non-stable/non-stable pair to defeat the entire economic
    // defense. On testnets (no floor set), keep the legacy "let it
    // through" behaviour — faucets are free and the global gas cap
    // still applies.
    const chainHasFloor = (CHAINS[input.chainId as ChainIdType]?.minLimitOrderUsd ?? 0) > 0;
    if (chainHasFloor) {
      return {
        profitable: false,
        priced: false,
        feeUsd: null,
        gasUsd,
        reason: 'unpriceable pair (no USD anchor either side); refusing on mainnet',
      };
    }
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

/**
 * Price an order's value in USD using stable-side anchor.
 *
 * Returns null when neither side is a known stable (we can't anchor without
 * an oracle), in which case callers should defer to other safeguards
 * (slippage gate, fee tier minima, etc.) rather than blocking the order.
 *
 * Used by the limit executor's dust filter and anywhere we need a coarse
 * USD reading without the full break-even calculus.
 */
export function priceOrderUsd(input: {
  amountInHuman: number;
  amountOutHuman: number;
  tokenInSymbol: string;
  tokenOutSymbol: string;
  /** Live USD-per-token from getTokenUsdPrice; optional. */
  tokenInUsd?: number | null;
  tokenOutUsd?: number | null;
}): number | null {
  // Live USD anchor (preferred — handles non-stable pairs like WETH→cbBTC).
  if (input.tokenInUsd != null) return input.amountInHuman * input.tokenInUsd;
  if (input.tokenOutUsd != null) return input.amountOutHuman * input.tokenOutUsd;
  // Stable-symbol shortcut (legacy fast path).
  if (STABLE_SYMBOLS.has(input.tokenInSymbol)) return input.amountInHuman;
  if (STABLE_SYMBOLS.has(input.tokenOutSymbol)) return input.amountOutHuman;
  return null;
}
