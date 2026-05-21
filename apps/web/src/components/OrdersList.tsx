import type { Order } from '@polyorder/shared';
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

function OrderRow({ order, onCancel, isCancelling }: { order: Order; onCancel: () => void; isCancelling: boolean }) {
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
    <tr className="hover:bg-slate-900/50">
      <td className="px-4 py-3 font-mono text-xs text-slate-300">{order.orderType}</td>
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
          <span className="text-emerald-300">
            {received} <span className="text-xs text-slate-400">{outSym}</span>
          </span>
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
            onClick={onCancel}
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

export function OrdersList({ enabled }: { enabled: boolean }) {
  const { data: orders, isLoading, error } = useOrders(enabled);
  const cancel = useCancelOrder();

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

  return (
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
          {orders.map((o: Order) => (
            <OrderRow
              key={o.id}
              order={o}
              onCancel={() => cancel.mutate(o.id)}
              isCancelling={cancel.isPending}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
