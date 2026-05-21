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
 * v1 only handles the case where tokenIn is itself a stablecoin (covers the
 * typical LIMIT_BUY flow: spend USDC, buy asset). Non-stable tokenIn returns
 * null — would need a dedicated USD oracle, deferred to Phase 5.
 */
export function estimateOrderUsd(params: {
  amountInHuman: string;
  tokenInSymbol: string;
}): number | null {
  const amt = parseFloat(params.amountInHuman);
  if (!amt || amt <= 0 || Number.isNaN(amt)) return null;
  if (STABLE_SYMBOLS.has(params.tokenInSymbol)) return amt;
  return null;
}
