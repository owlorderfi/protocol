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
import { useChainId } from 'wagmi';
import { formatUnits } from '@owlorderfi/shared';
import { useScheduledOrders, useCancelScheduledOrder } from '../hooks/useScheduledOrders';
import { findToken, tokenLabel, txExplorerUrl } from '../lib/tokens';
import type { ScheduledOrder } from '@owlorderfi/shared';
import { ChainBadge } from './ChainBadge';

// Tokens we treat as the "quote" side when displaying average price —
// price-per-1-non-stable feels more natural to most users
// ("WETH costs $2100") than the inverse ratio.
import { formatAssetPrice, displayPrice } from '../lib/priceFloor';
import { formatSmart } from '../lib/formatAmount';
import { useMarketPrice } from '../hooks/useMarketPrice';
import { usePriceFlip } from '../lib/PriceFlipContext';

// localStorage key for the "show scheduled orders from all chains" toggle.
// Independent of the limit-orders equivalent so the operator can mix
// (e.g. all-chains limit audit but only-current-chain TWAP work).
const ALL_CHAINS_LS_KEY = 'polyorder.scheduledAllChains';

// Mirrors keeper's SCHEDULED_RETRY_BACKOFF_SEC default (apps/keeper/src/config.ts).
// Used to render a live "retrying in Xs" countdown when a slice fails
// with a transient reason. If you change the keeper default, change this
// too — there's no API endpoint that surfaces keeper config yet.
const RETRY_BACKOFF_SEC = 60;

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
  const chainId = useChainId();
  const [allChains, setAllChains] = useState<boolean>(() => {
    return typeof window !== 'undefined' && localStorage.getItem(ALL_CHAINS_LS_KEY) === 'true';
  });
  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem(ALL_CHAINS_LS_KEY, String(allChains));
  }, [allChains]);

  if (!enabled) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/30 p-4 text-sm text-slate-400">
        Sign-in to see your scheduled orders.
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/30 p-4 text-sm text-slate-400">
        Loading scheduled orders…
      </div>
    );
  }
  // Split into active (always visible at the top) and finalized
  // (cancelled / completed / expired — collapsed under a "History"
  // toggle so the panel stays short by default but full history
  // remains one click away).
  const allOrders = orders ?? [];
  const distinctChainCount = new Set(allOrders.map((o) => o.chainId)).size;
  const filtered = allOrders.filter((o) => {
    if (!allChains && o.chainId !== chainId) return false;
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
      <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/20 p-4 text-center text-sm text-slate-400">
        No {what} orders yet.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {distinctChainCount > 1 && (
        // Mirrors the toggle in OrdersList. Only renders when the
        // underlying data spans multiple chains — otherwise the
        // filter is a no-op and the chip is dead weight.
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setAllChains((v) => !v)}
            title={allChains
              ? 'Currently showing scheduled orders from every chain — click to filter to the connected chain only'
              : 'Currently showing only scheduled orders on the connected chain — click to see every chain'}
            className={`rounded-full border px-3 py-1 text-xs transition ${
              allChains
                ? 'border-violet-500 bg-violet-500/15 text-violet-300'
                : 'border-slate-700 text-slate-400 hover:bg-slate-800'
            }`}
          >
            {allChains ? 'All chains' : 'This chain'}
          </button>
        </div>
      )}
      {active.map((o) => (
        <ScheduledRow
          key={o.id}
          order={o}
          onCancel={() => cancelMut.mutate(o.id)}
          isCancelling={cancelMut.isPending && cancelMut.variables === o.id}
          showChainBadge={allChains}
        />
      ))}
      {history.length > 0 && (
        <HistorySection
          orders={history}
          onCancel={(id) => cancelMut.mutate(id)}
          cancellingId={cancelMut.isPending ? (cancelMut.variables as string) : null}
          showChainBadge={allChains}
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
  showChainBadge,
}: {
  orders: ScheduledOrder[];
  onCancel: (id: string) => void;
  cancellingId: string | null;
  showChainBadge: boolean;
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
              showChainBadge={showChainBadge}
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
  showChainBadge,
}: {
  order: ScheduledOrder;
  onCancel: () => void;
  isCancelling: boolean;
  /** Render the chain abbreviation badge inline before the kind label.
   *  Only meaningful in all-chains view — when filtered to one chain
   *  the badge is redundant noise. */
  showChainBadge: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const { flipped } = usePriceFlip();
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

  // Live market price for the pair — used to colour the floor display
  // ("Stop if …") so a user can tell at a glance whether the order is
  // safely in execution territory (green), drifting toward the floor
  // (amber), or already breached (red). Hook is always called for
  // hook-order stability; it short-circuits internally when tokens
  // aren't resolvable. Canonical spot (tokenOut per tokenIn) — the same
  // direction minPriceScaled is stored in — so floor-vs-market compares
  // directly. Amount-independent, shared per pair with the keeper trigger.
  const market = useMarketPrice(
    order.tokenIn as `0x${string}`,
    order.tokenOut as `0x${string}`,
  );

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

  // Finalized = the keeper won't touch it again. Cancel/Completed/
  // Expired orders never retry, so we don't compute a retry-aware
  // countdown for them — fall straight through to the "stopped"
  // default. Declaration hoisted up here from its old spot near
  // the JSX so the next-execution-time logic can branch on it.
  const isActive = order.status === 'ACTIVE';

  // Last execution lookup — needed both for the "Next:" countdown
  // below (transient retry adjusts the next-attempt time) and for the
  // failure banner. Reading by array tail works because the API returns
  // executions sorted by (sliceIndex asc, executedAt asc) — the very
  // last entry is the most recent attempt across all slots.
  const lastExecution = order.executions.length > 0
    ? order.executions[order.executions.length - 1]
    : null;
  const lastFailed =
    isActive && lastExecution && lastExecution.status === 'FAILED'
      ? lastExecution
      : null;

  // Next execution time:
  //   - Transient FAILED on the active slot → keeper retries
  //     `lastFailed.executedAt + RETRY_BACKOFF_SEC`. Without this branch
  //     we'd render "Any moment now…" the entire backoff window, since
  //     `lastExecutedAt` only advances on FILLED rows.
  //   - Permanent FAILED → keeper won't retry; the action-required
  //     banner below handles the messaging, leave countdown showing
  //     stopped state ("—") rather than a misleading interval timer.
  //   - Otherwise → normal cadence (lastExecutedAt + intervalSec, or
  //     startTime for the first slice).
  const nextAtSec = (() => {
    if (lastFailed && !lastFailed.permanent) {
      return Math.floor(new Date(lastFailed.executedAt).getTime() / 1000) + RETRY_BACKOFF_SEC;
    }
    return order.lastExecutedAt
      ? Math.floor(new Date(order.lastExecutedAt).getTime() / 1000) + order.intervalSec
      : order.startTime;
  })();
  const nowSec = Math.floor(nowMs / 1000);
  const secondsToNext = Math.max(0, nextAtSec - nowSec);
  const isStopped = !!(lastFailed && lastFailed.permanent);
  const nextLabel = isStopped
    ? '—'
    : secondsToNext === 0
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

    // Realized average rate, canonical = tokenOut per tokenIn → fixed display.
    const d = displayPrice({
      canonical: outHuman / inHuman,
      flipped,
      tokenInSym: inSym,
      tokenInAddr: order.tokenIn,
      tokenOutSym: outSym,
      tokenOutAddr: order.tokenOut,
    });
    const decimals = d.value >= 100 ? 2 : d.value >= 1 ? 4 : 6;
    return `Avg (after fees): 1 ${d.baseSym} = ${d.value.toFixed(decimals)} ${d.quoteSym}`;
  })();

  // Finalized = the keeper won't touch it again. Dim the row, replace
  // the Cancel button with a status badge so the user keeps the
  // execution history but can tell at a glance the order is done.
  // (isActive itself is computed earlier — needed by the countdown.)
  const statusBadge = (() => {
    if (order.status === 'CANCELLED') return { label: 'CANCELLED', cls: 'border-slate-700 text-slate-400' };
    if (order.status === 'COMPLETED') return { label: 'COMPLETED', cls: 'border-emerald-900/50 text-emerald-400' };
    if (order.status === 'EXPIRED')   return { label: 'EXPIRED',   cls: 'border-amber-900/50 text-amber-400' };
    return null;
  })();

  return (
    <div
      className={`rounded-xl border border-slate-800 bg-slate-900/40 p-3 text-sm ${
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
          {showChainBadge && <ChainBadge chainId={order.chainId} />}
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

      <div className="flex items-center justify-between text-sm text-slate-400">
        <span>{progressLabel}</span>
        {isActive ? (
          <span>Next: {nextLabel}</span>
        ) : order.cancelledAt ? (
          <span>Cancelled {new Date(order.cancelledAt).toLocaleString()}</span>
        ) : null}
      </div>

      {/* Surface last failure inline — otherwise the "Next: any moment"
          row silently masks a stuck retry loop. Two colour codes:
            • Permanent (signature/deadline/cancelled/insufficient) → red
              with a "cancel + re-sign" call to action. Keeper will NEVER
              retry — only the maker can recover.
            • Transient (BREAK_EVEN_SKIP, GasTooHigh, RPC blip) → amber
              with a live countdown to the next retry attempt. The keeper
              is on it; user just needs to wait. */}
      {lastFailed && lastFailed.permanent && (
        <div
          className="mt-1 rounded border border-rose-900/40 bg-rose-950/30 px-2 py-2 text-sm text-rose-200"
        >
          <span className="font-medium">Action required:</span>{' '}
          <FailureReason reason={lastFailed.failureReason} tone="permanent" />
          {' '}
          <span className="text-rose-300/80">
            — cancel this order and re-sign (auto-retry disabled).
          </span>
        </div>
      )}
      {lastFailed && !lastFailed.permanent && (() => {
        const retryAtMs = new Date(lastFailed.executedAt).getTime() + RETRY_BACKOFF_SEC * 1000;
        const secsLeft = Math.max(0, Math.ceil((retryAtMs - nowMs) / 1000));
        const retryLabel = secsLeft > 0 ? `retrying in ${secsLeft}s` : 'retrying now…';
        return (
          <div
            className="mt-1 rounded border border-amber-900/40 bg-amber-950/30 px-2 py-2 text-sm text-amber-200"
          >
            <span className="font-medium">Last attempt failed:</span>{' '}
            <FailureReason reason={lastFailed.failureReason} tone="transient" />
            {' '}
            <span className="text-amber-300/80">— {retryLabel}.</span>
          </div>
        );
      })()}

      <div className="mt-1 text-sm text-slate-400">
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
        <div
          className="mt-0.5 text-sm text-cyan-400/80"
          title="Realized rate after Uniswap pool fee + OwlOrderFi protocol fee. Live spot may show slightly higher because fees are already netted out of this number."
        >
          {avgPriceLabel}
        </div>
      )}
      {order.minPriceScaled !== '0' && tokenInInfo && tokenOutInfo && (() => {
        // Single fixed display orientation. Floor + market are canonical
        // (tokenOut per tokenIn); displayPrice orients them identically.
        // The signed minPriceScaled is never touched.
        const tokens = {
          tokenInSym: inSym,
          tokenInAddr: order.tokenIn,
          tokenOutSym: outSym,
          tokenOutAddr: order.tokenOut,
        };
        const floorDisp = displayPrice({
          canonical: Number(formatUnits(order.minPriceScaled, 18)),
          flipped,
          ...tokens,
        });
        const marketDisp = market.priceScaled
          ? displayPrice({ canonical: Number(formatUnits(market.priceScaled, 18)), flipped, ...tokens })
          : null;
        const floorPrice = floorDisp.value;
        const marketPrice = marketDisp ? marketDisp.value : null;
        const baseSym = floorDisp.baseSym;
        const quoteSym = floorDisp.quoteSym;

        // Colour tier — done in raw scaled values so it's direction-
        // independent. `ratio` = how much the live execution rate exceeds
        // the maker's floor. Below 1 → floor already breached (red).
        // The "approaching" band uses 2× the order's own slippage tolerance
        // as the cushion (a 50bps order shows amber within 1% of floor).
        // Falls back to 200bps when slippage is 0 / missing.
        const slipBps = order.maxSlippageBps || 200;
        const warnPct = (slipBps * 2) / 10_000;
        let tier: 'green' | 'amber' | 'red' | 'unknown' = 'unknown';
        if (market.priceScaled && BigInt(order.minPriceScaled) > 0n) {
          const ratio = Number(market.priceScaled) / Number(order.minPriceScaled);
          if (ratio <= 1) tier = 'red';
          else if (ratio <= 1 + warnPct) tier = 'amber';
          else tier = 'green';
        }
        const tierClass =
          tier === 'red' ? 'text-rose-400'
            : tier === 'amber' ? 'text-amber-300'
              : tier === 'green' ? 'text-emerald-400'
                : 'text-slate-300';
        // A canonical minimum (floor) reads as "drops below" in the canonical
        // display direction, or "rises above" when displayPrice inverted it.
        const verb = floorDisp.inverted ? 'rises above' : 'drops below';
        return (
          <div className="mt-0.5 text-sm text-slate-400">
            Stop if 1 {baseSym} {verb}{' '}
            <span className={`font-mono ${tierClass}`}>
              {formatAssetPrice(floorPrice)} {quoteSym}
            </span>
            {marketPrice !== null && (
              <div className="mt-0.5 text-xs text-slate-500">
                Now: 1 {baseSym} ≈{' '}
                <span className="font-mono">{formatAssetPrice(marketPrice)} {quoteSym}</span>
              </div>
            )}
          </div>
        );
      })()}

      {expanded && (
        <div className="mt-2 border-t border-slate-800 pt-2 space-y-1">
          {order.executions.length === 0 ? (
            <div className="text-sm text-slate-400">
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
                  className="grid grid-cols-[auto_1fr_auto] items-center gap-2 text-sm"
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
                      <span className={ex.permanent ? 'text-rose-300/80' : 'text-amber-300/80'}>
                        {ex.permanent ? 'FAILED (permanent)' : 'FAILED (retry)'}: {ex.failureReason?.slice(0, 60) ?? 'unknown'}
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


/**
 * Inline failure reason renderer with click-to-expand for the long
 * viem error strings (multi-line, with contract calls + ABI details).
 *
 * Summary shows the first line (up to 150 chars) — for our common
 * shapes this captures the actionable bit:
 *   - "Missing or invalid parameters." (OP Sepolia RPC reject)
 *   - "The contract function \"executeScheduledOrder\" reverted with
 *      the following signature: 0x2c19b8b8"  (viem can't decode → we
 *      still surface the selector, see B.10.5 / F2 — ABI bundle refresh
 *      pending in apps/keeper)
 *
 * Click the summary to expand the full text in a preformatted block,
 * useful when the operator needs the underlying chain RPC / tx data
 * to debug.
 */
function FailureReason({
  reason,
  tone,
}: {
  reason: string | null | undefined;
  tone: 'permanent' | 'transient';
}) {
  if (!reason) return <>unknown reason</>;

  const newlineIdx = reason.indexOf('\n');
  const firstLine = newlineIdx === -1 ? reason : reason.slice(0, newlineIdx);
  const hasMore = newlineIdx !== -1 || reason.length > 150;

  if (!hasMore) {
    return <>{reason}</>;
  }

  const summary =
    firstLine.length > 150
      ? firstLine.slice(0, 150) + '…'
      : firstLine + (newlineIdx !== -1 ? ' …' : '');

  const chipColor =
    tone === 'permanent'
      ? 'text-rose-300 hover:text-rose-200'
      : 'text-amber-300 hover:text-amber-200';
  const preBg = tone === 'permanent' ? 'bg-rose-950/40' : 'bg-amber-950/40';

  return (
    <details className="inline-block align-baseline group">
      <summary
        className="inline cursor-pointer list-none"
      >
        {/* When collapsed, render the truncated summary + "show full".
            When the parent <details open>, the `group-open:` variant
            hides the summary text + swaps the link to "show less" so
            the full <pre> below is the only content visible. */}
        <span className="group-open:hidden">
          {summary}{' '}
          <span className={`text-xs underline ${chipColor}`}>
            show full
          </span>
        </span>
        <span className={`hidden text-xs underline group-open:inline ${chipColor}`}>
          show less
        </span>
      </summary>
      <pre
        className={`mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded border border-slate-800 ${preBg} p-2 font-mono text-xs leading-snug`}
      >
        {reason}
      </pre>
    </details>
  );
}
