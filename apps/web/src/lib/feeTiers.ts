// Display-only fee tier system. Today the contract charges a single
// `feeBps` for every order regardless of size. This module categorizes
// orders into tiers based on USD value so the UI can show users where
// they sit in the future per-tier pricing model.
//
// Real per-order pricing arrives in Phase 5a Tier 1: contract Order
// struct gets a `feeBps` field, frontend picks it per tier and signs it,
// contract honors the signed value. Until then, tier is informational.

export interface FeeTier {
  name: string;
  minUsd: number;
  /** Aspirational fee in bps (1 bp = 0.01%) once per-tier pricing ships. */
  targetBps: number;
  /** Tailwind color classes for the badge. */
  badge: string;
}

/**
 * Minimum per-slice USD value the frontend is willing to submit for
 * scheduled (DCA / TWAP) orders. Driven by keeper break-even math:
 * at the default 30 bps fee tier a $5 slice nets ~$0.015 in fee,
 * which covers gas on L2/Polygon even during moderate congestion
 * (up to ~100 gwei on Polygon = ~$0.013 cost). Below this size the
 * keeper actively loses money when gas spikes, so we refuse to
 * create the order in the first place.
 *
 * One-shot limit orders are NOT capped here — those run once and
 * the user picks their own gas/fee timing.
 */
export const MIN_SLICE_USD = 5;

export const FEE_TIERS: FeeTier[] = [
  {
    name: 'Default',
    minUsd: 0,
    targetBps: 30,
    badge: 'bg-slate-700/40 text-slate-300 border-slate-600/50',
  },
  {
    name: 'Bronze',
    minUsd: 100,
    targetBps: 25,
    badge: 'bg-amber-700/15 text-amber-300 border-amber-700/40',
  },
  {
    name: 'Silver',
    minUsd: 1_000,
    targetBps: 20,
    badge: 'bg-slate-400/20 text-slate-200 border-slate-400/40',
  },
  {
    name: 'Gold',
    minUsd: 10_000,
    targetBps: 15,
    badge: 'bg-yellow-500/15 text-yellow-300 border-yellow-500/40',
  },
];

/** Tier that matches a given order size in USD. Higher = better discount. */
export function tierForUsd(usd: number): FeeTier {
  // Walk from highest tier down; first match wins.
  for (let i = FEE_TIERS.length - 1; i >= 0; i--) {
    if (usd >= FEE_TIERS[i].minUsd) return FEE_TIERS[i];
  }
  return FEE_TIERS[0];
}

/** Stablecoin symbols we treat as 1:1 with USD for tier estimation. */
const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'BUSD']);

/**
 * Estimate the USD value of `amountInHuman` tokenIn.
 *
 * Three paths:
 *   1. tokenIn is itself a stablecoin → amount IS the USD value
 *   2. tokenOut is a stablecoin AND we have a current quote → derive USD
 *      from the quote (price = USD per tokenIn for that direction)
 *   3. Neither → null (no oracle yet, tier defaults to the unfavored end)
 *
 * Used for tier classification on limit, DCA, and TWAP orders. Per-slice
 * estimation for scheduled orders feeds the SAME helper — just pass the
 * per-slice human amount instead of the full order amount.
 */
export function estimateOrderUsd(params: {
  amountInHuman: string;
  tokenInSymbol: string;
  tokenOutSymbol?: string;
  /** tokenOut human per 1 tokenIn human, scaled 1e18 (from useMarketPrice). */
  priceScaled?: bigint | null;
}): number | null {
  const amt = parseFloat(params.amountInHuman);
  if (!amt || amt <= 0 || Number.isNaN(amt)) return null;
  if (STABLE_SYMBOLS.has(params.tokenInSymbol)) return amt;
  // tokenIn non-stable: try to read USD via the current quote when the
  // OTHER side is a stable. priceScaled is "tokenOut per tokenIn ×1e18".
  if (
    params.tokenOutSymbol &&
    STABLE_SYMBOLS.has(params.tokenOutSymbol) &&
    params.priceScaled &&
    params.priceScaled > 0n
  ) {
    const usdPerTokenIn = Number(params.priceScaled) / 1e18;
    return amt * usdPerTokenIn;
  }
  return null;
}
