import { useEffect } from 'react';
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { formatUnits } from '@owlorderfi/shared';
import { useQueryClient } from '@tanstack/react-query';
import { env, getRouterForChain } from '../lib/env';
import { getTokens, findToken } from '../lib/tokens';
import { formatSmart } from '../lib/formatAmount';
import { useAdminChain } from '../lib/AdminChainContext';
import {
  useAdminWhoami,
  useKeeperHealth,
  useContractState,
  useFees,
  useKeepersStatus,
  useEvents,
  type KeeperHealth,
  type ContractState,
  type FeeRow,
  type KeeperRow,
  type EventEntry,
} from '../hooks/useAdmin';

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

// ══════════════════════════════════════════════════════════════════
// INFO PANEL (left column) — keeper health + reserve + keepers
// Header has the chain dropdown + pause badge.
// ══════════════════════════════════════════════════════════════════

export function AdminInfoPanel({ enabled }: { enabled: boolean }) {
  const { chainId, setChainId } = useAdminChain();
  const whoami = useAdminWhoami(chainId, enabled);
  const ownerGated = enabled && whoami.data?.isOwner === true;

  const health = useKeeperHealth(chainId, ownerGated);
  const contractState = useContractState(chainId, ownerGated);
  const keeperAddrs = env.keepers[chainId] ?? [];
  const keepers = useKeepersStatus(chainId, keeperAddrs, ownerGated);
  const events = useEvents(chainId, ownerGated);

  if (!enabled) return null; // Wrap shown by AdminFeesPanel's gate; both hide when not auth

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
    return null; // Fees panel renders the "not owner" message; one is enough
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-slate-200">Operator dashboard</h2>
          {contractState.data && <PauseBadge paused={contractState.data.paused} />}
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

      <Panel title="Keeper">
        <HealthGrid health={health.data} isLoading={health.isLoading} error={health.error as Error | undefined} />
      </Panel>

      <Panel title="Reserve & refill">
        <ReserveCards
          state={contractState.data}
          isLoading={contractState.isLoading}
          chainId={chainId}
        />
      </Panel>

      <Panel title="Authorized keepers">
        <KeepersTable keepers={keepers.data ?? []} isLoading={keepers.isLoading} chainId={chainId} />
      </Panel>

      <Panel title="Recent events (last ~1h)">
        <EventsTable
          events={events.data ?? []}
          isLoading={events.isLoading}
          error={events.error as Error | undefined}
          chainId={chainId}
        />
      </Panel>

      <div className="text-xs uppercase tracking-wider text-slate-500">
        Owner-only · auto-refresh: health 5s · contract 30s · keepers 10s · fees 15s · events 30s
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// FEES PANEL (right column tab content) — fees table + sweep buttons
// ══════════════════════════════════════════════════════════════════

export function AdminFeesPanel({ enabled }: { enabled: boolean }) {
  const { chainId } = useAdminChain();
  const whoami = useAdminWhoami(chainId, enabled);
  const ownerGated = enabled && whoami.data?.isOwner === true;

  const tokens = getTokens(chainId).map((t) => t.address);
  const fees = useFees(chainId, tokens, ownerGated);

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
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 space-y-3">
      <h2 className="text-base font-semibold text-slate-200">Accumulated fees</h2>
      <FeesTable fees={fees.data ?? []} isLoading={fees.isLoading} chainId={chainId} />
      <div className="text-sm text-slate-400">
        Sweep is permissionless — anyone (incl. keeper) can call. Destination
        is fixed at fee recipient by the contract; you just pay gas.
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// Sub-panels
// ══════════════════════════════════════════════════════════════════

function PauseBadge({ paused }: { paused: boolean }) {
  return paused ? (
    <span className="rounded-full border border-rose-700 bg-rose-950/60 px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-rose-300">
      ● Paused
    </span>
  ) : (
    <span className="rounded-full border border-emerald-700 bg-emerald-950/60 px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-emerald-300">
      ● Live
    </span>
  );
}

function ReserveCards({
  state,
  isLoading,
  chainId,
}: {
  state: ContractState | undefined;
  isLoading: boolean;
  chainId: number;
}) {
  if (isLoading) return <div className="text-xs text-slate-400">Loading…</div>;
  if (!state) return null;

  const reserve = BigInt(state.accumulatedReserve);
  const target = BigInt(state.keeperReserveTargetWei);
  const fillPct =
    target === 0n ? 0 : Math.min(100, Number((reserve * 10_000n) / target) / 100);

  const refilled = BigInt(state.refilledInCurrentWindow);
  const dailyCap = BigInt(state.maxKeeperRefillPerDayWei);
  const refillPct =
    dailyCap === 0n ? 0 : Math.min(100, Number((refilled * 10_000n) / dailyCap) / 100);

  // "Available now" = how much the keeper can actually pull right now
  // (limited by both the reserve and the remaining daily window).
  const remaining = dailyCap > refilled ? dailyCap - refilled : 0n;
  const availableNow = reserve < remaining ? reserve : remaining;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <BarCard
          label="Keeper reserve"
          current={`${formatSmart(Number(formatUnits(reserve, 18)))} ETH`}
          target={`${formatSmart(Number(formatUnits(target, 18)))} ETH target`}
          pct={fillPct}
          tone={fillPct >= 100 ? 'ok' : fillPct >= 50 ? 'warn' : 'muted'}
          subtitle="Stored as WETH; unwrapped to ETH on refill (1:1)."
        />
        <BarCard
          label="Daily refill used"
          current={`${formatSmart(Number(formatUnits(refilled, 18)))} ETH`}
          target={`${formatSmart(Number(formatUnits(dailyCap, 18)))} ETH cap`}
          pct={refillPct}
          tone={refillPct >= 90 ? 'err' : refillPct >= 50 ? 'warn' : 'muted'}
          subtitle="Resets at UTC midnight."
        />
      </div>
      <div className="rounded-lg border border-cyan-900/40 bg-cyan-950/20 px-4 py-3">
        <div className="text-xs uppercase tracking-wider text-slate-400">Available now to refill keeper</div>
        <div className="font-mono text-xl text-cyan-200">
          {formatSmart(Number(formatUnits(availableNow, 18)))} ETH
        </div>
        <div className="text-xs text-slate-500">min(reserve, remaining daily cap)</div>
      </div>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
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
    </div>
  );
}

function FeesTable({
  fees,
  isLoading,
  chainId,
}: {
  fees: FeeRow[];
  isLoading: boolean;
  chainId: number;
}) {
  if (isLoading) return <div className="text-xs text-slate-400">Loading…</div>;
  if (fees.length === 0) {
    return <div className="text-xs text-slate-500">No supported tokens for chain {chainId}.</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-slate-400">
          <tr className="border-b border-slate-800">
            <th className="py-2 pr-3">Token</th>
            <th className="py-2 pr-3">Accumulated</th>
            <th className="py-2 pr-3 text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          {fees.map((row) => (
            <FeeRowDisplay key={row.token} row={row} chainId={chainId} />
          ))}
        </tbody>
      </table>
    </div>
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

  useEffect(() => {
    if (!isSuccess) return;
    void qc.invalidateQueries({ queryKey: ['admin', 'fees'] });
    void qc.invalidateQueries({ queryKey: ['admin', 'contract-state'] });
    void qc.invalidateQueries({ queryKey: ['admin', 'keepers'] });
    reset();
  }, [isSuccess, qc, reset]);

  const sweep = async () => {
    await writeContractAsync({
      address: getRouterForChain(chainId),
      abi: SWEEP_ABI,
      functionName: 'sweepFees',
      args: [row.token],
      chainId,
    });
  };

  return (
    <tr className="border-b border-slate-900/50">
      <td className="py-2 pr-3 font-mono text-slate-200">{symbol}</td>
      <td className="py-2 pr-3 font-mono text-slate-200">
        {formatSmart(Number(formatUnits(accumulated, decimals)))}
        <span className="text-xs text-slate-500">
          {' · '}
          {threshold === 0n
            ? 'inline'
            : `sweep at ${formatSmart(Number(formatUnits(threshold, decimals)))}`}
        </span>
      </td>
      <td className="py-2 pr-3 text-right">
        <button
          type="button"
          onClick={() => { void sweep().catch(() => {}); }}
          disabled={!hasFees || isSubmitting || isMining}
          className="rounded border border-cyan-700/60 bg-cyan-900/20 px-3 py-1.5 text-sm font-medium text-cyan-200 hover:bg-cyan-900/40 disabled:cursor-not-allowed disabled:opacity-30"
          title={!hasFees ? 'Nothing to sweep' : `Calls router.sweepFees(${symbol})`}
        >
          {isSubmitting ? 'Confirm…' : isMining ? 'Mining…' : 'Sweep'}
        </button>
      </td>
    </tr>
  );
}

function KeepersTable({
  keepers,
  isLoading,
  chainId,
}: {
  keepers: KeeperRow[];
  isLoading: boolean;
  chainId: number;
}) {
  if (isLoading) return <div className="text-xs text-slate-400">Loading…</div>;
  if (keepers.length === 0) {
    return (
      <div className="text-xs text-slate-500">
        No keeper addresses configured for chain {chainId}. Set{' '}
        <code className="text-slate-400">VITE_CHAIN_{chainId}_KEEPERS</code> in apps/web/.env to enable.
      </div>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-slate-400">
        <tr className="border-b border-slate-800">
          <th className="py-2 pr-3">Address</th>
          <th className="py-2 pr-3">Authorized</th>
          <th className="py-2 pr-3">Native balance</th>
        </tr>
      </thead>
      <tbody>
        {keepers.map((k) => {
          const bal = Number(formatUnits(BigInt(k.balanceWei), 18));
          const balTone = bal === 0 ? 'err' : bal < 0.005 ? 'warn' : 'ok';
          return (
            <tr key={k.address} className="border-b border-slate-900/50">
              <td className="py-2 pr-3 font-mono text-slate-200">
                <a
                  href={explorerAddr(chainId, k.address)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-cyan-300"
                >
                  {shortAddr(k.address)}
                </a>
              </td>
              <td className="py-2 pr-3 font-mono">
                {k.authorized ? (
                  <span className="text-emerald-400">yes</span>
                ) : (
                  <span className="text-rose-400">no</span>
                )}
              </td>
              <td className={`py-2 pr-3 font-mono ${TONE_CLASS[balTone]}`}>
                {formatSmart(bal)} ETH
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function EventsTable({
  events,
  isLoading,
  error,
  chainId,
}: {
  events: EventEntry[];
  isLoading: boolean;
  error: Error | undefined;
  chainId: number;
}) {
  if (isLoading) return <div className="text-sm text-slate-400">Loading events…</div>;
  if (error) return <div className="text-sm text-rose-300">Events query failed: {error.message}</div>;
  if (events.length === 0) {
    return <div className="text-sm text-slate-500">No events in the last ~1h.</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-slate-400">
          <tr className="border-b border-slate-800">
            <th className="py-2 pr-3 text-xs uppercase tracking-wider">When</th>
            <th className="py-2 pr-3 text-xs uppercase tracking-wider">Event</th>
            <th className="py-2 pr-3 text-xs uppercase tracking-wider">Details</th>
            <th className="py-2 pr-3 text-xs uppercase tracking-wider text-right">Tx</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <EventRow key={`${e.txHash}-${e.eventName}`} event={e} chainId={chainId} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EventRow({ event, chainId }: { event: EventEntry; chainId: number }) {
  const ago = since(new Date(event.timestamp * 1000).toISOString());
  const { badge, tone, details } = formatEventForDisplay(event, chainId);

  return (
    <tr className="border-b border-slate-900/50">
      <td className="py-2 pr-3 font-mono text-slate-300" title={`Block ${event.blockNumber}`}>
        {ago === null ? '?' : `${fmtTime(ago)} ago`}
      </td>
      <td className="py-2 pr-3">
        <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold uppercase tracking-wider ${tone}`}>
          {badge}
        </span>
      </td>
      <td className="py-2 pr-3 font-mono text-slate-200">{details}</td>
      <td className="py-2 pr-3 text-right">
        <a
          href={explorerTx(chainId, event.txHash)}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-xs text-cyan-400 hover:text-cyan-300"
          title={event.txHash}
        >
          {event.txHash.slice(0, 8)}…
        </a>
      </td>
    </tr>
  );
}

/**
 * Map a raw event into a colored badge + a human-readable details
 * string. Args are already string-serialized by the API; bigint
 * fields parse back here for unit formatting.
 */
function formatEventForDisplay(
  event: EventEntry,
  chainId: number,
): { badge: string; tone: string; details: string } {
  const a = event.args;
  switch (event.eventName) {
    case 'KeeperRefilled': {
      const amount = formatSmart(Number(formatUnits(BigInt(a.amount), 18)));
      return {
        badge: 'REFILL',
        tone: 'border-cyan-700 bg-cyan-950/40 text-cyan-200',
        details: `${amount} ETH → keeper ${shortAddr(a.keeper)}`,
      };
    }
    case 'FeesSwept': {
      const token = findToken(chainId, a.token);
      const decimals = token?.decimals ?? 18;
      const symbol = token?.symbol ?? shortAddr(a.token);
      const amount = formatSmart(Number(formatUnits(BigInt(a.amount), decimals)));
      return {
        badge: 'SWEEP',
        tone: 'border-emerald-700 bg-emerald-950/40 text-emerald-200',
        details: `${amount} ${symbol} → ${shortAddr(a.to)}`,
      };
    }
    case 'KeeperReserveAccumulated': {
      const token = findToken(chainId, a.token);
      const symbol = token?.symbol ?? 'WETH';
      const added = formatSmart(Number(formatUnits(BigInt(a.added), 18)));
      const newTotal = formatSmart(Number(formatUnits(BigInt(a.newTotal), 18)));
      const target = formatSmart(Number(formatUnits(BigInt(a.target), 18)));
      return {
        badge: 'RESERVE+',
        tone: 'border-amber-700 bg-amber-950/40 text-amber-200',
        details: `+${added} ${symbol} → ${newTotal}/${target}`,
      };
    }
    case 'FeesAccumulated': {
      const token = findToken(chainId, a.token);
      const decimals = token?.decimals ?? 18;
      const symbol = token?.symbol ?? shortAddr(a.token);
      const amount = formatSmart(Number(formatUnits(BigInt(a.amount), decimals)));
      const total = formatSmart(Number(formatUnits(BigInt(a.newTotal), decimals)));
      return {
        badge: 'ACCUM',
        tone: 'border-slate-600 bg-slate-800/60 text-slate-300',
        details: `+${amount} ${symbol} → total ${total}`,
      };
    }
    default:
      return {
        badge: event.eventName.toUpperCase(),
        tone: 'border-slate-600 bg-slate-800/60 text-slate-300',
        details: '—',
      };
  }
}

function explorerTx(chainId: number, hash: string): string {
  const base = chainId === 84532
    ? 'https://sepolia.basescan.org'
    : chainId === 8453
      ? 'https://basescan.org'
      : chainId === 137
        ? 'https://polygonscan.com'
        : '';
  return base ? `${base}/tx/${hash}` : '#';
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
  if (isLoading) return <div className="text-xs text-slate-400">Loading keeper health…</div>;
  if (error) return <div className="text-xs text-rose-300">Keeper unreachable: {error.message}</div>;
  if (!health) return null;

  const lastPollSec = since(health.last_poll_at);
  const lastFillSec = since(health.last_fill_at);
  const pollTone = lastPollSec === null ? 'muted' : lastPollSec < 10 ? 'ok' : lastPollSec < 60 ? 'warn' : 'err';
  const statusTone = health.status === 'ok' ? 'ok' : 'err';

  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">
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

// ══════════════════════════════════════════════════════════════════
// Small UI primitives
// ══════════════════════════════════════════════════════════════════

type Tone = 'ok' | 'warn' | 'err' | 'muted' | undefined;
const TONE_CLASS: Record<Exclude<Tone, undefined>, string> = {
  ok: 'text-emerald-400',
  warn: 'text-amber-300',
  err: 'text-rose-400',
  muted: 'text-slate-500',
};

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 space-y-3">
      <div className="text-xs uppercase tracking-wider text-slate-400">{title}</div>
      {children}
    </div>
  );
}

function Card({ label, value, tone }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
      <div className="text-xs uppercase tracking-wider text-slate-400">{label}</div>
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
  subtitle,
}: {
  label: string;
  current: string;
  target: string;
  pct: number;
  tone: Exclude<Tone, undefined>;
  subtitle?: string;
}) {
  const barColor =
    tone === 'ok' ? 'bg-emerald-500'
    : tone === 'warn' ? 'bg-amber-500'
    : tone === 'err' ? 'bg-rose-500'
    : 'bg-slate-500';
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
      <div className="flex items-baseline justify-between">
        <div className="text-xs uppercase tracking-wider text-slate-400">{label}</div>
        <div className="text-xs text-slate-500">{pct.toFixed(0)}%</div>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-slate-800">
        <div className={`h-full ${barColor} transition-all duration-300`} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-2 flex items-baseline justify-between text-sm">
        <span className={`font-mono ${TONE_CLASS[tone]}`}>{current}</span>
        <span className="font-mono text-slate-500">{target}</span>
      </div>
      {subtitle && <div className="mt-1 text-xs text-slate-500">{subtitle}</div>}
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
      <div className="text-xs uppercase tracking-wider text-slate-400">{k}</div>
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
  const base = chainId === 84532
    ? 'https://sepolia.basescan.org'
    : chainId === 8453
      ? 'https://basescan.org'
      : chainId === 137
        ? 'https://polygonscan.com'
        : '';
  return base ? `${base}/address/${addr}` : '#';
}
