import { useMemo } from 'react';
import { useOrders } from './useOrders';
import { useScheduledOrders } from './useScheduledOrders';

/**
 * Sum of allowance the user's CURRENTLY ACTIVE orders will still consume
 * on `(chainId, tokenIn)` between now and natural completion. Used by
 * the approval flow to size "exact" approvals correctly — an exact
 * approve that only covers the new order would race against allowance
 * already earmarked for existing orders and silently revert one of
 * them with `ERC20: insufficient allowance`.
 *
 * Three sources, summed:
 *   - Scheduled BOUNDED: `amountPerSlice × (maxSlices - slicesExecuted)`.
 *     Open-ended (maxSlices=0) DCA orders are EXCLUDED because the
 *     forms force unlimited approval for them — no race possible.
 *   - Limit orders OPEN: `amountIn` (the contract will pull the full
 *     amount when the trigger fires; nothing partial).
 *
 * Returns 0n while either query is loading so we don't gate the UI on
 * incomplete data; the 5-sec refetch tail recovers naturally.
 */
export function useOutstandingCommitment(
  enabled: boolean,
  chainId: number,
  tokenIn: string | undefined,
): bigint {
  const { data: scheduledOrders } = useScheduledOrders(enabled);
  const { data: limitOrders } = useOrders(enabled);

  return useMemo(() => {
    if (!tokenIn) return 0n;
    const targetToken = tokenIn.toLowerCase();

    let sum = 0n;

    for (const o of scheduledOrders ?? []) {
      if (o.status !== 'ACTIVE') continue;
      if (o.chainId !== chainId) continue;
      if (o.tokenIn.toLowerCase() !== targetToken) continue;
      // Open-ended scheduled orders force unlimited approval at create
      // time, so allowance is already maxUint256 — nothing to add.
      if (o.maxSlices === 0) continue;
      const remaining = Math.max(0, o.maxSlices - o.slicesExecuted);
      sum += BigInt(o.amountPerSlice) * BigInt(remaining);
    }

    for (const o of limitOrders ?? []) {
      if (o.status !== 'OPEN') continue;
      if (o.chainId !== chainId) continue;
      if (o.tokenIn.toLowerCase() !== targetToken) continue;
      sum += BigInt(o.amountIn);
    }

    return sum;
  }, [scheduledOrders, limitOrders, chainId, tokenIn]);
}
