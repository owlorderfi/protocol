import type { Address } from 'viem';

/**
 * In-memory cache of "no Uniswap route found" decisions per pair.
 *
 * After getUniswapQuote() throws because no direct pool and no hub route
 * exists, we mark the pair as dead for a TTL. Subsequent processOrder()
 * calls on that pair skip the expensive 6-RPC-call quote attempt until
 * the TTL expires — at which point we retry in case liquidity arrived.
 *
 * Resets on keeper restart. Not persisted to DB because:
 *  - false positives (we just had RPC blips) should clear quickly
 *  - DB persistence adds cross-restart inertia we don't want
 */

const DEAD_TTL_MS = 5 * 60 * 1000; // 5 minutes
const deadPairs = new Map<string, number>();

function pairKey(a: Address, b: Address): string {
  return [a, b].map((s) => s.toLowerCase()).sort().join('|');
}

export function isPairDead(a: Address, b: Address): boolean {
  const ts = deadPairs.get(pairKey(a, b));
  if (ts === undefined) return false;
  if (Date.now() - ts > DEAD_TTL_MS) {
    deadPairs.delete(pairKey(a, b));
    return false;
  }
  return true;
}

export function markPairDead(a: Address, b: Address): void {
  deadPairs.set(pairKey(a, b), Date.now());
}

/** Test hook — clears all entries. */
export function _resetPoolCache(): void {
  deadPairs.clear();
}
