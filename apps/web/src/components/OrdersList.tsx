import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import type { Order, OrderStatus as OrderStatusType } from '@polyorder/shared';
import { formatUnits } from '@polyorder/shared';
import { useOrders, useCancelOrder } from '../hooks/useOrders';
import { useMarketPrice } from '../hooks/useMarketPrice';
import { findToken, tokenLabel, txExplorerUrl } from '../lib/tokens';
import { env } from '../lib/env';

const STATUS_COLORS: Record<string, string> = {
  OPEN: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
  EXECUTING: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  FILLED: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  CANCELLED: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  EXPIRED: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  FAILED: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
};

/** Format a raw bigint-string amount for `token`. Falls back to raw if unknown. */
function formatAmount(chainId: number, address: string, raw: string): string {
  const t = findToken(chainId, address);
  if (!t) return raw;
  return formatUnits(raw, t.decimals);
}

/**
 * Live "distance to trigger" cell for OPEN orders. Reads the same Polygon
 * mainnet quote the form uses; React Query dedupes identical pairs, so
 * many orders on the same pair share a single fetch.
 */
function DistanceCell({ order }: { order: Order }) {
  const market = useMarketPrice(
    order.orderType,
    order.tokenIn as `0x${string}`,
    order.tokenOut as `0x${string}`,
  );

  if (order.status !== 'OPEN') {
    return <span className="text-slate-600">—</span>;
  }

  if (market.priceScaled === null) {
    return <span className="text-slate-500 text-xs">…</span>;
  }

  const marketNum = parseFloat(formatUnits(market.priceScaled, 18));
  const triggerNum = parseFloat(formatUnits(order.triggerPrice, 18));
  const wouldFire =
    order.orderType === 'LIMIT_BUY' || order.orderType === 'STOP_LOSS'
      ? marketNum <= triggerNum
      : marketNum >= triggerNum;

  if (wouldFire) {
    return (
      <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
        Triggers now
      </span>
    );
  }

  // Show market price + percent gap with arrow indicating which way the
  // market needs to move for the order to fire.
  const gapPct = ((marketNum - triggerNum) / marketNum) * 100;
  const needsDown =
    order.orderType === 'LIMIT_BUY' || order.orderType === 'STOP_LOSS'; // market > trigger, must drop
  const arrow = needsDown ? '↓' : '↑';
  const color = needsDown ? 'text-amber-300' : 'text-cyan-300';

  return (
    <div className="text-right">
      <div className="font-mono text-xs text-slate-300">
        {marketNum.toLocaleString(undefined, { maximumFractionDigits: 4 })}
      </div>
      <div className={`text-[10px] ${color}`}>
        {arrow} {Math.abs(gapPct).toFixed(2)}%
      </div>
    </div>
  );
}

function OrderRow({
  order,
  onCancel,
  isCancelling,
  isExpanded,
  onToggle,
}: {
  order: Order;
  onCancel: () => void;
  isCancelling: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const inSym = tokenLabel(env.chainId, order.tokenIn);
  const outSym = tokenLabel(env.chainId, order.tokenOut);
  const amountIn = formatAmount(env.chainId, order.tokenIn, order.amountIn);
  const received = order.filledAmountOut
    ? formatAmount(env.chainId, order.tokenOut, order.filledAmountOut)
    : null;
  const trigger = formatUnits(order.triggerPrice, 18);
  const shortTx = order.txHash ? `${order.txHash.slice(0, 8)}…${order.txHash.slice(-4)}` : null;
  const explorerUrl = order.txHash ? txExplorerUrl(env.chainId, order.txHash) : null;

  return (
    <tr
      onClick={onToggle}
      className={`cursor-pointer hover:bg-slate-900/50 ${isExpanded ? 'bg-slate-900/40' : ''}`}
    >
      <td className="px-4 py-3 font-mono text-xs text-slate-300">
        <span className="mr-1 text-slate-600">{isExpanded ? '▼' : '▸'}</span>
        {order.orderType}
      </td>
      <td className="px-4 py-3 text-xs text-slate-300">
        <span className="font-medium text-slate-100">{inSym}</span>
        <span className="mx-1 text-slate-500">→</span>
        <span className="font-medium text-slate-100">{outSym}</span>
      </td>
      <td className="px-4 py-3 text-right font-mono text-sm">
        {amountIn} <span className="text-xs text-slate-400">{inSym}</span>
      </td>
      <td className="px-4 py-3 text-right font-mono text-sm">
        {received ? (
          <div>
            <div className="text-emerald-300">
              {received} <span className="text-xs text-slate-400">{outSym}</span>
            </div>
            {order.feeTier != null && (
              <div className="text-[10px] text-slate-500">
                via {(order.feeTier / 10_000).toFixed(2)}% pool
              </div>
            )}
          </div>
        ) : (
          <span className="text-slate-600">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-right font-mono text-sm">{trigger}</td>
      <td className="px-4 py-3">
        <DistanceCell order={order} />
      </td>
      <td className="px-4 py-3">
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
            STATUS_COLORS[order.status] ?? 'bg-slate-500/15 text-slate-300 border-slate-500/30'
          }`}
        >
          {order.status}
        </span>
      </td>
      <td className="px-4 py-3 text-xs">
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
          <span className="text-slate-400">{new Date(order.createdAt).toLocaleTimeString()}</span>
        )}
      </td>
      <td className="px-4 py-3 text-right">
        {order.status === 'OPEN' && (
          <button
            onClick={(e) => {
              e.stopPropagation(); // don't toggle expand when clicking Cancel
              onCancel();
            }}
            disabled={isCancelling}
            className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
          >
            Cancel
          </button>
        )}
      </td>
    </tr>
  );
}

function OrderDetailRow({ order }: { order: Order }) {
  const explorerUrl = order.txHash ? txExplorerUrl(env.chainId, order.txHash) : null;

  const detailItem = (label: string, value: React.ReactNode) => (
    <div className="space-y-0.5">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="break-all font-mono text-xs text-slate-300">{value}</div>
    </div>
  );

  return (
    <tr className="bg-slate-950/40">
      <td colSpan={9} className="px-6 py-4">
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
          {order.filledAmountOut && detailItem('Filled amount out (raw)', order.filledAmountOut)}
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
          <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-slate-500 hover:text-slate-400">
            EIP-712 signature
          </summary>
          <div className="mt-2 break-all rounded bg-slate-950 p-2 font-mono text-[10px] text-slate-400">
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

export function OrdersList({ enabled }: { enabled: boolean }) {
  const { data: orders, isLoading, error } = useOrders(enabled);
  const cancel = useCancelOrder();

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

  return <OrdersTable orders={orders} cancel={cancel} />;
}

function OrdersTable({
  orders,
  cancel,
}: {
  orders: Order[];
  cancel: ReturnType<typeof useCancelOrder>;
}) {
  const [statusFilter, setStatusFilter] = useState<OrderStatusType | 'ALL'>('ALL');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const counts = useMemo(() => {
    const acc: Record<string, number> = { ALL: orders.length };
    for (const o of orders) acc[o.status] = (acc[o.status] ?? 0) + 1;
    return acc;
  }, [orders]);

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

  const filtered = statusFilter === 'ALL' ? orders : orders.filter((o) => o.status === statusFilter);

  return (
    <div className="space-y-3">
      {/* Status pills */}
      <div className="flex flex-wrap gap-2">
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
              <span className="ml-1.5 text-slate-500">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/40">
        <table className="w-full text-left text-sm">
        <thead className="bg-slate-900/60 text-xs uppercase tracking-wider text-slate-500">
          <tr>
            <th className="px-4 py-3">Type</th>
            <th className="px-4 py-3">Pair</th>
            <th className="px-4 py-3 text-right">Amount in</th>
            <th className="px-4 py-3 text-right">Received</th>
            <th className="px-4 py-3 text-right">Trigger</th>
            <th className="px-4 py-3 text-right">Market / Gap</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Tx / Created</th>
            <th className="px-4 py-3"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {filtered.length === 0 ? (
            <tr>
              <td colSpan={9} className="px-4 py-8 text-center text-sm text-slate-500">
                No {statusFilter !== 'ALL' && statusFilter.toLowerCase()} orders match this filter.
              </td>
            </tr>
          ) : (
            filtered.flatMap((o: Order) => {
              const isExpanded = expandedId === o.id;
              const rows = [
                <OrderRow
                  key={o.id}
                  order={o}
                  onCancel={() => cancel.mutate(o.id)}
                  isCancelling={cancel.isPending}
                  isExpanded={isExpanded}
                  onToggle={() => setExpandedId(isExpanded ? null : o.id)}
                />,
              ];
              if (isExpanded) rows.push(<OrderDetailRow key={`${o.id}-detail`} order={o} />);
              return rows;
            })
          )}
        </tbody>
      </table>
      </div>
    </div>
  );
}
