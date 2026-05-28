import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useChainId } from 'wagmi';
import type { Order, OrderStatus as OrderStatusType } from '@owlorderfi/shared';
import { formatUnits, priceScaledFromAmounts } from '@owlorderfi/shared';
import { useOrders, useCancelOrder } from '../hooks/useOrders';
import { useCancelOrderOnChain } from '../hooks/useCancelOrderOnChain';
import { useMarketPrice } from '../hooks/useMarketPrice';
import { findToken, tokenLabel, txExplorerUrl } from '../lib/tokens';
import { formatSmart } from '../lib/formatAmount';
import { displayPrice, toCanonicalPrice } from '../lib/priceFloor';
import { usePriceFlip } from '../lib/PriceFlipContext';
import { ChainBadge } from './ChainBadge';

const STATUS_COLORS: Record<string, string> = {
  OPEN: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
  EXECUTING: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  FILLED: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  CANCELLED: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  EXPIRED: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  FAILED: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
};

/**
 * Two-line timestamp: time on top (HH:MM), date on the line below in
 * italic muted color. Compact enough for narrow table cells while still
 * showing the full context — solves the "is this morning or yesterday?"
 * ambiguity of a bare clock time.
 */
function TimeWithDate({ iso }: { iso: string | Date }) {
  const d = new Date(iso);
  return (
    // whitespace-nowrap on both lines so "Sep 24, 2026" doesn't wrap
    // inside a narrow column; the cell then auto-widens to fit.
    <div className="leading-tight whitespace-nowrap">
      <div className="text-sm">{d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</div>
      <div className="text-sm italic text-slate-500">
        {d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
      </div>
    </div>
  );
}

/** Format a raw bigint-string amount for `token`. Falls back to raw if unknown. */
function formatAmount(chainId: number, address: string, raw: string): string {
  const t = findToken(chainId, address);
  if (!t) return raw;
  return formatSmart(parseFloat(formatUnits(raw, t.decimals)));
}

/**
 * Live "distance to trigger" cell for OPEN orders. Reads the same Polygon
 * mainnet quote the form uses; React Query dedupes identical pairs, so
 * many orders on the same pair share a single fetch.
 */
function DistanceCell({ order }: { order: Order }) {
  // Amount-independent canonical spot (server-side, shared per pair). NOT
  // the order's own amount — that would make every order a distinct cache
  // key (no sharing across users/orders → RPC blows up at scale) AND diverge
  // from the keeper, which also triggers off this shared per-pair reference.
  const market = useMarketPrice(order.tokenIn as `0x${string}`, order.tokenOut as `0x${string}`);
  const { flipped } = usePriceFlip();

  if (order.status !== 'OPEN') {
    return <span className="text-slate-500">—</span>;
  }

  if (market.priceScaled === null) {
    return <span className="text-slate-400 text-xs">…</span>;
  }

  const marketCanon = parseFloat(formatUnits(market.priceScaled, 18));
  const triggerStored = parseFloat(formatUnits(order.triggerPrice, 18));
  const triggerCanon = toCanonicalPrice(triggerStored, order.orderType);

  // Fire check stays in the stored (order-type) orientation, unchanged:
  // BUY/STOP fire when the rate drops to/below the trigger, SELL/TAKE when
  // it rises to/above it. (toCanonicalPrice is self-inverse: canonical → stored.)
  const marketStored = toCanonicalPrice(marketCanon, order.orderType);
  const wouldFire =
    order.orderType === 'LIMIT_BUY' || order.orderType === 'STOP_LOSS'
      ? marketStored <= triggerStored
      : marketStored >= triggerStored;

  if (wouldFire) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/20 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-emerald-300">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
        Triggers now
      </span>
    );
  }

  // One fixed display orientation for both market + trigger (same unit).
  const tokens = {
    tokenInSym: tokenLabel(order.chainId, order.tokenIn),
    tokenInAddr: order.tokenIn,
    tokenOutSym: tokenLabel(order.chainId, order.tokenOut),
    tokenOutAddr: order.tokenOut,
  };
  const md = displayPrice({ canonical: marketCanon, flipped, ...tokens });
  const td = displayPrice({ canonical: triggerCanon, flipped, ...tokens });
  const needsDown = md.value > td.value;
  const arrow = needsDown ? '↓' : '↑';
  const color = needsDown ? 'text-amber-300' : 'text-cyan-300';
  const gapPct = md.value > 0 ? ((md.value - td.value) / md.value) * 100 : 0;

  return (
    <div className="text-right">
      <div className="font-mono text-sm text-slate-300">{formatSmart(md.value)}</div>
      <div className={`text-sm ${color}`}>
        {arrow} {Math.abs(gapPct).toFixed(2)}%
      </div>
    </div>
  );
}

function OrderRow({
  order,
  onCancel,
  onCancelOnChain,
  isCancelling,
  isOnChainCancelling,
  isExpanded,
  onToggle,
  showChainBadge,
}: {
  order: Order;
  onCancel: () => void;
  onCancelOnChain: () => void;
  isCancelling: boolean;
  isOnChainCancelling: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  /** Render the chain abbreviation badge inline before the pair label.
   *  Only useful when the table is showing more than one chain at a
   *  time — otherwise it's the same value on every row. */
  showChainBadge: boolean;
}) {
  const { flipped } = usePriceFlip();
  const inSym = tokenLabel(order.chainId, order.tokenIn);
  const outSym = tokenLabel(order.chainId, order.tokenOut);
  const amountIn = formatAmount(order.chainId, order.tokenIn, order.amountIn);
  const received = order.filledAmountOut
    ? formatAmount(order.chainId, order.tokenOut, order.filledAmountOut)
    : null;
  // Stored trigger is in order-type-dependent units — normalize to canonical
  // first, then the single fixed display orientation (same unit everywhere).
  const triggerCanon = toCanonicalPrice(
    parseFloat(formatUnits(order.triggerPrice, 18)),
    order.orderType,
  );
  const triggerDisplay = displayPrice({
    canonical: triggerCanon,
    flipped,
    tokenInSym: inSym,
    tokenInAddr: order.tokenIn,
    tokenOutSym: outSym,
    tokenOutAddr: order.tokenOut,
  });
  const trigger = formatSmart(triggerDisplay.value);
  const triggerUnit = triggerDisplay.unit;
  const shortTx = order.txHash ? `${order.txHash.slice(0, 8)}…${order.txHash.slice(-4)}` : null;
  const explorerUrl = order.txHash ? txExplorerUrl(order.chainId, order.txHash) : null;

  return (
    <tr
      onClick={onToggle}
      className={`cursor-pointer hover:bg-slate-900/50 ${isExpanded ? 'bg-slate-900/40' : ''}`}
    >
      <td className="px-4 py-3 text-sm text-slate-300">
        <span className="mr-1 text-slate-500">{isExpanded ? '▼' : '▸'}</span>
        {showChainBadge && <span className="mr-1.5"><ChainBadge chainId={order.chainId} /></span>}
        <span className="font-medium text-slate-100">{inSym}</span>
        <span className="mx-1 text-slate-400">→</span>
        <span className="font-medium text-slate-100">{outSym}</span>
        {order.ladderId && order.ladderRungIndex !== null && (
          <span
            className="ml-2 rounded border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-xs text-violet-300"
            title={`Ladder ${order.ladderId.slice(0, 8)}…, rung ${order.ladderRungIndex + 1}`}
          >
            🪜 #{order.ladderRungIndex + 1}
          </span>
        )}
      </td>
      <td className="px-4 py-3 text-right font-mono text-sm">
        {amountIn} <span className="text-xs text-slate-400">{inSym}</span>
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-sm">
        {received ? (
          <div>
            <div className="text-emerald-300">
              {received} <span className="text-xs text-slate-400">{outSym}</span>
            </div>
            {order.feeTier != null && (
              <div className="text-sm text-slate-400">
                via {(order.feeTier / 10_000).toFixed(2)}% pool
              </div>
            )}
          </div>
        ) : (
          <span className="text-slate-500">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-right font-mono text-sm">
        <div>{trigger}</div>
        <div className="text-xs text-slate-500">{triggerUnit}</div>
      </td>
      <td className="px-4 py-3">
        <DistanceCell order={order} />
      </td>
      <td className="px-4 py-3">
        <span
          className={`rounded-full border px-2 py-0.5 text-xs font-medium uppercase tracking-wider ${
            STATUS_COLORS[order.status] ?? 'bg-slate-500/15 text-slate-300 border-slate-500/30'
          }`}
        >
          {order.status}
        </span>
        {/* Surface a keeper-side hiccup inline so a retrying/failed order
            isn't silently indistinguishable from a healthy OPEN one. OPEN +
            failureReason = transient, keeper will retry (amber); FAILED =
            won't retry (rose). Full reason on hover. */}
        {order.failureReason && (order.status === 'OPEN' || order.status === 'FAILED') && (
          <div
            className={`mt-1 max-w-[15rem] text-xs leading-snug ${
              order.status === 'OPEN' ? 'text-amber-300' : 'text-rose-300'
            }`}
            title={order.failureReason}
          >
            {order.status === 'OPEN'
              ? `⟳ retrying${order.retryCount > 0 ? ` (attempt ${order.retryCount})` : ''}`
              : '⚠ failed'}
            <span className="text-slate-400">
              {' — '}
              {order.failureReason.length > 44
                ? `${order.failureReason.slice(0, 44)}…`
                : order.failureReason}
            </span>
          </div>
        )}
      </td>
      <td className="px-4 py-3 text-sm text-slate-400" title={new Date(order.createdAt).toLocaleString()}>
        <TimeWithDate iso={order.createdAt} />
      </td>
      <td className="px-4 py-3 text-sm text-slate-400" title={order.filledAt ? new Date(order.filledAt).toLocaleString() : ''}>
        {order.filledAt
          ? <TimeWithDate iso={order.filledAt} />
          : <span className="text-slate-500">—</span>}
      </td>
      <td className="px-4 py-3 text-sm">
        {shortTx && order.txHash ? (
          explorerUrl ? (
            <a
              href={explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-cyan-300 underline-offset-2 hover:underline"
              title={order.txHash}
            >
              {shortTx} ↗
            </a>
          ) : (
            <span className="font-mono text-slate-300" title={order.txHash}>
              {shortTx}
            </span>
          )
        ) : (
          <span className="text-slate-500">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-right">
        {order.status === 'OPEN' && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onCancel();
            }}
            disabled={isCancelling}
            className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
            title="Off-chain cancel (free, no gas). Race-loses if keeper already submitted the tx."
          >
            Cancel
          </button>
        )}
        {order.status === 'EXECUTING' && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onCancelOnChain();
            }}
            disabled={isOnChainCancelling}
            className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
            title="On-chain cancel via cancelOrder(nonce). Costs a small amount of gas. Only path to stop a tx the keeper has already submitted."
          >
            Cancel <span className="text-slate-400">· gas</span>
          </button>
        )}
      </td>
    </tr>
  );
}

function OrderDetailRow({ order }: { order: Order }) {
  const explorerUrl = order.txHash ? txExplorerUrl(order.chainId, order.txHash) : null;
  const { flipped } = usePriceFlip();

  const detailItem = (label: string, value: React.ReactNode) => (
    <div className="space-y-0.5">
      <div className="text-xs uppercase tracking-wider text-slate-400">{label}</div>
      <div className="break-all font-mono text-sm text-slate-300">{value}</div>
    </div>
  );

  return (
    <tr className="bg-slate-950/40">
      <td colSpan={10} className="px-6 py-4">
        <div className="grid grid-cols-1 gap-x-6 gap-y-3 md:grid-cols-2 lg:grid-cols-3">
          {detailItem('Order ID', order.id)}
          {detailItem('Maker', order.maker)}
          {detailItem('Token in', order.tokenIn)}
          {detailItem('Token out', order.tokenOut)}
          {detailItem('Amount in (raw)', order.amountIn)}
          {detailItem('Min amount out (raw)', order.minAmountOut)}
          {detailItem('Trigger price (raw × 1e18)', order.triggerPrice)}
          {detailItem('Nonce', order.nonce)}
          {detailItem('Chain ID', String(order.chainId))}
          {detailItem('Created', new Date(order.createdAt).toLocaleString())}
          {detailItem(
            'Deadline',
            new Date(order.deadline * 1000).toLocaleString(),
          )}
          {order.filledAt && detailItem('Filled at', new Date(order.filledAt).toLocaleString())}
          {order.feeTier != null &&
            detailItem('Uniswap fee tier', `${order.feeTier} (${(order.feeTier / 10_000).toFixed(2)}%)`)}
          {order.filledAmountOut &&
            detailItem(
              'Received (net to maker)',
              formatAmount(order.chainId, order.tokenOut, order.filledAmountOut) +
                ' ' +
                tokenLabel(order.chainId, order.tokenOut),
            )}
          {order.feeAmount &&
            detailItem(
              'Protocol fee (to treasury)',
              formatAmount(order.chainId, order.tokenOut, order.feeAmount) +
                ' ' +
                tokenLabel(order.chainId, order.tokenOut),
            )}
          {order.feeAmount &&
            order.filledAmountOut &&
            detailItem(
              'Gross out of swap',
              formatAmount(
                order.chainId,
                order.tokenOut,
                (BigInt(order.filledAmountOut) + BigInt(order.feeAmount)).toString(),
              ) +
                ' ' +
                tokenLabel(order.chainId, order.tokenOut),
            )}
          {/* Effective execution price = gross out / amount in, decimal-adjusted.
              Anchors the "did the keeper actually fill at a reasonable price?" check. */}
          {(() => {
            if (!order.filledAmountOut || !order.feeAmount) return null;
            const tokenInInfo = findToken(order.chainId, order.tokenIn);
            const tokenOutInfo = findToken(order.chainId, order.tokenOut);
            if (!tokenInInfo || !tokenOutInfo) return null;
            const grossOut = BigInt(order.filledAmountOut) + BigInt(order.feeAmount);
            // Canonical fill price (tokenOut per tokenIn) regardless of the
            // stored orderType, then oriented the same way as the trigger/market
            // above so it reads in the same units (e.g. USDC/WETH).
            const fillCanonScaled = priceScaledFromAmounts({
              orderType: 'LIMIT_SELL',
              amountInRaw: BigInt(order.amountIn),
              amountOutRaw: grossOut,
              tokenInDecimals: tokenInInfo.decimals,
              tokenOutDecimals: tokenOutInfo.decimals,
            });
            const tokens = {
              tokenInSym: tokenInInfo.symbol,
              tokenInAddr: order.tokenIn,
              tokenOutSym: tokenOutInfo.symbol,
              tokenOutAddr: order.tokenOut,
            };
            const fillDisp = displayPrice({ canonical: Number(fillCanonScaled) / 1e18, flipped, ...tokens });
            // Trigger oriented the same way, for a same-frame % (sign matches).
            const triggerDisp = displayPrice({
              canonical: toCanonicalPrice(parseFloat(formatUnits(order.triggerPrice, 18)), order.orderType),
              flipped,
              ...tokens,
            });
            const diffPct = triggerDisp.value
              ? ((fillDisp.value - triggerDisp.value) / triggerDisp.value) * 100
              : 0;
            return (
              <>
                {detailItem(
                  'Actual fill price',
                  <span>
                    {formatSmart(fillDisp.value)} {fillDisp.unit}{' '}
                    <span className="text-slate-400 text-xs">
                      ({diffPct >= 0 ? '+' : ''}
                      {diffPct.toFixed(3)}% vs trigger)
                    </span>
                  </span>,
                )}
              </>
            );
          })()}
          {order.txHash &&
            detailItem(
              'Transaction hash',
              explorerUrl ? (
                <a
                  href={explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-cyan-300 hover:underline"
                >
                  {order.txHash} ↗
                </a>
              ) : (
                <span>{order.txHash}</span>
              ),
            )}
          {order.failureReason && detailItem('Failure reason', order.failureReason)}
        </div>
        <details className="mt-4">
          <summary className="cursor-pointer text-xs uppercase tracking-wider text-slate-400 hover:text-slate-400">
            EIP-712 signature
          </summary>
          <div className="mt-2 break-all rounded bg-slate-950 p-2 font-mono text-sm text-slate-400">
            {order.signature}
          </div>
        </details>
      </td>
    </tr>
  );
}

// Status changes we surface as toasts. CANCELLED is excluded because the
// cancel mutation already toasts on its own success.
const TOASTED_TERMINAL_STATUSES = new Set(['FILLED', 'FAILED', 'EXPIRED']);

interface OrdersListProps {
  enabled: boolean;
  /**
   * Filters the list to a slice of the user's limit orders so each
   * tab in the parent UI shows only what belongs there. Default `all`
   * is the "view all tabs" mode where everything is shown.
   *   - 'standalone': only orders WITHOUT a ladderId (true one-shot limits)
   *   - 'ladder':     only orders WITH a ladderId (rungs of a ladder run)
   * The data shape is identical — rungs are regular limit orders that
   * just happen to share a ladderId for display grouping.
   */
  ladderFilter?: 'all' | 'standalone' | 'ladder';
}

export function OrdersList({ enabled, ladderFilter = 'all' }: OrdersListProps) {
  const { data: rawOrders, isLoading, error } = useOrders(enabled);
  const orders = useMemo(() => {
    if (!rawOrders) return rawOrders;
    if (ladderFilter === 'standalone') return rawOrders.filter((o) => o.ladderId === null);
    if (ladderFilter === 'ladder') return rawOrders.filter((o) => o.ladderId !== null);
    return rawOrders;
  }, [rawOrders, ladderFilter]);
  const cancel = useCancelOrder();
  const cancelOnChain = useCancelOrderOnChain();

  // Snapshot the previous statuses to detect transitions on each refetch.
  // First load primes the ref without firing toasts (otherwise every existing
  // FILLED order would toast on initial load).
  const prevStatuses = useRef<Map<string, string> | null>(null);

  useEffect(() => {
    if (!orders) return;
    const current = new Map(orders.map((o) => [o.id, o.status]));

    if (prevStatuses.current === null) {
      prevStatuses.current = current;
      return;
    }

    for (const o of orders) {
      const wasStatus = prevStatuses.current.get(o.id);
      if (wasStatus === undefined) continue; // newly created — handled by submit toast
      if (wasStatus === o.status) continue;
      if (!TOASTED_TERMINAL_STATUSES.has(o.status)) continue;

      const shortId = o.id.slice(0, 8);
      if (o.status === 'FILLED') {
        toast.success(`Order ${shortId}… filled`);
      } else if (o.status === 'FAILED') {
        toast.error(`Order ${shortId}… failed`);
      } else if (o.status === 'EXPIRED') {
        toast(`Order ${shortId}… expired`, { icon: '⏰' });
      }
    }

    prevStatuses.current = current;
  }, [orders]);

  if (!enabled) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-8 text-center text-slate-400">
        Connect wallet and sign-in to see your orders.
      </div>
    );
  }

  if (isLoading) return <div className="text-slate-400">Loading orders…</div>;

  if (error) {
    return (
      <div className="rounded-xl border border-rose-900/50 bg-rose-950/40 p-4 text-rose-300">
        Error: {(error as Error).message}
      </div>
    );
  }

  if (!orders || orders.length === 0) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-8 text-center text-slate-400">
        No orders yet. Create one →
      </div>
    );
  }

  return <OrdersTable orders={orders} cancel={cancel} cancelOnChain={cancelOnChain} />;
}

// localStorage key for the "show orders from all chains" toggle.
// Persists across reloads so the operator's preference sticks (the
// default — current chain only — matches the more common "audit the
// chain I'm on" mental model).
const ALL_CHAINS_LS_KEY = 'polyorder.ordersAllChains';

function OrdersTable({
  orders,
  cancel,
  cancelOnChain,
}: {
  orders: Order[];
  cancel: ReturnType<typeof useCancelOrder>;
  cancelOnChain: ReturnType<typeof useCancelOrderOnChain>;
}) {
  const [statusFilter, setStatusFilter] = useState<OrderStatusType | 'ALL'>('ALL');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState<number>(25);
  const [page, setPage] = useState<number>(1);

  // Chain filter: default to current chain only, toggle to see all.
  // Persisted via localStorage so reload doesn't reset the preference.
  const chainId = useChainId();
  const [allChains, setAllChains] = useState<boolean>(() => {
    return typeof window !== 'undefined' && localStorage.getItem(ALL_CHAINS_LS_KEY) === 'true';
  });
  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem(ALL_CHAINS_LS_KEY, String(allChains));
  }, [allChains]);
  // Apply chain filter FIRST — status counts below reflect only the rows
  // the user can actually see, otherwise "OPEN 3" on a chain where none
  // are present is misleading.
  const chainScopedOrders = useMemo(
    () => (allChains ? orders : orders.filter((o) => o.chainId === chainId)),
    [orders, allChains, chainId],
  );
  // Distinct chains present in the unfiltered list — used to decide
  // whether to show the toggle at all. No point cluttering the UI with
  // an "all chains" toggle when the user only has orders on one chain.
  const distinctChainCount = useMemo(
    () => new Set(orders.map((o) => o.chainId)).size,
    [orders],
  );

  // Sort state — persisted so refresh doesn't reset the user's chosen view.
  // 3-state cycle: asc → desc → none (back to API default order).
  // Sortable columns kept small + meaningful (numeric cross-token compare on
  // amount/trigger would mix decimal scales, so we skip those).
  type SortKey = 'createdAt' | 'pair' | 'status' | 'filledAt';
  type SortDir = 'asc' | 'desc' | 'none';
  const [sortKey, setSortKey] = useState<SortKey | null>(() => {
    const stored = localStorage.getItem('polyorder.sortKey');
    return stored ? (stored as SortKey) : null;
  });
  const [sortDir, setSortDir] = useState<SortDir>(() => {
    return (localStorage.getItem('polyorder.sortDir') as SortDir) || 'none';
  });
  useEffect(() => {
    if (sortKey) localStorage.setItem('polyorder.sortKey', sortKey);
    else localStorage.removeItem('polyorder.sortKey');
  }, [sortKey]);
  useEffect(() => { localStorage.setItem('polyorder.sortDir', sortDir); }, [sortDir]);

  const onSort = (k: SortKey) => {
    if (k !== sortKey) {
      // First click on a new column picks the most useful direction —
      // descending for dates (newest first), ascending for text.
      setSortKey(k);
      setSortDir(k === 'createdAt' || k === 'filledAt' ? 'desc' : 'asc');
      return;
    }
    // Same column: cycle direction. After two clicks return to neutral
    // (API default order) so the user can "untouch" without picking
    // another column.
    setSortDir((d) => {
      if (d === 'asc') return 'desc';
      if (d === 'desc') {
        setSortKey(null);
        return 'none';
      }
      return 'asc';
    });
  };

  const counts = useMemo(() => {
    const acc: Record<string, number> = { ALL: chainScopedOrders.length };
    for (const o of chainScopedOrders) acc[o.status] = (acc[o.status] ?? 0) + 1;
    return acc;
  }, [chainScopedOrders]);

  // Show statuses present in the data plus a fixed "All" pill.
  const visibleStatuses: Array<OrderStatusType | 'ALL'> = [
    'ALL',
    'OPEN',
    'EXECUTING',
    'FILLED',
    'CANCELLED',
    'EXPIRED',
    'FAILED',
  ];

  const filteredUnsorted = statusFilter === 'ALL'
    ? chainScopedOrders
    : chainScopedOrders.filter((o) => o.status === statusFilter);
  const filtered = useMemo(() => {
    if (!sortKey || sortDir === 'none') return filteredUnsorted;
    const sign = sortDir === 'asc' ? 1 : -1;
    const cmp = (a: Order, b: Order): number => {
      switch (sortKey) {
        case 'pair':      return a.tokenIn.localeCompare(b.tokenIn) || a.tokenOut.localeCompare(b.tokenOut);
        case 'status':    return a.status.localeCompare(b.status);
        case 'createdAt': return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        case 'filledAt': {
          // Nulls (not-yet-filled rows) always go to the bottom, regardless
          // of direction — they're not comparable on this dimension.
          const av = a.filledAt ? new Date(a.filledAt).getTime() : null;
          const bv = b.filledAt ? new Date(b.filledAt).getTime() : null;
          if (av === null && bv === null) return 0;
          if (av === null) return  sign;  // a goes after b
          if (bv === null) return -sign;  // b goes after a
          return av - bv;
        }
      }
    };
    return [...filteredUnsorted].sort((a, b) => sign * cmp(a, b));
  }, [filteredUnsorted, sortKey, sortDir]);

  // Reset to page 1 whenever the filter changes or filtered length shrinks past
  // the current page. Done as effect so render stays pure.
  useEffect(() => {
    setPage(1);
  }, [statusFilter, pageSize, allChains, chainId]);

  // pageSize === 0 → "All" (no slicing)
  const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(filtered.length / pageSize)) : 1;
  const clampedPage = Math.min(page, totalPages);
  const sliceStart = pageSize > 0 ? (clampedPage - 1) * pageSize : 0;
  const sliceEnd = pageSize > 0 ? sliceStart + pageSize : filtered.length;
  const paged = filtered.slice(sliceStart, sliceEnd);

  return (
    <div className="space-y-3">
      {/* Status pills + (optional) "All chains" toggle on the right.
          The toggle only appears when orders span multiple chains —
          otherwise it'd be noise (the filter would be a no-op). */}
      <div className="flex flex-wrap items-center gap-2">
        {visibleStatuses.map((s) => {
          const count = counts[s] ?? 0;
          if (s !== 'ALL' && count === 0) return null;
          const active = statusFilter === s;
          return (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                active
                  ? 'border-cyan-500 bg-cyan-500/15 text-cyan-300'
                  : 'border-slate-700 text-slate-400 hover:bg-slate-800'
              }`}
            >
              {s === 'ALL' ? 'All' : s.charAt(0) + s.slice(1).toLowerCase()}
              <span className="ml-1.5 text-slate-400">{count}</span>
            </button>
          );
        })}
        {distinctChainCount > 1 && (
          <button
            type="button"
            onClick={() => setAllChains((v) => !v)}
            title={allChains
              ? 'Currently showing orders from every chain — click to filter to the connected chain only'
              : 'Currently showing only orders on the connected chain — click to see every chain'}
            className={`ml-auto rounded-full border px-3 py-1 text-xs transition ${
              allChains
                ? 'border-violet-500 bg-violet-500/15 text-violet-300'
                : 'border-slate-700 text-slate-400 hover:bg-slate-800'
            }`}
          >
            {allChains ? 'All chains' : 'This chain'}
          </button>
        )}
      </div>

      <div className="max-h-[60vh] overflow-y-auto rounded-xl border border-slate-800 bg-slate-900/40">
        <table className="w-full text-left text-sm">
        <thead className="sticky top-0 z-10 bg-slate-900 text-xs uppercase tracking-wider text-slate-400 shadow-[0_1px_0_0_rgba(30,41,59,1)]">
          <tr>
            <SortableTh label="Pair" sortKey="pair" current={sortKey} dir={sortDir} onClick={onSort} />
            <th className="px-4 py-3 text-right">Amount in</th>
            <th className="whitespace-nowrap px-4 py-3 text-right">Received</th>
            <th className="px-4 py-3 text-right">Trigger</th>
            <th className="px-4 py-3 text-right">Market / Gap</th>
            <SortableTh label="Status" sortKey="status" current={sortKey} dir={sortDir} onClick={onSort} />
            <SortableTh label="Created" sortKey="createdAt" current={sortKey} dir={sortDir} onClick={onSort} />
            <SortableTh label="Executed" sortKey="filledAt" current={sortKey} dir={sortDir} onClick={onSort} />
            <th className="px-4 py-3">Tx</th>
            <th className="px-4 py-3"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {filtered.length === 0 ? (
            <tr>
              <td colSpan={10} className="px-4 py-8 text-center text-sm text-slate-400">
                No {statusFilter !== 'ALL' && statusFilter.toLowerCase()} orders match this filter.
              </td>
            </tr>
          ) : (
            paged.flatMap((o: Order) => {
              const isExpanded = expandedId === o.id;
              const rows = [
                <OrderRow
                  key={o.id}
                  order={o}
                  onCancel={() => cancel.mutate(o.id)}
                  onCancelOnChain={() => void cancelOnChain.cancelOnChain(o.nonce)}
                  isCancelling={cancel.isPending}
                  isOnChainCancelling={cancelOnChain.isPending}
                  isExpanded={isExpanded}
                  onToggle={() => setExpandedId(isExpanded ? null : o.id)}
                  showChainBadge={allChains}
                />,
              ];
              if (isExpanded) rows.push(<OrderDetailRow key={`${o.id}-detail`} order={o} />);
              return rows;
            })
          )}
        </tbody>
      </table>
      </div>

      {/* Pagination footer — page size selector + nav */}
      {filtered.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-400">
          <div className="flex items-center gap-2">
            <span>Show</span>
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-200 focus:border-cyan-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/40"
            >
              {[10, 25, 50, 100].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
              <option value={0}>All</option>
            </select>
            <span>
              {pageSize > 0
                ? `${sliceStart + 1}–${Math.min(sliceEnd, filtered.length)} of ${filtered.length}`
                : `all ${filtered.length}`}
            </span>
          </div>

          {pageSize > 0 && totalPages > 1 && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setPage(1)}
                disabled={clampedPage === 1}
                className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800 disabled:opacity-30"
              >
                «
              </button>
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={clampedPage === 1}
                className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800 disabled:opacity-30"
              >
                ‹ Prev
              </button>
              <span className="px-2 font-mono text-slate-300">
                {clampedPage} / {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={clampedPage === totalPages}
                className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800 disabled:opacity-30"
              >
                Next ›
              </button>
              <button
                type="button"
                onClick={() => setPage(totalPages)}
                disabled={clampedPage === totalPages}
                className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800 disabled:opacity-30"
              >
                »
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Sortable column header with a 3-state indicator (▲ / ▼ / —).
 *  Direction-agnostic by itself — the parent supplies which key is active
 *  and the direction. Neutral state ('none' or sortKey not active) renders
 *  with no arrow and a dim hover affordance. */
function SortableTh<K extends string>({
  label, sortKey, current, dir, onClick,
}: {
  label: string;
  sortKey: K;
  current: K | null;
  dir: 'asc' | 'desc' | 'none';
  onClick: (k: K) => void;
}) {
  const isActive = current === sortKey && dir !== 'none';
  const arrow = isActive ? (dir === 'asc' ? '▲' : '▼') : '';
  return (
    <th className="px-4 py-3">
      <button
        type="button"
        onClick={() => onClick(sortKey)}
        className={`flex items-center gap-1 uppercase tracking-wider transition ${
          isActive ? 'text-slate-200' : 'text-slate-400 hover:text-slate-300'
        }`}
        title={
          isActive
            ? (dir === 'asc' ? 'Click for descending' : 'Click to clear sort')
            : `Sort by ${label}`
        }
      >
        {label}
        {arrow && <span className="text-xs">{arrow}</span>}
      </button>
    </th>
  );
}
