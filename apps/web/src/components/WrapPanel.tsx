import { useState } from 'react';
import { parseUnits, formatUnits } from '@polyorder/shared';
import { useWrapNative } from '../hooks/useWrapNative';
import { useTokenApproval } from '../hooks/useTokenApproval';

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
  const approval = useTokenApproval(hook?.meta.address);
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);

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
  const GAS_RESERVE = 10n ** 16n; // 0.01 native
  const wrapMax = nativeBalance > GAS_RESERVE ? nativeBalance - GAS_RESERVE : 0n;

  const wrapDisabled = disabled || parsed === null || parsed <= 0n || parsed > wrapMax;
  const unwrapDisabled = disabled || parsed === null || parsed <= 0n || parsed > wrappedBalance;

  // Unwrap routes through router.unwrap() and requires WPOL approval first.
  const needsApprovalForUnwrap = parsed !== null && approval.needsApproval(parsed);

  const handle = async (op: 'wrap' | 'unwrap' | 'approve') => {
    setError(null);
    try {
      if (op === 'approve') {
        await approval.approve();
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
        <span className="text-[10px] uppercase tracking-wider text-slate-500">
          {meta.nativeSymbol} ↔ {meta.wrappedSymbol}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded border border-slate-800 bg-slate-950/60 px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">{meta.nativeSymbol}</div>
          <div className="font-mono text-slate-200">
            {Number(formatUnits(nativeBalance, meta.decimals)).toFixed(4)}
          </div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-950/60 px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">{meta.wrappedSymbol}</div>
          <div className="font-mono text-slate-200">
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
        className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none disabled:opacity-50"
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
            title={`One-time approval letting the router pull ${meta.wrappedSymbol} for unwrap.`}
          >
            Approve {meta.wrappedSymbol}
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

      {error && (
        <div className="rounded border border-rose-900/50 bg-rose-950/40 p-2 text-xs text-rose-300">
          {error}
        </div>
      )}
    </div>
  );
}
