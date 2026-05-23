/**
 * TWAP tab — execute a large total amount over a bounded window in
 * regular slices. Targets the volume-weighted average price across the
 * window, minimizing market impact vs a single fat swap.
 *
 * Sister of CreateDcaForm — same backend, bounded defaults instead of
 * open-ended. User specifies total + window; we derive slices.
 */

import { useState } from 'react';
import { useChainId } from 'wagmi';
import toast from 'react-hot-toast';
import { parseUnits, formatUnits } from '@polyorder/shared';
import { useCreateScheduledOrder } from '../hooks/useCreateScheduledOrder';
import { useTokenApproval } from '../hooks/useTokenApproval';
import { useTokenBalance } from '../hooks/useTokenBalance';
import { useMarketPrice } from '../hooks/useMarketPrice';
import { getTokens, findToken } from '../lib/tokens';
import { classifyPair, computeFloor, flipDisplay, formatAssetPrice } from '../lib/priceFloor';

interface Props {
  enabled: boolean;
}

interface FormState {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  totalAmountHuman: string;
  windowKey: '15m' | '1h' | '4h' | '8h' | '24h';
  slices: number;
  slippagePct: number;
  /**
   * Tolerance for the maker-signed hard price floor — % the asset price
   * may drop (when selling) or rise (when buying) from current before
   * the contract refuses the slice. Tight defaults for TWAP since
   * windows are short and the market shouldn't move much.
   * Presets shortcut common values; the input accepts any positive %.
   */
  floorTolerancePct: number;
}

const WINDOW_SEC: Record<FormState['windowKey'], number> = {
  '15m': 900,
  '1h': 3600,
  '4h': 14_400,
  '8h': 28_800,
  '24h': 86_400,
};

const SLIPPAGE_PRESETS = [0.1, 0.5, 1, 2];

export function CreateTwapForm({ enabled }: Props) {
  const chainId = useChainId();
  const tokens = getTokens(chainId);

  if (tokens.length < 2) {
    return (
      <div className="rounded-xl border border-amber-900/50 bg-amber-950/30 p-4 text-sm text-amber-200">
        <div className="font-medium mb-1">No tokens configured for this chain</div>
        <p className="text-xs text-amber-300/80">
          Switch your wallet to a supported network to create TWAP orders.
        </p>
      </div>
    );
  }

  return <CreateTwapFormInner enabled={enabled} chainId={chainId} tokens={tokens} />;
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

  const [form, setForm] = useState<FormState>({
    tokenIn: tokens[0].address,
    tokenOut: tokens[1].address,
    totalAmountHuman: '1000',
    windowKey: '4h',
    slices: 20,
    slippagePct: 0.5,
    floorTolerancePct: 5,
  });

  const tokenIn = findToken(chainId, form.tokenIn)!;
  const tokenOut = findToken(chainId, form.tokenOut)!;
  const approval = useTokenApproval(form.tokenIn);
  const balance = useTokenBalance(form.tokenIn);
  const market = useMarketPrice('LIMIT_SELL', form.tokenIn, form.tokenOut);

  // ─── Derived schedule ─────────────────────────────────────────
  const windowSec = WINDOW_SEC[form.windowKey];
  // Contract enforces MIN_INTERVAL_SEC = 60s; if the user asks for
  // denser slicing we floor to 60s, but that also means fewer slices
  // can physically fit in the window before endTime. The signed
  // maxSlices stays at form.slices, the contract just stops firing
  // when the window ends — the extra slice slots silently expire.
  const idealInterval = form.slices > 0 ? Math.floor(windowSec / form.slices) : 0;
  const intervalClamped = idealInterval < 60 && form.slices > 1;
  const intervalSec = Math.max(60, idealInterval);
  // How many slices actually have time to fire before endTime, given
  // the clamped interval. When intervalClamped this is < form.slices.
  const effectiveSlices = Math.min(form.slices, Math.floor(windowSec / intervalSec));
  const totalAmountRaw = (() => {
    try {
      return parseUnits(form.totalAmountHuman, tokenIn.decimals);
    } catch {
      return 0n;
    }
  })();
  const amountPerSliceRaw =
    form.slices > 0 ? totalAmountRaw / BigInt(form.slices) : 0n;
  const amountPerSliceHuman =
    form.slices > 0
      ? (Number(form.totalAmountHuman) / form.slices).toFixed(4)
      : '0';

  const minutesBetween = Math.round(intervalSec / 60);

  const orientRaw = classifyPair(tokenIn.symbol, tokenOut.symbol);
  const floorRaw = computeFloor({
    currentPriceScaled: market.priceScaled,
    tolerancePct: form.floorTolerancePct,
    side: orientRaw.side,
  });
  const minPriceScaled = floorRaw.minPriceScaled; // signing math always uses raw
  const [displayFlipped, setDisplayFlipped] = useState(false);
  const displayed = displayFlipped
    ? flipDisplay(orientRaw, floorRaw)
    : { orient: orientRaw, floor: floorRaw };
  const orient = displayed.orient;
  const floor = displayed.floor;

  // ─── Validation ───────────────────────────────────────────────
  const validationError = (() => {
    if (!enabled) return 'Sign-in to continue';
    if (form.tokenIn === form.tokenOut) return 'Same token in and out';
    if (totalAmountRaw === 0n) return 'Total amount must be > 0';
    if (form.slices < 2) return 'TWAP needs at least 2 slices';
    if (intervalSec < 60) return 'Slices too dense (min 60s apart)';
    if (
      enabled &&
      !balance.isLoading &&
      totalAmountRaw > balance.balance
    ) {
      return `Insufficient ${tokenIn.symbol}`;
    }
    return null;
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
      endTime: now + windowSec + 60, // +60s buffer so last slice can fire
      maxSlices: form.slices,
      maxSlippageBps: Math.round(form.slippagePct * 100),
      minPriceScaled,
      feeBps: 30,
      signatureValidityDays: Math.ceil(windowSec / 86400) + 1, // window + 1d buffer
    });
    if (created) {
      toast.success(`TWAP order created — ${form.slices} slices over ${form.windowKey}`);
    }
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

      <div>
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
          <Label>Total {tokenIn.symbol} to send</Label>
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
          value={form.totalAmountHuman}
          onChange={(e) =>
            setForm({ ...form, totalAmountHuman: e.target.value })
          }
          disabled={!enabled}
          className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 disabled:opacity-50"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <SelectField
          label="Over"
          value={form.windowKey}
          onChange={(v) =>
            setForm({ ...form, windowKey: v as FormState['windowKey'] })
          }
          options={[
            { value: '15m', label: '15 minutes' },
            { value: '1h', label: '1 hour' },
            { value: '4h', label: '4 hours' },
            { value: '8h', label: '8 hours' },
            { value: '24h', label: '24 hours' },
          ]}
        />
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

      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <Label>
            {orientRaw.assetSym
              ? orientRaw.side === 'buy'
                ? `Stop if 1 ${orientRaw.assetSym} rises by more than`
                : `Stop if 1 ${orientRaw.assetSym} drops by more than`
              : 'Stop if price moves by more than'}
          </Label>
          {orientRaw.side === 'unknown' && (
            <span className="text-xs text-slate-400">N/A — stable pair</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {[0, 5, 10, 20].map((p) => (
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
              {p === 0 ? 'off' : orientRaw.side === 'buy' ? `+${p}%` : `−${p}%`}
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
          {effectiveSlices} swaps of ~{amountPerSliceHuman} {tokenIn.symbol} → {tokenOut.symbol}
        </div>
        <div>Every {minutesBetween} min for {form.windowKey}</div>
        {intervalClamped && (
          <div className="rounded border border-amber-900/50 bg-amber-950/30 p-2 text-amber-200">
            ⚠ Only {effectiveSlices} of {form.slices} slices fit — contract
            minimum is 60s between executions, so {form.windowKey} can hold
            at most {Math.floor(windowSec / 60)}. Reduce slices or extend the
            window to use all of them.
          </div>
        )}
        <div className="text-slate-400">
          Targets avg execution ≈ TWAP price over the window. Reduces market
          impact vs a single fat swap.
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
                : 'Sign & start TWAP'}
        </button>
      )}
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
