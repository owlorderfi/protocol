/**
 * Transparent pricing card. Sits below the Features grid so prospects
 * see what they pay before they sign anything — no hidden fees, no
 * gas surprises.
 *
 * Reads from the same FEE_TIERS source the order form uses, so any
 * future tier change updates here automatically (single source of truth).
 */

import { FEE_TIERS } from '../lib/feeTiers';

export function PricingPanel() {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/30 p-6">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-base font-semibold text-slate-200">Pricing</h2>
        <span className="text-xs font-medium text-emerald-300">
          You pay no gas
        </span>
      </div>

      <p className="mb-4 text-sm text-slate-300">
        The keeper covers gas for every execution. You only pay a
        protocol fee, deducted from the swap output. Tier picked
        automatically by order size.
      </p>

      <div className="overflow-hidden rounded-xl border border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-900/60 text-xs uppercase tracking-wider text-slate-400">
            <tr>
              <th className="px-4 py-2 text-left">Tier</th>
              <th className="px-4 py-2 text-left">Order size</th>
              <th className="px-4 py-2 text-right">Fee</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {FEE_TIERS.map((t, i) => {
              const next = FEE_TIERS[i + 1];
              const range = next
                ? `$${t.minUsd.toLocaleString()} – $${(next.minUsd - 1).toLocaleString()}`
                : `$${t.minUsd.toLocaleString()}+`;
              const display = i === 0 ? `< $${FEE_TIERS[1].minUsd.toLocaleString()}` : range;
              return (
                <tr key={t.name} className="bg-slate-950/40">
                  <td className="px-4 py-2">
                    <span className={`inline-block rounded-md border px-2 py-0.5 text-xs ${t.badge}`}>
                      {t.name}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-300">{display}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs text-slate-200">
                    {(t.targetBps / 100).toFixed(2)}%
                    <span className="ml-1 text-slate-500">({t.targetBps} bps)</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-3 space-y-1 text-xs text-slate-400">
        <div>
          <span className="text-slate-300">Gas:</span> paid by the keeper.
          Auto-paused if the network gas price spikes above 500 gwei
          (configurable per chain) so executions never burn money during
          congestion — your order just waits for calmer conditions.
        </div>
        <div>
          <span className="text-slate-300">Fee:</span> taken from{' '}
          <em>tokenOut</em>, not tokenIn. You always get the full notional
          you signed for, minus the fee in the asset you receive.
        </div>
        <div>
          <span className="text-slate-300">Cancellation:</span> free
          off-chain. On-chain cancel costs only the gas of the cancel
          tx (~$0.001 on L2).
        </div>
      </div>

    </section>
  );
}
