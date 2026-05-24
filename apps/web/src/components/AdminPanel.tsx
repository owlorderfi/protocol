import { useEffect, useState } from 'react';
import { useChainId, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { formatUnits } from '@owlorderfi/shared';
import { env, getRouterForChain } from '../lib/env';
import { getTokens, findToken } from '../lib/tokens';
import { formatSmart } from '../lib/formatAmount';
import {
  useAdminWhoami,
  useKeeperHealth,
  useContractState,
  useFees,
  useKeepersStatus,
  type KeeperHealth,
  type ContractState,
  type FeeRow,
  type KeeperRow,
} from '../hooks/useAdmin';
import { useQueryClient } from '@tanstack/react-query';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

const SWEEP_ABI = [
  {
    type: 'function',
    name: 'sweepFees',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [],
  },
] as const;

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
 * Bundle 1 layout: keeper health (top) + on-chain reserve + fees
 * table with sweep buttons + authorized keepers.
 */
export function AdminPanel({ enabled }: { enabled: boolean }) {
  const connectedChainId = useChainId();
  const fallback = env.chainIds[0]!;
  const [chainId, setChainId] = useState<number>(connectedChainId ?? fallback);

  const whoami = useAdminWhoami(chainId, enabled);
  const ownerGated = enabled && whoami.data?.isOwner === true;

  const health = useKeeperHealth(chainId, ownerGated);
  const contractState = useContractState(chainId, ownerGated);

  // Token list from the frontend's registry — caller-supplies is the
  // chosen pattern (no API duplication of tokens.ts).
  const tokens = getTokens(chainId).map((t) => t.address);
  const fees = useFees(chainId, tokens, ownerGated);

  const keeperAddrs = env.keepers[chainId] ?? [];
  const keepers = useKeepersStatus(chainId, keeperAddrs, ownerGated);

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
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-slate-200">Operator dashboard</h2>
          {contractState.data && (
            <PauseBadge paused={contractState.data.paused} />
          )}
        </div>
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

      <ReservePanel state={contractState.data} isLoading={contractState.isLoading} chainId={chainId} />

      <FeesPanel fees={fees.data ?? []} chainId={chainId} isLoading={fees.isLoading} />

      <KeepersPanel keepers={keepers.data ?? []} isLoading={keepers.isLoading} chainId={chainId} />

      <div className="border-t border-slate-800 pt-2 text-[10px] uppercase tracking-wider text-slate-500">
        Owner-only · auto-refresh: health 5s · contract 30s · fees 15s · keepers 30s
      </div>
    </div>
  );
}

// ─── Sub-panels ────────────────────────────────────────────────────

function PauseBadge({ paused }: { paused: boolean }) {
  return paused ? (
    <span className="rounded-full border border-rose-700 bg-rose-950/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-rose-300">
      ● Paused
    </span>
  ) : (
    <span className="rounded-full border border-emerald-700 bg-emerald-950/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-300">
      ● Live
    </span>
  );
}

function ReservePanel({
  state,
  isLoading,
  chainId,
}: {
  state: ContractState | undefined;
  isLoading: boolean;
  chainId: number;
}) {
  if (isLoading) {
    return <Section title="Reserve">Loading…</Section>;
  }
  if (!state) return null;

  // Native = 18 dec on all our chains today. If we add a chain with
  // a different native decimals, look it up from CHAINS instead.
  const reserve = BigInt(state.accumulatedReserve);
  const target = BigInt(state.keeperReserveTargetWei);
  const fillPct =
    target === 0n
      ? 0
      : Math.min(100, Number((reserve * 10_000n) / target) / 100);

  const refilled = BigInt(state.refilledInCurrentWindow);
  const dailyCap = BigInt(state.maxKeeperRefillPerDayWei);
  const refillPct =
    dailyCap === 0n
      ? 0
      : Math.min(100, Number((refilled * 10_000n) / dailyCap) / 100);

  return (
    <Section title="Reserve & refill">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <BarCard
          label="Keeper reserve (WETH)"
          current={`${formatSmart(Number(formatUnits(reserve, 18)))} ETH`}
          target={`${formatSmart(Number(formatUnits(target, 18)))} ETH target`}
          pct={fillPct}
          tone={fillPct >= 100 ? 'ok' : fillPct >= 50 ? 'warn' : 'muted'}
        />
        <BarCard
          label="Daily refill used"
          current={`${formatSmart(Number(formatUnits(refilled, 18)))} ETH`}
          target={`${formatSmart(Number(formatUnits(dailyCap, 18)))} ETH cap`}
          pct={refillPct}
          tone={refillPct >= 90 ? 'err' : refillPct >= 50 ? 'warn' : 'muted'}
        />
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
        <KV
          k="Fee recipient"
          v={shortAddr(state.feeRecipient)}
          link={explorerAddr(chainId, state.feeRecipient)}
          title={state.feeRecipient}
        />
        <KV
          k="Native wrapped"
          v={
            state.nativeWrappedToken === ZERO_ADDR
              ? <span className="text-rose-400">disabled</span>
              : shortAddr(state.nativeWrappedToken)
          }
          link={
            state.nativeWrappedToken === ZERO_ADDR
              ? undefined
              : explorerAddr(chainId, state.nativeWrappedToken)
          }
          title={state.nativeWrappedToken}
        />
      </div>
    </Section>
  );
}

function FeesPanel({
  fees,
  chainId,
  isLoading,
}: {
  fees: FeeRow[];
  chainId: number;
  isLoading: boolean;
}) {
  if (isLoading) {
    return <Section title="Accumulated fees">Loading…</Section>;
  }
  if (fees.length === 0) {
    return <Section title="Accumulated fees">No supported tokens configured for chain {chainId}.</Section>;
  }
  return (
    <Section title="Accumulated fees">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-left text-slate-400">
            <tr className="border-b border-slate-800">
              <th className="py-1.5 pr-3">Token</th>
              <th className="py-1.5 pr-3">Accumulated</th>
              <th className="py-1.5 pr-3">Auto-sweep at</th>
              <th className="py-1.5 pr-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {fees.map((row) => (
              <FeeRowDisplay key={row.token} row={row} chainId={chainId} />
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 text-[10px] text-slate-500">
        Sweep is permissionless — anyone (including the keeper) can call it.
        The destination is fixed at the fee recipient by the contract.
      </div>
    </Section>
  );
}

function FeeRowDisplay({ row, chainId }: { row: FeeRow; chainId: number }) {
  const token = findToken(chainId, row.token);
  const decimals = token?.decimals ?? 18;
  const symbol = token?.symbol ?? shortAddr(row.token);
  const accumulated = BigInt(row.accumulated);
  const threshold = BigInt(row.sweepThreshold);
  const hasFees = accumulated > 0n;

  const qc = useQueryClient();
  const { writeContractAsync, isPending: isSubmitting, data: txHash, reset } =
    useWriteContract();
  const { isLoading: isMining, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
    query: { enabled: !!txHash },
  });

  // Refresh fees + contract-state when the sweep tx confirms. Must
  // be in an effect — running invalidate() during render triggers a
  // refetch which sets isSuccess again on the next cycle → infinite
  // loop. Same reason `reset()` belongs here.
  useEffect(() => {
    if (!isSuccess) return;
    void qc.invalidateQueries({ queryKey: ['admin', 'fees'] });
    void qc.invalidateQueries({ queryKey: ['admin', 'contract-state'] });
    reset();
  }, [isSuccess, qc, reset]);

  const sweep = async () => {
    await writeContractAsync({
      address: getRouterForChain(chainId),
      abi: SWEEP_ABI,
      functionName: 'sweepFees',
      args: [row.token],
      // Explicit chainId so wagmi prompts a wallet switch when the
      // dashboard's selected chain differs from the wallet's current
      // chain. Without this the tx signs against whatever chain the
      // wallet is on — which would either revert (no contract at the
      // address on that chain) or, worse, hit an unrelated contract
      // at the same address on a different chain.
      chainId,
    });
  };

  return (
    <tr className="border-b border-slate-900/50">
      <td className="py-1.5 pr-3 font-mono text-slate-200">{symbol}</td>
      <td className="py-1.5 pr-3 font-mono text-slate-200">
        {formatSmart(Number(formatUnits(accumulated, decimals)))}{' '}
        <span className="text-slate-500">{symbol}</span>
      </td>
      <td className="py-1.5 pr-3 font-mono text-slate-400">
        {threshold === 0n
          ? <span title="0 → fees forward inline, never accumulate">inline</span>
          : `${formatSmart(Number(formatUnits(threshold, decimals)))} ${symbol}`}
      </td>
      <td className="py-1.5 pr-3 text-right">
        <button
          type="button"
          onClick={() => { void sweep().catch(() => {}); }}
          disabled={!hasFees || isSubmitting || isMining}
          className="rounded border border-cyan-700/60 bg-cyan-900/20 px-2 py-1 text-[11px] font-medium text-cyan-200 hover:bg-cyan-900/40 disabled:cursor-not-allowed disabled:opacity-30"
          title={
            !hasFees
              ? 'Nothing to sweep'
              : `Calls router.sweepFees(${symbol}) — fixed destination, you just pay gas.`
          }
        >
          {isSubmitting ? 'Confirm…' : isMining ? 'Mining…' : 'Sweep'}
        </button>
      </td>
    </tr>
  );
}

function KeepersPanel({
  keepers,
  chainId,
  isLoading,
}: {
  keepers: KeeperRow[];
  chainId: number;
  isLoading: boolean;
}) {
  if (isLoading) {
    return <Section title="Authorized keepers">Loading…</Section>;
  }
  if (keepers.length === 0) {
    return (
      <Section title="Authorized keepers">
        <span className="text-xs text-slate-500">
          No keeper addresses configured for chain {chainId}.{' '}
          Set <code className="text-slate-400">VITE_CHAIN_{chainId}_KEEPERS</code> in apps/web/.env to enable.
        </span>
      </Section>
    );
  }
  return (
    <Section title="Authorized keepers">
      <table className="w-full text-xs">
        <thead className="text-left text-slate-400">
          <tr className="border-b border-slate-800">
            <th className="py-1.5 pr-3">Address</th>
            <th className="py-1.5 pr-3">Authorized</th>
            <th className="py-1.5 pr-3">Native balance</th>
          </tr>
        </thead>
        <tbody>
          {keepers.map((k) => {
            const bal = Number(formatUnits(BigInt(k.balanceWei), 18));
            const balTone = bal === 0 ? 'err' : bal < 0.005 ? 'warn' : 'ok';
            return (
              <tr key={k.address} className="border-b border-slate-900/50">
                <td className="py-1.5 pr-3 font-mono text-slate-200">
                  <a
                    href={explorerAddr(chainId, k.address)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-cyan-300"
                  >
                    {shortAddr(k.address)}
                  </a>
                </td>
                <td className="py-1.5 pr-3 font-mono">
                  {k.authorized ? (
                    <span className="text-emerald-400">yes</span>
                  ) : (
                    <span className="text-rose-400">no</span>
                  )}
                </td>
                <td className={`py-1.5 pr-3 font-mono ${TONE_CLASS[balTone]}`}>
                  {formatSmart(bal)} ETH
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Section>
  );
}

// ─── Health (Bundle 0, unchanged) ──────────────────────────────────

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
    return <Section title="Keeper">Loading keeper health…</Section>;
  }
  if (error) {
    return (
      <Section title="Keeper">
        <div className="text-xs text-rose-300">Keeper unreachable: {error.message}</div>
      </Section>
    );
  }
  if (!health) return null;

  const lastPollSec = since(health.last_poll_at);
  const lastFillSec = since(health.last_fill_at);
  const pollTone = lastPollSec === null ? 'muted' : lastPollSec < 10 ? 'ok' : lastPollSec < 60 ? 'warn' : 'err';
  const statusTone = health.status === 'ok' ? 'ok' : 'err';

  return (
    <Section title="Keeper">
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
    </Section>
  );
}

// ─── Small UI primitives ───────────────────────────────────────────

type Tone = 'ok' | 'warn' | 'err' | 'muted' | undefined;
const TONE_CLASS: Record<Exclude<Tone, undefined>, string> = {
  ok: 'text-emerald-400',
  warn: 'text-amber-300',
  err: 'text-rose-400',
  muted: 'text-slate-500',
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-400">{title}</div>
      {children}
    </div>
  );
}

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

function BarCard({
  label,
  current,
  target,
  pct,
  tone,
}: {
  label: string;
  current: string;
  target: string;
  pct: number;
  tone: Exclude<Tone, undefined>;
}) {
  const barColor =
    tone === 'ok' ? 'bg-emerald-500'
    : tone === 'warn' ? 'bg-amber-500'
    : tone === 'err' ? 'bg-rose-500'
    : 'bg-slate-500';
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
      <div className="flex items-baseline justify-between">
        <div className="text-[10px] uppercase tracking-wider text-slate-400">{label}</div>
        <div className="text-[10px] text-slate-500">{pct.toFixed(0)}%</div>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-slate-800">
        <div className={`h-full ${barColor} transition-all duration-300`} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 flex items-baseline justify-between text-xs">
        <span className={`font-mono ${TONE_CLASS[tone]}`}>{current}</span>
        <span className="font-mono text-slate-500">{target}</span>
      </div>
    </div>
  );
}

function KV({
  k,
  v,
  link,
  title,
}: {
  k: string;
  v: React.ReactNode;
  link?: string;
  title?: string;
}) {
  const body = link ? (
    <a href={link} target="_blank" rel="noopener noreferrer" className="hover:text-cyan-300" title={title}>
      {v}
    </a>
  ) : (
    <span title={title}>{v}</span>
  );
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-slate-400">{k}</div>
      <div className="font-mono text-sm text-slate-200">{body}</div>
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

function explorerAddr(chainId: number, addr: string): string {
  // Source from shared CHAINS would be cleaner; quick map here for the
  // 2 chains we actually serve from the UI today.
  const base = chainId === 84532
    ? 'https://sepolia.basescan.org'
    : chainId === 8453
      ? 'https://basescan.org'
      : chainId === 137
        ? 'https://polygonscan.com'
        : '';
  return base ? `${base}/address/${addr}` : '#';
}
