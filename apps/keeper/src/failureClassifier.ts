/**
 * Shared "is this failure recoverable?" classifier for both the Limit
 * and Scheduled executors. The two paths used to drift — scheduled had
 * its own classifyFailure that caught e.g. `InvalidSignature`, while
 * Limit always re-tried until LIMIT_MAX_RETRIES regardless of cause.
 * The user's first overnight test surfaced exactly that: a Limit order
 * whose maker had moved USDC out of the wallet failed 15 times with
 * `ERC20: transfer amount exceeds balance` before escalating — every
 * retry was guaranteed to revert. Centralising the rule both removes
 * that waste AND keeps the two executors honest with each other when
 * we discover new permanent patterns.
 *
 * Permanent = no retry possible without maker action (re-sign / top-up
 *             / cancel / change wallet). Skip straight to FAILED.
 * Transient = condition could clear on its own (gas drops, pool moves,
 *             RPC recovers). Bump retry counter, fall back into queue.
 *
 * Default: transient. False positives (retrying a permanent failure)
 * waste a few RPC calls + log lines; false negatives (permanently
 * dropping a recoverable order) silently break the user's order flow.
 * Strongly favour the former.
 *
 * IMPORTANT: do NOT match the bare word 'signature' — viem's diagnostic
 * prefix "reverted with the following signature: 0x..." contains it
 * and would mark every undecoded revert as permanent. Real incident:
 * slice 9 of e33731f8 on Arb, 2026-05-27 — actually InsufficientOutput,
 * misclassified permanent because the diagnostic text contained the
 * word "signature".
 */

import { GasTooHighError } from './chain';

export function classifyFailure(err: unknown): { permanent: boolean } {
  // GasTooHigh is OUR cap check, not a chain reject. Always transient —
  // the cap exists precisely because we want to back off and try later.
  if (err instanceof GasTooHighError) return { permanent: false };

  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();

  // BREAK_EVEN_SKIP is the keeper's own pre-flight gate — fee < gas × 1.5
  // safety margin. Will clear when gas drops.
  if (msg.includes('break_even_skip')) return { permanent: false };

  // Maker signed an order with NO on-chain floor (minPriceScaled = 0)
  // back when that was allowed. The new contract rejects on submission
  // — only fix is to re-sign with a floor. A.12.
  if (msg.includes('no_price_floor')) return { permanent: true };

  // Wallet rotated / schema drift / domain mismatch — signature no
  // longer recovers to the maker address. Maker must re-sign.
  if (msg.includes('invalidsignature') || msg.includes('signermismatch')) {
    return { permanent: true };
  }

  // Maker's signature validity passed (deadline or order endTime). Can't
  // be revived — only by signing a fresh order.
  if (msg.includes('orderexpired') || msg.includes('scheduledexpired')) {
    return { permanent: true };
  }

  // Maker cancelled the order via cancelOrder (which marks the nonce as
  // used). Could also fire if the maker re-used a nonce off-chain — same
  // result either way: no retry possible.
  if (msg.includes('noncealreadyused') || msg.includes('scheduledexhausted')) {
    return { permanent: true };
  }

  // ERC20 fund-side errors bubble through AggregatorCallFailed wrapper
  // in different shapes depending on which token contract reverted:
  //   - OpenZeppelin v4: "ERC20: insufficient allowance"
  //   - OpenZeppelin v5: "ERC20InsufficientBalance"
  //   - Older / forks:   "ERC20: transfer amount exceeds balance"
  //   - Native USDC:     "ERC20: transfer amount exceeds allowance"
  // Catch all three idioms. None of these clear without maker action
  // (top-up or re-approve).
  if (
    msg.includes('exceeds balance') ||
    msg.includes('exceeds allowance') ||
    (msg.includes('insufficient') && (msg.includes('balance') || msg.includes('allowance')))
  ) {
    return { permanent: true };
  }

  // Everything else (InsufficientOutput, RPC blips, generic reverts) →
  // transient. The Limit / Scheduled call sites then decide what cap
  // and backoff fits their flow.
  return { permanent: false };
}
