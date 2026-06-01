/**
 * DCA tab — "Buy [token] every [period]" set-and-forget for retail.
 *
 * Open-ended by default (endTime=0, maxSlices=0) — keeper keeps firing
 * one slice per interval until the maker cancels OR the signature
 * expires (signatureValidityDays). User can switch to a bounded
 * duration via the dropdown.
 *
 * Sister component: CreateTwapForm — same backend, bounded window
 * defaults instead.
 */

import { useEffect, useState } from 'react';
import { useSessionForm } from '../hooks/useSessionForm';
import { useChainId } from 'wagmi';
import toast from 'react-hot-toast';
import { parseUnits, formatUnits } from '@owlorderfi/shared';
import { useCreateScheduledOrder } from '../hooks/useCreateScheduledOrder';
import { useTokenApproval } from '../hooks/useTokenApproval';
import { useOutstandingCommitment } from '../hooks/useOutstandingCommitment';
import { useTokenBalance } from '../hooks/useTokenBalance';
import { useMarketPrice } from '../hooks/useMarketPrice';
import { SlippageSuggestion } from './SlippageSuggestion';
import { getTokens, findToken } from '../lib/tokens';
import { computeFloor, formatAssetPrice, displayPrice } from '../lib/priceFloor';
import { usePriceFlip } from '../lib/PriceFlipContext';
import { formatSmart } from '../lib/formatAmount';
import { useActiveToken } from '../lib/ActiveTokenContext';
import { FEE_TIERS, tierForUsd, estimateOrderUsd } from '../lib/feeTiers';
import { computeExpectedAmountOut } from '../lib/orderMath';
import {
  DCA_MODE_PRESETS,
  MODE_LABELS,
  detectActiveMode,
  type ExecutionMode,
} from '../lib/executionModes';
import { ApproveUnlimitedModal } from './ApproveUnlimitedModal';

interface Props {
  enabled: boolean;
}

interface FormState {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountPerSliceHuman: string;
  intervalKey: 'hourly' | 'daily' | 'weekly' | 'monthly';
  durationKey: '1m' | '3m' | '6m' | '1y';
  slippagePct: number;
  /**
   * Tolerance for the maker-signed hard price floor — how far the asset
   * price may move from the current quote before the contract refuses
   * the slice. Semantic flips by direction:
   *   - buying:  "stop if asset rises by more than X%"
   *   - selling: "stop if asset drops by more than X%"
   * 0 = no floor (let the keeper's per-tx slippage gate be the sole
   * defense). Default loose for DCA so dip-buying still fires.
   * Presets shortcut common values; the input accepts any positive %.
   */
  floorTolerancePct: number;
}

const INTERVAL_SEC: Record<FormState['intervalKey'], number> = {
  hourly: 3600,
  daily: 86_400,
  weekly: 604_800,
  monthly: 2_592_000, // 30d
};

const DURATION_SEC: Record<FormState['durationKey'], number> = {
  '1m': 30 * 86_400,
  '3m': 90 * 86_400,
  '6m': 180 * 86_400,
  '1y': 365 * 86_400,
};

const SLIPPAGE_PRESETS = [0.1, 0.3, 0.5, 1, 2];

export function CreateDcaForm({ enabled }: Props) {
  const chainId = useChainId();
  const tokens = getTokens(chainId);

  if (tokens.length < 2) {
    return (
      <div className="rounded-xl border border-amber-900/50 bg-amber-950/30 p-4 text-sm text-amber-200">
        <div className="font-medium mb-1">No tokens configured for this chain</div>
        <p className="text-sm text-amber-300/80">
          Switch your wallet to a supported network to create DCA orders.
        </p>
      </div>
    );
  }

  // key={chainId} forces remount on chain switch — see CreateOrderForm
  // for the same rationale (avoids stale tokenIn/tokenOut crash).
  return <CreateDcaFormInner key={chainId} enabled={enabled} chainId={chainId} tokens={tokens} />;
}

function CreateDcaFormInner({
  enabled,
  chainId,
  tokens,
}: {
  enabled: boolean;
  chainId: number;
  tokens: ReturnType<typeof getTokens>;
}) {
  const { submit, isSubmitting, error } = useCreateScheduledOrder();

  // Per-chain key so address fields (tokenIn/tokenOut) don't bleed
  // across chains in sessionStorage. Other fields are chain-agnostic but
  // there's no clean way to split them.
  const [form, setForm] = useSessionForm<FormState>(`polyorder.formDca.${chainId}`, {
    tokenIn: tokens[0].address,
    tokenOut: tokens[1].address,
    // Per-slice amount starts empty — Approve preview should not surface
    // a synthetic value before the user types. `touched` flag suppresses
    // the validation banner while the field is pristine.
    amountPerSliceHuman: '',
    intervalKey: 'daily',
    durationKey: '3m',
    slippagePct: 0.5,
    floorTolerancePct: 25,
  });

  // Stub-fallback tokens for the one-render gap after a chain switch
  // (form state still has the previous chain's addresses; the reset
  // effect below fires on the next tick). Stubs keep .symbol/.decimals
  // access safe — CANNOT early-return here, hook call order has to
  // stay stable across renders. See CreateLadderForm.tsx for context.
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
  const balance = useTokenBalance(form.tokenIn);
  // Broadcast our current tokenIn so the WalletSummary widget can
  // auto-focus on the same token. Cheap effect; only fires on change.
  const { setActiveTokenIn } = useActiveToken();
  useEffect(() => {
    setActiveTokenIn(form.tokenIn);
  }, [form.tokenIn, setActiveTokenIn]);
  // ─── Derived schedule ─────────────────────────────────────────
  const intervalSec = INTERVAL_SEC[form.intervalKey];
  const durationSec = DURATION_SEC[form.durationKey];
  const numSlices = Math.floor(durationSec / intervalSec);

  const amountInRaw = (() => {
    try {
      return parseUnits(form.amountPerSliceHuman, tokenIn.decimals);
    } catch {
      return 0n;
    }
  })();

  // Current market price (tokenOut human per 1 tokenIn human, scaled 1e18).
  // LIMIT_SELL orientation matches "I send tokenIn, receive tokenOut" so the
  // returned price is in the same direction as the contract's minPriceScaled.
  // Amount-independent spot (server-side), so no probe amount.
  const market = useMarketPrice(form.tokenIn, form.tokenOut);
  // Total commitment = amountPerSlice × maxSlices. Drives both
  // the Preview line and the approval sizing — these two must
  // stay in sync. All DCAs are bounded (we removed 'forever' as
  // it makes the wallet manager + approval flow unpredictable).
  const totalCommitmentRaw = amountInRaw * BigInt(numSlices);
  const totalAmountHuman = `${formatSmart(Number(form.amountPerSliceHuman) * numSlices)} ${tokenIn.symbol}`;

  // Tier driven by per-slice USD value (NOT total) — every slice is an
  // independent on-chain swap, so the fee applies per slice. Falls back
  // to Default tier when the pair has no stable side (no USD anchor).
  const sliceUsd = estimateOrderUsd({
    amountInHuman: form.amountPerSliceHuman,
    tokenInSymbol: tokenIn.symbol,
    tokenOutSymbol: tokenOut.symbol,
    priceScaled: market.priceScaled,
  });
  const tier = sliceUsd !== null ? tierForUsd(sliceUsd) : FEE_TIERS[0];
  const feeBps = tier.targetBps;

  // Pair direction drives the floor semantic. For USDC→WETH the user is
  // BUYING WETH (asset), so the floor caps "max price per WETH". Non-stable
  // pairs (e.g. WETH/WBTC) get a default asset = tokenOut; the display can
  // be flipped client-side via the toggle below without re-signing.
  const floorRaw = computeFloor({
    currentPriceScaled: market.priceScaled,
    tolerancePct: form.floorTolerancePct,
  });
  const minPriceScaled = floorRaw.minPriceScaled; // signing math always uses raw
  // Pair is "unknown" only during the one-render stub gap after a chain
  // switch (token not yet resolved on the new chain).
  const pairUnknown = !tokenInRaw || !tokenOutRaw;

  // Read-only orientative preview: what each swap WOULD yield right now,
  // at the live pool spot rate. NOT a guarantee — by the time slice N
  // executes (days/weeks later) the market price has moved, so the actual
  // fill could be higher OR lower than this. We deliberately show the
  // live-rate estimate instead of the floor-based worst case, because
  // floor is contractual protection (a safety net the user already chose
  // via floorTolerancePct) and worst-case-only framing was misleading
  // — DCA users care about "what would I get TODAY at this size", not
  // "what's the absolute minimum the contract would accept".
  const previewPerSlice = (() => {
    if (amountInRaw === 0n || pairUnknown || market.priceScaled === null) return null;
    // Match the limit form's illiquid-pool guard so a degenerate spot
    // (e.g. ~9e11 USDC/WETH on a near-empty testnet pool) doesn't render
    // absurd yield numbers next to the order config. The submit-time
    // validationError already blocks the order in that case; this keeps
    // the visible preview honest too.
    const spot = Number(market.priceScaled) / 1e18;
    if (!isFinite(spot) || spot > 1e9 || spot < 1e-9) return null;
    try {
      const expected = computeExpectedAmountOut({
        orderType: 'LIMIT_SELL',
        amountInRaw,
        triggerPriceScaled: market.priceScaled,
        tokenInDecimals: tokenIn.decimals,
        tokenOutDecimals: tokenOut.decimals,
      });
      return {
        expectedHuman: formatUnits(expected, tokenOut.decimals),
        totalExpectedHuman: formatUnits(expected * BigInt(numSlices), tokenOut.decimals),
      };
    } catch {
      return null;
    }
  })();
  // Unlimited-approval flow: default is exact-amount. User opts in via
  // ApproveUnlimitedModal which handles its own acknowledgment state.
  const [unlimitedModalOpen, setUnlimitedModalOpen] = useState(false);
  // Mode picker is purely a shortcut — it sets slippage + floor in one
  // click; the granular controls below stay visible so the user can
  // see exactly what each mode chose. activeMode is derived from the
  // current values; editing any control individually flips it back to
  // 'custom' automatically.
  const activeMode: ExecutionMode = detectActiveMode(
    { slippagePct: form.slippagePct, floorTolerancePct: form.floorTolerancePct },
    DCA_MODE_PRESETS,
  );
  const applyMode = (m: Exclude<ExecutionMode, 'custom'>) => {
    const preset = DCA_MODE_PRESETS[m];
    setForm({
      ...form,
      slippagePct: preset.slippagePct,
      floorTolerancePct: preset.floorTolerancePct,
    });
  };
  // Single fixed display orientation — each value goes through displayPrice
  // so the number and its unit can never disagree. The signed minPriceScaled
  // stays canonical and untouched.
  const { flipped, toggleFlipped } = usePriceFlip();
  const priceTokens = {
    tokenInSym: tokenIn.symbol,
    tokenInAddr: form.tokenIn,
    tokenOutSym: tokenOut.symbol,
    tokenOutAddr: form.tokenOut,
  };
  const curDisp = !pairUnknown && floorRaw.currentAssetPrice !== null
    ? displayPrice({ canonical: floorRaw.currentAssetPrice, flipped, ...priceTokens })
    : null;
  const thrDisp = !pairUnknown && floorRaw.thresholdAssetPrice !== null
    ? displayPrice({ canonical: floorRaw.thresholdAssetPrice, flipped, ...priceTokens })
    : null;

  // ─── Validation ───────────────────────────────────────────────
  const validationError = (() => {
    if (!enabled) return 'Sign-in to continue';
    if (form.tokenIn === form.tokenOut) return 'Same token in and out';
    if (amountInRaw === 0n) return 'Amount must be > 0';
    // Illiquid-pool guard (matches the Limit form): a degenerate pool reports
    // a garbage spot, so every derived floor is meaningless. Outside 1e-9..1e9
    // = not a real market — block with an honest message.
    if (market.priceScaled !== null) {
      const spot = Number(market.priceScaled) / 1e18;
      if (spot > 1e9 || spot < 1e-9) return 'Price unavailable — this pair looks illiquid on this chain';
    }
    // Per-slice break-even is enforced dynamically at execution time by
    // the keeper (live ETH/USD anchor + current gas + 1.5× safety margin).
    // The old static $5 floor here drifted out of date with gas conditions
    // — at Base mainnet's typical 0.006 gwei the real break-even is ~$1.50,
    // so $5 was blocking perfectly viable slices. Trust the keeper-side
    // check; if a slice is unprofitable when its time comes, the slice is
    // marked FAILED with a clear reason and the user can re-sign with a
    // larger amount or wait for gas to drop.
    // Hard balance gate: only block when even the FIRST slice can't
    // fire (wallet < amountPerSlice). Multi-slice shortfalls become
    // soft warnings instead — user might plan to top up, cancel
    // siblings, or accept partial execution. Forcing them to resolve
    // upfront is over-paternalistic and breaks legitimate flows.
    if (enabled && !balance.isLoading && amountInRaw > balance.balance) {
      const haveH = formatSmart(Number(formatUnits(balance.balance, tokenIn.decimals)));
      const needH = formatSmart(Number(formatUnits(amountInRaw, tokenIn.decimals)));
      return `Insufficient ${tokenIn.symbol} for even one slice: need ${needH}, have ${haveH}`;
    }
    // A.12: never sign a scheduled order with a zero on-chain floor. 0
    // disables the contract's post-swap floor check, so a compromised RPC
    // could set the keeper's minOut arbitrarily low and the slice fills at a
    // terrible price. Block both the explicit no-floor path and the
    // not-yet-quoted state (where computeFloor returns "0").
    if (floorRaw.minPriceScaled === '0') {
      return form.floorTolerancePct === 0
        ? 'Set a price floor — DCA needs downside protection (pick a level above 0%)'
        : 'Waiting for live price to set the floor…';
    }
    return null;
  })();

  // Soft warning: total commitment of this DCA + sibling orders
  // exceeds the wallet. Shown as an amber banner but doesn't block
  // submit — user may plan ahead, cancel siblings, or accept a
  // partial run.
  const shortfallWarning = (() => {
    if (!enabled || balance.isLoading || validationError) return null;
    const required = totalCommitmentRaw > 0n ? totalCommitmentRaw : amountInRaw;
    const totalReserved = required + otherCommitted;
    if (totalReserved <= balance.balance) return null;
    const haveH = formatSmart(Number(formatUnits(balance.balance, tokenIn.decimals)));
    const needH = formatSmart(Number(formatUnits(required, tokenIn.decimals)));
    const reservedH = otherCommitted > 0n
      ? formatSmart(Number(formatUnits(otherCommitted, tokenIn.decimals)))
      : null;
    const deficit = totalReserved - balance.balance;
    const deficitH = formatSmart(Number(formatUnits(deficit, tokenIn.decimals)));
    return reservedH
      ? `Wallet (${haveH}) short by ${deficitH} ${tokenIn.symbol} for this DCA (${needH}) + ${reservedH} reserved by other orders. Some slices will fail until you top up.`
      : `Wallet (${haveH}) won't cover the full DCA total (${needH} ${tokenIn.symbol}). First ~${Math.floor(Number(balance.balance) / Number(amountInRaw))} slices fire, then keeper waits for top-up.`;
  })();

  // Approval check needs the FULL commitment for a bounded DCA, not
  // just one slice — otherwise allowance(N) where N < total would
  // silently pass and execution would revert on slice K when
  // allowance ran out. Unbounded DCA forces unlimited approve, so
  // the threshold reduces to single-slice (cosmetic).
  const requiredApprovalRaw = totalCommitmentRaw > 0n ? totalCommitmentRaw : amountInRaw;
  const showApprove =
    enabled && !validationError && approval.needsApproval(requiredApprovalRaw);
  const formDisabled =
    isSubmitting || approval.isApproving || !enabled || validationError !== null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (formDisabled) return;
    const now = Math.floor(Date.now() / 1000);
    const created = await submit({
      tokenIn: form.tokenIn,
      tokenOut: form.tokenOut,
      amountPerSlice: amountInRaw.toString(),
      intervalSec,
      startTime: now, // start ASAP
      endTime: now + durationSec,
      maxSlices: numSlices,
      maxSlippageBps: Math.round(form.slippagePct * 100),
      minPriceScaled,
      feeBps,
      // Signature stays valid for the order's duration + 30 days buffer.
      signatureValidityDays: Math.ceil(durationSec / 86400) + 30,
    });
    if (created) {
      toast.success(`DCA order created — first slice in ~30s`);
      // Reset amount to empty so the operator visually confirms the
      // submit landed and doesn't accidentally re-submit the same
      // amount on a second click. Other fields (interval, duration,
      // slippage, floor) stay set — they're typically reused across
      // back-to-back DCA orders.
      setForm((f) => ({ ...f, amountPerSliceHuman: '' }));
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
      {/* Live market rate — click to flip how all prices read (global). */}
      <button
        type="button"
        onClick={toggleFlipped}
        title="Click to flip how prices are shown everywhere (display only)"
        className="block w-full rounded-lg border border-cyan-900/40 bg-cyan-950/30 px-4 py-3 text-center transition hover:border-cyan-700/50"
      >
        <div className="text-xs uppercase tracking-wider text-slate-400">Now</div>
        <div className="mt-0.5 font-mono text-lg text-cyan-100">
          {curDisp
            ? `1 ${curDisp.baseSym} ≈ ${formatAssetPrice(curDisp.value)} ${curDisp.quoteSym}`
            : 'Loading live rate…'}
        </div>
        {curDisp && (
          <div className="mt-0.5 text-xs text-slate-500">
            <span className="font-mono">{curDisp.directionLabel}</span> <span aria-hidden>⇄</span>
          </div>
        )}
      </button>

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

      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
            <Label>Amount per swap</Label>
            <span className="text-sm text-slate-400 whitespace-nowrap">
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
            value={form.amountPerSliceHuman}
            onChange={(e) =>
              setForm({ ...form, amountPerSliceHuman: e.target.value })
            }
            disabled={!enabled}
            className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 disabled:opacity-50"
          />
        </div>
        <SelectField
          label="Every"
          value={form.intervalKey}
          onChange={(v) =>
            setForm({ ...form, intervalKey: v as FormState['intervalKey'] })
          }
          options={[
            { value: 'hourly', label: 'hour' },
            { value: 'daily', label: 'day' },
            { value: 'weekly', label: 'week' },
            { value: 'monthly', label: 'month' },
          ]}
        />
      </div>

      <SelectField
        label="For"
        value={form.durationKey}
        onChange={(v) =>
          setForm({ ...form, durationKey: v as FormState['durationKey'] })
        }
        options={[
          { value: '1m', label: '1 month' },
          { value: '3m', label: '3 months' },
          { value: '6m', label: '6 months' },
          { value: '1y', label: '1 year' },
        ]}
      />

      {/* Mode shortcut — one click sets slippage + floor. The granular
          controls stay visible below so the user always sees what each
          mode chose; editing any control individually flips back to
          'custom' automatically. */}
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
        <SlippageSuggestion
          tokenIn={form.tokenIn}
          tokenOut={form.tokenOut}
          currentSlippagePct={form.slippagePct}
          onApply={(s) => setForm({ ...form, slippagePct: s })}
          disabled={!enabled}
        />
      </div>

      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <Label>Floor tolerance</Label>
          {pairUnknown && (
            <span className="text-xs text-slate-400">N/A — missing tokens</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* No "off" (0%) — a DCA must carry a non-zero on-chain price
              floor (A.12). 0 disables the contract's floor check, leaving an
              untrusted RPC quote as the only guard. */}
          {[5, 10, 25, 50].map((p) => (
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
              {`${p}%`}
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
        {amountInRaw <= 0n ? (
          <div className="mt-1 text-sm text-slate-500 italic">
            Enter an amount above to preview the floor at the live rate.
          </div>
        ) : curDisp && (
          <div className="mt-1 block text-left text-sm text-slate-400">
            Now: <span className="font-mono text-slate-400">1 {curDisp.baseSym} ≈{' '}
              {formatAssetPrice(curDisp.value)} {curDisp.quoteSym}</span>
            {thrDisp !== null && (
              <>
                {' '}· Stop if 1 {curDisp.baseSym}{' '}
                {curDisp.inverted ? 'rises above' : 'drops below'}{' '}
                <span className="font-mono text-amber-300">
                  {formatAssetPrice(thrDisp.value)} {curDisp.quoteSym}
                </span>
              </>
            )}
          </div>
        )}
        {form.floorTolerancePct !== 0 && !pairUnknown && amountInRaw > 0n && !market.priceScaled && (
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
          {numSlices} {form.intervalKey} swaps
        </div>
        <div>
          Per swap: {form.amountPerSliceHuman} {tokenIn.symbol} → {tokenOut.symbol}
        </div>
        {previewPerSlice && (
          <div
            title={`Orientative — what each swap would yield at the live pool rate right now. Future swaps fill at the rate at THEIR moment, so the actual fills will vary up or down from this number as the market moves.`}
          >
            Per swap at current rate:{' '}
            <span className="font-mono text-slate-300">
              ≈ {formatSmart(Number(previewPerSlice.expectedHuman))} {tokenOut.symbol}
            </span>
          </div>
        )}
        <div>Total sent over period: {totalAmountHuman}</div>
        {previewPerSlice && (
          <div title={`Orientative — total at the live rate × ${numSlices} swaps. Actual outcome will vary as the price moves.`}>
            Total at current rate:{' '}
            <span className="font-mono text-slate-300">
              ≈ {formatSmart(Number(previewPerSlice.totalExpectedHuman))} {tokenOut.symbol}
            </span>
          </div>
        )}
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
          First swap: ~30s after submit. Keeper handles the rest automatically.
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
              // Always exact: amountPerSlice × maxSlices + otherCommitted
              // so siblings (other DCAs / TWAPs / limit orders on the same
              // token) keep their allowance intact. The "approve unlimited"
              // path lives behind a confirmation link below, not a toggle.
              const exactAmount = amountInRaw * BigInt(numSlices) + otherCommitted;
              void approval.approve(exactAmount).catch(() => {});
            }}
            disabled={approval.isApproving}
            className="w-full rounded-lg bg-amber-500 px-4 py-2.5 text-sm font-medium text-slate-950 hover:bg-amber-400 disabled:opacity-50"
          >
            {(() => {
              if (approval.isApproving) return `Approving ${tokenIn.symbol}…`;
              const totalRaw = amountInRaw * BigInt(numSlices) + otherCommitted;
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
              Sum = {formatSmart(Number(form.amountPerSliceHuman) * numSlices)} (this DCA) +{' '}
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
                  : 'Sign & create DCA'}
          </button>
          {/* Transparency line: tell the user WHY no approve is needed.
              Without this the form silently skips the approve flow and
              the user wonders if it's broken. */}
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
        orderKindLabel="DCA"
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

// ─── Small layout helpers used by both DCA + TWAP forms ─────────

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
