/**
 * Active scheduled orders panel — shows DCA + TWAP orders in flight
 * for the connected wallet. Each row: progress bar (X/N slices), next
 * execution time, total spent so far, average price paid, cancel
 * button. Refreshes every 5s via useScheduledOrders.
 *
 * Cancel is two-step under the hood:
 *   1. DELETE /scheduled-orders/:id (DB → CANCELLED, keeper stops
 *      picking it up)
 *   2. The user is shown a follow-up toast prompting them to ALSO
 *      call cancelOrder(nonce) on the contract if they want
 *      defense-in-depth (in case the keeper raced ahead between
 *      DB-cancel and the next poll tick). For most users the
 *      off-chain cancel is enough.
 */

import { formatUnits } from '@polyorder/shared';
import { useScheduledOrders, useCancelScheduledOrder } from '../hooks/useScheduledOrders';
import { findToken, tokenLabel } from '../lib/tokens';
import type { ScheduledOrder } from '@polyorder/shared';

interface Props {
  enabled: boolean;
}

export function ScheduledOrdersList({ enabled }: Props) {
  const { data: orders, isLoading } = useScheduledOrders(enabled);
  const cancelMut = useCancelScheduledOrder();

  if (!enabled) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/30 p-4 text-xs text-slate-500">
        Sign-in to see your scheduled orders.
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/30 p-4 text-xs text-slate-500">
        Loading scheduled orders…
      </div>
    );
  }
  // Only show ACTIVE — completed/cancelled/expired clutter the panel.
  const active = (orders ?? []).filter((o) => o.status === 'ACTIVE');
  if (active.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/20 p-4 text-center text-xs text-slate-500">
        No active scheduled orders. Create a DCA or TWAP order to start.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {active.map((o) => (
        <ScheduledRow
          key={o.id}
          order={o}
          onCancel={() => cancelMut.mutate(o.id)}
          isCancelling={cancelMut.isPending && cancelMut.variables === o.id}
        />
      ))}
    </div>
  );
}

function ScheduledRow({
  order,
  onCancel,
  isCancelling,
}: {
  order: ScheduledOrder;
  onCancel: () => void;
  isCancelling: boolean;
}) {
  const inSym = tokenLabel(order.chainId, order.tokenIn);
  const outSym = tokenLabel(order.chainId, order.tokenOut);
  const tokenInInfo = findToken(order.chainId, order.tokenIn);

  // Distinguishing DCA from TWAP without a stored `kind` column on the
  // order: cadence is the cleanest proxy. ≥ 1h interval = DCA (user
  // intent: buy regularly over long horizon). < 1h = TWAP (user intent:
  // slice a large order into a short execution window). Covers >95% of
  // sensible configs from the two forms.
  // Long-term fix: add a `kind: 'DCA' | 'TWAP'` enum column to
  // scheduled_orders + send from the frontend on create.
  const isDca = order.intervalSec >= 3600;
  const kindBadge = isDca ? '📅 DCA' : '⚡ TWAP';

  // Progress bar shows for any bounded order (maxSlices > 0), regardless
  // of DCA/TWAP classification. Open-ended DCA shows count only.
  const isBounded = order.maxSlices > 0;
  const progressLabel = isBounded
    ? `${order.slicesExecuted} / ${order.maxSlices} swaps`
    : `${order.slicesExecuted} swap${order.slicesExecuted === 1 ? '' : 's'} so far`;
  const progressPct = isBounded
    ? Math.min(100, (order.slicesExecuted / order.maxSlices) * 100)
    : 0;

  // Next execution time — first slice fires at startTime; subsequent
  // at lastExecutedAt + intervalSec.
  const nextAtSec = order.lastExecutedAt
    ? Math.floor(new Date(order.lastExecutedAt).getTime() / 1000) + order.intervalSec
    : order.startTime;
  const nowSec = Math.floor(Date.now() / 1000);
  const secondsToNext = Math.max(0, nextAtSec - nowSec);
  const nextLabel =
    secondsToNext === 0
      ? 'Any moment now…'
      : secondsToNext < 60
        ? `in ${secondsToNext}s`
        : secondsToNext < 3600
          ? `in ${Math.round(secondsToNext / 60)} min`
          : secondsToNext < 86400
            ? `in ${Math.round(secondsToNext / 3600)} h`
            : `in ${Math.round(secondsToNext / 86400)} d`;

  const tokenOutInfo = findToken(order.chainId, order.tokenOut);

  // Per-slice human amount + total spent so far.
  const perSliceHuman = tokenInInfo
    ? Number(formatUnits(order.amountPerSlice, tokenInInfo.decimals)).toFixed(4)
    : order.amountPerSlice;
  const totalSpentHuman = tokenInInfo
    ? Number(
        formatUnits(
          (BigInt(order.amountPerSlice) * BigInt(order.slicesExecuted)).toString(),
          tokenInInfo.decimals,
        ),
      ).toFixed(4)
    : '—';

  // Avg price from FILLED executions: sum(amountOut) / sum(amountIn)
  // expressed as "X tokenOut per 1 tokenIn". Only meaningful when at
  // least one slice has filled; otherwise we omit the row entirely.
  const filled = order.executions.filter(
    (e) => e.status === 'FILLED' && e.amountIn && e.amountOut,
  );
  const avgPriceLabel = (() => {
    if (filled.length === 0 || !tokenInInfo || !tokenOutInfo) return null;
    const totalIn = filled.reduce((acc, e) => acc + BigInt(e.amountIn!), 0n);
    const totalOut = filled.reduce((acc, e) => acc + BigInt(e.amountOut!), 0n);
    if (totalIn === 0n) return null;
    const inHuman = Number(formatUnits(totalIn.toString(), tokenInInfo.decimals));
    const outHuman = Number(formatUnits(totalOut.toString(), tokenOutInfo.decimals));
    if (inHuman === 0) return null;
    const perInUnit = outHuman / inHuman;
    // Pick the friendlier direction: show as "X big units per 1 small".
    // For USDC→WETH (0.0005 WETH per USDC) it's friendlier to invert.
    if (perInUnit < 0.01) {
      return `Avg: ${(1 / perInUnit).toFixed(2)} ${inSym} per 1 ${outSym}`;
    }
    return `Avg: ${perInUnit.toFixed(6)} ${outSym} per 1 ${inSym}`;
  })();

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3 text-xs">
      <div className="mb-1 flex items-center justify-between">
        <div className="font-medium text-slate-200">
          {kindBadge}: {perSliceHuman} {inSym} → {outSym}{' '}
          {isDca ? '(recurring)' : `(${order.maxSlices} slices)`}
        </div>
        <button
          onClick={onCancel}
          disabled={isCancelling}
          className="rounded border border-rose-900/50 px-2 py-0.5 text-[10px] text-rose-300 hover:bg-rose-950/40 disabled:opacity-50"
        >
          {isCancelling ? 'Cancelling…' : 'Cancel'}
        </button>
      </div>

      {isBounded && (
        <div className="my-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
          <div
            className="h-full rounded-full bg-cyan-500 transition-all"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}

      <div className="flex items-center justify-between text-[11px] text-slate-400">
        <span>{progressLabel}</span>
        <span>Next: {nextLabel}</span>
      </div>

      <div className="mt-1 text-[10px] text-slate-500">
        Total spent: {totalSpentHuman} {inSym}
        {order.endTime !== 0 && (
          <>
            {' · '}Ends{' '}
            {new Date(order.endTime * 1000).toLocaleString()}
          </>
        )}
      </div>
      {avgPriceLabel && (
        <div className="mt-0.5 text-[10px] text-cyan-400/80">{avgPriceLabel}</div>
      )}
    </div>
  );
}
