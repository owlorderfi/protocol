import type { Order } from '@polyorder/shared';
import { formatUnits } from '@polyorder/shared';
import { useOrders, useCancelOrder } from '../hooks/useOrders';
import { findToken, tokenLabel } from '../lib/tokens';
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
            <th className="px-4 py-3 text-right">Trigger</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Created</th>
            <th className="px-4 py-3"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {orders.map((o: Order) => {
            const inSym = tokenLabel(env.chainId, o.tokenIn);
            const outSym = tokenLabel(env.chainId, o.tokenOut);
            const amountIn = formatAmount(env.chainId, o.tokenIn, o.amountIn);
            const trigger = formatUnits(o.triggerPrice, 18);
            return (
              <tr key={o.id} className="hover:bg-slate-900/50">
                <td className="px-4 py-3 font-mono text-xs text-slate-300">{o.orderType}</td>
                <td className="px-4 py-3 text-xs text-slate-300">
                  <span className="font-medium text-slate-100">{inSym}</span>
                  <span className="mx-1 text-slate-500">→</span>
                  <span className="font-medium text-slate-100">{outSym}</span>
                </td>
                <td className="px-4 py-3 text-right font-mono text-sm">
                  {amountIn} <span className="text-xs text-slate-400">{inSym}</span>
                </td>
                <td className="px-4 py-3 text-right font-mono text-sm">{trigger}</td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
                      STATUS_COLORS[o.status] ?? 'bg-slate-500/15 text-slate-300 border-slate-500/30'
                    }`}
                  >
                    {o.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs text-slate-400">
                  {new Date(o.createdAt).toLocaleTimeString()}
                </td>
                <td className="px-4 py-3 text-right">
                  {o.status === 'OPEN' && (
                    <button
                      onClick={() => cancel.mutate(o.id)}
                      disabled={cancel.isPending}
                      className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
