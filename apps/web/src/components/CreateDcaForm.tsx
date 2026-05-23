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
import { parseUnits } from '@polyorder/shared';
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
  amountPerSliceHuman: string;
  intervalKey: 'hourly' | 'daily' | 'weekly' | 'monthly';
  durationKey: 'forever' | '1m' | '3m' | '6m' | '1y';
  slippagePct: number;
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

const SLIPPAGE_PRESETS = [0.5, 1, 2];

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
    slippagePct: 1,
  });

  const tokenIn = findToken(chainId, form.tokenIn)!;
  const tokenOut = findToken(chainId, form.tokenOut)!;
  const approval = useTokenApproval(form.tokenIn);
  const balance = useTokenBalance(form.tokenIn);

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

  // ─── Validation ───────────────────────────────────────────────
  const validationError = (() => {
    if (!enabled) return 'Sign-in to continue';
    if (form.tokenIn === form.tokenOut) return 'Same token in and out';
    if (amountInRaw === 0n) return 'Amount must be > 0';
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
      feeBps: 30, // default tier
      // Signature stays valid for the order's duration + 30 days buffer.
      // Open-ended orders default to 365 days (re-sign annually).
      signatureValidityDays: durationSec === 0 ? 365 : Math.ceil(durationSec / 86400) + 30,
    });
    if (created) toast.success(`DCA order created — first slice in ~30s`);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <SelectField
          label="Buy"
          value={form.tokenOut}
          onChange={(v) => setForm({ ...form, tokenOut: v as `0x${string}` })}
          options={tokens.map((t) => ({ value: t.address, label: t.symbol }))}
        />
        <SelectField
          label="With"
          value={form.tokenIn}
          onChange={(v) => setForm({ ...form, tokenIn: v as `0x${string}` })}
          options={tokens.map((t) => ({ value: t.address, label: t.symbol }))}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Amount per buy</Label>
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
          {numSlices === 0
            ? `Every ${form.intervalKey.replace('ly', '')} until you cancel`
            : `${numSlices} ${form.intervalKey} buys`}
        </div>
        <div>
          Per buy: {form.amountPerSliceHuman} {tokenIn.symbol} → {tokenOut.symbol}
        </div>
        <div>Total spend over period: {totalAmountHuman}</div>
        <div className="text-slate-500">
          First buy: ~30s after submit. Keeper handles the rest automatically.
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
