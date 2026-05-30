/**
 * Modal surface that lists every ERC-20 allowance the user has granted
 * to the OwlOrderFi router on the current chain, with a per-row
 * Revoke action.
 *
 * Why this lives in the app at all: we tell the user repeatedly that
 * their worst-case loss is bounded by the allowance they've granted,
 * and that they can revoke from their wallet at any time. Telling
 * someone they have control while making them hunt down revoke.cash
 * for it is a trust gap. Doing it in-app closes the gap and signals
 * we're on the user's side.
 *
 * Revoke is `approve(router, 0)` — a normal ERC-20 transaction. The
 * pre-revoke confirmation surfaces any open orders that depend on the
 * allowance, since revoking will cause those orders to fail when the
 * keeper next tries to pull. We warn but don't hard-block — the user
 * may have decided the position isn't worth keeping anyway.
 */

import { useState } from 'react';
import { useChainId, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { erc20Abi, maxUint256 } from 'viem';
import { CHAINS, type ChainIdType, formatUnits } from '@owlorderfi/shared';
import { useAllowances, type ActiveAllowance } from '../hooks/useAllowances';
import { useOutstandingCommitmentDetailed } from '../hooks/useOutstandingCommitment';
import { getRouterForChain } from '../lib/env';
import { formatSmart } from '../lib/formatAmount';

// An allowance at or above 2^200 is reasonably treated as "infinite"
// for display. Real allowances rarely break this threshold.
const UNLIMITED_DISPLAY_THRESHOLD = 1n << 200n;

interface Props {
  open: boolean;
  onClose: () => void;
  enabled: boolean;
}

export function AllowanceManager({ open, onClose, enabled }: Props) {
  const chainId = useChainId();
  const chainName = CHAINS[chainId as ChainIdType]?.name ?? `chain ${chainId}`;
  const { allowances, isLoading, refetch } = useAllowances(enabled && open);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="allowances-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-4 py-8"
    >
      <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 shadow-xl">
        <div className="flex items-start justify-between border-b border-slate-800 px-6 py-4">
          <div>
            <h2 id="allowances-title" className="text-lg font-semibold text-slate-100">
              Token allowances
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              ERC-20 approvals you've granted to OwlOrderFi on {chainName}.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-slate-400 hover:text-slate-200"
          >
            ✕
          </button>
        </div>

        <div className="space-y-3 px-6 py-5">
          {isLoading && allowances.length === 0 && (
            <p className="text-sm text-slate-400">Reading allowances…</p>
          )}
          {!isLoading && allowances.length === 0 && (
            <p className="text-sm text-slate-400">
              No active allowances on {chainName}. The protocol can't pull any tokens
              until you sign an order that grants one.
            </p>
          )}
          {allowances.map((a) => (
            <AllowanceRow
              key={a.token.address}
              entry={a}
              enabled={enabled}
              onRevoked={refetch}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function AllowanceRow({
  entry,
  enabled,
  onRevoked,
}: {
  entry: ActiveAllowance;
  enabled: boolean;
  onRevoked: () => void;
}) {
  const { token, allowance } = entry;
  const chainId = useChainId();
  const router = (() => {
    try {
      return getRouterForChain(chainId);
    } catch {
      return undefined;
    }
  })();
  const commitment = useOutstandingCommitmentDetailed(enabled, chainId, token.address);
  const [confirming, setConfirming] = useState(false);
  const { writeContractAsync, data: txHash, isPending: isWritePending, reset: resetWrite } =
    useWriteContract();
  const { isLoading: isMining } = useWaitForTransactionReceipt({
    hash: txHash,
    query: { enabled: !!txHash },
  });
  const isUnlimited = allowance >= UNLIMITED_DISPLAY_THRESHOLD;
  const isMax = allowance === maxUint256;
  const human = isUnlimited
    ? isMax ? 'Unlimited' : 'Effectively unlimited'
    : formatSmart(Number(formatUnits(allowance, token.decimals)));

  const limitCount = commitment.limit > 0n ? 1 : 0; // we only know totals; treat as ≥1
  const dcaCount = commitment.dca > 0n ? 1 : 0;
  const twapCount = commitment.twap > 0n ? 1 : 0;
  const hasOpenOrders = limitCount + dcaCount + twapCount + commitment.foreverDcaCount > 0;

  const isRevoking = isWritePending || isMining;

  const doRevoke = async () => {
    if (!router) return;
    try {
      await writeContractAsync({
        address: token.address as `0x${string}`,
        abi: erc20Abi,
        functionName: 'approve',
        args: [router, 0n],
      });
      // Wait a beat for the tx to mine + refetch picks up.
      setConfirming(false);
      // Trigger a refetch shortly after — useWaitForTransactionReceipt
      // also flips isMining, but the parent refetch keeps the list view
      // honest if the user closes + reopens the modal quickly.
      setTimeout(() => {
        onRevoked();
        resetWrite();
      }, 1500);
    } catch {
      // User rejected or network error — leave the row in place so they
      // can try again. The wagmi hook state resets itself.
    }
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="text-base font-medium text-slate-200">{token.symbol}</div>
          <div className="mt-0.5 font-mono text-sm text-slate-400">
            {human} <span className="text-xs">{token.symbol}</span> approved
          </div>
        </div>
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={isRevoking}
          className="rounded-lg border border-rose-700 bg-rose-950/40 px-3 py-1.5 text-sm font-medium text-rose-200 transition hover:bg-rose-900/40 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isRevoking ? 'Revoking…' : 'Revoke'}
        </button>
      </div>

      {hasOpenOrders && (
        <p className="mt-2 text-xs text-amber-300/90">
          You have open orders using this token. Revoking will cause them to fail
          when the keeper next tries to execute — cancel them first if you want
          them to run.
        </p>
      )}

      {confirming && (
        <div className="mt-3 rounded-lg border border-slate-700 bg-slate-900/80 p-3 text-sm">
          <p className="text-slate-200">
            Set the allowance for{' '}
            <span className="font-mono font-medium">{token.symbol}</span> to{' '}
            <span className="font-mono font-medium">0</span>?
          </p>
          {hasOpenOrders && (
            <p className="mt-1 text-xs text-amber-300/90">
              Active orders relying on this allowance will fail to execute.
            </p>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void doRevoke()}
              disabled={isRevoking}
              className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-slate-100 hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isRevoking ? 'Revoking…' : 'Revoke allowance'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
