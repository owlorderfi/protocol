/**
 * Compact "what's in my wallet for this token, and how much is
 * already reserved by my active orders" widget. Sits above the
 * orders panel on the left column.
 *
 * Three columns: In Wallet (raw ERC20 balance), In Orders
 * (sum from useOutstandingCommitment — bounded DCA + TWAP + limit
 * OPEN on the same token), Available (wallet − orders, what a new
 * order can actually use).
 *
 * Dropdown lists the chain's supported tokens; auto-selects the
 * form's current tokenIn (via ActiveTokenContext) so the widget
 * stays in sync as the user edits the form. Manual dropdown
 * change overrides the auto-select locally — useful for peeking
 * at another token without touching the form.
 */

import { useEffect, useState } from 'react';
import { useChainId } from 'wagmi';
import { formatUnits } from '@owlorderfi/shared';
import { useTokenBalance } from '../hooks/useTokenBalance';
import { useOutstandingCommitmentDetailed } from '../hooks/useOutstandingCommitment';
import { useActiveToken } from '../lib/ActiveTokenContext';
import { getTokens } from '../lib/tokens';
import { formatSmart } from '../lib/formatAmount';

interface Props {
  enabled: boolean;
}

export function WalletSummary({ enabled }: Props) {
  const chainId = useChainId();
  const { activeTokenIn } = useActiveToken();
  const tokens = getTokens(chainId);

  const [selected, setSelected] = useState<`0x${string}` | undefined>(
    activeTokenIn ?? tokens[0]?.address,
  );

  // Auto-sync to whatever the form is currently composing. User
  // manually picking a different token in our dropdown overrides
  // this — but the next time the form's tokenIn changes, we snap
  // back to it. That's the intended UX: inspecting is transient,
  // composing wins long-term.
  useEffect(() => {
    if (activeTokenIn) setSelected(activeTokenIn);
  }, [activeTokenIn]);

  const tokenInfo = tokens.find((t) => t.address.toLowerCase() === selected?.toLowerCase());
  const balance = useTokenBalance(selected);
  const { total: reserved, foreverDcaCount } = useOutstandingCommitmentDetailed(
    enabled,
    chainId,
    selected,
  );

  if (tokens.length === 0 || !tokenInfo) {
    return null; // Chain not configured; nothing useful to show
  }

  const balanceHuman = Number(formatUnits(balance.balance, tokenInfo.decimals));
  const reservedHuman = Number(formatUnits(reserved, tokenInfo.decimals));
  // Keep the signed delta so a shortfall shows as a real negative
  // number, not 0. "−0.0677 USDC" is way more useful than "0 USDC"
  // (which hides the magnitude of the gap the user needs to top up).
  const isShort = reserved > balance.balance;
  const deltaRaw = isShort ? reserved - balance.balance : balance.balance - reserved;
  const deltaHuman = Number(formatUnits(deltaRaw, tokenInfo.decimals));
  const availableDisplay = isShort
    ? `−${formatSmart(deltaHuman)}`
    : formatSmart(deltaHuman);

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/30 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-slate-400">
          <span>Wallet</span>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value as `0x${string}`)}
            disabled={!enabled}
            className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none disabled:opacity-50"
          >
            {tokens.map((t) => (
              <option key={t.address} value={t.address}>
                {t.symbol}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-1 flex-wrap gap-x-6 gap-y-1 text-xs text-slate-400">
          <Cell label="In wallet" value={formatSmart(balanceHuman)} unit={tokenInfo.symbol} />
          <Cell
            label="In orders"
            value={formatSmart(reservedHuman)}
            unit={tokenInfo.symbol}
            valueClass={reserved > 0n ? 'text-amber-300' : 'text-slate-400'}
          />
          <Cell
            label="Available"
            value={availableDisplay}
            unit={tokenInfo.symbol}
            valueClass={isShort ? 'text-rose-400' : 'text-emerald-400'}
            title={isShort ? `Short by ${formatSmart(deltaHuman)} ${tokenInfo.symbol} — top up to cover active orders` : undefined}
          />
        </div>
      </div>
      {!enabled && (
        <div className="mt-1 text-xs text-slate-400">
          Sign-in to see live balances.
        </div>
      )}
      {foreverDcaCount > 0 && (
        <div className="mt-1 text-xs text-slate-400">
          + {foreverDcaCount} open-ended DCA{foreverDcaCount === 1 ? '' : 's'}{' '}
          running on this token (no fixed total — funded slice-by-slice).
        </div>
      )}
    </div>
  );
}

function Cell({
  label,
  value,
  unit,
  valueClass,
  title,
}: {
  label: string;
  value: string;
  unit: string;
  valueClass?: string;
  title?: string;
}) {
  return (
    <div title={title}>
      <div className="text-xs uppercase tracking-wider text-slate-400">{label}</div>
      <div className={`font-mono text-sm ${valueClass ?? 'text-slate-200'}`}>
        {value} <span className="text-xs text-slate-400">{unit}</span>
      </div>
    </div>
  );
}
