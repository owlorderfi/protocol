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

import { useState } from 'react';
import { useChainId } from 'wagmi';
import toast from 'react-hot-toast';
import { parseUnits, formatUnits } from '@owlorderfi/shared';
import { useCreateScheduledOrder } from '../hooks/useCreateScheduledOrder';
import { useTokenApproval } from '../hooks/useTokenApproval';
import { useTokenBalance } from '../hooks/useTokenBalance';
import { useMarketPrice } from '../hooks/useMarketPrice';
import { getTokens, findToken } from '../lib/tokens';
import { classifyPair, computeFloor, flipDisplay, formatAssetPrice } from '../lib/priceFloor';
import { FEE_TIERS, tierForUsd, estimateOrderUsd, MIN_SLICE_USD } from '../lib/feeTiers';
import {
  DCA_MODE_PRESETS,
  MODE_LABELS,
  detectActiveMode,
  type ExecutionMode,
} from '../lib/executionModes';

interface Props {
  enabled: boolean;
}

interface FormState {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountPerSliceHuman: string;
  intervalKey: 'hourly' | 'daily' | 'weekly' | 'monthly';
  durationKey: 'forever' | '1m' | '3m' | '6m' | '1y';
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
  forever: 0, // unbounded
  '1m': 30 * 86_400,
  '3m': 90 * 86_400,
  '6m': 180 * 86_400,
  '1y': 365 * 86_400,
};

const SLIPPAGE_PRESETS = [0.1, 0.5, 1, 2];

export function CreateDcaForm({ enabled }: Props) {
  const chainId = useChainId();
  const tokens = getTokens(chainId);

  if (tokens.length < 2) {
    return (
      <div className="rounded-xl border border-amber-900/50 bg-amber-950/30 p-4 text-sm text-amber-200">
        <div className="font-medium mb-1">No tokens configured for this chain</div>
        <p className="text-xs text-amber-300/80">
          Switch your wallet to a supported network to create DCA orders.
        </p>
      </div>
    );
  }

  return <CreateDcaFormInner enabled={enabled} chainId={chainId} tokens={tokens} />;
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

  const [form, setForm] = useState<FormState>({
    tokenIn: tokens[0].address,
    tokenOut: tokens[1].address,
    amountPerSliceHuman: '10',
    intervalKey: 'daily',
    durationKey: '3m',
    slippagePct: 0.5,
    floorTolerancePct: 25,
  });

  const tokenIn = findToken(chainId, form.tokenIn)!;
  const tokenOut = findToken(chainId, form.tokenOut)!;
  const approval = useTokenApproval(form.tokenIn);
  const balance = useTokenBalance(form.tokenIn);
  // Current market price (tokenOut human per 1 tokenIn human, scaled 1e18).
  // LIMIT_SELL orientation matches "I send tokenIn, receive tokenOut" so the
  // returned price is in the same direction as the contract's minPriceScaled.
  const market = useMarketPrice('LIMIT_SELL', form.tokenIn, form.tokenOut);

  // ─── Derived schedule ─────────────────────────────────────────
  const intervalSec = INTERVAL_SEC[form.intervalKey];
  const durationSec = DURATION_SEC[form.durationKey];
  const numSlices = durationSec === 0 ? 0 : Math.floor(durationSec / intervalSec);

  const amountInRaw = (() => {
    try {
      return parseUnits(form.amountPerSliceHuman, tokenIn.decimals);
    } catch {
      return 0n;
    }
  })();
  const totalAmountHuman =
    numSlices === 0
      ? 'unbounded'
      : `${(Number(form.amountPerSliceHuman) * numSlices).toFixed(2)} ${tokenIn.symbol}`;

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
  const orientRaw = classifyPair(tokenIn.symbol, tokenOut.symbol);
  const floorRaw = computeFloor({
    currentPriceScaled: market.priceScaled,
    tolerancePct: form.floorTolerancePct,
    side: orientRaw.side,
  });
  const minPriceScaled = floorRaw.minPriceScaled; // signing math always uses raw
  // Display-only flip (purely cosmetic). Useful when the user prefers
  // reading the price in the other token's units for an exotic pair.
  const [displayFlipped, setDisplayFlipped] = useState(false);
  // Custom panel reveals the granular slippage + floor inputs. Hidden
  // by default so first-time users see just the three macro modes;
  // power users open it to tune individual knobs.
  const [showCustom, setShowCustom] = useState(false);
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
    setShowCustom(false);
  };
  const displayed = displayFlipped
    ? flipDisplay(orientRaw, floorRaw)
    : { orient: orientRaw, floor: floorRaw };
  const orient = displayed.orient;
  const floor = displayed.floor;

  // ─── Validation ───────────────────────────────────────────────
  const validationError = (() => {
    if (!enabled) return 'Sign-in to continue';
    if (form.tokenIn === form.tokenOut) return 'Same token in and out';
    if (amountInRaw === 0n) return 'Amount must be > 0';
    // Refuse slices the keeper can't profitably execute during gas
    // spikes (see MIN_SLICE_USD docstring). Only enforce when we have
    // a USD anchor; for exotic pairs we skip and let the keeper's
    // per-slice break-even check be the gate.
    if (sliceUsd !== null && sliceUsd < MIN_SLICE_USD) {
      return `Slice too small (~$${sliceUsd.toFixed(2)}). Minimum is $${MIN_SLICE_USD}.`;
    }
    if (
      enabled &&
      !balance.isLoading &&
      amountInRaw > balance.balance
    ) {
      return `Insufficient ${tokenIn.symbol} per slice`;
    }
    return null;
  })();

  const showApprove =
    enabled && !validationError && approval.needsApproval(amountInRaw);
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
      endTime: durationSec === 0 ? 0 : now + durationSec,
      maxSlices: numSlices, // 0 if forever
      maxSlippageBps: Math.round(form.slippagePct * 100),
      minPriceScaled,
      feeBps,
      // Signature stays valid for the order's duration + 30 days buffer.
      // Open-ended orders default to 365 days (re-sign annually).
      signatureValidityDays: durationSec === 0 ? 365 : Math.ceil(durationSec / 86400) + 30,
    });
    if (created) toast.success(`DCA order created — first slice in ~30s`);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
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
            <span className="text-xs text-slate-400 whitespace-nowrap">
              Bal:{' '}
              <span className="font-mono text-slate-300">
                {balance.isLoading
                  ? '…'
                  : Number(formatUnits(balance.balance, tokenIn.decimals)).toFixed(4)}
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
          { value: 'forever', label: 'forever (until I cancel)' },
          { value: '1m', label: '1 month' },
          { value: '3m', label: '3 months' },
          { value: '6m', label: '6 months' },
          { value: '1y', label: '1 year' },
        ]}
      />

      {/* Execution mode picker — three macro presets bundling slippage +
          floor. "Custom" reveals the granular knobs below for power users. */}
      <div>
        <Label>Execution mode</Label>
        <div className="grid grid-cols-4 gap-2">
          {(['safe', 'balanced', 'turbo'] as const).map((m) => {
            const meta = MODE_LABELS[m];
            const isActive = activeMode === m && !showCustom;
            return (
              <button
                type="button"
                key={m}
                onClick={() => applyMode(m)}
                disabled={!enabled}
                title={meta.tagline}
                className={`rounded-lg border px-2 py-2 text-xs disabled:opacity-50 ${
                  isActive
                    ? 'border-cyan-500 bg-cyan-500/15 text-cyan-200'
                    : 'border-slate-800 bg-slate-950 text-slate-300 hover:bg-slate-900'
                }`}
              >
                <div>{meta.emoji} {meta.name}</div>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setShowCustom((v) => !v)}
            disabled={!enabled}
            className={`rounded-lg border px-2 py-2 text-xs disabled:opacity-50 ${
              showCustom || activeMode === 'custom'
                ? 'border-cyan-500 bg-cyan-500/15 text-cyan-200'
                : 'border-slate-800 bg-slate-950 text-slate-300 hover:bg-slate-900'
            }`}
          >
            <div>⚙️ Custom</div>
          </button>
        </div>
      </div>

      {(showCustom || activeMode === 'custom') && (
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
                className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-1.5 pr-7 font-mono text-xs text-slate-100 disabled:opacity-50"
              />
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-400">%</span>
            </div>
          </div>
        </div>
      )}

      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <Label>
            {orientRaw.assetSym
              ? `Stop if 1 ${orientRaw.assetSym} rises by more than`
              : 'Stop if price rises by more than'}
          </Label>
          {orientRaw.side === 'unknown' && (
            <span className="text-xs text-slate-400">N/A — stable pair</span>
          )}
        </div>
        {(showCustom || activeMode === 'custom') && (
          <div className="flex items-center gap-2">
            {[0, 5, 25, 100].map((p) => (
              <button
                type="button"
                key={p}
                onClick={() => setForm({ ...form, floorTolerancePct: p })}
                disabled={!enabled || orientRaw.side === 'unknown'}
                className={`rounded-lg border px-2 py-1 text-xs disabled:opacity-50 ${
                  form.floorTolerancePct === p
                    ? 'border-cyan-500 bg-cyan-500/15 text-cyan-200'
                    : 'border-slate-800 bg-slate-950 text-slate-300'
                }`}
              >
                {p === 0 ? 'off' : `+${p}%`}
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
                disabled={!enabled || orientRaw.side === 'unknown'}
                className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-1.5 pr-7 font-mono text-xs text-slate-100 disabled:opacity-50"
              />
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-400">%</span>
            </div>
          </div>
        )}
        {floor.currentAssetPrice !== null && orient.assetSym && orient.quoteSym && (
          <button
            type="button"
            onClick={() => setDisplayFlipped((v) => !v)}
            title="Click to flip quoting direction (display only — does not change the signed floor)"
            className="mt-1 block text-left text-xs text-slate-400 hover:text-slate-300"
          >
            Now: <span className="font-mono text-slate-400">1 {orient.assetSym} ≈{' '}
              {formatAssetPrice(floor.currentAssetPrice)} {orient.quoteSym}</span>
            {floor.thresholdAssetPrice !== null && (
              <>
                {' '}· Stop if{' '}
                <span className="font-mono text-amber-300">
                  1 {orient.assetSym}{' '}
                  {orient.side === 'buy' ? '>' : '<'}{' '}
                  {formatAssetPrice(floor.thresholdAssetPrice)} {orient.quoteSym}
                </span>
              </>
            )}
            <span className="ml-1 text-slate-500">⇄</span>
          </button>
        )}
        {form.floorTolerancePct !== 0 && orientRaw.side !== 'unknown' && !market.priceScaled && (
          <div className="mt-1 text-xs text-amber-400">
            Loading quote… floor will be set when price loads.
          </div>
        )}
      </div>

      <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-400 space-y-1">
        <div className="text-slate-200 font-medium">Preview</div>
        <div>
          {numSlices === 0
            ? `Every ${form.intervalKey.replace('ly', '')} until you cancel`
            : `${numSlices} ${form.intervalKey} swaps`}
        </div>
        <div>
          Per swap: {form.amountPerSliceHuman} {tokenIn.symbol} → {tokenOut.symbol}
        </div>
        <div>Total sent over period: {totalAmountHuman}</div>
        <div className="flex items-baseline justify-between gap-2">
          <span>
            Fee per swap:{' '}
            <span className="font-mono text-slate-300">{(feeBps / 100).toFixed(2)}%</span>
          </span>
          <span className={`rounded border px-2 py-0.5 text-xs ${tier.badge}`}>
            {tier.name}
            {sliceUsd !== null && (
              <span className="ml-1 font-mono text-xs opacity-75">
                ~${sliceUsd.toFixed(2)}/slice
              </span>
            )}
          </span>
        </div>
        <div className="text-slate-400">
          First swap: ~30s after submit. Keeper handles the rest automatically.
        </div>
      </div>

      {error && (
        <div className="rounded border border-rose-900/50 bg-rose-950/40 p-2 text-xs text-rose-300">
          {error}
        </div>
      )}

      {showApprove ? (
        <button
          type="button"
          onClick={() => void approval.approve().catch(() => {})}
          disabled={approval.isApproving}
          className="w-full rounded-lg bg-amber-500 px-4 py-2.5 text-sm font-medium text-slate-950 hover:bg-amber-400 disabled:opacity-50"
        >
          {approval.isApproving
            ? `Approving ${tokenIn.symbol}…`
            : `1. Approve ${tokenIn.symbol}`}
        </button>
      ) : (
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
      )}
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
