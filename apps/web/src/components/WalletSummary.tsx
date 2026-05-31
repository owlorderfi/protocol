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
import { AllowanceManager } from './AllowanceManager';
import { GasIndicator } from './GasIndicator';
import { CHAINS, type ChainIdType } from '@owlorderfi/shared';

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
  const [ordersExpanded, setOrdersExpanded] = useState(false);
  const [allowanceManagerOpen, setAllowanceManagerOpen] = useState(false);

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
  const commitment = useOutstandingCommitmentDetailed(enabled, chainId, selected);

  if (tokens.length === 0 || !tokenInfo) {
    return null; // Chain not configured; nothing useful to show
  }

  const reserved = commitment.total;
  const foreverDcaCount = commitment.foreverDcaCount;
  const balanceHuman = Number(formatUnits(balance.balance, tokenInfo.decimals));
  const limitHuman = Number(formatUnits(commitment.limit, tokenInfo.decimals));
  const dcaHuman = Number(formatUnits(commitment.dca, tokenInfo.decimals));
  const twapHuman = Number(formatUnits(commitment.twap, tokenInfo.decimals));
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
      {/* Network gas + min-order chip on top of the wallet panel.
          Chain-level info (no tab is special; this affects every order
          type), so we mount it here once instead of duplicating it
          inside each form. Wrapper conditionally rendered so testnets
          (where GasIndicator returns null) don't get an empty divider. */}
      {(() => {
        const info = CHAINS[chainId as ChainIdType];
        if (!info || info.isTestnet || !info.nativeUsdEstimate) return null;
        return (
          <div className="mb-2 border-b border-slate-800 pb-2">
            <GasIndicator chainId={chainId} />
          </div>
        );
      })()}
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
          <Cell label="Wallet" value={formatSmart(balanceHuman)} unit={tokenInfo.symbol} />
          <button
            type="button"
            onClick={() => setOrdersExpanded((v) => !v)}
            className="text-left"
            title="Click to expand / collapse breakdown by order type"
          >
            <Cell
              label={`Orders ${ordersExpanded ? '▾' : '▸'}`}
              value={formatSmart(Number(formatUnits(reserved, tokenInfo.decimals)))}
              unit={tokenInfo.symbol}
              valueClass={reserved > 0n ? 'text-amber-300' : 'text-slate-400'}
            />
          </button>
          <Cell
            label="Available"
            value={availableDisplay}
            unit={tokenInfo.symbol}
            valueClass={isShort ? 'text-rose-400' : 'text-emerald-400'}
            title={isShort ? `Short by ${formatSmart(deltaHuman)} ${tokenInfo.symbol} — top up to cover active orders` : undefined}
          />
        </div>

        <button
          type="button"
          onClick={() => setAllowanceManagerOpen(true)}
          disabled={!enabled}
          className="ml-auto text-xs text-slate-400 underline-offset-2 hover:text-cyan-300 hover:underline disabled:opacity-50"
          title="Audit + revoke ERC-20 allowances you've granted to OwlOrderFi on this chain"
        >
          Allowances
        </button>
      </div>

      {ordersExpanded && reserved > 0n && (
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 border-t border-slate-800 pt-2 text-xs text-slate-400">
          <Cell
            label="Limit"
            value={formatSmart(limitHuman)}
            unit={tokenInfo.symbol}
            valueClass={commitment.limit > 0n ? 'text-amber-300' : 'text-slate-500'}
          />
          <Cell
            label="DCA"
            value={formatSmart(dcaHuman)}
            unit={tokenInfo.symbol}
            valueClass={commitment.dca > 0n ? 'text-amber-300' : 'text-slate-500'}
          />
          <Cell
            label="TWAP"
            value={formatSmart(twapHuman)}
            unit={tokenInfo.symbol}
            valueClass={commitment.twap > 0n ? 'text-amber-300' : 'text-slate-500'}
          />
        </div>
      )}
      {!enabled && (
        <div className="mt-1 text-sm text-slate-400">
          Sign-in to see live balances.
        </div>
      )}
      {foreverDcaCount > 0 && (
        <div className="mt-1 text-sm text-slate-400">
          + {foreverDcaCount} open-ended DCA{foreverDcaCount === 1 ? '' : 's'}{' '}
          running on this token (no fixed total — funded slice-by-slice).
        </div>
      )}
      <AllowanceManager
        open={allowanceManagerOpen}
        onClose={() => setAllowanceManagerOpen(false)}
        enabled={enabled}
      />
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
