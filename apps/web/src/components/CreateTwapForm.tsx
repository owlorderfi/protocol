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
import { getTokens, findToken } from '../lib/tokens';

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
}

const WINDOW_SEC: Record<FormState['windowKey'], number> = {
  '15m': 900,
  '1h': 3600,
  '4h': 14_400,
  '8h': 28_800,
  '24h': 86_400,
};

const SLIPPAGE_PRESETS = [0.5, 1, 2];

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
    slippagePct: 1,
  });

  const tokenIn = findToken(chainId, form.tokenIn)!;
  // tokenOut is referenced via form.tokenOut in the dropdown + submit
  // payload; the form is symbol-driven so we don't need the info struct.
  const approval = useTokenApproval(form.tokenIn);
  const balance = useTokenBalance(form.tokenIn);

  // ─── Derived schedule ─────────────────────────────────────────
  const windowSec = WINDOW_SEC[form.windowKey];
  const intervalSec = Math.max(60, Math.floor(windowSec / form.slices));
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
      feeBps: 30,
      signatureValidityDays: Math.ceil(windowSec / 86400) + 1, // window + 1d buffer
    });
    if (created) {
      toast.success(`TWAP order created — ${form.slices} slices over ${form.windowKey}`);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <SelectField
          label="Sell"
          value={form.tokenIn}
          onChange={(v) => setForm({ ...form, tokenIn: v as `0x${string}` })}
          options={tokens.map((t) => ({ value: t.address, label: t.symbol }))}
        />
        <SelectField
          label="For"
          value={form.tokenOut}
          onChange={(v) => setForm({ ...form, tokenOut: v as `0x${string}` })}
          options={tokens.map((t) => ({ value: t.address, label: t.symbol }))}
        />
      </div>

      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <Label>Total {tokenIn.symbol} to sell</Label>
          <span className="text-[10px] text-slate-500">
            Balance:{' '}
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
            value={form.slices}
            onChange={(e) =>
              setForm({ ...form, slices: Math.max(2, Math.floor(Number(e.target.value))) })
            }
            disabled={!enabled}
            className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 disabled:opacity-50"
          />
        </div>
      </div>

      <div>
        <Label>Slippage tolerance per slice</Label>
        <div className="flex gap-2">
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
        </div>
      </div>

      <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-400 space-y-1">
        <div className="text-slate-200 font-medium">Preview</div>
        <div>
          {form.slices} swaps of ~{amountPerSliceHuman} {tokenIn.symbol} each
        </div>
        <div>Every {minutesBetween} min for {form.windowKey}</div>
        <div className="text-slate-500">
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
    <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
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
        className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none"
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
