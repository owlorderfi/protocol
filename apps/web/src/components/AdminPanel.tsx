import { useState } from 'react';
import { useChainId } from 'wagmi';
import { env } from '../lib/env';
import { useAdminWhoami, useKeeperHealth, type KeeperHealth } from '../hooks/useAdmin';

/**
 * Operator dashboard — surfaces the keeper's /health JSON via the
 * owner-only API proxy. Visible (and the underlying endpoints
 * accessible) only when the connected wallet matches the on-chain
 * owner of the selected chain.
 *
 * Two-layer gate:
 *  - UI: hide the entire panel unless `whoami.isOwner === true`
 *  - API: OwnerOnlyGuard rejects the proxy call with 403 if the JWT
 *    wallet ≠ on-chain owner (defense in depth — DevTools bypass of
 *    the UI gate still gets nothing back from the server)
 *
 * Chain dropdown lets operator inspect any configured chain's keeper;
 * defaults to whatever chain the wallet is on. Single-chain deploys
 * still render the dropdown (degraded to one option) so the UX is
 * uniform whether the operator runs Base Sepolia or a fleet of L2s.
 */
export function AdminPanel({ enabled }: { enabled: boolean }) {
  const connectedChainId = useChainId();
  const fallback = env.chainIds[0]!;
  const [chainId, setChainId] = useState<number>(connectedChainId ?? fallback);

  const whoami = useAdminWhoami(chainId, enabled);
  const health = useKeeperHealth(chainId, enabled && whoami.data?.isOwner === true);

  if (!enabled) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 text-sm text-slate-400">
        Sign in to access operator tools.
      </div>
    );
  }

  if (whoami.isLoading) {
    return <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 text-sm text-slate-400">Checking ownership…</div>;
  }

  if (whoami.isError) {
    return (
      <div className="rounded-xl border border-rose-900/50 bg-rose-950/40 p-5 text-sm text-rose-300">
        Owner lookup failed: {(whoami.error as Error).message}
      </div>
    );
  }

  if (whoami.data && !whoami.data.isOwner) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 space-y-2 text-sm">
        <div className="text-slate-300">Not the owner of this chain.</div>
        <div className="text-xs text-slate-400 font-mono">
          You: {shortAddr(whoami.data.walletAddress)}<br />
          Owner: {shortAddr(whoami.data.owner)}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-200">Keeper dashboard</h2>
        <label className="flex items-center gap-2 text-xs text-slate-400">
          <span>Chain</span>
          <select
            value={chainId}
            onChange={(e) => setChainId(Number(e.target.value))}
            className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none"
          >
            {env.chainIds.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        </label>
      </div>

      <HealthGrid health={health.data} isLoading={health.isLoading} error={health.error as Error | undefined} />

      <div className="border-t border-slate-800 pt-2 text-[10px] uppercase tracking-wider text-slate-500">
        Owner-only · auto-refresh 5s ·{' '}
        <span className={health.isFetching ? 'text-cyan-400' : 'text-slate-500'}>
          {health.isFetching ? 'refreshing…' : 'idle'}
        </span>
      </div>
    </div>
  );
}

function HealthGrid({
  health,
  isLoading,
  error,
}: {
  health: KeeperHealth | undefined;
  isLoading: boolean;
  error: Error | undefined;
}) {
  if (isLoading) {
    return <div className="text-sm text-slate-400">Loading keeper health…</div>;
  }
  if (error) {
    return (
      <div className="rounded border border-rose-900/50 bg-rose-950/40 p-3 text-xs text-rose-300">
        Keeper unreachable: {error.message}
      </div>
    );
  }
  if (!health) return null;

  const lastPollSec = since(health.last_poll_at);
  const lastFillSec = since(health.last_fill_at);
  const pollTone = lastPollSec === null ? 'muted' : lastPollSec < 10 ? 'ok' : lastPollSec < 60 ? 'warn' : 'err';
  const statusTone = health.status === 'ok' ? 'ok' : 'err';

  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
      <Card label="Status" value={health.status} tone={statusTone} />
      <Card label="Uptime" value={fmtTime(health.uptime_seconds)} />
      <Card
        label="Open orders"
        value={health.open_orders.toString()}
        tone={health.open_orders > 0 ? 'ok' : 'muted'}
      />
      <Card
        label="Last poll"
        value={lastPollSec === null ? 'never' : `${fmtTime(lastPollSec)} ago`}
        tone={pollTone}
      />
      <Card
        label="Last fill"
        value={lastFillSec === null ? 'never' : `${fmtTime(lastFillSec)} ago`}
        tone={lastFillSec === null ? 'muted' : 'ok'}
      />
      <Card label="Orders polled" value={health.orders_polled.toString()} />
      <Card label="Orders triggered" value={health.orders_triggered.toString()} />
      <Card label="Tx submitted" value={health.tx_submitted.toString()} />
      <Card
        label="Tx replaced"
        value={health.tx_replaced.toString()}
        tone={health.tx_replaced > 0 ? 'warn' : 'muted'}
      />
    </div>
  );
}

type Tone = 'ok' | 'warn' | 'err' | 'muted' | undefined;
const TONE_CLASS: Record<Exclude<Tone, undefined>, string> = {
  ok: 'text-emerald-400',
  warn: 'text-amber-300',
  err: 'text-rose-400',
  muted: 'text-slate-500',
};

function Card({ label, value, tone }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-400">{label}</div>
      <div className={`font-mono text-lg ${tone ? TONE_CLASS[tone] : 'text-slate-200'}`}>
        {value}
      </div>
    </div>
  );
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function fmtTime(sec: number): string {
  if (sec === null || sec === undefined || sec < 0) return '—';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}

function since(iso: string | null): number | null {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
}
