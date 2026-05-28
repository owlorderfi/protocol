/**
 * TWAP tab — execute a large total amount over a bounded window in
 * regular slices. Targets the volume-weighted average price across the
 * window, minimizing market impact vs a single fat swap.
 *
 * Sister of CreateDcaForm — same backend, bounded defaults instead of
 * open-ended. User specifies total + window; we derive slices.
 */

import { useEffect, useState } from 'react';
import { useChainId } from 'wagmi';
import { useSessionForm } from '../hooks/useSessionForm';
import toast from 'react-hot-toast';
import { parseUnits, formatUnits } from '@owlorderfi/shared';
import { useCreateScheduledOrder } from '../hooks/useCreateScheduledOrder';
import { useTokenApproval } from '../hooks/useTokenApproval';
import { useOutstandingCommitment } from '../hooks/useOutstandingCommitment';
import { useTokenBalance } from '../hooks/useTokenBalance';
import { useMarketPrice } from '../hooks/useMarketPrice';
import { getTokens, findToken } from '../lib/tokens';
import { computeFloor, formatAssetPrice, orientPair } from '../lib/priceFloor';
import { formatSmart } from '../lib/formatAmount';
import { useActiveToken } from '../lib/ActiveTokenContext';
import { FEE_TIERS, tierForUsd, estimateOrderUsd, getMinSliceUsd } from '../lib/feeTiers';
import { CHAINS, type ChainIdType } from '@owlorderfi/shared';
import {
  TWAP_MODE_PRESETS,
  MODE_LABELS,
  detectActiveMode,
  type ExecutionMode,
} from '../lib/executionModes';
import { ApproveUnlimitedModal } from './ApproveUnlimitedModal';
import { useDisplayFlip } from '../lib/DisplayFlipContext';
import { usePriceConvention } from '../lib/PriceConventionContext';

interface Props {
  enabled: boolean;
}

interface FormState {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  totalAmountHuman: string;
  /** Spacing between slices. ≥ 60s to satisfy contract MIN_INTERVAL_SEC. */
  intervalValue: number;
  intervalUnit: 'min' | 'hour';
  slices: number;
  slippagePct: number;
  /**
   * Tolerance for the maker-signed hard price floor — % the asset price
   * may drop (when selling) or rise (when buying) from current before
   * the contract refuses the slice. Tight defaults for TWAP since
   * the typical execution is over hours, not weeks.
   * Presets shortcut common values; the input accepts any positive %.
   */
  floorTolerancePct: number;
}

const SLIPPAGE_PRESETS = [0.1, 0.3, 0.5, 1, 2];

export function CreateTwapForm({ enabled }: Props) {
  const chainId = useChainId();
  const tokens = getTokens(chainId);

  if (tokens.length < 2) {
    return (
      <div className="rounded-xl border border-amber-900/50 bg-amber-950/30 p-4 text-sm text-amber-200">
        <div className="font-medium mb-1">No tokens configured for this chain</div>
        <p className="text-sm text-amber-300/80">
          Switch your wallet to a supported network to create TWAP orders.
        </p>
      </div>
    );
  }

  // key={chainId} forces remount on chain switch — see CreateOrderForm
  // for the same rationale (avoids stale tokenIn/tokenOut crash).
  return <CreateTwapFormInner key={chainId} enabled={enabled} chainId={chainId} tokens={tokens} />;
}

function CreateTwapFormInner({
  enabled,
  chainId,
  tokens,
}: {
  enabled: boolean;
  chainId: number;
  tokens: ReturnType<typeof getTokens>;
}) {
  const { submit, isSubmitting, error } = useCreateScheduledOrder();

  // Per-chain key (see CreateDcaForm.tsx) keeps token addresses scoped.
  const [form, setForm] = useSessionForm<FormState>(`polyorder.formTwap.${chainId}`, {
    tokenIn: tokens[0].address,
    tokenOut: tokens[1].address,
    // Total starts empty — Approve preview shouldn't pre-populate a
    // figure the user never asked for. `touched` keeps the validation
    // banner suppressed until the field is focused.
    totalAmountHuman: '',
    intervalValue: 5,
    intervalUnit: 'min',
    slices: 20,
    slippagePct: 0.5,
    floorTolerancePct: 5,
  });

  // Stub-fallback tokens for the one-render gap after a chain switch.
  // See CreateLadderForm.tsx for why this can't early-return.
  const tokenInRaw = findToken(chainId, form.tokenIn);
  const tokenOutRaw = findToken(chainId, form.tokenOut);
  const tokenIn =
    tokenInRaw ?? { symbol: '?', decimals: 18, address: form.tokenIn as `0x${string}` };
  const tokenOut =
    tokenOutRaw ?? { symbol: '?', decimals: 18, address: form.tokenOut as `0x${string}` };
  useEffect(() => {
    const chainTokens = getTokens(chainId);
    const inOk = !!tokenInRaw && chainTokens.some((t) => t.address === form.tokenIn);
    const outOk = !!tokenOutRaw && chainTokens.some((t) => t.address === form.tokenOut);
    if (!inOk || !outOk) {
      setForm((f) => ({
        ...f,
        tokenIn: chainTokens[0].address,
        tokenOut: chainTokens[1].address,
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId]);
  const otherCommitted = useOutstandingCommitment(enabled, chainId, form.tokenIn);
  const approval = useTokenApproval(form.tokenIn, otherCommitted);
  const { setActiveTokenIn } = useActiveToken();
  useEffect(() => {
    setActiveTokenIn(form.tokenIn);
  }, [form.tokenIn, setActiveTokenIn]);
  const balance = useTokenBalance(form.tokenIn);

  // ─── Derived schedule ─────────────────────────────────────────
  // Cadence-driven model: user picks interval + slice count, we don't
  // pretend to fit them in a fixed window. Avoids the silent
  // "expired before all slices fired" failure of the previous
  // window-driven design (inclusion-latency compounds across slices,
  // so even 15 slices over 15min would only land ~11). Total runtime
  // is approximate by definition — chain latency varies — so we just
  // show an estimate instead of hard-capping.
  const intervalSec = Math.max(
    60,
    form.intervalValue * (form.intervalUnit === 'hour' ? 3600 : 60),
  );
  const totalAmountRaw = (() => {
    try {
      return parseUnits(form.totalAmountHuman, tokenIn.decimals);
    } catch {
      return 0n;
    }
  })();
  const amountPerSliceRaw =
    form.slices > 0 ? totalAmountRaw / BigInt(form.slices) : 0n;

  // Live market quote. Probe = amountPerSliceRaw so the returned price
  // matches what a real slice would receive on this pair — critical on
  // thin testnet pools where the default 1-unit-of-tokenIn probe blows
  // past multiple ticks and returns a wrecked quote. Falls back to 1
  // unit inside the hook when the form is still empty (amountPerSliceRaw=0).
  const market = useMarketPrice(
    'LIMIT_SELL',
    form.tokenIn,
    form.tokenOut,
    amountPerSliceRaw,
  );
  const amountPerSliceHuman =
    form.slices > 0
      ? formatSmart(Number(form.totalAmountHuman) / form.slices)
      : '0';

  // Rough total runtime — N-1 gaps between N slices. Real-world will
  // run slightly longer due to inclusion latency per slice. The contract
  // anchors next-slice-due time to the previous slice's INCLUSION
  // (block.timestamp), so every block-time + RPC-roundtrip delay
  // compounds. Surface a realistic upper bound based on chain so users
  // aren't surprised when a "10 min" TWAP actually takes 12.
  const LATENCY_SEC_PER_CHAIN: Record<number, number> = {
    1: 18,      // Ethereum mainnet — 12s block + RPC + keeper poll
    8453: 8,    // Base mainnet — 2s block
    84532: 10,  // Base Sepolia — slightly higher than mainnet
    137: 6,     // Polygon — 2s block
    10: 6,      // Optimism — 2s block
    42161: 4,   // Arbitrum — sub-second blocks
  };
  const latencyPerSlice = LATENCY_SEC_PER_CHAIN[chainId] ?? 15;
  const estimatedBestSec = Math.max(0, (form.slices - 1) * intervalSec);
  const estimatedRealisticSec = estimatedBestSec + Math.max(0, form.slices - 1) * latencyPerSlice;
  const formatDuration = (sec: number): string => {
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.round(sec / 60)} min`;
    if (sec < 86_400) return `${(sec / 3600).toFixed(1)} h`;
    return `${(sec / 86_400).toFixed(1)} d`;
  };
  const totalRuntimeHuman = formatDuration(estimatedBestSec);
  const realisticRuntimeHuman = formatDuration(estimatedRealisticSec);

  // Per-slice USD value → tier. Same logic as DCA + limit orders so a
  // user can predict their tier by mental math.
  const sliceUsd = estimateOrderUsd({
    amountInHuman: amountPerSliceHuman,
    tokenInSymbol: tokenIn.symbol,
    tokenOutSymbol: tokenOut.symbol,
    priceScaled: market.priceScaled,
  });
  const tier = sliceUsd !== null ? tierForUsd(sliceUsd) : FEE_TIERS[0];
  const feeBps = tier.targetBps;

  const floorRaw = computeFloor({
    currentPriceScaled: market.priceScaled,
    tolerancePct: form.floorTolerancePct,
  });
  const minPriceScaled = floorRaw.minPriceScaled; // signing math always uses raw
  const [displayFlipped, setDisplayFlipped] = useDisplayFlip(chainId, form.tokenIn, form.tokenOut);
  const { convention } = usePriceConvention();
  const pairUnknown = !tokenInRaw || !tokenOutRaw;
  const [unlimitedModalOpen, setUnlimitedModalOpen] = useState(false);
  const activeMode: ExecutionMode = detectActiveMode(
    { slippagePct: form.slippagePct, floorTolerancePct: form.floorTolerancePct },
    TWAP_MODE_PRESETS,
  );
  const applyMode = (m: Exclude<ExecutionMode, 'custom'>) => {
    const preset = TWAP_MODE_PRESETS[m];
    setForm({
      ...form,
      slippagePct: preset.slippagePct,
      floorTolerancePct: preset.floorTolerancePct,
    });
  };
  // Orientation under the global convention (market/swap) + per-pair ⇄.
  // Signed minPriceScaled stays canonical; only displayed values + labels
  // follow the convention. displayInverse=true means show 1/canonical.
  const orientResult = orientPair({
    tokenInSym: tokenIn.symbol,
    tokenInAddr: form.tokenIn,
    tokenOutSym: tokenOut.symbol,
    tokenOutAddr: form.tokenOut,
    flipped: displayFlipped,
    convention,
  });
  const invPrice = (p: number | null) => (p === null || p === 0 ? null : 1 / p);
  const orient = {
    assetSym: pairUnknown ? null : orientResult.denomSym,
    quoteSym: pairUnknown ? null : orientResult.numerSym,
    side: orientResult.displayInverse ? ('flipped' as const) : ('natural' as const),
  };
  const floor = {
    minPriceScaled: floorRaw.minPriceScaled,
    currentAssetPrice: orientResult.displayInverse
      ? invPrice(floorRaw.currentAssetPrice)
      : floorRaw.currentAssetPrice,
    thresholdAssetPrice: orientResult.displayInverse
      ? invPrice(floorRaw.thresholdAssetPrice)
      : floorRaw.thresholdAssetPrice,
  };

  // ─── Validation ───────────────────────────────────────────────
  const validationError = (() => {
    if (!enabled) return 'Sign-in to continue';
    if (form.tokenIn === form.tokenOut) return 'Same token in and out';
    if (totalAmountRaw === 0n) return 'Total amount must be > 0';
    if (form.slices < 2) return 'TWAP needs at least 2 slices';
    if (form.slices > 120) return 'Max 120 slices per order';
    if (intervalSec < 60) return 'Interval must be at least 1 min';
    // Same break-even guard as DCA. With more slices the per-slice
    // amount shrinks, so it's easier to hit here: a $1000 TWAP split
    // into 100 slices = $10/slice (OK). Split into 500 slices =
    // $2/slice (rejected).
    const chainInfo = CHAINS[chainId as ChainIdType];
    const minSliceUsd = getMinSliceUsd(chainInfo?.isTestnet ?? false);
    if (sliceUsd !== null && minSliceUsd > 0 && sliceUsd < minSliceUsd) {
      return `Slice too small (~$${sliceUsd.toFixed(2)}). Minimum is $${minSliceUsd}. Reduce slice count or increase total.`;
    }
    // Hard gate: only block if even one slice can't fire.
    if (enabled && !balance.isLoading && amountPerSliceRaw > balance.balance) {
      const haveH = formatSmart(Number(formatUnits(balance.balance, tokenIn.decimals)));
      const needH = formatSmart(Number(formatUnits(amountPerSliceRaw, tokenIn.decimals)));
      return `Insufficient ${tokenIn.symbol} for even one slice: need ${needH}, have ${haveH}`;
    }
    return null;
  })();

  // Soft warning when the full TWAP can't fit (other orders + this
  // total > wallet). User may top up or accept partial execution.
  const shortfallWarning = (() => {
    if (!enabled || balance.isLoading || validationError) return null;
    const totalReserved = totalAmountRaw + otherCommitted;
    if (totalReserved <= balance.balance) return null;
    const haveH = formatSmart(Number(formatUnits(balance.balance, tokenIn.decimals)));
    const needH = formatSmart(Number(formatUnits(totalAmountRaw, tokenIn.decimals)));
    const reservedH = otherCommitted > 0n
      ? formatSmart(Number(formatUnits(otherCommitted, tokenIn.decimals)))
      : null;
    const deficit = totalReserved - balance.balance;
    const deficitH = formatSmart(Number(formatUnits(deficit, tokenIn.decimals)));
    return reservedH
      ? `Wallet (${haveH}) short by ${deficitH} ${tokenIn.symbol} for this TWAP (${needH}) + ${reservedH} reserved by other orders. Some slices will fail until you top up.`
      : `Wallet (${haveH}) won't cover the full TWAP total (${needH} ${tokenIn.symbol}). First ~${amountPerSliceRaw > 0n ? Math.floor(Number(balance.balance) / Number(amountPerSliceRaw)) : 0} slices fire, then keeper waits for top-up.`;
  })();

  const showApprove =
    enabled &&
    !validationError &&
    approval.needsApproval(totalAmountRaw); // need approval covering full sum
  const formDisabled =
    isSubmitting || approval.isApproving || !enabled || validationError !== null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (formDisabled) return;
    const now = Math.floor(Date.now() / 1000);
    const created = await submit({
      tokenIn: form.tokenIn,
      tokenOut: form.tokenOut,
      amountPerSlice: amountPerSliceRaw.toString(),
      intervalSec,
      startTime: now,
      // endTime=0 → open-ended. maxSlices caps total; the order stops
      // firing once all slices land or the maker cancels. Avoids the
      // old "expired before complete" failure mode from window-driven
      // scheduling. Signature deadline still enforces a meaningful TTL
      // via signatureValidityDays below.
      endTime: 0,
      maxSlices: form.slices,
      maxSlippageBps: Math.round(form.slippagePct * 100),
      minPriceScaled,
      feeBps,
      // Signature good for the realistic runtime plus a generous buffer
      // for the keeper to catch up after any incident. Floored at 7 days
      // so very fast TWAPs still leave a recovery window.
      signatureValidityDays: Math.max(7, Math.ceil(estimatedRealisticSec / 86_400) + 7),
    });
    if (created) {
      toast.success(`TWAP order created — ${form.slices} slices, ~${totalRuntimeHuman} total`);
      // Reset total to empty so the operator visually confirms the
      // submit landed and doesn't accidentally re-submit the same
      // total on a second click. Other fields (interval, slices,
      // slippage, floor) stay set — typically reused across
      // back-to-back TWAP orders.
      setForm((f) => ({ ...f, totalAmountHuman: '' }));
    } else if (error) {
      toast.error(error);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-slate-800 bg-slate-900/40 p-6"
    >
      {/* 2-col split at md+ — schedule inputs on the left, preview +
          action on the right. Single column below md. */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {/* ─── LEFT: inputs ───────────────────────────────── */}
        <div className="space-y-4">
      <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
        <SelectField
          label="From"
          value={form.tokenIn}
          onChange={(v) => setForm({ ...form, tokenIn: v as `0x${string}` })}
          options={tokens.map((t) => ({ value: t.address, label: t.symbol }))}
        />
        <button
          type="button"
          onClick={() =>
            setForm((p) => ({ ...p, tokenIn: p.tokenOut, tokenOut: p.tokenIn }))
          }
          disabled={!enabled}
          className="mb-1 rounded-lg border border-slate-700 px-2 py-1.5 text-slate-300 hover:bg-slate-800 disabled:opacity-50"
          title="Swap direction"
        >
          ⇄
        </button>
        <SelectField
          label="To"
          value={form.tokenOut}
          onChange={(v) => setForm({ ...form, tokenOut: v as `0x${string}` })}
          options={tokens.map((t) => ({ value: t.address, label: t.symbol }))}
        />
      </div>

      {/* Live market rate banner — same pattern as DCA / Ladder. */}
      <button
        type="button"
        onClick={() => setDisplayFlipped((v) => !v)}
        title="Click to flip direction (display only)"
        className="block w-full rounded-lg border border-cyan-900/40 bg-cyan-950/30 px-4 py-3 text-center transition hover:border-cyan-700/50"
      >
        <div className="text-xs uppercase tracking-wider text-slate-400">Now</div>
        <div className="mt-0.5 font-mono text-lg text-cyan-100">
          {floor.currentAssetPrice !== null && orient.assetSym && orient.quoteSym
            ? `1 ${orient.assetSym} ≈ ${formatAssetPrice(floor.currentAssetPrice)} ${orient.quoteSym}`
            : 'Loading live rate…'}
          <span className="ml-2 text-slate-500" title="flip view">⇄</span>
        </div>
      </button>

      <div>
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
          <Label>Total {tokenIn.symbol} to send</Label>
          <span className="text-xs text-slate-400 whitespace-nowrap">
            Bal:{' '}
            <span className="font-mono text-slate-300">
              {balance.isLoading
                ? '…'
                : formatSmart(Number(formatUnits(balance.balance, tokenIn.decimals)))}
            </span>{' '}
            {tokenIn.symbol}
          </span>
        </div>
        <input
          type="text"
          inputMode="decimal"
          value={form.totalAmountHuman}
          onChange={(e) =>
            setForm({ ...form, totalAmountHuman: e.target.value })
          }
          disabled={!enabled}
          className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 disabled:opacity-50"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Every</Label>
          <div className="flex gap-2">
            <input
              type="number"
              min={1}
              max={999}
              value={form.intervalValue === 0 ? '' : form.intervalValue}
              onChange={(e) => {
                const v = e.target.value;
                setForm({
                  ...form,
                  intervalValue: v === '' ? 0 : Math.max(0, Math.floor(Number(v))),
                });
              }}
              disabled={!enabled}
              className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 disabled:opacity-50"
            />
            <select
              value={form.intervalUnit}
              onChange={(e) =>
                setForm({ ...form, intervalUnit: e.target.value as FormState['intervalUnit'] })
              }
              disabled={!enabled}
              className="rounded-lg border border-slate-800 bg-slate-950 px-2 py-2 text-sm text-slate-100 disabled:opacity-50"
            >
              <option value="min">min</option>
              <option value="hour">hour</option>
            </select>
          </div>
        </div>
        <div>
          <Label>Slices</Label>
          <input
            type="number"
            min={2}
            max={120}
            value={form.slices === 0 ? '' : form.slices}
            onChange={(e) => {
              // Let the user clear the field while typing (empty string →
              // 0 in state). Validation below catches < 2 and disables
              // the submit button, so we don't fight the keystroke here.
              const v = e.target.value;
              setForm({
                ...form,
                slices: v === '' ? 0 : Math.max(0, Math.floor(Number(v))),
              });
            }}
            disabled={!enabled}
            className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 disabled:opacity-50"
          />
        </div>
      </div>

      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <Label>Mode shortcut</Label>
          {activeMode === 'custom' && (
            <span className="text-xs text-slate-400">⚙️ Custom</span>
          )}
        </div>
        <div className="flex gap-2">
          {(['safe', 'balanced', 'turbo'] as const).map((m) => {
            const meta = MODE_LABELS[m];
            const isActive = activeMode === m;
            return (
              <button
                type="button"
                key={m}
                onClick={() => applyMode(m)}
                disabled={!enabled}
                title={meta.tagline}
                className={`rounded-lg border px-3 py-1 text-xs disabled:opacity-50 ${
                  isActive
                    ? 'border-cyan-500 bg-cyan-500/15 text-cyan-200'
                    : 'border-slate-800 bg-slate-950 text-slate-300 hover:bg-slate-900'
                }`}
              >
                {meta.emoji} {meta.name}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <Label>Slippage tolerance per slice</Label>
        <div className="flex items-center gap-2">
          {SLIPPAGE_PRESETS.map((p) => (
            <button
              type="button"
              key={p}
              onClick={() => setForm({ ...form, slippagePct: p })}
              disabled={!enabled}
              className={`rounded-lg border px-2 py-1 text-xs disabled:opacity-50 ${
                form.slippagePct === p
                  ? 'border-cyan-500 bg-cyan-500/15 text-cyan-200'
                  : 'border-slate-800 bg-slate-950 text-slate-300'
              }`}
            >
              {p}%
            </button>
          ))}
          <div className="relative flex-1">
            <input
              type="number"
              step="0.01"
              min="0"
              max="50"
              value={form.slippagePct}
              onChange={(e) =>
                setForm({ ...form, slippagePct: Number(e.target.value) })
              }
              disabled={!enabled}
              className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 pr-7 font-mono text-sm text-slate-100 disabled:opacity-50"
            />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-400">%</span>
          </div>
        </div>
      </div>

      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <Label>Floor tolerance</Label>
          {pairUnknown && (
            <span className="text-xs text-slate-400">N/A — missing tokens</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {[0, 3, 5, 10, 20].map((p) => (
            <button
              type="button"
              key={p}
              onClick={() => setForm({ ...form, floorTolerancePct: p })}
              disabled={!enabled || pairUnknown}
              className={`rounded-lg border px-2 py-1 text-xs disabled:opacity-50 ${
                form.floorTolerancePct === p
                  ? 'border-cyan-500 bg-cyan-500/15 text-cyan-200'
                  : 'border-slate-800 bg-slate-950 text-slate-300'
              }`}
            >
              {p === 0 ? 'off' : `${p}%`}
            </button>
          ))}
          <div className="relative flex-1">
            <input
              type="number"
              step="1"
              min="0"
              max="1000"
              value={form.floorTolerancePct}
              onChange={(e) =>
                setForm({ ...form, floorTolerancePct: Math.max(0, Number(e.target.value)) })
              }
              disabled={!enabled || pairUnknown}
              className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 pr-7 font-mono text-sm text-slate-100 disabled:opacity-50"
            />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-400">%</span>
          </div>
        </div>
        {amountPerSliceRaw <= 0n ? (
          <div className="mt-1 text-sm text-slate-500 italic">
            Enter a total amount above to preview the floor at the live rate.
          </div>
        ) : floor.currentAssetPrice !== null && orient.assetSym && orient.quoteSym && (
          <button
            type="button"
            onClick={() => setDisplayFlipped((v) => !v)}
            title="Click to flip quoting direction (display only — does not change the signed floor)"
            className="mt-1 block text-left text-sm text-slate-400 hover:text-slate-300"
          >
            Now: <span className="font-mono text-slate-400">1 {orient.assetSym} ≈{' '}
              {formatAssetPrice(floor.currentAssetPrice)} {orient.quoteSym}</span>
            {floor.thresholdAssetPrice !== null && (
              <>
                {' '}· Stop if 1 {orient.assetSym}{' '}
                {orient.side === 'flipped' ? 'rises above' : 'drops below'}{' '}
                <span className="font-mono text-amber-300">
                  {formatAssetPrice(floor.thresholdAssetPrice)} {orient.quoteSym}
                </span>
              </>
            )}
            <span className="ml-1 text-slate-500">⇄</span>
          </button>
        )}
        {form.floorTolerancePct !== 0 && !pairUnknown && amountPerSliceRaw > 0n && !market.priceScaled && (
          <div className="mt-1 text-sm text-amber-400">
            Loading quote… floor will be set when price loads.
          </div>
        )}
      </div>

        </div>{/* ─── /LEFT ─────────────────────────────────── */}

        {/* ─── RIGHT: preview + action ─────────────────────── */}
        <div className="space-y-4">

      <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-sm text-slate-400 space-y-1">
        <div className="text-slate-200 font-medium">Preview</div>
        <div>
          {form.slices} swaps of ~{amountPerSliceHuman} {tokenIn.symbol} → {tokenOut.symbol}
        </div>
        <div>
          Every {form.intervalValue} {form.intervalUnit}
          {form.intervalValue !== 1 && form.intervalUnit === 'min' ? 's' : ''}
          {form.intervalValue !== 1 && form.intervalUnit === 'hour' ? 's' : ''}
        </div>
        <div className="text-slate-400">
          Total runtime ≈{' '}
          <span className="text-slate-300">{totalRuntimeHuman}</span>
          {realisticRuntimeHuman !== totalRuntimeHuman && (
            <>
              {' '}–{' '}
              <span className="text-slate-300">{realisticRuntimeHuman}</span>{' '}
              <span
                title={`Estimate accounts for ~${latencyPerSlice}s inclusion latency per slice on this chain. Real time may vary with network congestion.`}
              >
                (chain latency)
              </span>
            </>
          )}
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span>
            Fee per swap:{' '}
            <span className="font-mono text-slate-300">{(feeBps / 100).toFixed(2)}%</span>
          </span>
          <span className={`rounded border px-2 py-0.5 text-xs ${tier.badge}`}>
            {tier.name}
            {sliceUsd !== null && (
              <span className="ml-1 font-mono text-xs opacity-75">
                ~${formatSmart(sliceUsd)}/slice
              </span>
            )}
          </span>
        </div>
        <div className="text-slate-400">
          Targets avg execution ≈ TWAP price over the run. Order keeps firing
          on schedule until all {form.slices} slices land or you cancel.
        </div>
      </div>

      {/* Submit errors surface as a toast (see submit handler above).
          No inline banner — keeps the form layout stable on retry. */}

      {shortfallWarning && (
        <div className="rounded border border-amber-900/50 bg-amber-950/40 p-3 text-sm text-amber-300">
          ⚠️ {shortfallWarning}
        </div>
      )}

      {showApprove ? (
        <div className="space-y-1.5">
          <button
            type="button"
            onClick={() => {
              // Always exact: totalAmount for THIS TWAP plus the
              // user's outstanding commitment on the same token. The
              // "approve unlimited" path lives behind a confirmation link
              // below, not a toggle.
              void approval.approve(totalAmountRaw + otherCommitted).catch(() => {});
            }}
            disabled={approval.isApproving}
            className="w-full rounded-lg bg-amber-500 px-4 py-2.5 text-sm font-medium text-slate-950 hover:bg-amber-400 disabled:opacity-50"
          >
            {(() => {
              if (approval.isApproving) return `Approving ${tokenIn.symbol}…`;
              const totalRaw = totalAmountRaw + otherCommitted;
              const totalHuman = formatSmart(Number(formatUnits(totalRaw, tokenIn.decimals)));
              return `1. Approve ${totalHuman} ${tokenIn.symbol} (exact)`;
            })()}
          </button>
          <button
            type="button"
            disabled={approval.isApproving}
            onClick={() => setUnlimitedModalOpen(true)}
            className="block w-full text-center text-xs text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline disabled:opacity-50"
          >
            Approve unlimited instead (advanced)
          </button>
          {otherCommitted > 0n && (
            <div className="text-xs text-slate-500">
              Sum = {form.totalAmountHuman} (this TWAP) +{' '}
              {formatSmart(Number(formatUnits(otherCommitted, tokenIn.decimals)))}{' '}
              {tokenIn.symbol} reserved by your other active orders.
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <button
            type="submit"
            disabled={formDisabled}
            className="w-full rounded-lg bg-cyan-500 px-4 py-2.5 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
          >
            {!enabled
              ? 'Sign-in first'
              : isSubmitting
                ? 'Signing + submitting…'
                : validationError
                  ? validationError
                  : 'Sign & start TWAP'}
          </button>
          {enabled && approval.allowance > 0n && !validationError && (
            <div className="text-sm text-emerald-400/80">
              ✓ Allowance covers this order ({formatSmart(Number(formatUnits(approval.allowance, tokenIn.decimals)))} {tokenIn.symbol}{' '}
              already approved
              {approval.otherCommitted > 0n && (
                <>, {formatSmart(Number(formatUnits(approval.otherCommitted, tokenIn.decimals)))}{' '}
                  reserved by other active orders</>
              )})
            </div>
          )}
        </div>
      )}
        </div>{/* ─── /RIGHT ───────────────────────────────── */}
      </div>{/* ─── /grid ────────────────────────────────── */}

      <ApproveUnlimitedModal
        open={unlimitedModalOpen}
        onClose={() => setUnlimitedModalOpen(false)}
        tokenSymbol={tokenIn.symbol}
        orderKindLabel="TWAP"
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
    </form>
  );
}

// ─── Same layout helpers as CreateDcaForm — duplicated for now,
// hoist to a shared module if a third scheduled-flavour appears. ─

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 text-xs uppercase tracking-wider text-slate-400">
      {children}
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div>
      <Label>{label}</Label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/40"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
