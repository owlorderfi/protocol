import { useState, useMemo, useEffect } from 'react';
import toast from 'react-hot-toast';
import { CHAINS, type ChainIdType, type OrderType } from '@owlorderfi/shared';
import { useSessionForm } from '../hooks/useSessionForm';
import { parseUnits, formatUnits } from '@owlorderfi/shared';
import { useCreateOrder } from '../hooks/useCreateOrder';
import { useTokenApproval } from '../hooks/useTokenApproval';
import { useOutstandingCommitment } from '../hooks/useOutstandingCommitment';
import { formatSmart, trimToSigFigs } from '../lib/formatAmount';
import { displayPrice, displayedToCanonical } from '../lib/priceFloor';
import { usePriceFlip } from '../lib/PriceFlipContext';
import { useActiveToken } from '../lib/ActiveTokenContext';
import { useMarketPrice } from '../hooks/useMarketPrice';
import { usePoolTrend } from '../hooks/usePoolTrend';
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
import { ApproveUnlimitedModal } from './ApproveUnlimitedModal';

// A Limit order is just "swap tokenIn → tokenOut, execute when the rate is
// favourable" — no Buy/Sell framing. Internally it's always LIMIT_SELL
// (fires when the canonical rate ≥ the signed trigger); the displayed
// direction is a separate global view choice (in/out + flip), never part of
// the order. STOP_LOSS/TAKE_PROFIT stay supported by the contract but aren't
// produced here (a separate Stop tab is the post-launch home for those).

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

  // key={chainId} forces React to unmount + remount the inner form when
  // the wallet switches chains. Without it, form.tokenIn / form.tokenOut
  // keep the old chain's addresses, findToken(newChain, oldAddr) returns
  // undefined, and the next `.symbol` access crashes the React tree.
  return <CreateOrderFormInner key={chainId} enabled={enabled} chainId={chainId} tokens={tokens} />;
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

  // Per-chain key keeps token addresses scoped (see CreateDcaForm).
  const [form, setForm] = useSessionForm<FormState>(`polyorder.formLimit.${chainId}`, {
    // Limit is always internally LIMIT_SELL — see ORDER_TYPE below. (Field
    // kept for the persisted shape; never read.)
    orderType: 'LIMIT_SELL',
    tokenIn: tokens[0].address,
    tokenOut: tokens[1].address,
    // Amount starts empty so the Approve button + balance-check helpers
    // don't preview a synthetic value the user never typed. The
    // `touched` flag pattern (per CLAUDE.md "Validation banners")
    // suppresses the amber "Enter an amount" banner until the user
    // focuses the field — empty + pristine reads as "ready to fill in".
    amountInHuman: '',
    // Canonical (tokenOut per tokenIn). Empty → the smart-suggest fills it
    // once the market price loads (aggressiveness defaults to 'tight').
    triggerPriceHuman: '',
    slippagePct: 0.5,
    deadlineHours: 24,
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
  // Limit = "swap tokenIn→tokenOut, execute when the rate is favourable":
  // always LIMIT_SELL internally (fires when canonical current ≥ trigger;
  // trigger stored canonical = tokenOut per tokenIn). BUY/SELL were just two
  // encodings of the same order. The displayed direction is a separate global
  // view choice (in/out + flip) and never affects what's signed.
  const ORDER_TYPE: OrderType = 'LIMIT_SELL';
  const market = useMarketPrice(form.tokenIn, form.tokenOut); // canonical
  const { flipped, toggleFlipped } = usePriceFlip();
  const priceTokens = {
    tokenInSym: tokenIn.symbol,
    tokenInAddr: form.tokenIn,
    tokenOutSym: tokenOut.symbol,
    tokenOutAddr: form.tokenOut,
  };
  const balance = useTokenBalance(form.tokenIn);
  const twap = usePoolTwap(ORDER_TYPE, form.tokenIn, form.tokenOut);

  // form.triggerPriceHuman is CANONICAL (tokenOut per tokenIn — what's signed).
  // The input shows it in the current display orientation; keep a local raw
  // string so typing isn't round-tripped through 1/x on every keystroke. The
  // canonical value is committed on blur. This effect refreshes the shown
  // value when the smart-suggest writes a new canonical trigger or the global
  // flip toggles — never the other way (so it can't fight live typing).
  const [triggerInputRaw, setTriggerInputRaw] = useState('');
  useEffect(() => {
    const c = parseFloat(form.triggerPriceHuman);
    if (!Number.isFinite(c) || c <= 0) {
      setTriggerInputRaw('');
      return;
    }
    setTriggerInputRaw(trimToSigFigs(displayPrice({ canonical: c, flipped, ...priceTokens }).value, 6));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.triggerPriceHuman, flipped, form.tokenIn, form.tokenOut]);

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
  const [unlimitedModalOpen, setUnlimitedModalOpen] = useState(false);

  // Longer-horizon trend, fed by the API's pool-spot-snapshot cron. Used
  // by Smart Suggest when the Wait pill is 1h (TWAP's 5min trend doesn't
  // extrapolate honestly to 1h; we'd rather have NO drift than fake drift).
  // Lazy-loaded — the hook is enabled ONLY when horizon === 3600, so a
  // user who never touches the 1h pill (most users on Wait=5m default)
  // never pays for the /market/trend network round-trip. Drops one fetch
  // from cold chain switches.
  const trend1h = usePoolTrend(form.tokenIn, form.tokenOut, 3600, horizon === 3600);

  // Scaled bigint → canonical human string. Sig-figs (not fixed decimals) so
  // small canonical rates (e.g. 0.00028 WETH per USDC) keep precision instead
  // of collapsing under toFixed(6).
  const priceToShortHuman = (priceScaled: bigint): string => {
    return trimToSigFigs(Number(priceScaled) / 1e18, 9);
  };

  // Invert a human-readable trigger price for the flipped pair direction:
  // "2108" (USDC per WETH) → "0.000474" (WETH per USDC). toPrecision(6) keeps
  // 6 significant digits, which works cleanly across both magnitudes.
  const invertTriggerHuman = (value: string): string => {
    const n = parseFloat(value);
    if (!Number.isFinite(n) || n <= 0) return '';
    return trimToSigFigs(1 / n, 9);
  };

  // Recompute the suggested trigger from explicit inputs. Avoids any closure
  // capture on form state so the value used here is always exactly what the
  // caller intends, not what the last render happened to bind.
  // Pick the trend signal whose measurement window matches the chosen
  // horizon (match-window principle in orderMath.driftAtHorizon — we
  // never project a trend beyond its measurement window):
  //   Wait 30s/5m → 5m TWAP trend  (live observe-based)
  //   Wait 1h    → 1h DB-snapshot trend (if available)
  //   Wait 1d    → no trend; drift=0 by zeroing the window
  const pickTrendForHorizon = (
    h: Horizon,
  ): { trendPct: number; trendWindowSec: number } => {
    if (h <= 300) return { trendPct: twap.trendPct ?? 0, trendWindowSec: 300 };
    if (h === 3600 && trend1h.available && trend1h.trendPct !== null) {
      return { trendPct: trend1h.trendPct, trendWindowSec: 3600 };
    }
    // No matching window → drift=0 via windowSec=0 short-circuit in
    // driftAtHorizon. trendPct value here is irrelevant (multiplied by
    // T/W which is short-circuited to 0).
    return { trendPct: 0, trendWindowSec: 0 };
  };

  const recomputeSuggestion = (
    aggro: Aggressiveness,
    h: Horizon,
    orderType: OrderType,
  ) => {
    if (market.priceScaled === null) return;
    if (twap.sigma30s !== null && twap.sigma30s > 0) {
      const trend = pickTrendForHorizon(h);
      const result = smartSuggestTrigger({
        orderType,
        current: market.priceScaled,
        sigma30s: twap.sigma30s,
        trendPct: trend.trendPct,
        trendWindowSec: trend.trendWindowSec,
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
    recomputeSuggestion(aggro, horizon, ORDER_TYPE);
    clearStaleBanners();
  };

  const handleHorizonChange = (h: Horizon) => {
    setHorizon(h);
    // If a suggestion was active, regenerate with the new horizon so the
    // displayed trigger stays consistent with what the pills mean.
    if (aggressiveness !== null) recomputeSuggestion(aggressiveness, h, ORDER_TYPE);
    clearStaleBanners();
  };

  // Auto-recompute the trigger price when the swap direction or pair flips
  // (or when market/σ becomes available on first load), as long as a pill is
  // still selected. Manual edits set aggressiveness=null and pause this.
  useEffect(() => {
    if (aggressiveness === null) return;
    if (market.priceScaled === null) return;
    recomputeSuggestion(aggressiveness, horizon, ORDER_TYPE);
    // recomputeSuggestion is defined inline above; we deliberately depend on
    // the inputs that drive its output, not on the function identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ORDER_TYPE, form.tokenIn, form.tokenOut, market.priceScaled, twap.sigma30s, twap.trendPct, trend1h.trendPct, trend1h.available]);

  const liveFillProb = useMemo(() => {
    if (market.priceScaled === null || twap.sigma30s === null) return null;
    const typed = parseFloat(triggerInputRaw);
    if (!Number.isFinite(typed) || typed <= 0) return null;
    const triggerCanon = displayedToCanonical(typed, priceTokens, flipped);
    const trend = pickTrendForHorizon(horizon);
    return computeFillProbability({
      orderType: ORDER_TYPE,
      currentScaled: market.priceScaled, // spot, matches the market ribbon
      triggerPriceHuman: triggerCanon, // canonical, same frame as currentScaled
      sigma30s: twap.sigma30s,
      trendPct: trend.trendPct,
      trendWindowSec: trend.trendWindowSec,
      horizonSec: horizon,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market.priceScaled, twap.sigma30s, twap.trendPct, trend1h.trendPct, trend1h.available, triggerInputRaw, flipped, ORDER_TYPE, horizon]);

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
    // Read the trigger LIVE from the typed display value (converted to
    // canonical for signing) so the quote + submit match exactly what's shown,
    // with no dependence on a blur to commit.
    const typedTrigger = parseFloat(triggerInputRaw);
    if (triggerInputRaw.trim() === '' || !Number.isFinite(typedTrigger) || typedTrigger <= 0) {
      return { validationError: 'Enter a trigger price' };
    }

    // Degenerate / illiquid pool guard. A thin testnet pool reports a garbage
    // spot (e.g. ~9e11 USDC/WETH on Base Sepolia), so every derived trigger is
    // meaningless and the order can't fill at a real price. Block with an
    // honest message. The band is generous — every real OwlOrderFi pair sits
    // well inside 1e-9..1e9 (WETH/USDC spans 3e-4..3300); only a near-empty
    // pool lands outside it. (null = still loading; the button is disabled.)
    if (market.priceScaled !== null) {
      const spot = Number(market.priceScaled) / 1e18;
      if (spot > 1e9 || spot < 1e-9) {
        return { validationError: 'Price unavailable — this pair looks illiquid on this chain' };
      }
    }

    try {
      const amountInRaw = parseUnits(form.amountInHuman, tokenIn.decimals);
      const triggerPriceScaled = parseUnits(
        trimToSigFigs(displayedToCanonical(typedTrigger, priceTokens, flipped), 9),
        18,
      );

      if (amountInRaw === 0n) return { validationError: 'Amount in must be > 0' };
      if (triggerPriceScaled === 0n) return { validationError: 'Trigger price must be > 0' };

      const expectedOut = computeExpectedAmountOut({
        orderType: ORDER_TYPE,
        amountInRaw,
        triggerPriceScaled,
        tokenInDecimals: tokenIn.decimals,
        tokenOutDecimals: tokenOut.decimals,
      });

      const minAmountOut = applySlippage(expectedOut, form.slippagePct);
      if (minAmountOut === 0n) return { validationError: 'Slippage too high or output rounds to 0' };

      // Balance check runs AFTER the math so the read-only preview lines
      // ("At trigger price ≈ X, Min after slippage ≥ Y") stay visible even
      // when the connected wallet is short — the user can still see what
      // the order would yield before they top up. The balance error still
      // gates submit (via validationError below), it just no longer hides
      // the math the user is configuring. Skip the check:
      //   (a) while the balance read is in flight,
      //   (b) when wallet not connected/authed — `enabled=false` → the
      //       read returns 0 by default which would otherwise show
      //       "Insufficient have 0, need X" before the user even connects.
      let balanceError: string | undefined;
      if (enabled && !balance.isLoading && amountInRaw > balance.balance) {
        const have = formatUnits(balance.balance, tokenIn.decimals);
        const need = formatUnits(amountInRaw, tokenIn.decimals);
        balanceError = `Insufficient ${tokenIn.symbol} balance: have ${have}, need ${need}`;
      }

      return {
        validationError: balanceError,
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
    triggerInputRaw,
    flipped,
    form.slippagePct,
    ORDER_TYPE,
    form.tokenIn,
    form.tokenOut,
    tokenIn.decimals,
    tokenIn.symbol,
    tokenOut.decimals,
    balance.balance,
    balance.isLoading,
    enabled,
    market.priceScaled,
  ]);

  // Any user edit clears a stale submit-error from the mutation hook
  // so the next toast.error fires fresh on the new attempt instead of
  // displaying the previous error indefinitely. Call from user-edit
  // paths; programmatic setForm (post-submit clear, smart-suggest
  // recompute) deliberately skip this.
  const clearStaleBanners = () => {
    if (error !== null) resetCreate();
  };

  const onChange = <K extends keyof FormState>(k: K) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const v = e.target.value;
    setForm((prev) => ({
      ...prev,
      [k]: k === 'deadlineHours' || k === 'slippagePct' ? Number(v) : v,
    } as FormState));
    clearStaleBanners();
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
    // Two checks now because the quote can have BOTH math fields AND
    // a validationError (balance shortfall): math is still useful for
    // the read-only preview, but submit must still be blocked.
    if (!('amountIn' in quote) || quote.validationError) return;
    const { amountIn, minAmountOut, triggerPrice } = quote;
    if (!amountIn || !minAmountOut || !triggerPrice) return;

    const result = await submit({
      orderType: ORDER_TYPE,
      tokenIn: form.tokenIn,
      tokenOut: form.tokenOut,
      amountIn,
      minAmountOut,
      triggerPrice,
      deadlineHours: form.deadlineHours,
      feeBps,
    });
    if (result) {
      const shortId = result.id.slice(0, 8);
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
    'w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400 focus:border-cyan-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/40 disabled:opacity-50';
  const labelClass = 'mb-1 block text-xs font-medium uppercase tracking-wider text-slate-400';

  const formDisabled = !enabled || isSubmitting;
  // Normalise undefined → null: the success path also carries
  // `validationError: undefined` when the math is computable but balance
  // is fine (see quote useMemo above), so consumers can do a single
  // truthy / null check without worrying about the union shape. The
  // submit button's `disabled={... validationError !== null}` would
  // otherwise see `undefined !== null` as truthy and lock the button.
  const validationError = quote.validationError ?? null;

  // Approval status — only relevant once we have a valid amount.
  // `typeof` guard is load-bearing despite the `in` check: under
  // noUncheckedIndexedAccess, TS treats `quote.amountIn` as
  // `string | undefined` even after the `in` check narrows the union,
  // so BigInt(string | undefined) rejects without it.
  const amountInRaw = 'amountIn' in quote && typeof quote.amountIn === 'string'
    ? BigInt(quote.amountIn)
    : 0n;

  // Soft warning: this single limit can fire on its own (hard-block guards
  // amountInRaw > balance above), but combined with the maker's already-OPEN
  // orders the total commitment exceeds wallet. Banner only; submit allowed
  // because the maker may top up before the trigger fires, or accept that
  // siblings race for the shared allowance. Mirrors the DCA/TWAP pattern so
  // all four forms surface "reserved by other orders" consistently.
  const shortfallWarning = (() => {
    if (!enabled || balance.isLoading || validationError || amountInRaw === 0n) return null;
    const totalReserved = amountInRaw + otherCommitted;
    if (totalReserved <= balance.balance) return null;
    const haveH = formatSmart(Number(formatUnits(balance.balance, tokenIn.decimals)));
    const needH = formatSmart(Number(formatUnits(amountInRaw, tokenIn.decimals)));
    const reservedH = otherCommitted > 0n
      ? formatSmart(Number(formatUnits(otherCommitted, tokenIn.decimals)))
      : null;
    const deficit = totalReserved - balance.balance;
    const deficitH = formatSmart(Number(formatUnits(deficit, tokenIn.decimals)));
    return reservedH
      ? `Wallet (${haveH}) short by ${deficitH} ${tokenIn.symbol} for this limit (${needH}) + ${reservedH} reserved by other orders. The order may revert when triggered until you top up.`
      : `Wallet (${haveH}) short by ${deficitH} ${tokenIn.symbol} for this limit (${needH}). Order may revert when triggered until you top up.`;
  })();

  const showApprove = enabled && !validationError && approval.needsApproval(amountInRaw);

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-slate-800 bg-slate-900/40 p-6"
    >
      <h2 className="text-lg font-semibold">Create Order</h2>

      {/* Two-column split at md+ — inputs on the left, preview + action
          on the right. Stacks single-column below md so mobile keeps
          the natural top-to-bottom flow. */}
      <div className="mt-4 grid grid-cols-1 gap-6 md:grid-cols-2">
        {/* ─── LEFT: inputs ───────────────────────────────── */}
        <div className="space-y-4">

      {/* Direction is controlled by clicking the "Execute if" preview
          line below (in the trigger price section). No separate
          direction picker — keeps the form lean, matches DCA/TWAP
          where the same line is the direction control surface. */}

      {/* Price now — top of the form for quick reference (display only). */}
      {market.priceScaled !== null && (() => {
        const marketCanon = parseFloat(formatUnits(market.priceScaled, 18));
        const typedTrigger = parseFloat(triggerInputRaw);
        const triggerCanon =
          Number.isFinite(typedTrigger) && typedTrigger > 0
            ? displayedToCanonical(typedTrigger, priceTokens, flipped)
            : 0;
        const triggerSet = triggerCanon > 0;
        const md = displayPrice({ canonical: marketCanon, flipped, ...priceTokens });
        const td = triggerSet ? displayPrice({ canonical: triggerCanon, flipped, ...priceTokens }) : null;
        const op = md.inverted ? '≤' : '≥';
        const wouldFireNow = triggerSet && marketCanon >= triggerCanon;
        return (
          <div className="mb-2">
            <button
              type="button"
              onClick={toggleFlipped}
              title="Click to flip how prices are shown (display only — does not change the order)"
              className="block w-full rounded-lg border border-cyan-900/40 bg-cyan-950/30 px-4 py-3 text-center transition hover:border-cyan-700/50"
            >
              <div className="text-xs uppercase tracking-wider text-slate-400">Now</div>
              <div className="mt-0.5 font-mono text-lg text-cyan-100">
                1 {md.baseSym} ≈ {formatSmart(md.value)} {md.quoteSym}
              </div>
              <div className="mt-0.5 text-xs text-slate-500">
                <span className="font-mono">{md.directionLabel}</span> <span aria-hidden>⇄</span>
              </div>
              {triggerSet && td && (
                <div className="mt-1 text-sm text-slate-400">
                  Execute when 1 {md.baseSym} {op}{' '}
                  <span className="font-mono text-amber-300">
                    {formatSmart(td.value)} {md.quoteSym}
                  </span>
                </div>
              )}
            </button>
            {wouldFireNow ? (
              <span className="mt-1 inline-flex items-center gap-1.5 rounded-md bg-emerald-500/20 px-2 py-0.5 text-sm font-semibold uppercase tracking-wider text-emerald-300">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
                Would fire now
              </span>
            ) : triggerSet && td && md.value > 0 && (() => {
              const deltaPct = ((td.value - md.value) / md.value) * 100;
              const needsDown = op === '≤';
              const arrow = needsDown ? '↓' : '↑';
              const tone = needsDown ? 'text-amber-300' : 'text-cyan-300';
              return (
                <span className={`mt-1 inline-block text-sm font-medium ${tone}`}>
                  {arrow} {Math.abs(deltaPct).toFixed(2)}% to trigger
                </span>
              );
            })()}
          </div>
        );
      })()}
      {market.isLoading && (
        <div className="mb-2 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-400">
          Loading market price…
        </div>
      )}

      {/* Pair selection with flip */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
        <div>
          <label className={labelClass}>From</label>
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
          <label className={labelClass}>To</label>
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

        </div>{/* ─── /LEFT ─────────────────────────────────── */}

        {/* ─── RIGHT: trigger · price · action ─────────────── */}
        <div className="space-y-4">

      {/* Trigger price. The order is always "swap tokenIn→tokenOut, execute
          when the rate is favourable" (internally LIMIT_SELL). The displayed
          direction follows the global in/out view; the trigger is typed in
          that same orientation and converted to canonical for signing. */}
      <div>
        {(() => {
          // Trigger typed in the current display orientation (same as the
          // "Now" line). Default (not flipped) = tokenIn/tokenOut, so the
          // user reads "1 tokenOut ≤ X tokenIn". Converted to canonical
          // (tokenOut/tokenIn) on blur for signing.
          const dispInverted = !flipped;
          const op = dispInverted ? '≤' : '≥';
          const unit = dispInverted
            ? `${tokenIn.symbol}/${tokenOut.symbol}`
            : `${tokenOut.symbol}/${tokenIn.symbol}`;
          const baseS = dispInverted ? tokenOut.symbol : tokenIn.symbol;
          const quoteS = dispInverted ? tokenIn.symbol : tokenOut.symbol;
          return (
            <>
              <label className={labelClass}>Trigger price ({unit})</label>
              <input
                type="text"
                inputMode="decimal"
                value={triggerInputRaw}
                onChange={(e) => {
                  setAggressiveness(null); // deselect Tight/Balanced/Patient on manual edit
                  setTriggerInputRaw(e.target.value);
                  clearStaleBanners();
                }}
                onBlur={() => {
                  const n = parseFloat(triggerInputRaw);
                  if (Number.isFinite(n) && n > 0) {
                    const canon = displayedToCanonical(n, priceTokens, flipped);
                    setForm((f) => ({ ...f, triggerPriceHuman: trimToSigFigs(canon, 9) }));
                  } else if (triggerInputRaw.trim() === '') {
                    setForm((f) => ({ ...f, triggerPriceHuman: '' }));
                  }
                }}
                disabled={formDisabled}
                placeholder="0.0"
                className={`${inputClass} font-mono`}
              />
              <p className="mt-1 text-sm text-slate-400">
                Execute when 1 {baseS} {op} {triggerInputRaw || '?'} {quoteS}
              </p>
            </>
          );
        })()}

        {/* Smart trigger suggestion (v2 — σ + trend + horizon aware) */}
        <div className="mt-2 rounded-lg border border-slate-800 bg-slate-950/40 p-2.5">
          <div className="flex items-center justify-between gap-2 text-xs uppercase tracking-wider text-slate-400">
            <span>✨ Smart suggest</span>
            {twap.trend && (() => {
              // Show the trend whose window matches the active horizon
              // (match-window principle — see orderMath.driftAtHorizon).
              // For 30s/5m we use the live 5min TWAP trend; for 1h we
              // use the 1h DB-snapshot trend (if accumulated); for 1d
              // drift is always 0 so we mark the 5m label as
              // informational only.
              const using1hTrend = horizon === 3600 && trend1h.available && trend1h.trendPct !== null;
              const driftApplied = horizon <= 300 || using1hTrend;
              const labelWindow = using1hTrend ? '1h' : '5m';
              const displayedPct = using1hTrend ? trend1h.trendPct ?? 0 : twap.trendPct ?? 0;
              // Recompute the up/down/sideways from whichever trend we're
              // showing so the arrow matches the number.
              const displayedTrend: 'up' | 'down' | 'flat' =
                Math.abs(displayedPct) < 0.01 ? 'flat' : displayedPct > 0 ? 'up' : 'down';
              const colorClass = !driftApplied
                ? 'text-slate-500 line-through decoration-slate-700'
                : displayedTrend === 'up'
                  ? 'text-cyan-300'
                  : displayedTrend === 'down'
                    ? 'text-amber-300'
                    : 'text-slate-400';
              const title = driftApplied
                ? `${labelWindow} trend: ${displayedPct.toFixed(3)}% — applied to drift estimate`
                : `5min trend: ${displayedPct.toFixed(3)}% — IGNORED for 1d horizon (we don't project drift over a full day from past data — see Smart Suggest math).`;
              return (
                <span className={colorClass} title={title}>
                  Trend ({labelWindow}): {displayedTrend === 'up' ? '↑ up' : displayedTrend === 'down' ? '↓ down' : '— sideways'}
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
              <span
                title="Distance from current spot to your trigger, as a percentage. Smart Suggest grows this when recent trend moves toward your target (you get a bigger 'discount' for free) and shrinks it when trend moves against you."
                className="cursor-help"
              >
                Offset:{' '}
                <span className="text-slate-200">
                  {liveFillProb.offsetPct === 0 ? '0%' : `${liveFillProb.offsetPct.toFixed(3)}%`}
                </span>
              </span>
              <span
                title="Probability the pool's spot reaches your trigger within this horizon, derived from the pool's own realised volatility (σ) and recent trend. Smart Suggest sizes the trigger so this matches your chosen aggressiveness (Tight ≈ 32%, Balanced ≈ 5%, Patient ≈ 0.3%) — that's why the % stays similar across trends; the trend gets absorbed into the Offset instead. A math readout, not a trade recommendation — buy vs sell direction is yours to choose."
                className="cursor-help"
              >
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
        {/* Two separate thresholds for two separate risks:
            - `tooLow`: keeper gate will abort if minOut is within keeper
              buffer of the re-quote. So the floor for "won't revert" is
              `σ × 3 + keeperBuffer`. That's the suggested number we surface.
            - `tooHigh`: sandwich risk depends only on slack between user
              slippage and natural market move (σ × 3). The keeper buffer
              is our operational concern, not a sandwich-bot's. So the
              MEV warning fires at `> 3× sigma-only suggestion`, ignoring
              the buffer. Otherwise our buffer would hide real MEV risk. */}
        {twap.sigma30s !== null && twap.sigma30s > 0 && (() => {
          const sigmaPct = twap.sigma30s * 100;
          const keeperBufferPct =
            (CHAINS[chainId as ChainIdType]?.keeperSlippageBufferBps ?? 50) / 100;
          // Floor at 0.1% (no pool is THAT calm), cap at 2% (above is
          // suspicious / illiquid pair territory the user should question).
          const sigmaSuggestion = Math.max(0.1, Math.min(2, sigmaPct * 3));
          const suggested = Math.max(0.1, Math.min(2, sigmaPct * 3 + keeperBufferPct));
          const tooLow = form.slippagePct < suggested * 0.7;
          // Sandwich threshold uses σ-only math (sigmaSuggestion × 3) —
          // the keeper buffer is OUR concern, not a sandwich-bot's. But
          // when σ is so low that sigmaSuggestion hits the 0.1% floor,
          // the σ-only threshold (0.3%) drops below the keeper-safe
          // suggestion (which always includes the buffer). Pressing Apply
          // would then immediately re-trigger this warning at the suggested
          // value. Floor the threshold at 1.2× the suggested keeper-safe
          // value so following the suggestion never trips it; manual
          // widening past +20% still gets flagged as it should.
          const tooHigh = form.slippagePct > Math.max(sigmaSuggestion * 3, suggested * 1.2);
          return (
            <div className="mt-2 flex items-center justify-between text-sm">
              <span className={tooLow ? 'text-amber-300' : tooHigh ? 'text-rose-300' : 'text-slate-400'}>
                {tooLow && '⚠ may revert: '}
                {tooHigh && '⚠ sandwich risk: '}
                Suggested {suggested.toFixed(2)}% (σ₃₀ₛ × 3 + {keeperBufferPct.toFixed(2)}% keeper buffer)
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

      {/* Quote summary. Renders whenever the math is computable
          (amount + trigger valid), independent of validationError —
          a balance shortfall shouldn't hide what the order WOULD yield
          if the wallet were topped up. Submit is still gated separately
          via handleSubmit's validationError check. */}
      {'minAmountOutHuman' in quote && (
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

      {/* No inline status banners — submit errors / successes surface
          as toasts (see submit handler above), validation errors paint
          on the submit button text. Same pattern as DCA / TWAP. */}

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
              // Always exact: this order PLUS the user's existing
              // outstanding commitment on the same token so the new
              // approval doesn't short-change a running DCA/TWAP/limit by
              // stealing its allowance. The "approve unlimited" path lives
              // behind a confirmation link below.
              void approval.approve(amountInRaw + otherCommitted).catch(() => {});
            }}
            disabled={approval.isApproving}
            className="w-full rounded-lg bg-amber-500 px-4 py-2.5 text-sm font-medium text-slate-950 hover:bg-amber-400 disabled:opacity-50"
          >
            {(() => {
              if (approval.isApproving) return `Approving ${tokenIn.symbol}…`;
              const totalRaw = amountInRaw + otherCommitted;
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
              Sum = {form.amountInHuman} (this order) +{' '}
              {formatSmart(Number(formatUnits(otherCommitted, tokenIn.decimals)))}{' '}
              {tokenIn.symbol} reserved by your other active orders.
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
                  // Surface the actual validation reason on the button
                  // (e.g. "Amount in must be > 0"). Same UX as DCA / TWAP —
                  // no separate amber banner, no generic "Fix inputs"
                  // detour. Button is still disabled via validationError
                  // on the `disabled` prop, so a duplicate submit can't
                  // slip through.
                  ? validationError
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

        </div>{/* ─── /RIGHT ───────────────────────────────── */}
      </div>{/* ─── /grid ────────────────────────────────── */}

      <ApproveUnlimitedModal
        open={unlimitedModalOpen}
        onClose={() => setUnlimitedModalOpen(false)}
        tokenSymbol={tokenIn.symbol}
        orderKindLabel="order"
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
