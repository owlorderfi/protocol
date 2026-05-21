import { useState } from 'react';
import type { OrderType } from '@polyorder/shared';
import { useCreateOrder, type CreateOrderFormValues } from '../hooks/useCreateOrder';

// Demo tokens for Amoy — these don't need real liquidity since keeper runs in dry-run.
// Replace with a real token picker (TokenSelect + 1inch /tokens) for Phase 2.
const DEMO_TOKENS = [
  { symbol: 'USDC', address: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582', decimals: 6 },
  { symbol: 'WETH', address: '0xb0F8E96d52caC8c87bB7AE19a8A93a9bf67de10b', decimals: 18 },
];

const ORDER_TYPES: { value: OrderType; label: string; hint: string }[] = [
  { value: 'LIMIT_BUY', label: 'Limit Buy', hint: 'Trigger when tokenOut price ≤ trigger' },
  { value: 'LIMIT_SELL', label: 'Limit Sell', hint: 'Trigger when tokenIn price ≥ trigger' },
  { value: 'STOP_LOSS', label: 'Stop Loss', hint: 'Trigger when tokenIn price ≤ trigger' },
  { value: 'TAKE_PROFIT', label: 'Take Profit', hint: 'Trigger when tokenIn price ≥ trigger' },
];

interface Props {
  enabled: boolean;
}

export function CreateOrderForm({ enabled }: Props) {
  const { submit, isSubmitting, error } = useCreateOrder();
  const [success, setSuccess] = useState<string | null>(null);

  const [form, setForm] = useState<CreateOrderFormValues>({
    orderType: 'LIMIT_BUY',
    tokenIn: DEMO_TOKENS[0].address,
    tokenOut: DEMO_TOKENS[1].address,
    amountIn: '1000000', // 1 USDC (6 decimals)
    minAmountOut: '1',
    triggerPrice: '2000000000000000000000', // 2000 * 1e18
    deadlineHours: 24,
  });

  const onChange = (k: keyof CreateOrderFormValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const v = e.target.value;
    setForm((prev) => ({ ...prev, [k]: k === 'deadlineHours' ? Number(v) : v }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSuccess(null);
    const result = await submit(form);
    if (result) setSuccess(`Order created: ${result.id.slice(0, 8)}…`);
  };

  const inputClass =
    'w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none disabled:opacity-50';
  const labelClass = 'mb-1 block text-xs font-medium uppercase tracking-wider text-slate-400';

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/40 p-6"
    >
      <h2 className="text-lg font-semibold">Create Order</h2>

      <div>
        <label className={labelClass}>Order type</label>
        <select
          value={form.orderType}
          onChange={onChange('orderType')}
          disabled={!enabled || isSubmitting}
          className={inputClass}
        >
          {ORDER_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-slate-500">
          {ORDER_TYPES.find((t) => t.value === form.orderType)?.hint}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Token in</label>
          <select
            value={form.tokenIn}
            onChange={onChange('tokenIn')}
            disabled={!enabled || isSubmitting}
            className={inputClass}
          >
            {DEMO_TOKENS.map((t) => (
              <option key={t.address} value={t.address}>
                {t.symbol}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>Token out</label>
          <select
            value={form.tokenOut}
            onChange={onChange('tokenOut')}
            disabled={!enabled || isSubmitting}
            className={inputClass}
          >
            {DEMO_TOKENS.map((t) => (
              <option key={t.address} value={t.address}>
                {t.symbol}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Amount in (raw)</label>
          <input
            type="text"
            value={form.amountIn}
            onChange={onChange('amountIn')}
            disabled={!enabled || isSubmitting}
            placeholder="1000000"
            className={`${inputClass} font-mono`}
          />
        </div>
        <div>
          <label className={labelClass}>Min amount out (raw)</label>
          <input
            type="text"
            value={form.minAmountOut}
            onChange={onChange('minAmountOut')}
            disabled={!enabled || isSubmitting}
            placeholder="1"
            className={`${inputClass} font-mono`}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Trigger price × 1e18</label>
          <input
            type="text"
            value={form.triggerPrice}
            onChange={onChange('triggerPrice')}
            disabled={!enabled || isSubmitting}
            placeholder="2000000000000000000000"
            className={`${inputClass} font-mono`}
          />
        </div>
        <div>
          <label className={labelClass}>Valid for (hours)</label>
          <input
            type="number"
            min={1}
            max={720}
            value={form.deadlineHours}
            onChange={onChange('deadlineHours')}
            disabled={!enabled || isSubmitting}
            className={inputClass}
          />
        </div>
      </div>

      <button
        type="submit"
        disabled={!enabled || isSubmitting}
        className="w-full rounded-lg bg-cyan-500 px-4 py-2.5 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
      >
        {!enabled ? 'Sign-in first' : isSubmitting ? 'Signing + submitting…' : 'Sign & submit order'}
      </button>

      {error && (
        <div className="rounded-lg border border-rose-900/50 bg-rose-950/40 p-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      {success && (
        <div className="rounded-lg border border-emerald-900/50 bg-emerald-950/40 p-3 text-sm text-emerald-300">
          {success}
        </div>
      )}
    </form>
  );
}
