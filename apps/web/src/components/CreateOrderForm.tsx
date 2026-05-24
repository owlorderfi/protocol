import { useState, useMemo, useEffect } from 'react';
import toast from 'react-hot-toast';
import type { OrderType } from '@owlorderfi/shared';
import { parseUnits, formatUnits } from '@owlorderfi/shared';
import { useCreateOrder } from '../hooks/useCreateOrder';
import { useTokenApproval } from '../hooks/useTokenApproval';
import { useOutstandingCommitment } from '../hooks/useOutstandingCommitment';
import { formatSmart } from '../lib/formatAmount';
import { useActiveToken } from '../lib/ActiveTokenContext';
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
import { useChainId } from 'wagmi';

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
  /**
   * Approval mode. `false` (default) = unlimited maxUint256, industry
   * default — one approval covers every future order on this token.
   * `true` = exact amount + 5% buffer, signed per-order. Doubles the
   * gas cost (approve + execute every time) but caps the contract's
   * authority over the user's balance. See approval-hardening-plan.md.
   */
  approveExact: boolean;
}

interface Props {
  enabled: boolean;
}

/**
 * Top-level component is a thin shell that guards against unsupported
 * chains BEFORE the form's heavy hook chain runs. React rules-of-hooks
 * forbid conditional hook calls, so we extract the form body into an
 * inner component that's only mounted when the chain has ≥ 2 tokens.
 */
export function CreateOrderForm({ enabled }: Props) {
  const chainId = useChainId();
  const tokens = getTokens(chainId);

  if (tokens.length < 2) {
    return (
      <div className="rounded-xl border border-amber-900/50 bg-amber-950/30 p-4 text-sm text-amber-200">
        <div className="font-medium mb-1">No tokens configured for this chain</div>
        <p className="text-sm text-amber-300/80">
          Connected to chainId <span className="font-mono">{chainId}</span>, but OwlOrderFi
          has no token list for it yet. Switch your wallet to a supported network to create
          orders.
        </p>
      </div>
    );
  }

  return <CreateOrderFormInner enabled={enabled} chainId={chainId} tokens={tokens} />;
}

function CreateOrderFormInner({
  enabled,
  chainId,
  tokens,
}: {
  enabled: boolean;
  chainId: number;
  tokens: ReturnType<typeof getTokens>;
}) {
  const { submit, isSubmitting, error, reset: resetCreate } = useCreateOrder();
  const [success, setSuccess] = useState<string | null>(null);
  // Banner suppression flag — validation errors only surface AFTER the
  // user has touched an input. Without this, the form shows
  // "Enter an amount" the moment the page loads (or right after a
  // successful submit clears amountInHuman) — looks like the form
  // is broken when it's actually pristine.
  const [touched, setTouched] = useState(false);

  const [form, setForm] = useState<FormState>({
    orderType: 'LIMIT_BUY',
    tokenIn: tokens[0].address,
    tokenOut: tokens[1].address,
    amountInHuman: '1',
    triggerPriceHuman: '2000',
    slippagePct: 0.5,
    deadlineHours: 24,
    approveExact: false,
  });

  const tokenIn = findToken(chainId, form.tokenIn)!;
  const tokenOut = findToken(chainId, form.tokenOut)!;

  // Other active orders on the same token compete for the same
  // allowance — fold their outstanding commitment into the approval
  // sizing so exact-mode users get prompted to top up instead of
  // racing siblings into an insufficient-allowance revert.
  const otherCommitted = useOutstandingCommitment(enabled, chainId, form.tokenIn);
  const approval = useTokenApproval(form.tokenIn, otherCommitted);
  const { setActiveTokenIn } = useActiveToken();
  useEffect(() => {
    setActiveTokenIn(form.tokenIn);
  }, [form.tokenIn, setActiveTokenIn]);
  const market = useMarketPrice(form.orderType, form.tokenIn, form.tokenOut);
  const balance = useTokenBalance(form.tokenIn);
  const twap = usePoolTwap(form.orderType, form.tokenIn, form.tokenOut);

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
    clearStaleBanners();
  };

  const handleHorizonChange = (h: Horizon) => {
    setHorizon(h);
    // If a suggestion was active, regenerate with the new horizon so the
    // displayed trigger stays consistent with what the pills mean.
    if (aggressiveness !== null) recomputeSuggestion(aggressiveness, h, form.orderType);
    clearStaleBanners();
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
    // A swap from a token to itself has no economic meaning and would also
    // fail at the pool level (no such pool). Block at the form layer so the
    // user sees a clear message instead of a quote/RPC error.
    if (form.tokenIn.toLowerCase() === form.tokenOut.toLowerCase()) {
      return { validationError: 'tokenIn and tokenOut must differ' };
    }
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

      // Balance check — mirror the API-side guard so the user gets immediate
      // feedback instead of submitting a tx that will be rejected. Skip:
      // (a) while the balance read is in flight,
      // (b) when wallet not connected/authed — `enabled=false` → the read
      //     returns 0 by default which would otherwise show "Insufficient
      //     have 0, need X" before the user even connects.
      if (enabled && !balance.isLoading && amountInRaw > balance.balance) {
        const have = formatUnits(balance.balance, tokenIn.decimals);
        const need = formatUnits(amountInRaw, tokenIn.decimals);
        return { validationError: `Insufficient ${tokenIn.symbol} balance: have ${have}, need ${need}` };
      }

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
    form.tokenIn,
    form.tokenOut,
    tokenIn.decimals,
    tokenIn.symbol,
    tokenOut.decimals,
    balance.balance,
    balance.isLoading,
    enabled,
  ]);

  // Any user edit means the previous submit result (success "Order created"
  // or rose-banner error) is no longer the most relevant feedback. Call this
  // from every user-edit code path so the banners return to neutral instead
  // of acting like a history log. NB: programmatic setForm calls (post-submit
  // clear, smart-suggest recompute) deliberately do NOT call this.
  const clearStaleBanners = () => {
    if (success !== null) setSuccess(null);
    if (error !== null) resetCreate();
  };

  const onChange = <K extends keyof FormState>(k: K) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const v = e.target.value;
    setForm((prev) => ({
      ...prev,
      [k]: k === 'deadlineHours' || k === 'slippagePct' ? Number(v) : v,
    } as FormState));
    clearStaleBanners();
    // Editing anything counts as engagement → validation errors are
    // now welcome (was the user about to submit, now they want
    // feedback).
    setTouched(true);
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
      // Pristine again from the user's perspective: empty amount is
      // expected after success, not an error to flag.
      setTouched(false);
    } else if (error) {
      toast.error(error);
    }
  };

  const inputClass =
    'w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400 focus:border-cyan-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/40 disabled:opacity-50';
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
        <p className="mt-1 text-sm text-slate-400">
          {form.orderType === 'LIMIT_BUY'
            ? `Execute when 1 ${tokenOut.symbol} costs ≤ trigger ${tokenIn.symbol} (gets cheaper)`
            : `Execute when 1 ${tokenIn.symbol} fetches ≥ trigger ${tokenOut.symbol} (gets more)`}
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
          {balance.balance > 0n ? (
            <button
              type="button"
              onClick={() => {
                setForm((f) => ({
                  ...f,
                  amountInHuman: formatUnits(balance.balance, tokenIn.decimals),
                }));
                clearStaleBanners();
              }}
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
          ) : (
            // Always surface the balance — silence here is too easily read as
            // "balance still loading" instead of the literal "you have 0".
            <span className="text-xs text-slate-400">
              Balance:{' '}
              <span className="font-mono text-slate-400">
                {balance.isLoading ? '…' : '0'}
              </span>
            </span>
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

      {/* Trigger price — label + hint depend on the trigger direction.
          ≤ (LIMIT_BUY):  max tokenIn to spend per 1 tokenOut  (e.g. ≤ 2000 USDC per WETH)
          ≥ (LIMIT_SELL): min tokenOut to receive per 1 tokenIn (e.g. ≥ 3000 USDC per WETH) */}
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
            <div
              className={`mb-2 flex items-center justify-between rounded-lg border px-3 py-2 text-sm transition-colors ${
                wouldFireNow
                  ? 'border-emerald-500/40 bg-emerald-500/10'
                  : 'border-slate-800 bg-slate-950/40'
              }`}
            >
              <span className="text-slate-400">
                Market: <span className="font-mono text-slate-200">{marketHuman.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
              </span>
              {wouldFireNow ? (
                <span className="flex items-center gap-1.5 rounded-md bg-emerald-500/20 px-2.5 py-1 text-sm font-semibold uppercase tracking-wider text-emerald-300">
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
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
          <div className="mb-2 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-400">
            Loading market price…
          </div>
        )}
        <label className={labelClass}>
          {form.orderType === 'LIMIT_BUY'
            ? `Trigger price (max ${tokenIn.symbol} per ${tokenOut.symbol})`
            : `Trigger price (${tokenOut.symbol} per ${tokenIn.symbol})`}
        </label>
        <input
          type="text"
          inputMode="decimal"
          value={form.triggerPriceHuman}
          onChange={(e) => {
            setAggressiveness(null); // deselect Tight/Balanced/Patient on manual edit
            setForm((f) => ({ ...f, triggerPriceHuman: e.target.value }));
            clearStaleBanners();
          }}
          disabled={formDisabled}
          placeholder="2000"
          className={`${inputClass} font-mono`}
        />
        <p className="mt-1 text-sm text-slate-400">
          {form.orderType === 'LIMIT_BUY'
            ? `Execute when 1 ${tokenOut.symbol} costs at most ${form.triggerPriceHuman || '?'} ${tokenIn.symbol}`
            : `Execute when 1 ${tokenIn.symbol} fetches at least ${form.triggerPriceHuman || '?'} ${tokenOut.symbol}`}
        </p>

        {/* Smart trigger suggestion (v2 — σ + trend + horizon aware) */}
        <div className="mt-2 rounded-lg border border-slate-800 bg-slate-950/40 p-2.5">
          <div className="flex items-center justify-between gap-2 text-xs uppercase tracking-wider text-slate-400">
            <span>✨ Smart suggest</span>
            {twap.trend && (() => {
              // Trend is always derived from the 5-min TWAP window. For
              // horizons > 5min we zero out drift, so the trend label is
              // shown dimmed to signal "informational only".
              const driftApplied = horizon <= 300;
              const colorClass = !driftApplied
                ? 'text-slate-500 line-through decoration-slate-700'
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
            <span className="text-xs uppercase tracking-wider text-slate-400">Wait</span>
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
            <div className="mt-2 flex justify-between text-sm text-slate-400">
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
            <div className="mt-1 text-sm text-slate-400">
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
              onClick={() => {
                setForm((f) => ({ ...f, slippagePct: p }));
                clearStaleBanners();
              }}
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
        {/* σ-adaptive suggestion. Sigma is realized 30s vol. 3σ buffer covers
            ~99% of normal moves while keeping sandwich room tight. Floor at
            0.1% (don't get rejected by every wei of pool drift) and cap at
            2% (above is suspicious / illiquid pair territory). */}
        {twap.sigma30s !== null && twap.sigma30s > 0 && (() => {
          const sigmaPct = twap.sigma30s * 100;
          const suggested = Math.max(0.1, Math.min(2, sigmaPct * 3));
          const tooLow = form.slippagePct < suggested * 0.7;
          const tooHigh = form.slippagePct > suggested * 3;
          return (
            <div className="mt-2 flex items-center justify-between text-sm">
              <span className={tooLow ? 'text-amber-300' : tooHigh ? 'text-rose-300' : 'text-slate-400'}>
                {tooLow && '⚠ may revert: '}
                {tooHigh && '⚠ sandwich risk: '}
                Suggested {suggested.toFixed(2)}% (σ₃₀ₛ × 3)
              </span>
              {Math.abs(form.slippagePct - suggested) > 0.05 && (
                <button
                  type="button"
                  onClick={() => {
                    setForm((f) => ({ ...f, slippagePct: parseFloat(suggested.toFixed(2)) }));
                    clearStaleBanners();
                  }}
                  disabled={formDisabled}
                  className="rounded border border-slate-700 px-2 py-0.5 text-xs text-cyan-300 hover:bg-slate-800 disabled:opacity-50"
                >
                  Apply
                </button>
              )}
            </div>
          );
        })()}
      </div>

      {/* Quote summary */}
      {!validationError && 'minAmountOutHuman' in quote && (
        <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-sm">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs uppercase tracking-wider text-slate-400">Quote at trigger</span>
            <span
              className={`rounded-full border px-2 py-0.5 text-xs font-medium uppercase tracking-wider ${tier.badge}`}
              title={orderUsd === null
                ? 'USD value unknown for non-stable tokenIn — Default tier applied.'
                : `Order ~$${orderUsd.toFixed(2)} → ${tier.name} tier (${tier.targetBps} bps).`}
            >
              {tier.name}
            </span>
          </div>
          {/* Compact labels — the parenthetical context (slippage %,
              tier name) is already visible above in the form and would
              wrap the row at 400px right-column width otherwise. Tooltips
              preserve the full context for power users. */}
          <div className="flex justify-between gap-2 font-mono text-sm">
            <span className="text-slate-400">Expected out</span>
            <span
              className="text-slate-200 whitespace-nowrap"
              title={`${quote.expectedOutHuman} ${tokenOut.symbol}`}
            >
              ~{formatSmart(Number(quote.expectedOutHuman))} {tokenOut.symbol}
            </span>
          </div>
          <div className="flex justify-between gap-2 font-mono text-sm">
            <span
              className="text-slate-400"
              title={`Worst-case fill after ${form.slippagePct}% slippage tolerance`}
            >
              Min received
            </span>
            <span
              className="text-emerald-300 whitespace-nowrap"
              title={`${quote.minAmountOutHuman} ${tokenOut.symbol}`}
            >
              ≥ {formatSmart(Number(quote.minAmountOutHuman))} {tokenOut.symbol}
            </span>
          </div>
          <div className="flex justify-between gap-2 font-mono text-sm">
            <span
              className="text-slate-400"
              title={`${tier.name} tier — ${feeBps} bps`}
            >
              Protocol fee
            </span>
            <span className="text-slate-300 whitespace-nowrap">
              {(feeBps / 100).toFixed(2)}%
            </span>
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

      {/* Status banners — placed ABOVE the action button so users on small
          screens don't have to scroll past the form to see why their submit
          was rejected (or that it succeeded). All four error sources sit
          here; success stays nearby so it lands in the same visual region. */}
      {approval.approveError && (
        <div className="rounded-lg border border-rose-900/50 bg-rose-950/40 p-3 text-sm text-rose-300">
          Approval error: {approval.approveError}
        </div>
      )}
      {validationError && touched && (
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

      {showApprove ? (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => {
              // Errors (user reject, network) surface via approval.approveError.
              // Swallow the rejected promise here so the browser doesn't log
              // "Uncaught (in promise)" — the hook's writeError state already
              // captures it for display below.
              // Exact mode covers THIS order PLUS the user's existing
              // outstanding commitment on the same token, so the new
              // approval doesn't accidentally short-change a running
              // DCA/TWAP/limit by stealing its allowance. Unlimited:
              // hook uses maxUint256.
              const exactAmount = form.approveExact
                ? amountInRaw + otherCommitted
                : undefined;
              void approval.approve(exactAmount).catch(() => {});
            }}
            disabled={approval.isApproving}
            className="w-full rounded-lg bg-amber-500 px-4 py-2.5 text-sm font-medium text-slate-950 hover:bg-amber-400 disabled:opacity-50"
          >
            {(() => {
              if (approval.isApproving) return `Approving ${tokenIn.symbol}…`;
              if (!form.approveExact) return `1. Approve ${tokenIn.symbol} (unlimited)`;
              // Exact mode actually approves amountIn + outstanding so a
              // running DCA/TWAP doesn't lose its earmarked allowance.
              // Show that sum on the button — Rabby will display the same.
              const totalRaw = amountInRaw + otherCommitted;
              const totalHuman = formatSmart(Number(formatUnits(totalRaw, tokenIn.decimals)));
              return `1. Approve ${totalHuman} ${tokenIn.symbol} (exact)`;
            })()}
          </button>
          <label className="flex items-start gap-2 text-sm text-slate-400 cursor-pointer">
            <input
              type="checkbox"
              checked={form.approveExact}
              onChange={(e) => setForm((f) => ({ ...f, approveExact: e.target.checked }))}
              disabled={formDisabled || approval.isApproving}
              className="mt-0.5 accent-cyan-500"
            />
            <span>
              Approve <span className="text-slate-300">exact amount</span> instead of
              unlimited. Safer (caps router's authority over your {tokenIn.symbol}{' '}
              balance) but every future order needs a fresh approve.
            </span>
          </label>
          {form.approveExact && otherCommitted > 0n && (
            <div className="text-xs text-slate-500">
              Sum =  {form.amountInHuman} (this order) +{' '}
              {formatSmart(Number(formatUnits(otherCommitted, tokenIn.decimals)))}{' '}
              {tokenIn.symbol} already reserved by your other active orders.
              Approving just this order's amount would let the keeper consume
              the older orders' allowance first, then fail on this one with
              ERC20: insufficient allowance.
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2">
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
                  : 'Sign & submit order'}
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

    </form>
  );
}
