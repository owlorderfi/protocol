import { useState, useMemo } from 'react';
import toast from 'react-hot-toast';
import type { OrderType } from '@polyorder/shared';
import { parseUnits, formatUnits } from '@polyorder/shared';
import { useCreateOrder } from '../hooks/useCreateOrder';
import { useTokenApproval } from '../hooks/useTokenApproval';
import { useMarketPrice } from '../hooks/useMarketPrice';
import { useTokenBalance } from '../hooks/useTokenBalance';
import { useProtocolFee } from '../hooks/useProtocolFee';
import { usePoolTwap } from '../hooks/usePoolTwap';
import { tierForUsd, estimateOrderUsd } from '../lib/feeTiers';
import { suggestTriggerPrice, staticTriggerSuggestion } from '../lib/orderMath';
import { getTokens, findToken } from '../lib/tokens';
import { computeExpectedAmountOut, applySlippage } from '../lib/orderMath';
import { env } from '../lib/env';

const ORDER_TYPES: { value: OrderType; label: string; hint: string }[] = [
  { value: 'LIMIT_BUY', label: 'Limit Buy', hint: 'Buy tokenOut when price ≤ trigger' },
  { value: 'LIMIT_SELL', label: 'Limit Sell', hint: 'Sell tokenIn when price ≥ trigger' },
  { value: 'STOP_LOSS', label: 'Stop Loss', hint: 'Sell tokenIn when price ≤ trigger' },
  { value: 'TAKE_PROFIT', label: 'Take Profit', hint: 'Sell tokenIn when price ≥ trigger' },
];

const SLIPPAGE_PRESETS = [0.1, 0.5, 1, 2];

interface FormState {
  orderType: OrderType;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountInHuman: string;
  triggerPriceHuman: string;
  slippagePct: number;
  deadlineHours: number;
}

interface Props {
  enabled: boolean;
}

export function CreateOrderForm({ enabled }: Props) {
  const { submit, isSubmitting, error } = useCreateOrder();
  const [success, setSuccess] = useState<string | null>(null);

  const tokens = getTokens(env.chainId);

  const [form, setForm] = useState<FormState>({
    orderType: 'LIMIT_BUY',
    tokenIn: tokens[0].address,
    tokenOut: tokens[1].address,
    amountInHuman: '1',
    triggerPriceHuman: '2000',
    slippagePct: 0.5,
    deadlineHours: 24,
  });

  const tokenIn = findToken(env.chainId, form.tokenIn)!;
  const tokenOut = findToken(env.chainId, form.tokenOut)!;

  const approval = useTokenApproval(form.tokenIn);
  const market = useMarketPrice(form.orderType, form.tokenIn, form.tokenOut);
  const balance = useTokenBalance(form.tokenIn);
  const protocolFee = useProtocolFee();
  const history = usePoolTwap(form.orderType, form.tokenIn, form.tokenOut);

  const handleSuggest = () => {
    const suggested =
      suggestTriggerPrice({
        orderType: form.orderType,
        current: history.current,
        min: history.min,
        max: history.max,
        samples: history.samples,
      }) ?? (history.current !== null ? staticTriggerSuggestion(form.orderType, history.current) : null);
    if (suggested === null) return;
    setForm((f) => ({ ...f, triggerPriceHuman: formatUnits(suggested, 18) }));
  };

  // Encode + auto-derive minAmountOut from triggerPrice + slippage.
  // Returns { ...raw bigint strings } or { validationError }.
  const quote = useMemo(() => {
    try {
      const amountInRaw = parseUnits(form.amountInHuman, tokenIn.decimals);
      const triggerPriceScaled = parseUnits(form.triggerPriceHuman, 18);

      if (amountInRaw === 0n) return { validationError: 'Amount in must be > 0' };
      if (triggerPriceScaled === 0n) return { validationError: 'Trigger price must be > 0' };

      const expectedOut = computeExpectedAmountOut({
        orderType: form.orderType,
        amountInRaw,
        triggerPriceScaled,
        tokenInDecimals: tokenIn.decimals,
        tokenOutDecimals: tokenOut.decimals,
      });

      const minAmountOut = applySlippage(expectedOut, form.slippagePct);
      if (minAmountOut === 0n) return { validationError: 'Slippage too high or output rounds to 0' };

      return {
        amountIn: amountInRaw.toString(),
        minAmountOut: minAmountOut.toString(),
        triggerPrice: triggerPriceScaled.toString(),
        expectedOutHuman: formatUnits(expectedOut, tokenOut.decimals),
        minAmountOutHuman: formatUnits(minAmountOut, tokenOut.decimals),
      };
    } catch (err) {
      return { validationError: err instanceof Error ? err.message : 'Invalid number' };
    }
  }, [
    form.amountInHuman,
    form.triggerPriceHuman,
    form.slippagePct,
    form.orderType,
    tokenIn.decimals,
    tokenOut.decimals,
  ]);

  const onChange = <K extends keyof FormState>(k: K) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const v = e.target.value;
    setForm((prev) => ({
      ...prev,
      [k]: k === 'deadlineHours' || k === 'slippagePct' ? Number(v) : v,
    } as FormState));
  };

  const flipTokens = () => {
    setForm((prev) => ({ ...prev, tokenIn: prev.tokenOut, tokenOut: prev.tokenIn }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSuccess(null);
    if ('validationError' in quote) return;

    const result = await submit({
      orderType: form.orderType,
      tokenIn: form.tokenIn,
      tokenOut: form.tokenOut,
      amountIn: quote.amountIn,
      minAmountOut: quote.minAmountOut,
      triggerPrice: quote.triggerPrice,
      deadlineHours: form.deadlineHours,
    });
    if (result) {
      const shortId = result.id.slice(0, 8);
      setSuccess(`Order created: ${shortId}…`);
      toast.success(`Order ${shortId}… submitted`);
      // Clear the amount so an accidental double-click can't create a duplicate.
      // Other fields (pair, trigger, slippage) stay so the user can quickly stack
      // similar orders by just typing a new amount.
      setForm((f) => ({ ...f, amountInHuman: '' }));
    } else if (error) {
      toast.error(error);
    }
  };

  const inputClass =
    'w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none disabled:opacity-50';
  const labelClass = 'mb-1 block text-xs font-medium uppercase tracking-wider text-slate-400';

  const formDisabled = !enabled || isSubmitting;
  const validationError = 'validationError' in quote ? quote.validationError : null;

  // Approval status — only relevant once we have a valid amount
  const amountInRaw = 'amountIn' in quote && typeof quote.amountIn === 'string'
    ? BigInt(quote.amountIn)
    : 0n;
  const showApprove = enabled && !validationError && approval.needsApproval(amountInRaw);

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/40 p-6"
    >
      <h2 className="text-lg font-semibold">Create Order</h2>

      {/* Order type */}
      <div>
        <label className={labelClass}>Order type</label>
        <select value={form.orderType} onChange={onChange('orderType')} disabled={formDisabled} className={inputClass}>
          {ORDER_TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        <p className="mt-1 text-xs text-slate-500">
          {ORDER_TYPES.find((t) => t.value === form.orderType)?.hint}
        </p>
      </div>

      {/* Pair selection with flip */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
        <div>
          <label className={labelClass}>You pay</label>
          <select value={form.tokenIn} onChange={onChange('tokenIn')} disabled={formDisabled} className={inputClass}>
            {tokens.map((t) => <option key={t.address} value={t.address}>{t.symbol}</option>)}
          </select>
        </div>
        <button
          type="button"
          onClick={flipTokens}
          disabled={formDisabled}
          className="mb-1 rounded-lg border border-slate-700 px-2 py-1.5 text-slate-300 hover:bg-slate-800 disabled:opacity-50"
          title="Swap direction"
        >
          ⇄
        </button>
        <div>
          <label className={labelClass}>You receive</label>
          <select value={form.tokenOut} onChange={onChange('tokenOut')} disabled={formDisabled} className={inputClass}>
            {tokens.map((t) => <option key={t.address} value={t.address}>{t.symbol}</option>)}
          </select>
        </div>
      </div>

      {/* Amount in */}
      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <label className={labelClass + ' mb-0'}>Amount in</label>
          {balance.balance > 0n && (
            <button
              type="button"
              onClick={() =>
                setForm((f) => ({
                  ...f,
                  amountInHuman: formatUnits(balance.balance, tokenIn.decimals),
                }))
              }
              disabled={formDisabled}
              className="text-xs text-slate-400 hover:text-cyan-300 disabled:opacity-50"
              title="Use full balance"
            >
              Balance:{' '}
              <span className="font-mono text-slate-200">
                {formatUnits(balance.balance, tokenIn.decimals)}
              </span>{' '}
              <span className="text-cyan-400">[Max]</span>
            </button>
          )}
        </div>
        <div className="relative">
          <input
            type="text"
            inputMode="decimal"
            value={form.amountInHuman}
            onChange={onChange('amountInHuman')}
            disabled={formDisabled}
            placeholder="0.0"
            className={`${inputClass} pr-16 font-mono`}
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-slate-400">
            {tokenIn.symbol}
          </span>
        </div>
      </div>

      {/* Trigger price — label + hint depend on order type semantics.
          LIMIT_BUY:   max amount of tokenIn to spend per 1 tokenOut       (e.g. max 2000 USDC per WETH)
          LIMIT_SELL:  min amount of tokenOut to receive per 1 tokenIn     (e.g. min 3000 USDC per WETH)
          STOP_LOSS:   sell when 1 tokenIn drops to this many tokenOut
          TAKE_PROFIT: sell when 1 tokenIn reaches this many tokenOut */}
      <div>
        {/* Market price ribbon — live, refreshes every 10s */}
        {market.priceScaled !== null && form.triggerPriceHuman && (() => {
          const marketHuman = parseFloat(formatUnits(market.priceScaled, 18));
          const trigger = parseFloat(form.triggerPriceHuman);
          const delta = ((marketHuman - trigger) / marketHuman) * 100;
          const wouldFireNow =
            form.orderType === 'LIMIT_BUY' || form.orderType === 'STOP_LOSS'
              ? marketHuman <= trigger
              : marketHuman >= trigger;
          return (
            <div className="mb-2 flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-1.5 text-xs">
              <span className="text-slate-400">
                Market: <span className="font-mono text-slate-200">{marketHuman.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
              </span>
              {wouldFireNow ? (
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 font-medium text-emerald-300">
                  Would fire now
                </span>
              ) : (
                <span className={delta > 0 ? 'text-amber-300' : 'text-cyan-300'}>
                  {delta > 0 ? '↓' : '↑'} {Math.abs(delta).toFixed(2)}% to trigger
                </span>
              )}
            </div>
          );
        })()}
        {market.isLoading && (
          <div className="mb-2 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-1.5 text-xs text-slate-500">
            Loading market price…
          </div>
        )}
        <div className="mb-1 flex items-baseline justify-between">
          <label className={labelClass + ' mb-0'}>
            {form.orderType === 'LIMIT_BUY'
              ? `Trigger price (max ${tokenIn.symbol} per ${tokenOut.symbol})`
              : `Trigger price (${tokenOut.symbol} per ${tokenIn.symbol})`}
          </label>
          <button
            type="button"
            onClick={handleSuggest}
            disabled={formDisabled || market.priceScaled === null}
            title={
              history.samples >= 2
                ? 'Suggests a price slightly past the recent 60s TWAP range — likely to hit again soon.'
                : 'Loading 60s TWAP from Uniswap V3 pool…'
            }
            className="text-xs text-slate-400 hover:text-cyan-300 disabled:opacity-50"
          >
            ✨ <span className="text-cyan-400">Suggest</span>
          </button>
        </div>
        <input
          type="text"
          inputMode="decimal"
          value={form.triggerPriceHuman}
          onChange={onChange('triggerPriceHuman')}
          disabled={formDisabled}
          placeholder="2000"
          className={`${inputClass} font-mono`}
        />
        <p className="mt-1 text-xs text-slate-500">
          {form.orderType === 'LIMIT_BUY' &&
            `Execute when 1 ${tokenOut.symbol} costs at most ${form.triggerPriceHuman || '?'} ${tokenIn.symbol}`}
          {form.orderType === 'LIMIT_SELL' &&
            `Execute when 1 ${tokenIn.symbol} fetches at least ${form.triggerPriceHuman || '?'} ${tokenOut.symbol}`}
          {form.orderType === 'STOP_LOSS' &&
            `Execute when 1 ${tokenIn.symbol} drops to ${form.triggerPriceHuman || '?'} ${tokenOut.symbol} or lower`}
          {form.orderType === 'TAKE_PROFIT' &&
            `Execute when 1 ${tokenIn.symbol} reaches ${form.triggerPriceHuman || '?'} ${tokenOut.symbol} or higher`}
        </p>
      </div>

      {/* Slippage tolerance */}
      <div>
        <label className={labelClass}>Slippage tolerance</label>
        <div className="flex items-center gap-2">
          {SLIPPAGE_PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setForm((f) => ({ ...f, slippagePct: p }))}
              disabled={formDisabled}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                form.slippagePct === p
                  ? 'border-cyan-500 bg-cyan-500/15 text-cyan-300'
                  : 'border-slate-700 text-slate-400 hover:bg-slate-800'
              } disabled:opacity-50`}
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
              onChange={onChange('slippagePct')}
              disabled={formDisabled}
              className={`${inputClass} pr-8 font-mono`}
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">%</span>
          </div>
        </div>
      </div>

      {/* Quote summary */}
      {!validationError && 'minAmountOutHuman' in quote && (() => {
        const orderUsd = estimateOrderUsd({
          amountInHuman: form.amountInHuman,
          tokenInSymbol: tokenIn.symbol,
        });
        const tier = orderUsd !== null ? tierForUsd(orderUsd) : null;
        return (
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-sm">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs uppercase tracking-wider text-slate-500">Quote at trigger</span>
              {tier && (
                <span
                  className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${tier.badge}`}
                  title={`Display only — contract still charges ${protocolFee.feePct ?? '?'}% today. Per-tier pricing ships in Phase 5a.`}
                >
                  {tier.name}
                </span>
              )}
            </div>
            <div className="flex justify-between font-mono text-xs">
              <span className="text-slate-400">Expected out</span>
              <span className="text-slate-200">~{quote.expectedOutHuman} {tokenOut.symbol}</span>
            </div>
            <div className="flex justify-between font-mono text-xs">
              <span className="text-slate-400">Min received ({form.slippagePct}% slip)</span>
              <span className="text-emerald-300">≥ {quote.minAmountOutHuman} {tokenOut.symbol}</span>
            </div>
            {protocolFee.feePct !== null && (
              <div className="flex justify-between font-mono text-xs">
                <span className="text-slate-400">Protocol fee</span>
                <span className="text-slate-300">{protocolFee.feePct}%</span>
              </div>
            )}
          </div>
        );
      })()}

      {/* Deadline */}
      <div>
        <label className={labelClass}>Valid for (hours)</label>
        <input
          type="number"
          min={1}
          max={720}
          value={form.deadlineHours}
          onChange={onChange('deadlineHours')}
          disabled={formDisabled}
          className={inputClass}
        />
      </div>

      {showApprove ? (
        <button
          type="button"
          onClick={() => {
            // Errors (user reject, network) surface via approval.approveError.
            // Swallow the rejected promise here so the browser doesn't log
            // "Uncaught (in promise)" — the hook's writeError state already
            // captures it for display below.
            void approval.approve().catch(() => {});
          }}
          disabled={approval.isApproving}
          className="w-full rounded-lg bg-amber-500 px-4 py-2.5 text-sm font-medium text-slate-950 hover:bg-amber-400 disabled:opacity-50"
        >
          {approval.isApproving ? `Approving ${tokenIn.symbol}…` : `1. Approve ${tokenIn.symbol}`}
        </button>
      ) : (
        <button
          type="submit"
          disabled={formDisabled || validationError !== null}
          className="w-full rounded-lg bg-cyan-500 px-4 py-2.5 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
        >
          {!enabled
            ? 'Sign-in first'
            : isSubmitting
              ? 'Signing + submitting…'
              : validationError
                ? 'Fix inputs above'
                : approval.allowance > 0n
                  ? 'Sign & submit order'
                  : 'Sign & submit order'}
        </button>
      )}

      {approval.approveError && (
        <div className="rounded-lg border border-rose-900/50 bg-rose-950/40 p-3 text-sm text-rose-300">
          Approval error: {approval.approveError}
        </div>
      )}

      {validationError && (
        <div className="rounded-lg border border-amber-900/50 bg-amber-950/40 p-3 text-sm text-amber-300">
          {validationError}
        </div>
      )}

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
