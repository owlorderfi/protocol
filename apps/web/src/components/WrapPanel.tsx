import { useState } from 'react';
import { useChainId } from 'wagmi';
import { parseUnits, formatUnits } from '@owlorderfi/shared';
import { useWrapNative } from '../hooks/useWrapNative';
import { useTokenApproval } from '../hooks/useTokenApproval';
import { ApproveUnlimitedModal } from './ApproveUnlimitedModal';

/**
 * Wrap / unwrap the chain's native gas coin to its ERC20 wrapper (POL ↔ WPOL).
 * Hidden when the current chain has no wrapper configured.
 *
 * UX: one shared amount input plus two buttons. The input meaning swaps with
 * the action — typing "5" then clicking Wrap deposits 5 POL; clicking Unwrap
 * withdraws 5 WPOL. Each button is disabled when the relevant balance can't
 * cover the amount, so the user never gets a useless wallet prompt.
 */
export function WrapPanel({ enabled }: { enabled: boolean }) {
  const hook = useWrapNative();
  const chainId = useChainId();
  const approval = useTokenApproval(hook?.meta.address);
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Approval UX on par with the orders forms: the button approves the EXACT
  // amount; unlimited is the modal-confirmed "(advanced)" link below.
  // Approval is only needed for unwrap (the router pulls the wrapped token);
  // wrap sends native directly.
  const [unlimitedModalOpen, setUnlimitedModalOpen] = useState(false);

  if (!hook) return null; // chain has no wrapped native configured

  const { meta, nativeBalance, wrappedBalance, wrap, unwrap, isPending } = hook;
  const disabled = !enabled || isPending || approval.isApproving;

  const parsed = (() => {
    if (amount.trim() === '') return null;
    try {
      return parseUnits(amount, meta.decimals);
    } catch {
      return null;
    }
  })();

  // Leave a small native dust for gas when wrapping the whole balance —
  // otherwise the wrap tx itself can't pay for its own execution.
  // 0.0005 native covers L2 gas (Base, Polygon, Arbitrum ~$0.001 per tx)
  // with plenty of headroom. On L1 Ethereum this would be tight; bump it
  // per-chain once we add L1 to the supported list.
  const GAS_RESERVE = 5n * 10n ** 14n; // 0.0005 native
  const wrapMax = nativeBalance > GAS_RESERVE ? nativeBalance - GAS_RESERVE : 0n;

  const wrapDisabled = disabled || parsed === null || parsed <= 0n || parsed > wrapMax;
  const unwrapDisabled = disabled || parsed === null || parsed <= 0n || parsed > wrappedBalance;

  // Unwrap routes through router.unwrap() and requires WPOL approval first.
  const needsApprovalForUnwrap = parsed !== null && approval.needsApproval(parsed);

  const handle = async (op: 'wrap' | 'unwrap' | 'approve') => {
    setError(null);
    try {
      if (op === 'approve') {
        // The button always approves the EXACT typed amount; the unlimited
        // path is the modal-confirmed link (calls approval.approve() with no
        // arg → maxUint256). The button is disabled when parsed is null.
        await approval.approve(parsed ?? undefined);
        return;
      }
      if (parsed === null) return;
      await (op === 'wrap' ? wrap(parsed) : unwrap(parsed));
      setAmount('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('User rejected')) {
        setError(null); // user-aborted; no need to surface
      } else {
        setError(msg.slice(0, 160));
      }
    }
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-200">Wrap / Unwrap</h2>
        <span className="text-xs uppercase tracking-wider text-slate-400">
          {meta.nativeSymbol} ↔ {meta.wrappedSymbol}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded border border-slate-800 bg-slate-950/60 px-2 py-2">
          <div className="text-xs uppercase tracking-wider text-slate-400">{meta.nativeSymbol}</div>
          <div className="font-mono text-sm text-slate-200">
            {Number(formatUnits(nativeBalance, meta.decimals)).toFixed(4)}
          </div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-950/60 px-2 py-2">
          <div className="text-xs uppercase tracking-wider text-slate-400">{meta.wrappedSymbol}</div>
          <div className="font-mono text-sm text-slate-200">
            {Number(formatUnits(wrappedBalance, meta.decimals)).toFixed(4)}
          </div>
        </div>
      </div>

      <input
        type="text"
        inputMode="decimal"
        value={amount}
        onChange={(e) => {
          setAmount(e.target.value);
          setError(null);
        }}
        disabled={disabled}
        placeholder="0.0"
        className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 placeholder:text-slate-400 focus:border-cyan-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/40 disabled:opacity-50"
      />

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => handle('wrap')}
          disabled={wrapDisabled}
          className="rounded-lg border border-cyan-700/60 bg-cyan-900/20 py-1.5 text-xs font-medium text-cyan-200 hover:bg-cyan-900/40 disabled:opacity-40"
          title={`Deposit ${meta.nativeSymbol} into the ${meta.wrappedSymbol} contract`}
        >
          Wrap → {meta.wrappedSymbol}
        </button>
        {needsApprovalForUnwrap ? (
          <button
            type="button"
            onClick={() => handle('approve')}
            disabled={disabled || parsed === null || parsed <= 0n}
            className="rounded-lg border border-amber-700/60 bg-amber-900/20 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-900/40 disabled:opacity-40"
            title={`Required ONLY for unwrap (the router pulls ${meta.wrappedSymbol} from your wallet). Wrap doesn't need approve — it sends native ${meta.nativeSymbol} directly with the tx.`}
          >
            {approval.isApproving
              ? `Approving ${meta.wrappedSymbol}…`
              : `Approve ${amount} ${meta.wrappedSymbol} (exact)`}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => handle('unwrap')}
            disabled={unwrapDisabled}
            className="rounded-lg border border-amber-700/60 bg-amber-900/20 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-900/40 disabled:opacity-40"
            title={`Withdraw ${meta.wrappedSymbol} back to native ${meta.nativeSymbol} via router.unwrap (EIP-7702 compatible).`}
          >
            Unwrap → {meta.nativeSymbol}
          </button>
        )}
      </div>

      {/* Explain a disabled Wrap so it's not mistaken for an approval gate.
          Wrap = native → wrapped, sends value directly, needs NO approval —
          it's disabled purely when you lack enough native (gas reserve kept).
          The Approve in the other slot is for the reverse (unwrap) only. */}
      {!disabled && parsed !== null && parsed > 0n && parsed > wrapMax && (
        <p className="text-xs text-slate-400">
          Can&apos;t wrap {amount} {meta.nativeSymbol} — your {meta.nativeSymbol} balance is
          lower (a little is kept for gas). Wrapping needs <span className="text-slate-300">no
          approval</span>; the Approve button is only for the reverse (unwrap → {meta.nativeSymbol}).
        </p>
      )}

      {needsApprovalForUnwrap && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setUnlimitedModalOpen(true)}
          className="block w-full text-center text-xs text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline disabled:opacity-50"
        >
          Approve unlimited instead (advanced)
        </button>
      )}

      {error && (
        <div className="rounded border border-rose-900/50 bg-rose-950/40 p-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      <ApproveUnlimitedModal
        open={unlimitedModalOpen}
        onClose={() => setUnlimitedModalOpen(false)}
        tokenSymbol={meta.wrappedSymbol}
        orderKindLabel="unwrap"
        chainId={chainId}
        onConfirm={async () => {
          setUnlimitedModalOpen(false);
          try {
            await approval.approve();
          } catch {
            /* user rejected — useTokenApproval clears its own state */
          }
        }}
      />
    </div>
  );
}
