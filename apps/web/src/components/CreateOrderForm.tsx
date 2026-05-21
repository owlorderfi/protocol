import { useState, useMemo, useEffect } from 'react';
import toast from 'react-hot-toast';
import type { OrderType } from '@polyorder/shared';
import { parseUnits, formatUnits } from '@polyorder/shared';
import { useCreateOrder } from '../hooks/useCreateOrder';
import { useTokenApproval } from '../hooks/useTokenApproval';
import { useMarketPrice } from '../hooks/useMarketPrice';
import { useTokenBalance } from '../hooks/useTokenBalance';
import { usePoolTwap } from '../hooks/usePoolTwap';
import { FEE_TIERS, tierForUsd, estimateOrderUsd } from '../lib/feeTiers';
import {
  smartSuggestTrigger,
  staticTriggerSuggestion,
  computeFillProbability,
  type Aggressiveness,
  type Horizon,
} from '../lib/orderMath';
import { getTokens, findToken } from '../lib/tokens';
import { computeExpectedAmountOut, applySlippage } from '../lib/orderMath';
import { env } from '../lib/env';

// In DeFi every order is a swap (tokenIn → tokenOut) — "buy" and "sell"
// are TradFi framing. We collapse the 4 OrderType enum values to 2 trigger
// directions: ≤ trigger and ≥ trigger. The user picks the pair direction
// separately. Backend still receives LIMIT_BUY/LIMIT_SELL (STOP_LOSS and
// TAKE_PROFIT are unused from the new UI but the contract keeps supporting
// them for backwards compatibility).
const TRIGGER_DIRECTIONS: { value: OrderType; label: string }[] = [
  { value: 'LIMIT_BUY',  label: 'When price ≤ trigger' },
  { value: 'LIMIT_SELL', label: 'When price ≥ trigger' },
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
  const market = useMarketPrice(form.tokenIn, form.tokenOut);
  const balance = useTokenBalance(form.tokenIn);
  const twap = usePoolTwap(form.tokenIn, form.tokenOut);

  // Tier + per-order feeBps driven by USD value of the order. Non-stable
  // tokenIn returns null → fall back to the Default tier (30 bps).
  const orderUsd = estimateOrderUsd({
    amountInHuman: form.amountInHuman,
    tokenInSymbol: tokenIn.symbol,
  });
  const tier = orderUsd !== null ? tierForUsd(orderUsd) : FEE_TIERS[0];
  const feeBps = tier.targetBps;

  // Default to Tight + 30s — a slightly-better-than-market trigger over a
  // short horizon. Editing the trigger field manually clears `aggressiveness`
  // so the auto-recompute effect stops fighting the user.
  const [aggressiveness, setAggressiveness] = useState<Aggressiveness | null>('tight');
  const [horizon, setHorizon] = useState<Horizon>(30);

  // Trim 18-decimal scaled bigint to a sensible 6-decimal display string.
  // 6 decimals is more than enough for any pool price; 18 just looks like noise.
  const priceToShortHuman = (priceScaled: bigint): string => {
    return (Number(priceScaled) / 1e18).toFixed(6);
  };

  // Invert a human-readable trigger price for the flipped pair direction:
  // "2108" (USDC per WETH) → "0.000474" (WETH per USDC). toPrecision(6) keeps
  // 6 significant digits, which works cleanly across both magnitudes.
  const invertTriggerHuman = (value: string): string => {
    const n = parseFloat(value);
    if (!Number.isFinite(n) || n <= 0) return '';
    return parseFloat((1 / n).toPrecision(6)).toString();
  };

  // Recompute the suggested trigger from explicit inputs. Avoids any closure
  // capture on form state so the value used here is always exactly what the
  // caller intends, not what the last render happened to bind.
  const recomputeSuggestion = (
    aggro: Aggressiveness,
    h: Horizon,
    orderType: OrderType,
  ) => {
    if (market.priceScaled === null) return;
    if (twap.sigma30s !== null && twap.sigma30s > 0) {
      const result = smartSuggestTrigger({
        orderType,
        current: market.priceScaled,
        sigma30s: twap.sigma30s,
        trendPct: twap.trendPct ?? 0,
        aggressiveness: aggro,
        horizonSec: h,
      });
      setForm((f) => ({ ...f, triggerPriceHuman: priceToShortHuman(result.priceScaled) }));
    } else {
      const fallback = staticTriggerSuggestion(orderType, market.priceScaled);
      setForm((f) => ({ ...f, triggerPriceHuman: priceToShortHuman(fallback) }));
    }
  };

  const handleSuggest = (aggro: Aggressiveness) => {
    setAggressiveness(aggro);
    recomputeSuggestion(aggro, horizon, form.orderType);
  };

  const handleHorizonChange = (h: Horizon) => {
    setHorizon(h);
    // If a suggestion was active, regenerate with the new horizon so the
    // displayed trigger stays consistent with what the pills mean.
    if (aggressiveness !== null) recomputeSuggestion(aggressiveness, h, form.orderType);
  };

  // Auto-recompute the trigger price when the swap direction or pair flips
  // (or when market/σ becomes available on first load), as long as a pill is
  // still selected. Manual edits set aggressiveness=null and pause this.
  useEffect(() => {
    if (aggressiveness === null) return;
    if (market.priceScaled === null) return;
    recomputeSuggestion(aggressiveness, horizon, form.orderType);
    // recomputeSuggestion is defined inline above; we deliberately depend on
    // the inputs that drive its output, not on the function identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.orderType, form.tokenIn, form.tokenOut, market.priceScaled, twap.sigma30s, twap.trendPct]);

  const liveFillProb = useMemo(() => {
    if (market.priceScaled === null || twap.sigma30s === null) return null;
    const triggerNum = parseFloat(form.triggerPriceHuman);
    if (!triggerNum || Number.isNaN(triggerNum)) return null;
    return computeFillProbability({
      orderType: form.orderType,
      currentScaled: market.priceScaled, // spot, matches the market ribbon
      triggerPriceHuman: triggerNum,
      sigma30s: twap.sigma30s,
      trendPct: twap.trendPct ?? 0,
      horizonSec: horizon,
    });
  }, [market.priceScaled, twap.sigma30s, twap.trendPct, form.triggerPriceHuman, form.orderType, horizon]);

  // Encode + auto-derive minAmountOut from triggerPrice + slippage.
  // Returns { ...raw bigint strings } or { validationError }.
  const quote = useMemo(() => {
    // Empty inputs are the expected state right after auto-flip or initial
    // mount — surface a friendly prompt instead of letting parseUnits throw
    // 'Invalid numeric string: ""'.
    if (form.amountInHuman.trim() === '') return { validationError: 'Enter an amount' };
    if (form.triggerPriceHuman.trim() === '') return { validationError: 'Enter a trigger price' };

    try {
      const amountInRaw = parseUnits(form.amountInHuman, tokenIn.decimals);
      const triggerPriceScaled = parseUnits(form.triggerPriceHuman, 18);

      if (amountInRaw === 0n) return { validationError: 'Amount in must be > 0' };
      if (triggerPriceScaled === 0n) return { validationError: 'Trigger price must be > 0' };

      const expectedOut = computeExpectedAmountOut({
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
    // Changing the direction is a meaningful intent: re-engage Tight so the
    // trigger gets a fresh σ-aware suggestion for the new comparison side.
    // Without this, a prior manual edit (which clears the pill) would keep
    // the stale value when the user picks ≤ / ≥.
    if (k === 'orderType') {
      const newType = v as OrderType;
      setAggressiveness('tight');
      recomputeSuggestion('tight', horizon, newType);
    }
  };

  const flipTokens = () => {
    // Flip the pair. If a suggest pill is active, the auto-recompute effect
    // will replace the trigger with a fresh σ-aware suggestion for the new
    // direction. If not, fall back to a deterministic 1/x inversion so the
    // user's manual value isn't lost.
    setForm((prev) => ({
      ...prev,
      tokenIn: prev.tokenOut,
      tokenOut: prev.tokenIn,
      triggerPriceHuman: aggressiveness !== null
        ? prev.triggerPriceHuman
        : invertTriggerHuman(prev.triggerPriceHuman),
    }));
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
      feeBps,
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

      {/* Swap direction (trigger comparison) */}
      <div>
        <label className={labelClass}>Swap when</label>
        <select value={form.orderType} onChange={onChange('orderType')} disabled={formDisabled} className={inputClass}>
          {TRIGGER_DIRECTIONS.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        <p className="mt-1 text-xs text-slate-500">
          {form.orderType === 'LIMIT_BUY'
            ? `Execute when 1 ${tokenOut.symbol} becomes cheap enough (≤ trigger ${tokenIn.symbol})`
            : `Execute when 1 ${tokenOut.symbol} becomes expensive enough (≥ trigger ${tokenIn.symbol})`}
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

      {/* Trigger price — units are always tokenIn per tokenOut, regardless
          of the comparison direction. Hint and "would fire" wording change
          but the unit (e.g. USDC per WETH for USDC→WETH) stays the same. */}
      <div>
        {/* Market price ribbon — live, refreshes every 10s */}
        {market.priceScaled !== null && form.triggerPriceHuman && (() => {
          const marketHuman = parseFloat(formatUnits(market.priceScaled, 18));
          const trigger = parseFloat(form.triggerPriceHuman);
          const delta = ((marketHuman - trigger) / marketHuman) * 100;
          const wouldFireNow =
            form.orderType === 'LIMIT_BUY'
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
        <label className={labelClass}>
          Trigger price ({tokenIn.symbol} per {tokenOut.symbol})
        </label>
        <input
          type="text"
          inputMode="decimal"
          value={form.triggerPriceHuman}
          onChange={(e) => {
            setAggressiveness(null); // deselect Tight/Balanced/Patient on manual edit
            setForm((f) => ({ ...f, triggerPriceHuman: e.target.value }));
          }}
          disabled={formDisabled}
          placeholder="2000"
          className={`${inputClass} font-mono`}
        />
        <p className="mt-1 text-xs text-slate-500">
          {form.orderType === 'LIMIT_BUY'
            ? `Execute when 1 ${tokenOut.symbol} costs ≤ ${form.triggerPriceHuman || '?'} ${tokenIn.symbol}`
            : `Execute when 1 ${tokenOut.symbol} costs ≥ ${form.triggerPriceHuman || '?'} ${tokenIn.symbol}`}
        </p>

        {/* Smart trigger suggestion (v2 — σ + trend + horizon aware) */}
        <div className="mt-2 rounded-lg border border-slate-800 bg-slate-950/40 p-2.5">
          <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider text-slate-500">
            <span>✨ Smart suggest</span>
            {twap.trend && (() => {
              // Trend is always derived from the 5-min TWAP window. For
              // horizons > 5min we zero out drift, so the trend label is
              // shown dimmed to signal "informational only".
              const driftApplied = horizon <= 300;
              const colorClass = !driftApplied
                ? 'text-slate-600 line-through decoration-slate-700'
                : twap.trend === 'up'
                  ? 'text-cyan-300'
                  : twap.trend === 'down'
                    ? 'text-amber-300'
                    : 'text-slate-400';
              return (
                <span
                  className={colorClass}
                  title={
                    driftApplied
                      ? `5min trend: ${twap.trendPct?.toFixed(3) ?? '?'}% — applied to drift estimate`
                      : `5min trend: ${twap.trendPct?.toFixed(3) ?? '?'}% — IGNORED for ${horizon === 3600 ? '1h' : '1d'} horizon (don't extrapolate short trend to long horizons)`
                  }
                >
                  Trend (5m): {twap.trend === 'up' ? '↑ up' : twap.trend === 'down' ? '↓ down' : '— sideways'}
                </span>
              );
            })()}
          </div>

          {/* Horizon selector — how long the user is willing to wait */}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wider text-slate-500">Wait</span>
            {([30, 300, 3600, 86400] as Horizon[]).map((h) => (
              <button
                key={h}
                type="button"
                onClick={() => handleHorizonChange(h)}
                disabled={formDisabled || market.priceScaled === null}
                title={
                  h === 30
                    ? 'Next ~30 seconds — drift signal in use'
                    : h === 300
                      ? 'Next 5 minutes — drift signal in use'
                      : h === 3600
                        ? '1 hour — drift ignored (5-min trend doesn\'t extrapolate)'
                        : '1 day — drift ignored, pure σ scaling'
                }
                className={`rounded border px-2 py-0.5 text-xs transition ${
                  horizon === h
                    ? 'border-cyan-500 bg-cyan-500/15 text-cyan-300'
                    : 'border-slate-700 text-slate-400 hover:bg-slate-800'
                } disabled:opacity-50`}
              >
                {h === 30 ? '30s' : h === 300 ? '5m' : h === 3600 ? '1h' : '1d'}
              </button>
            ))}
          </div>

          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {(['tight', 'balanced', 'patient'] as Aggressiveness[]).map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => handleSuggest(a)}
                disabled={formDisabled || market.priceScaled === null}
                title={
                  a === 'tight'
                    ? '1×σ effective barrier — high probability, small discount'
                    : a === 'balanced'
                      ? '2×σ — medium probability, medium discount'
                      : '3×σ — low probability, bigger discount'
                }
                className={`rounded border px-2 py-1 text-xs transition ${
                  aggressiveness === a
                    ? 'border-cyan-500 bg-cyan-500/15 text-cyan-300'
                    : 'border-slate-700 text-slate-400 hover:bg-slate-800'
                } disabled:opacity-50`}
              >
                {a === 'tight' ? 'Tight (1σ)' : a === 'balanced' ? 'Balanced (2σ)' : 'Patient (3σ)'}
              </button>
            ))}
          </div>
          {liveFillProb && (
            <div className="mt-2 flex justify-between text-[11px] text-slate-400">
              <span>
                Offset:{' '}
                <span className="text-slate-200">
                  {liveFillProb.offsetPct === 0 ? '0%' : `${liveFillProb.offsetPct.toFixed(3)}%`}
                </span>
              </span>
              <span>
                Fill prob in {horizon === 30 ? '~30s' : horizon === 300 ? '5m' : horizon === 3600 ? '1h' : '1d'}:{' '}
                <span
                  className={
                    liveFillProb.probability >= 0.3
                      ? 'text-emerald-300'
                      : liveFillProb.probability >= 0.1
                        ? 'text-amber-300'
                        : 'text-rose-300'
                  }
                >
                  ~{Math.round(liveFillProb.probability * 100)}%
                </span>
              </span>
            </div>
          )}
          {twap.sigma30s !== null && (
            <div className="mt-1 text-[10px] text-slate-600">
              σ₃₀ₛ = {(twap.sigma30s * 100).toFixed(3)}% · samples: {twap.samples}
            </div>
          )}
        </div>
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
      {!validationError && 'minAmountOutHuman' in quote && (
        <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-sm">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs uppercase tracking-wider text-slate-500">Quote at trigger</span>
            <span
              className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${tier.badge}`}
              title={orderUsd === null
                ? 'USD value unknown for non-stable tokenIn — Default tier applied.'
                : `Order ~$${orderUsd.toFixed(2)} → ${tier.name} tier (${tier.targetBps} bps).`}
            >
              {tier.name}
            </span>
          </div>
          <div className="flex justify-between font-mono text-xs">
            <span className="text-slate-400">Expected out</span>
            <span className="text-slate-200">~{quote.expectedOutHuman} {tokenOut.symbol}</span>
          </div>
          <div className="flex justify-between font-mono text-xs">
            <span className="text-slate-400">Min received ({form.slippagePct}% slip)</span>
            <span className="text-emerald-300">≥ {quote.minAmountOutHuman} {tokenOut.symbol}</span>
          </div>
          <div className="flex justify-between font-mono text-xs">
            <span className="text-slate-400">Protocol fee ({tier.name})</span>
            <span className="text-slate-300">{(feeBps / 100).toFixed(2)}%</span>
          </div>
        </div>
      )}

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
