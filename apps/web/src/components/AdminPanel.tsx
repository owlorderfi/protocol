import { useEffect, useState } from 'react';
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseUnits, formatUnits } from '@owlorderfi/shared';
import { isAddress, getAddress } from 'viem';
import { useQueryClient } from '@tanstack/react-query';
import { env, getRouterForChain } from '../lib/env';
import { getTokens, findToken } from '../lib/tokens';
import { formatSmart } from '../lib/formatAmount';
import { useAdminChain } from '../lib/AdminChainContext';
import { ConfirmModal } from './ConfirmModal';
import {
  useAdminWhoami,
  useKeeperHealth,
  useContractState,
  useFees,
  useKeepersStatus,
  useEvents,
  useDbStats,
  type KeeperHealth,
  type ContractState,
  type FeeRow,
  type KeeperRow,
  type EventEntry,
  type DbStats,
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

/**
 * Owner-only writes used by AdminActionsPanel. Kept separate from
 * SWEEP_ABI so a future ABI mismatch on one path doesn't take down
 * the other.
 */
const ADMIN_WRITE_ABI = [
  { type: 'function', name: 'pause', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'unpause', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  {
    type: 'function',
    name: 'setKeeperReserveTarget',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'targetWei', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setSweepThreshold',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'threshold', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setFeeRecipient',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newRecipient', type: 'address' }],
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
  const dbStats = useDbStats(chainId, ownerGated);

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

      <Panel title="DB activity">
        <StatsPanel stats={dbStats.data} isLoading={dbStats.isLoading} chainId={chainId} />
      </Panel>

      <Panel title="Authorized keepers">
        <KeepersTable keepers={keepers.data ?? []} isLoading={keepers.isLoading} chainId={chainId} />
      </Panel>

      <Panel title="Recent events (last 100, all time)">
        <EventsTable
          events={events.data ?? []}
          isLoading={events.isLoading}
          error={events.error as Error | undefined}
          chainId={chainId}
        />
      </Panel>

      <Panel title="Owner actions (danger zone)">
        <AdminActionsPanel chainId={chainId} state={contractState.data} />
      </Panel>

      <div className="text-xs uppercase tracking-wider text-slate-500">
        Owner-only · auto-refresh: health 5s · contract 30s · keepers 10s · fees 15s · events 30s · db-stats 30s
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

// ══════════════════════════════════════════════════════════════════
// Owner actions panel — pause/unpause + adjust reserve target +
// adjust per-token sweep threshold + update fee recipient. Every
// action goes through the user's wallet (wagmi useWriteContract);
// API doesn't broadcast. After tx success → invalidate the relevant
// admin queries so the panel reflects the new state immediately.
// ══════════════════════════════════════════════════════════════════

function AdminActionsPanel({
  chainId,
  state,
}: {
  chainId: number;
  state: ContractState | undefined;
}) {
  const [openModal, setOpenModal] = useState<
    null | 'pause' | 'reserve' | 'threshold' | 'feeRecipient'
  >(null);

  return (
    <>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <ActionButton
          onClick={() => setOpenModal('pause')}
          disabled={!state}
          tone={state?.paused ? 'ok' : 'danger'}
        >
          {state?.paused ? 'Unpause contract' : 'Pause contract'}
        </ActionButton>
        <ActionButton
          onClick={() => setOpenModal('reserve')}
          disabled={!state}
        >
          Adjust keeper reserve target
        </ActionButton>
        <ActionButton onClick={() => setOpenModal('threshold')}>
          Adjust per-token sweep threshold
        </ActionButton>
        <ActionButton
          onClick={() => setOpenModal('feeRecipient')}
          tone="warn"
        >
          Change fee recipient
        </ActionButton>
      </div>
      <div className="text-xs text-slate-500">
        All actions sign from your wallet — the API doesn't broadcast.
        Pausing + fee recipient changes are high-blast-radius → both
        require typing a confirmation word.
      </div>

      <PauseModal
        open={openModal === 'pause'}
        onClose={() => setOpenModal(null)}
        chainId={chainId}
        paused={state?.paused ?? false}
      />
      <AdjustReserveModal
        open={openModal === 'reserve'}
        onClose={() => setOpenModal(null)}
        chainId={chainId}
        currentWei={state?.keeperReserveTargetWei ?? '0'}
      />
      <AdjustThresholdModal
        open={openModal === 'threshold'}
        onClose={() => setOpenModal(null)}
        chainId={chainId}
      />
      <FeeRecipientModal
        open={openModal === 'feeRecipient'}
        onClose={() => setOpenModal(null)}
        chainId={chainId}
        currentRecipient={state?.feeRecipient ?? '0x0000000000000000000000000000000000000000'}
      />
    </>
  );
}

function ActionButton({
  children,
  onClick,
  disabled,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'neutral' | 'warn' | 'danger' | 'ok';
}) {
  const toneClass =
    tone === 'danger' ? 'border-rose-700/60 bg-rose-900/20 text-rose-200 hover:bg-rose-900/40'
    : tone === 'warn' ? 'border-amber-700/60 bg-amber-900/20 text-amber-200 hover:bg-amber-900/40'
    : tone === 'ok' ? 'border-emerald-700/60 bg-emerald-900/20 text-emerald-200 hover:bg-emerald-900/40'
    : 'border-slate-700/60 bg-slate-800/40 text-slate-200 hover:bg-slate-800/60';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg border px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40 ${toneClass}`}
    >
      {children}
    </button>
  );
}

/**
 * Shared hook for admin write actions. Wraps useWriteContract +
 * useWaitForTransactionReceipt + post-success query invalidation +
 * error surfacing into a flat API that every action modal consumes.
 *
 * `submit(args)` accepts the same args object as wagmi's
 * writeContractAsync — keeps the type plumbing simple.
 */
type WriteArgs = Parameters<ReturnType<typeof useWriteContract>['writeContractAsync']>[0];

function useAdminAction(invalidateKeys: string[][]) {
  const qc = useQueryClient();
  const { writeContractAsync, isPending: isSubmitting, data: txHash, reset, error: writeError } = useWriteContract();
  const { isLoading: isMining, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
    query: { enabled: !!txHash },
  });
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!isSuccess) return;
    for (const key of invalidateKeys) {
      void qc.invalidateQueries({ queryKey: key });
    }
    reset();
  }, [isSuccess, qc, reset, invalidateKeys]);

  const errorMsg = localError ?? (writeError ? writeError.message.slice(0, 200) : null);

  const submit = async (args: WriteArgs): Promise<boolean> => {
    setLocalError(null);
    try {
      await writeContractAsync(args);
      return true;
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (m.includes('User rejected')) {
        setLocalError(null); // silent — user cancelled in wallet
      } else {
        setLocalError(m.slice(0, 200));
      }
      return false;
    }
  };

  return {
    submit,
    isSubmitting: isSubmitting || isMining,
    isSuccess,
    error: errorMsg,
  };
}

function PauseModal({
  open,
  onClose,
  chainId,
  paused,
}: {
  open: boolean;
  onClose: () => void;
  chainId: number;
  paused: boolean;
}) {
  const action = useAdminAction([['admin', 'contract-state']]);
  useEffect(() => {
    if (action.isSuccess) onClose();
  }, [action.isSuccess, onClose]);

  const word = paused ? 'UNPAUSE' : 'PAUSE';
  const fnName: 'pause' | 'unpause' = paused ? 'unpause' : 'pause';

  return (
    <ConfirmModal
      open={open}
      onClose={onClose}
      title={paused ? 'Unpause contract' : 'Pause contract'}
      tone={paused ? 'neutral' : 'danger'}
      confirmLabel={paused ? 'Unpause' : 'Pause now'}
      submittingLabel="Confirming on-chain…"
      isSubmitting={action.isSubmitting}
      error={action.error}
      typeToConfirm={word}
      body={
        paused ? (
          <>
            <p>
              The contract is currently <span className="text-rose-300 font-semibold">PAUSED</span>.
              Users cannot create or execute orders. Unpausing immediately restores normal trading.
            </p>
            <p className="text-xs text-slate-500">
              Verify whatever incident caused the pause has been investigated before resuming.
            </p>
          </>
        ) : (
          <>
            <p>
              Pausing <span className="font-semibold">stops every executeOrder + unwrap call
              for all users immediately</span>. Existing orders sit untouched on-chain;
              users can still cancel.
            </p>
            <p className="text-xs text-slate-500">
              Use only for true emergencies (live exploit, bad keeper config, contract bug).
              You'll need to unpause manually to resume.
            </p>
          </>
        )
      }
      onConfirm={async () => {
        await action.submit({
          address: getRouterForChain(chainId),
          abi: ADMIN_WRITE_ABI,
          functionName: fnName,
          args: [],
          chainId,
        });
      }}
    />
  );
}

function AdjustReserveModal({
  open,
  onClose,
  chainId,
  currentWei,
}: {
  open: boolean;
  onClose: () => void;
  chainId: number;
  currentWei: string;
}) {
  const action = useAdminAction([['admin', 'contract-state']]);
  const [valueEth, setValueEth] = useState('');
  // Reset input on each open so a previous attempt doesn't linger.
  useEffect(() => { if (open) setValueEth(''); }, [open]);
  useEffect(() => {
    if (action.isSuccess) onClose();
  }, [action.isSuccess, onClose]);

  // Parse ETH input → bigint wei. Bad input shows below.
  let newWei: bigint | null = null;
  let parseError: string | null = null;
  if (valueEth.trim() !== '') {
    try {
      newWei = parseUnits(valueEth.trim(), 18);
      if (newWei < 0n) {
        parseError = 'Value must be ≥ 0';
        newWei = null;
      }
    } catch {
      parseError = 'Invalid number';
    }
  }

  const currentEth = formatSmart(Number(formatUnits(BigInt(currentWei), 18)));

  return (
    <ConfirmModal
      open={open}
      onClose={onClose}
      title="Adjust keeper reserve target"
      confirmLabel="Set new target"
      submittingLabel="Confirming on-chain…"
      isSubmitting={action.isSubmitting}
      error={action.error ?? parseError}
      body={
        <>
          <p>
            Current: <span className="font-mono text-slate-100">{currentEth} ETH</span>.
            Affects how much WETH the contract holds in reserve before
            forwarding fees to the fee recipient. Set to 0 to disable the
            reserve mechanism entirely (WETH then behaves like any other
            token).
          </p>
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-slate-400">New target (ETH)</span>
            <input
              type="text"
              inputMode="decimal"
              value={valueEth}
              onChange={(e) => setValueEth(e.target.value)}
              disabled={action.isSubmitting}
              placeholder="0.02"
              autoFocus
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 focus:border-cyan-500 focus:outline-none disabled:opacity-50"
            />
          </label>
          {newWei !== null && (
            <p className="text-xs text-slate-500">
              = {newWei.toString()} wei. Diff vs current:{' '}
              {newWei > BigInt(currentWei) ? '+' : ''}
              {formatSmart(Number(formatUnits(newWei - BigInt(currentWei), 18)))} ETH.
            </p>
          )}
        </>
      }
      onConfirm={async () => {
        if (newWei === null) return;
        await action.submit({
          address: getRouterForChain(chainId),
          abi: ADMIN_WRITE_ABI,
          functionName: 'setKeeperReserveTarget',
          args: [newWei],
          chainId,
        });
      }}
    />
  );
}

function AdjustThresholdModal({
  open,
  onClose,
  chainId,
}: {
  open: boolean;
  onClose: () => void;
  chainId: number;
}) {
  const action = useAdminAction([
    ['admin', 'fees'],
    ['admin', 'contract-state'],
  ]);
  const tokens = getTokens(chainId);
  const [selectedAddr, setSelectedAddr] = useState<`0x${string}`>(tokens[0]?.address ?? '0x0' as `0x${string}`);
  const [valueHuman, setValueHuman] = useState('');
  useEffect(() => {
    if (open) {
      setValueHuman('');
      if (tokens[0]) setSelectedAddr(tokens[0].address);
    }
  }, [open, tokens]);
  useEffect(() => {
    if (action.isSuccess) onClose();
  }, [action.isSuccess, onClose]);

  const selectedToken = tokens.find((t) => t.address.toLowerCase() === selectedAddr.toLowerCase());

  let newRaw: bigint | null = null;
  let parseError: string | null = null;
  if (valueHuman.trim() !== '' && selectedToken) {
    try {
      newRaw = parseUnits(valueHuman.trim(), selectedToken.decimals);
      if (newRaw < 0n) {
        parseError = 'Value must be ≥ 0';
        newRaw = null;
      }
    } catch {
      parseError = 'Invalid number';
    }
  }

  return (
    <ConfirmModal
      open={open}
      onClose={onClose}
      title="Adjust sweep threshold"
      confirmLabel="Set threshold"
      submittingLabel="Confirming on-chain…"
      isSubmitting={action.isSubmitting}
      error={action.error ?? parseError}
      body={
        <>
          <p>
            Sets the per-token auto-sweep trigger: when accumulated fees
            for a token cross this value, the next executeOrder pays for
            an inline sweep to the fee recipient. Set to 0 to forward
            every fee inline (no accumulation). WETH ignores this — it's
            governed by the reserve target.
          </p>
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-slate-400">Token</span>
            <select
              value={selectedAddr}
              onChange={(e) => setSelectedAddr(e.target.value as `0x${string}`)}
              disabled={action.isSubmitting}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none disabled:opacity-50"
            >
              {tokens.map((t) => (
                <option key={t.address} value={t.address}>{t.symbol}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-slate-400">
              New threshold ({selectedToken?.symbol ?? '—'})
            </span>
            <input
              type="text"
              inputMode="decimal"
              value={valueHuman}
              onChange={(e) => setValueHuman(e.target.value)}
              disabled={action.isSubmitting}
              placeholder="10"
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 focus:border-cyan-500 focus:outline-none disabled:opacity-50"
            />
          </label>
          {newRaw !== null && selectedToken && (
            <p className="text-xs text-slate-500">= {newRaw.toString()} raw units</p>
          )}
        </>
      }
      onConfirm={async () => {
        if (newRaw === null) return;
        await action.submit({
          address: getRouterForChain(chainId),
          abi: ADMIN_WRITE_ABI,
          functionName: 'setSweepThreshold',
          args: [selectedAddr, newRaw],
          chainId,
        });
      }}
    />
  );
}

function FeeRecipientModal({
  open,
  onClose,
  chainId,
  currentRecipient,
}: {
  open: boolean;
  onClose: () => void;
  chainId: number;
  currentRecipient: string;
}) {
  const action = useAdminAction([['admin', 'contract-state']]);
  const [addr, setAddr] = useState('');
  useEffect(() => { if (open) setAddr(''); }, [open]);
  useEffect(() => {
    if (action.isSuccess) onClose();
  }, [action.isSuccess, onClose]);

  const trimmed = addr.trim();
  const validAddr = isAddress(trimmed);
  // EIP-55 checksum normalisation so what user enters becomes what the
  // contract sees — matches the rest of the app's address handling.
  const newRecipient = validAddr ? getAddress(trimmed) : null;
  const sameAsCurrent = newRecipient && newRecipient === currentRecipient;

  return (
    <ConfirmModal
      open={open}
      onClose={onClose}
      title="Change fee recipient"
      tone="warn"
      confirmLabel="Update recipient"
      submittingLabel="Confirming on-chain…"
      isSubmitting={action.isSubmitting}
      error={action.error}
      typeToConfirm="CHANGE"
      body={
        <>
          <p>
            Current: <span className="font-mono text-slate-100">{currentRecipient}</span>.
            All future protocol fees go to the new address.{' '}
            <span className="text-amber-300 font-semibold">
              Existing accumulated fees will route to the NEW recipient on next sweep.
            </span>
          </p>
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-slate-400">New recipient address</span>
            <input
              type="text"
              value={addr}
              onChange={(e) => setAddr(e.target.value)}
              disabled={action.isSubmitting}
              placeholder="0x…"
              autoFocus
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 focus:border-cyan-500 focus:outline-none disabled:opacity-50"
            />
          </label>
          {trimmed !== '' && !validAddr && (
            <p className="text-xs text-rose-300">Not a valid 0x address.</p>
          )}
          {sameAsCurrent && (
            <p className="text-xs text-amber-300">This is the same as the current recipient.</p>
          )}
        </>
      }
      onConfirm={async () => {
        if (!newRecipient || sameAsCurrent) return;
        await action.submit({
          address: getRouterForChain(chainId),
          abi: ADMIN_WRITE_ABI,
          functionName: 'setFeeRecipient',
          args: [newRecipient],
          chainId,
        });
      }}
    />
  );
}

function StatsPanel({
  stats,
  isLoading,
  chainId,
}: {
  stats: DbStats | undefined;
  isLoading: boolean;
  chainId: number;
}) {
  // Per-chain "I've seen this" timestamp — once the operator dismisses
  // the failure banner, it stays hidden until a NEWER failure comes in
  // (latestFail.at > acked). Persisted in localStorage so a refresh
  // doesn't undo the dismiss.
  const ackKey = `polyorder.admin.failureAck.${chainId}`;
  const [ackedAt, setAckedAt] = useState<string | null>(() => {
    try { return localStorage.getItem(ackKey); } catch { return null; }
  });
  // Re-read when chainId changes (operator switched chain in dropdown).
  useEffect(() => {
    try { setAckedAt(localStorage.getItem(ackKey)); } catch { /* private mode etc */ }
  }, [ackKey]);

  if (isLoading) return <div className="text-sm text-slate-400">Loading…</div>;
  if (!stats) return null;

  // Throughput delta tone — green up, red down, muted same.
  const dt = stats.throughput.deltaPct;
  const dtTone: Exclude<Tone, undefined> = dt > 5 ? 'ok' : dt < -5 ? 'err' : 'muted';
  const dtSign = dt > 0 ? '+' : '';

  // Pick the most-recent failure across orders + executions for the
  // "latest reason" display — operator wants the freshest signal of
  // what broke.
  const latestFail = pickFreshestFailure(stats.failed);
  const hasFailures = stats.failed.orders.count > 0 || stats.failed.executions.count > 0;
  // Banner visible only when:
  //  - there ARE failures (count > 0 on either side), AND
  //  - either nothing's acked OR the latest is NEWER than what was acked.
  // Strict > on timestamps so re-acking the same failure doesn't oscillate.
  const showBanner = hasFailures && (
    !latestFail || !ackedAt || new Date(latestFail.at).getTime() > new Date(ackedAt).getTime()
  );

  const dismiss = () => {
    if (!latestFail) return;
    try { localStorage.setItem(ackKey, latestFail.at); } catch { /* private mode */ }
    setAckedAt(latestFail.at);
  };

  return (
    <div className="space-y-3">
      {/* Throughput strip — primary metric */}
      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        <Card
          label="Filled last hour"
          value={stats.throughput.lastHour.toString()}
          tone={stats.throughput.lastHour > 0 ? 'ok' : 'muted'}
        />
        <Card
          label="Prior hour"
          value={stats.throughput.priorHour.toString()}
          tone="muted"
        />
        <Card
          label="Δ vs prior"
          value={stats.throughput.priorHour === 0 ? '—' : `${dtSign}${dt.toFixed(0)}%`}
          tone={dtTone}
        />
      </div>

      {/* Status counts — Order + ScheduledOrder side-by-side */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <StatusBlock title="Limit orders" counts={stats.counts.orders} />
        <StatusBlock title="DCA / TWAP orders" counts={stats.counts.scheduled} />
      </div>

      {/* Failed-last-24h banner — visible only when there ARE failures
          AND the latest one hasn't been dismissed yet. Dismiss writes
          a per-chain ack timestamp to localStorage; banner reappears
          on the next NEW failure (timestamp > acked). */}
      {showBanner && (
        <div className="rounded-lg border border-rose-900/50 bg-rose-950/30 px-3 py-2">
          <div className="flex items-baseline justify-between gap-2">
            <div className="text-xs uppercase tracking-wider text-rose-300">
              Failures last 24h
            </div>
            <div className="flex items-center gap-3">
              <div className="font-mono text-sm text-rose-200">
                {stats.failed.orders.count} order
                {stats.failed.orders.count === 1 ? '' : 's'}
                {' + '}
                {stats.failed.executions.count} slice
                {stats.failed.executions.count === 1 ? '' : 's'}
              </div>
              <button
                type="button"
                onClick={dismiss}
                className="rounded border border-rose-700/50 px-2 py-0.5 text-xs text-rose-200 hover:bg-rose-900/40"
                title="Dismiss this notice. It will reappear if a newer failure happens."
              >
                Dismiss
              </button>
            </div>
          </div>
          {latestFail && (
            <div className="mt-1 text-sm text-slate-300">
              Latest ({fmtTime(since(latestFail.at) ?? 0)} ago):{' '}
              <span className="font-mono text-rose-200">{latestFail.reason}</span>
            </div>
          )}
        </div>
      )}

      {/* Subtle hint when there ARE failures but operator has acked the
          latest. Avoids leaving the operator wondering why the rose
          banner disappeared. */}
      {hasFailures && !showBanner && (
        <div className="text-xs text-slate-500">
          {stats.failed.orders.count + stats.failed.executions.count} failure
          {stats.failed.orders.count + stats.failed.executions.count === 1 ? '' : 's'} in
          the last 24h (dismissed; a newer one will resurface this notice).
        </div>
      )}
    </div>
  );
}

function StatusBlock({
  title,
  counts,
}: {
  title: string;
  counts: Record<string, number>;
}) {
  const entries = Object.entries(counts);
  const total = entries.reduce((a, [, v]) => a + v, 0);
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
      <div className="flex items-baseline justify-between">
        <div className="text-xs uppercase tracking-wider text-slate-400">{title}</div>
        <div className="font-mono text-xs text-slate-500">{total} total</div>
      </div>
      {entries.length === 0 ? (
        <div className="mt-1 text-sm text-slate-500">No orders yet.</div>
      ) : (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm">
          {entries.map(([status, n]) => (
            <span key={status} className="font-mono">
              <span className={STATUS_TONE[status] ?? 'text-slate-300'}>{status.toLowerCase()}</span>
              <span className="text-slate-500"> {n}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  OPEN: 'text-cyan-300',
  ACTIVE: 'text-cyan-300',
  EXECUTING: 'text-amber-300',
  FILLED: 'text-emerald-300',
  COMPLETED: 'text-emerald-300',
  PENDING: 'text-amber-300',
  CANCELLED: 'text-slate-400',
  EXPIRED: 'text-slate-400',
  FAILED: 'text-rose-400',
};

function pickFreshestFailure(
  failed: DbStats['failed'],
): { reason: string; at: string } | null {
  const o = failed.orders;
  const e = failed.executions;
  if (!o.latestAt && !e.latestAt) return null;
  // Both present → newer wins. Only one present → use that.
  const oTime = o.latestAt ? new Date(o.latestAt).getTime() : 0;
  const eTime = e.latestAt ? new Date(e.latestAt).getTime() : 0;
  if (oTime >= eTime && o.latestReason) {
    return { reason: truncate(o.latestReason, 120), at: o.latestAt! };
  }
  if (e.latestReason) {
    return { reason: truncate(e.latestReason, 120), at: e.latestAt! };
  }
  return null;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
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
    return <div className="text-sm text-slate-500">No events recorded for this contract yet.</div>;
  }
  return (
    // Vertical scroll container so the panel doesn't push the rest of
    // the dashboard off-screen when the list is dense (up to 100 rows).
    // Sticky thead keeps the column labels visible while scrolling.
    <div className="max-h-96 overflow-y-auto overflow-x-auto rounded-md border border-slate-800">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-slate-900 text-left text-slate-400 shadow-[0_1px_0_0_rgba(30,41,59,1)]">
          <tr>
            <th className="px-3 py-2 text-xs uppercase tracking-wider">When</th>
            <th className="px-3 py-2 text-xs uppercase tracking-wider">Event</th>
            <th className="px-3 py-2 text-xs uppercase tracking-wider">Details</th>
            <th className="px-3 py-2 text-xs uppercase tracking-wider text-right">Tx</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e, i) => (
            <EventRow key={`${e.txHash}-${e.eventName}-${i}`} event={e} chainId={chainId} />
          ))}
        </tbody>
      </table>
      <div className="border-t border-slate-800 bg-slate-950/40 px-3 py-1.5 text-xs text-slate-500">
        Showing {events.length} most recent event{events.length === 1 ? '' : 's'}
        {events.length >= 100 && ' (capped at 100)'}
      </div>
    </div>
  );
}

function EventRow({ event, chainId }: { event: EventEntry; chainId: number }) {
  const ago = since(new Date(event.timestamp * 1000).toISOString());
  const { badge, tone, details } = formatEventForDisplay(event, chainId);

  return (
    <tr className="border-b border-slate-900/50">
      <td className="px-3 py-2 font-mono text-slate-300" title={`Block ${event.blockNumber}`}>
        {ago === null ? '?' : `${fmtTime(ago)} ago`}
      </td>
      <td className="px-3 py-2">
        <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold uppercase tracking-wider ${tone}`}>
          {badge}
        </span>
      </td>
      <td className="px-3 py-2 font-mono text-slate-200">{details}</td>
      <td className="px-3 py-2 text-right">
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
