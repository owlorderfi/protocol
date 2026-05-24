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

import { useEffect, useState } from 'react';
import { formatUnits } from '@owlorderfi/shared';
import { useScheduledOrders, useCancelScheduledOrder } from '../hooks/useScheduledOrders';
import { findToken, tokenLabel, txExplorerUrl } from '../lib/tokens';
import type { ScheduledOrder } from '@owlorderfi/shared';

// Tokens we treat as the "quote" side when displaying average price —
// price-per-1-non-stable feels more natural to most users
// ("WETH costs $2100") than the inverse ratio.
import { classifyPair, computeFloor, flipDisplay, formatAssetPrice } from '../lib/priceFloor';
import { formatSmart } from '../lib/formatAmount';

const QUOTE_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'USDP', 'USDS', 'FRAX', 'LUSD']);

interface Props {
  enabled: boolean;
  /**
   * Optional kind filter:
   *   'dca'  → only show DCA orders (intervalSec ≥ 1h)
   *   'twap' → only show TWAP orders (intervalSec < 1h)
   *   undefined → show all (default)
   * Matches the heuristic used in ScheduledRow's kindBadge so list +
   * row labels stay consistent.
   */
  kindFilter?: 'dca' | 'twap';
}

export function ScheduledOrdersList({ enabled, kindFilter }: Props) {
  const { data: orders, isLoading } = useScheduledOrders(enabled);
  const cancelMut = useCancelScheduledOrder();

  if (!enabled) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/30 p-4 text-xs text-slate-400">
        Sign-in to see your scheduled orders.
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/30 p-4 text-xs text-slate-400">
        Loading scheduled orders…
      </div>
    );
  }
  // Split into active (always visible at the top) and finalized
  // (cancelled / completed / expired — collapsed under a "History"
  // toggle so the panel stays short by default but full history
  // remains one click away).
  const filtered = (orders ?? []).filter((o) => {
    if (!kindFilter) return true;
    const isDca = o.intervalSec >= 3600;
    return kindFilter === 'dca' ? isDca : !isDca;
  });
  const active = filtered.filter((o) => o.status === 'ACTIVE');
  const history = filtered
    .filter((o) => o.status !== 'ACTIVE')
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

  if (active.length === 0 && history.length === 0) {
    const what = kindFilter ? kindFilter.toUpperCase() : 'scheduled';
    return (
      <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/20 p-4 text-center text-xs text-slate-400">
        No {what} orders yet.
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
      {history.length > 0 && (
        <HistorySection
          orders={history}
          onCancel={(id) => cancelMut.mutate(id)}
          cancellingId={cancelMut.isPending ? (cancelMut.variables as string) : null}
        />
      )}
    </div>
  );
}

/**
 * Collapsible bucket for finalized orders (cancelled / completed /
 * expired). Collapsed by default so the active panel stays short;
 * one click reveals the full history with all execution data intact.
 */
function HistorySection({
  orders,
  onCancel,
  cancellingId,
}: {
  orders: ScheduledOrder[];
  onCancel: (id: string) => void;
  cancellingId: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/20">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-slate-300 hover:text-cyan-300"
      >
        <span>
          <span className="text-slate-400">{open ? '▾' : '▸'}</span>{' '}
          History ({orders.length})
        </span>
        <span className="text-xs text-slate-400">
          {open ? 'hide' : 'show'}
        </span>
      </button>
      {open && (
        // Cap the expanded section at ~60% of the viewport so a long
        // history doesn't push the rest of the page out of reach.
        // Global scrollbar styling (index.css) keeps the thin slate
        // theme consistent with the rest of the app.
        <div className="max-h-[60vh] space-y-2 overflow-y-auto border-t border-slate-800 p-2">
          {orders.map((o) => (
            <ScheduledRow
              key={o.id}
              order={o}
              onCancel={() => onCancel(o.id)}
              isCancelling={cancellingId === o.id}
            />
          ))}
        </div>
      )}
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
  const [expanded, setExpanded] = useState(false);
  // Per-row flip of the floor's quoting direction (display only, doesn't
  // touch the signed minPriceScaled).
  const [floorFlipped, setFloorFlipped] = useState(false);
  // 1Hz heartbeat just to re-render the "Next: in Xs" countdown.
  // React Query's 5s refetch only forces a render when the order data
  // actually changes — but the countdown depends on Date.now(), which
  // does not. Without this tick the label gets stuck on the value
  // captured at last render and drifts arbitrarily out of date.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
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
  const nowSec = Math.floor(nowMs / 1000);
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

  // Per-slice human amount + total sent so far. formatSmart adapts
  // decimal count to magnitude (4 frac digits for >=1, 6 sig figs for
  // smaller) so tiny WETH amounts don't collapse to "0.0000".
  const perSliceHuman = tokenInInfo
    ? formatSmart(Number(formatUnits(order.amountPerSlice, tokenInInfo.decimals)))
    : order.amountPerSlice;
  const totalSpentHuman = tokenInInfo
    ? formatSmart(
        Number(
          formatUnits(
            (BigInt(order.amountPerSlice) * BigInt(order.slicesExecuted)).toString(),
            tokenInInfo.decimals,
          ),
        ),
      )
    : '—';
  // Total received = sum of amountOut across FILLED slices. PENDING /
  // FAILED don't count because there's no receipt. Different from
  // "spent" which can be derived from slicesExecuted * perSlice (the
  // contract always pulls the full slice amount before swapping).
  const totalReceivedHuman = (() => {
    if (!tokenOutInfo) return null;
    const filledOut = order.executions
      .filter((e) => e.status === 'FILLED' && e.amountOut)
      .reduce((acc, e) => acc + BigInt(e.amountOut!), 0n);
    if (filledOut === 0n) return null;
    return formatSmart(Number(formatUnits(filledOut.toString(), tokenOutInfo.decimals)));
  })();

  // Avg price from FILLED executions: sum(amountOut) / sum(amountIn).
  // Display direction picked to feel natural ("WETH costs 2100 USDC",
  // not "1 USDC buys 0.000475 WETH"):
  //   - If one side is a stablecoin → show "1 NON-STABLE = X STABLE"
  //   - Else → show whichever direction gives the bigger, readable number
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
    if (inHuman === 0 || outHuman === 0) return null;

    const outIsStable = QUOTE_SYMBOLS.has(outSym);
    const inIsStable = QUOTE_SYMBOLS.has(inSym);

    // "Base per 1 Quote" → quote on the right.
    let baseAmount: number;
    let quoteAmount: number;
    let baseSym: string;
    let quoteSym: string;
    if (outIsStable && !inIsStable) {
      // tokenIn is base (e.g., WETH), tokenOut is quote stablecoin.
      // Per 1 WETH bought, how much USDC paid → invert: actually we sold
      // tokenIn for tokenOut, so per 1 tokenIn we got `outHuman/inHuman`.
      // That's what the user wants: "1 WETH = ? USDC".
      baseAmount = inHuman; baseSym = inSym;
      quoteAmount = outHuman; quoteSym = outSym;
    } else if (inIsStable && !outIsStable) {
      // tokenIn is quote stable (e.g., USDC), tokenOut is base (WETH).
      // User bought WETH with USDC: "1 WETH cost X USDC" → invert.
      baseAmount = outHuman; baseSym = outSym;
      quoteAmount = inHuman; quoteSym = inSym;
    } else {
      // No stable side — pick the direction that gives a number ≥ 1.
      const ratio = outHuman / inHuman;
      if (ratio >= 1) {
        baseAmount = inHuman; baseSym = inSym;
        quoteAmount = outHuman; quoteSym = outSym;
      } else {
        baseAmount = outHuman; baseSym = outSym;
        quoteAmount = inHuman; quoteSym = inSym;
      }
    }
    const pricePerOne = quoteAmount / baseAmount;
    const decimals = pricePerOne >= 100 ? 2 : pricePerOne >= 1 ? 4 : 6;
    return `Avg: 1 ${baseSym} = ${pricePerOne.toFixed(decimals)} ${quoteSym}`;
  })();

  // Finalized = the keeper won't touch it again. Dim the row, replace
  // the Cancel button with a status badge so the user keeps the
  // execution history but can tell at a glance the order is done.
  const isActive = order.status === 'ACTIVE';
  const statusBadge = (() => {
    if (order.status === 'CANCELLED') return { label: 'CANCELLED', cls: 'border-slate-700 text-slate-400' };
    if (order.status === 'COMPLETED') return { label: 'COMPLETED', cls: 'border-emerald-900/50 text-emerald-400' };
    if (order.status === 'EXPIRED')   return { label: 'EXPIRED',   cls: 'border-amber-900/50 text-amber-400' };
    return null;
  })();

  // Surface the LAST execution's outcome when it failed. Without this
  // the user sees "Next: any moment now…" indefinitely while the
  // keeper retries-and-fails on a permanent issue (bad slippage floor,
  // dead pool, gas spike, etc.). Reading the most recent execution by
  // sliceIndex is the cheapest proxy for "most recent" since the
  // executor reserves slots in order.
  const lastExecution = order.executions.length > 0
    ? order.executions[order.executions.length - 1]
    : null;
  const lastFailed =
    isActive && lastExecution && lastExecution.status === 'FAILED'
      ? lastExecution
      : null;

  return (
    <div
      className={`rounded-xl border border-slate-800 bg-slate-900/40 p-3 text-xs ${
        !isActive ? 'opacity-60' : ''
      }`}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex flex-1 items-center gap-2 text-left font-medium text-slate-200 hover:text-cyan-300"
          title="Show executions"
        >
          <span className="text-slate-400">{expanded ? '▾' : '▸'}</span>
          <span>
            {kindBadge}: {perSliceHuman} {inSym} → {outSym}{' '}
            {isBounded ? `(${order.maxSlices} slices)` : '(recurring)'}
          </span>
        </button>
        {isActive ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onCancel();
            }}
            disabled={isCancelling}
            className="rounded border border-rose-900/50 px-2 py-0.5 text-xs text-rose-300 hover:bg-rose-950/40 disabled:opacity-50"
          >
            {isCancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        ) : statusBadge ? (
          <span className={`rounded border px-2 py-0.5 text-xs ${statusBadge.cls}`}>
            {statusBadge.label}
          </span>
        ) : null}
      </div>

      {isBounded && (
        <div className="my-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
          <div
            className="h-full rounded-full bg-cyan-500 transition-all"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-slate-400">
        <span>{progressLabel}</span>
        {isActive ? (
          <span>Next: {nextLabel}</span>
        ) : order.cancelledAt ? (
          <span>Cancelled {new Date(order.cancelledAt).toLocaleString()}</span>
        ) : null}
      </div>

      {/* Surface last failure inline — otherwise the "Next: any moment"
          row silently masks a stuck retry loop (e.g. permanent quote
          rejection from a broken floor, gas spike, RPC outage). One
          line, amber, click-to-expand for full reason. */}
      {lastFailed && (
        <div
          className="mt-1 rounded border border-rose-900/40 bg-rose-950/30 px-2 py-1 text-xs text-rose-300"
          title={lastFailed.failureReason ?? 'unknown'}
        >
          <span className="font-medium">Last attempt failed:</span>{' '}
          {lastFailed.failureReason
            ? lastFailed.failureReason.length > 80
              ? lastFailed.failureReason.slice(0, 80) + '…'
              : lastFailed.failureReason
            : 'unknown reason'}
          {' '}
          <span className="text-rose-400/70">
            (auto-retry on next tick)
          </span>
        </div>
      )}

      <div className="mt-1 text-xs text-slate-400">
        Sent: {totalSpentHuman} {inSym}
        {totalReceivedHuman !== null && (
          <> · Got: {totalReceivedHuman} {outSym}</>
        )}
        {order.endTime !== 0 && (
          <>
            {' · '}Ends{' '}
            {new Date(order.endTime * 1000).toLocaleString()}
          </>
        )}
      </div>
      {avgPriceLabel && (
        <div className="mt-0.5 text-xs text-cyan-400/80">{avgPriceLabel}</div>
      )}
      {order.minPriceScaled !== '0' && tokenInInfo && tokenOutInfo && (() => {
        // Render the floor in the direction the user actually thinks in
        // (asset price quoted in stable units). Non-stable pairs default
        // to "asset = tokenOut"; the click toggle below flips the display.
        const oRaw = classifyPair(inSym, outSym);
        const fRaw = computeFloor({
          currentPriceScaled: BigInt(order.minPriceScaled),
          tolerancePct: 0, // tol=0 → thresholdAssetPrice null, currentAssetPrice is the floor
          side: oRaw.side,
        });
        const { orient: o, floor: f } = floorFlipped
          ? flipDisplay(oRaw, fRaw)
          : { orient: oRaw, floor: fRaw };
        const floorPrice = f.currentAssetPrice;
        if (floorPrice === null || o.side === 'unknown' || !o.assetSym || !o.quoteSym) {
          // Fallback: raw direction (e.g. stable/stable pair)
          return (
            <div className="mt-0.5 text-xs text-slate-400" title="Maker-signed hard floor">
              Floor:{' '}
              <span className="font-mono text-slate-300">
                1 {inSym} ≥{' '}
                {Number(formatUnits(order.minPriceScaled, 18)).toPrecision(4)} {outSym}
              </span>
            </div>
          );
        }
        return (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setFloorFlipped((v) => !v); }}
            title="Click to flip quoting direction (display only)"
            className="mt-0.5 block text-left text-xs text-slate-400 hover:text-slate-300"
          >
            Stop if{' '}
            <span className="font-mono text-slate-300">
              1 {o.assetSym}{' '}
              {o.side === 'buy' ? '>' : '<'}{' '}
              {formatAssetPrice(floorPrice)} {o.quoteSym}
            </span>
            <span className="ml-1 text-slate-500">⇄</span>
          </button>
        );
      })()}

      {expanded && (
        <div className="mt-2 border-t border-slate-800 pt-2 space-y-1">
          {order.executions.length === 0 ? (
            <div className="text-xs text-slate-400">
              No executions yet — the keeper will fire the first slice when due.
            </div>
          ) : (
            order.executions.map((ex) => {
              const txUrl = ex.txHash ? txExplorerUrl(order.chainId, ex.txHash) : null;
              const inH = ex.amountIn && tokenInInfo
                ? formatSmart(Number(formatUnits(ex.amountIn, tokenInInfo.decimals)))
                : '—';
              const outH = ex.amountOut && tokenOutInfo
                ? formatSmart(Number(formatUnits(ex.amountOut, tokenOutInfo.decimals)))
                : '—';
              const ts = new Date(ex.executedAt).toLocaleString();
              const statusColor =
                ex.status === 'FILLED'
                  ? 'text-emerald-400'
                  : ex.status === 'FAILED'
                    ? 'text-rose-400'
                    : 'text-amber-400';
              return (
                <div
                  key={ex.id}
                  className="grid grid-cols-[auto_1fr_auto] items-center gap-2 text-xs"
                >
                  <span className={`font-mono ${statusColor}`}>
                    #{ex.sliceIndex + 1}
                  </span>
                  <span className="text-slate-400">
                    {ex.status === 'FILLED' ? (
                      <>
                        {inH} {inSym} → {outH} {outSym}
                      </>
                    ) : ex.status === 'FAILED' ? (
                      <span className="text-rose-300/80">
                        FAILED: {ex.failureReason?.slice(0, 60) ?? 'unknown'}
                      </span>
                    ) : (
                      <span className="text-amber-300/80">Pending…</span>
                    )}
                    <span className="ml-2 text-slate-400">{ts}</span>
                  </span>
                  {txUrl ? (
                    <a
                      href={txUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-cyan-400/70 hover:text-cyan-300"
                      onClick={(e) => e.stopPropagation()}
                    >
                      tx ↗
                    </a>
                  ) : (
                    <span />
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
