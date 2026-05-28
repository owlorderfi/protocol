/**
 * Take-profit / DCA-in ladder form.
 *
 * A ladder is N independent limit orders signed in one UX flow, at
 * staggered prices between a start and end value. Each rung gets the
 * same fraction of the total amount (1/N) — equal distribution for now.
 * Linear price spacing between start and end. Advanced modes (front /
 * back-loaded distribution, geometric spacing, custom per-rung overrides)
 * can layer on top later without changing the storage model.
 *
 * Contract is unaware of ladders: each rung is a regular LIMIT_SELL /
 * LIMIT_BUY. The grouping (ladderId + rung index) lives only in the
 * backend DB so the orders list can present them as one entity.
 *
 * Submit flow: user clicks "Create ladder (N signatures)" → wallet
 * prompts N times sequentially. On partial signing (user rejects rung
 * K of N), the K-1 rungs already submitted stay live — toast tells the
 * maker so they can cancel via the Orders tab. Auto-cancelling would
 * require yet more signatures, defeating the point.
 */
import { useEffect, useState } from 'react';
import { useChainId } from 'wagmi';
import toast from 'react-hot-toast';
import { CHAINS, parseUnits, formatUnits, type ChainIdType, type OrderType } from '@owlorderfi/shared';
import { estimateOrderUsd, getMinSliceUsd } from '../lib/feeTiers';
import { useCreateOrder } from '../hooks/useCreateOrder';
import { useSessionForm } from '../hooks/useSessionForm';
import { findToken, getTokens } from '../lib/tokens';
import { formatSmart, trimToSigFigs } from '../lib/formatAmount';
import { useTokenBalance } from '../hooks/useTokenBalance';
import { useTokenApproval } from '../hooks/useTokenApproval';
import { useOutstandingCommitment } from '../hooks/useOutstandingCommitment';
import { useActiveToken } from '../lib/ActiveTokenContext';
import { useMarketPrice } from '../hooks/useMarketPrice';
import { formatAssetPrice, displayPrice } from '../lib/priceFloor';
import { usePriceFlip } from '../lib/PriceFlipContext';
import { ApproveUnlimitedModal } from './ApproveUnlimitedModal';

interface Props {
  enabled: boolean;
}

type Distribution = 'equal' | 'front' | 'back';
type Spacing = 'linear' | 'geometric';

interface FormState {
  // orderType is INFERRED from start vs end price ordering (see derivation
  // below). Kept off the form so the user only sees the inputs that actually
  // change behaviour: tokens + prices + amount + shape.
  tokenIn: string;
  tokenOut: string;
  totalAmountHuman: string;
  numRungs: number;
  startPriceHuman: string; // price at rung 0 (closest to current market)
  endPriceHuman: string;   // price at rung N-1 (furthest from current)
  /**
   * How total amount splits across rungs:
   *   equal — each rung gets 1/N (default; what MVP did)
   *   front — front-loaded: more on the rungs closer to start (heavier
           early exits / early dip buys)
   *   back  — back-loaded: more on the rungs closer to end
   */
  distribution: Distribution;
  /**
   * How prices walk from start to end:
   *   linear    — equal arithmetic step: (end−start)/(N−1) per rung
   *   geometric — equal multiplicative step: (end/start)^(1/(N−1)) per rung
   *               Feels more natural for crypto (10% rises through the
   *               ladder regardless of base price level).
   */
  spacing: Spacing;
  slippagePct: number;
  deadlineHours: number;
}

export function CreateLadderForm({ enabled }: Props) {
  const chainId = useChainId();
  const tokens = getTokens(chainId);
  const { submit, isSubmitting } = useCreateOrder();

  const [form, setForm] = useSessionForm<FormState>(`polyorder.formLadder.${chainId}`, {
    tokenIn: tokens[0].address,
    tokenOut: tokens[1].address,
    totalAmountHuman: '',
    numRungs: 4,
    startPriceHuman: '',
    endPriceHuman: '',
    distribution: 'equal',
    spacing: 'linear',
    slippagePct: 0.5,
    deadlineHours: 24 * 30, // 30 days
  });

  // Token lookups can return undefined during chain switch — the form
  // state still holds the previous chain's addresses for one render
  // before useSessionForm + the reset-effect below snap things back.
  // Use a stub fallback (symbol "?", decimals 18) so .symbol/.decimals
  // access doesn't crash during that one render. CANNOT early-return
  // here — hooks below (useTokenBalance, useMarketPrice, useState
  // displayFlipped, etc.) would change call-order on subsequent
  // renders and React's hook check would explode.
  const tokenInRaw = findToken(chainId, form.tokenIn);
  const tokenOutRaw = findToken(chainId, form.tokenOut);
  const tokenIn =
    tokenInRaw ?? { symbol: '?', decimals: 18, address: form.tokenIn as `0x${string}` };
  const tokenOut =
    tokenOutRaw ?? { symbol: '?', decimals: 18, address: form.tokenOut as `0x${string}` };

  useEffect(() => {
    // If the stored tokens don't exist on the current chain (typically
    // right after a wallet network switch), snap to this chain's first
    // two registered tokens. Brief stub render above keeps the UI
    // alive while React schedules the re-render.
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

  // Internally start/end prices are stored in CANONICAL direction
  // (tokenOut/tokenIn) so the signing math always reads the value it needs;
  // they're rendered in the single fixed display orientation (see `o` below).
  const [rungsInputRaw, setRungsInputRaw] = useState<string>(String(form.numRungs));
  useEffect(() => {
    setRungsInputRaw(String(form.numRungs));
  }, [form.numRungs]);
  // Local raw state for start / end inputs. Without this, every keystroke
  // gets round-tripped through fromDisplay(toDisplay(...)) which strips
  // partial values like "504." (parseFloat eats the trailing dot) and
  // makes the field feel broken. We track what the user actually typed
  // here; canonical form.startPriceHuman / form.endPriceHuman only update
  // on blur (or on external changes like Suggest, swap, wipe — see the
  // syncing effects below).
  // Unlimited-approval flow: default is exact-amount. User opts into
  // max-uint256 via a confirmation modal (see ApproveUnlimitedModal).
  const [approveModalOpen, setApproveModalOpen] = useState(false);
  // Single global display orientation (asset priced in the numéraire by
  // default; the ⇄ flips it everywhere). Ladder, the other forms, and the
  // orders table all show this pair the SAME way. `orient.displayInverse` =
  // whether the displayed number is 1/canonical (tiny shim so the references
  // below read unchanged; it tracks the global flip via `o`).
  const { flipped, toggleFlipped } = usePriceFlip();
  const o = displayPrice({
    canonical: 1,
    flipped,
    tokenInSym: tokenIn.symbol,
    tokenInAddr: form.tokenIn,
    tokenOutSym: tokenOut.symbol,
    tokenOutAddr: form.tokenOut,
  });
  const quoteSym = o.quoteSym;
  const baseSym = o.baseSym;
  const orient = { displayInverse: o.inverted };
  const toDisplay = (canonical: string): string => {
    if (!canonical) return '';
    const n = parseFloat(canonical);
    if (!Number.isFinite(n) || n <= 0) return canonical;
    return trimToSigFigs(orient.displayInverse ? 1 / n : n, 6);
  };
  const fromDisplay = (input: string): string => {
    if (!input) return '';
    if (!orient.displayInverse) return input;
    const n = parseFloat(input);
    if (!Number.isFinite(n) || n <= 0) return input;
    return trimToSigFigs(1 / n, 6);
  };
  const [startInputRaw, setStartInputRaw] = useState<string>('');
  const [endInputRaw, setEndInputRaw] = useState<string>('');
  // Sync raw → canonical happens on blur (see input handlers). Sync the
  // OTHER way — canonical → raw — fires on external mutations to
  // form.startPriceHuman / form.endPriceHuman (Suggest, swap, wipe) and
  // when displayFlipped toggles (so the visible value updates with the
  // perspective flip). Keystroke-time canonical updates don't happen
  // anymore so this effect won't fight live typing.
  useEffect(() => {
    setStartInputRaw(toDisplay(form.startPriceHuman));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.startPriceHuman, orient.displayInverse]);
  useEffect(() => {
    setEndInputRaw(toDisplay(form.endPriceHuman));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.endPriceHuman, orient.displayInverse]);
  const { setActiveTokenIn } = useActiveToken();
  useEffect(() => {
    setActiveTokenIn(form.tokenIn as `0x${string}`);
  }, [form.tokenIn, setActiveTokenIn]);
  const balance = useTokenBalance(form.tokenIn as `0x${string}`);
  const otherCommitted = useOutstandingCommitment(enabled, chainId, form.tokenIn as `0x${string}`);
  const approval = useTokenApproval(form.tokenIn as `0x${string}`, otherCommitted);

  const totalAmountRaw = (() => {
    try {
      return parseUnits(form.totalAmountHuman, tokenIn.decimals);
    } catch {
      return 0n;
    }
  })();
  const amountPerRungRaw = form.numRungs > 0 ? totalAmountRaw / BigInt(form.numRungs) : 0n;

  // Live market quote — amount-independent spot (server-side), so no probe.
  // LIMIT_SELL is the canonical scaling convention, same as the other forms.
  const market = useMarketPrice(
    form.tokenIn as `0x${string}`,
    form.tokenOut as `0x${string}`,
  );
  const currentRate = market.priceScaled !== null
    ? Number(market.priceScaled) / 1e18
    : null;

  // Build the rung breakdown. Linear interpolation between start and
  // end prices; equal amount split across rungs.
  const startPrice = parseFloat(form.startPriceHuman || '0');
  const endPrice = parseFloat(form.endPriceHuman || '0');

  // Order type is INFERRED from the direction of the ladder, not asked
  // explicitly. If the user types start < end → prices ascend across the
  // ladder, each rung fires as the market climbs through it → LIMIT_SELL
  // (trigger ≥ price). start > end → prices descend → LIMIT_BUY
  // (trigger ≤ price; classic dip-buying). No buy/sell toggle means
  // no chance for the maker to pick the wrong semantic by mistake.
  const orderType: OrderType =
    Number.isFinite(startPrice) &&
    Number.isFinite(endPrice) &&
    startPrice > 0 &&
    endPrice > 0 &&
    endPrice < startPrice
      ? 'LIMIT_BUY'
      : 'LIMIT_SELL';

  // Build rung breakdown: price walk + amount split. Two orthogonal
  // dimensions: spacing (how prices step from start to end) and
  // distribution (how the total amount allocates across rungs).
  //
  // Spacing math:
  //   linear:    p_i = start + (end - start) * t              (t = i/(N-1))
  //   geometric: p_i = start * (end/start)^t                  (constant %)
  //
  // Distribution weights (normalized so sum = N, then multiplied by
  // per-rung target = total/N to get each rung's amount):
  //   equal: w_i = 1 for all i
  //   front: w_i decreasing — front-loaded (more on rungs near start)
  //   back:  w_i increasing — back-loaded  (more on rungs near end)
  //
  // For non-equal distributions we use a simple linear weight ramp
  // 2..0 (or 0..2) which sums to N — keeps the contrast clear without
  // an extreme tail. Slight bigint rounding at the end goes onto the
  // last rung so totals match exactly.
  const rungs: Array<{ priceHuman: number; amountRaw: bigint }> = [];
  const validInputs =
    Number.isFinite(startPrice) &&
    Number.isFinite(endPrice) &&
    startPrice > 0 &&
    endPrice > 0 &&
    startPrice !== endPrice &&
    form.numRungs >= 2 &&
    totalAmountRaw > 0n;
  if (validInputs) {
    const N = form.numRungs;
    // 1) Price per rung
    const prices: number[] = [];
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      const p =
        form.spacing === 'geometric'
          ? startPrice * Math.pow(endPrice / startPrice, t)
          : startPrice + (endPrice - startPrice) * t;
      prices.push(p);
    }
    // 2) Weights normalized so sum = N (so weight × total/N = rung amount)
    const weights: number[] = [];
    for (let i = 0; i < N; i++) {
      const t = N === 1 ? 0 : i / (N - 1);
      if (form.distribution === 'equal') weights.push(1);
      else if (form.distribution === 'front') weights.push(2 - 2 * t); // 2 → 0
      else /* back */ weights.push(2 * t);                              // 0 → 2
    }
    // Edge: pure 'back' or 'front' produces a rung with weight 0 (zero
    // amount). Clamp to a floor (10% of equal share) so every rung
    // gets at least a token allocation; renormalize after.
    const minWeight = 0.2;
    const clamped = weights.map((w) => Math.max(w, minWeight));
    const sum = clamped.reduce((a, b) => a + b, 0);
    const normalized = clamped.map((w) => (w * N) / sum);
    // 3) Allocate amounts in bigint, putting rounding slack on last rung
    const perEqual = totalAmountRaw / BigInt(N);
    let allocated = 0n;
    for (let i = 0; i < N - 1; i++) {
      const a = (perEqual * BigInt(Math.round(normalized[i] * 1000))) / 1000n;
      rungs.push({ priceHuman: prices[i], amountRaw: a });
      allocated += a;
    }
    rungs.push({ priceHuman: prices[N - 1], amountRaw: totalAmountRaw - allocated });
  }

  // Plain-language description of what's about to happen. Reads off
  // the actual ladder parameters so the user can sanity-check that
  // the form matches their intent. Direction phrasing flips with the
  // perspective toggle so "rises/drops" stays consistent with the
  // numbers actually shown to the user.
  const actionDescription = (() => {
    if (rungs.length === 0) return null;
    const startDisplayed = orient.displayInverse ? 1 / startPrice : startPrice;
    const endDisplayed = orient.displayInverse ? 1 / endPrice : endPrice;
    const direction = startDisplayed < endDisplayed ? 'rises' : 'drops';
    return (
      `Send ${formatSmart(Number(formatUnits(totalAmountRaw, tokenIn.decimals)))} ${tokenIn.symbol} ` +
      `across ${rungs.length} rungs, receive ${tokenOut.symbol} as the rate ${direction} ` +
      `from ${formatSmart(startDisplayed)} to ${formatSmart(endDisplayed)} ${quoteSym}/${baseSym}.`
    );
  })();

  // Per-rung minimum coverage so the keeper can profitably execute each
  // rung. Same floor as DCA/TWAP slices ($MIN_SLICE_USD_MAINNET on mainnet,
  // 0 on testnets where gas is free). Total minimum scales with number
  // of rungs since each rung is an independent on-chain execution.
  const chainInfo = CHAINS[chainId as ChainIdType];
  const isTestnetChain = chainInfo?.isTestnet ?? false;
  const minPerRungUsd = getMinSliceUsd(isTestnetChain);
  const minTotalUsd = minPerRungUsd * form.numRungs;
  const totalUsd = estimateOrderUsd({
    amountInHuman: form.totalAmountHuman,
    tokenInSymbol: tokenIn.symbol,
    tokenOutSymbol: tokenOut.symbol,
    priceScaled: market.priceScaled,
  });
  const belowMinCoverage =
    !isTestnetChain &&
    minPerRungUsd > 0 &&
    totalUsd !== null &&
    totalUsd > 0 &&
    totalUsd < minTotalUsd;

  // Auto-suggest sensible defaults: ±10% around current rate, plus a
  // rung count that gives each rung enough USD to clear break-even.
  // Skipped fields stay untouched so the user keeps anything they
  // already typed deliberately.
  const suggestEnabled = enabled && !isSubmitting && currentRate !== null && currentRate > 0;
  // Tracks the inputs that fed the last successful Suggest run. When the
  // user changes amount or slippage afterwards, the recommended range
  // becomes stale (rung count + min-coverage no longer match), so we
  // wipe start/end and force the user to re-run Suggest rather than
  // silently leaving them with mismatched values. Manual edits to
  // start/end/swap also reset this so future input changes don't wipe
  // values the user is now owning themselves.
  const [suggestSignature, setSuggestSignature] = useState<string | null>(null);
  const currentSuggestInputs = `${form.totalAmountHuman}|${form.slippagePct}|${form.tokenIn}|${form.tokenOut}`;
  useEffect(() => {
    if (suggestSignature !== null && suggestSignature !== currentSuggestInputs) {
      setForm((f) => ({ ...f, startPriceHuman: '', endPriceHuman: '' }));
      setSuggestSignature(null);
    }
  }, [suggestSignature, currentSuggestInputs, setForm]);

  const handleSuggest = () => {
    if (!suggestEnabled) return;
    // Spread is the favorable-side range we lay rungs across (canonical
    // 1.02× current → 1.20× current = 18% wide).
    const spreadPct = 0.18;
    // Granularity floor: don't pack rungs closer than max(2%, 3× slippage),
    // otherwise consecutive rungs effectively fire at the same price after
    // slippage absorption — wasted gas + signatures for nothing.
    const gapPct = Math.max(0.02, (form.slippagePct / 100) * 3);
    const rungsFromGranularity = Math.max(2, Math.min(10, Math.round(spreadPct / gapPct)));
    // Amount floor: each rung must earn enough fee to cover keeper gas.
    // Aim for ~2× the per-rung break-even so a small price drift doesn't
    // push individual rungs below margin.
    const rungsFromAmount =
      totalUsd !== null && totalUsd > 0 && minPerRungUsd > 0
        ? Math.max(2, Math.floor(totalUsd / (minPerRungUsd * 2)))
        : 10;
    const suggestedRungs = Math.max(2, Math.min(10, Math.min(rungsFromGranularity, rungsFromAmount)));

    // Range sits ENTIRELY on the favorable side of current — not centered
    // around it. Canonical (tokenOut/tokenIn) increases when the trade
    // becomes more favorable for the maker regardless of side: selling
    // tokenIn for more tokenOut, OR buying tokenOut with less tokenIn —
    // both surface as a higher canonical ratio. start < end → orderType
    // infers to LIMIT_SELL, matching "sell into strength / buy on dip".
    const start = trimToSigFigs(currentRate! * 1.02, 6);
    const end = trimToSigFigs(currentRate! * 1.20, 6);
    setForm({
      ...form,
      numRungs: suggestedRungs,
      startPriceHuman: start,
      endPriceHuman: end,
    });
    setSuggestSignature(currentSuggestInputs);
  };

  // Validation
  const validationError = (() => {
    if (!enabled) return 'Sign-in to continue';
    if (form.tokenIn === form.tokenOut) return 'Same token in and out';
    if (totalAmountRaw === 0n) return 'Enter total amount';
    if (form.numRungs < 2 || form.numRungs > 10) return 'Rungs must be 2-10';
    if (startPrice <= 0) return 'Enter start price';
    if (endPrice <= 0) return 'Enter end price';
    if (startPrice === endPrice) return 'Start and end prices must differ';
    if (!balance.isLoading && totalAmountRaw > balance.balance) {
      return `Insufficient ${tokenIn.symbol}: have ${formatSmart(Number(formatUnits(balance.balance, tokenIn.decimals)))}, need ${formatSmart(Number(formatUnits(totalAmountRaw, tokenIn.decimals)))}`;
    }
    return null;
  })();

  // Combined commitment for approval sizing: ALL rungs at once
  const showApprove = enabled && !validationError && approval.needsApproval(totalAmountRaw);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (validationError || rungs.length === 0) return;

    // Generate one ladderId for the whole batch. crypto.randomUUID is
    // available in all modern browsers and Node 19+.
    const ladderId = crypto.randomUUID();
    const minAmountOutPct = (10_000 - Math.round(form.slippagePct * 100)) / 10_000;

    let createdCount = 0;
    const toastId = toast.loading(`Signing rung 1/${rungs.length}…`);
    for (let i = 0; i < rungs.length; i++) {
      toast.loading(`Signing rung ${i + 1}/${rungs.length}…`, { id: toastId });
      const rung = rungs[i];
      // Trigger price in 1e18 scale. Same direction-of-meaning as
      // CreateOrderForm: useMarketPrice/priceScaledFromAmounts convention.
      // For LIMIT_SELL: triggerPrice = tokenOut_human/tokenIn_human × 1e18
      // For LIMIT_BUY:  triggerPrice = tokenIn_human/tokenOut_human × 1e18
      // The trigger value the user typed IS already in their natural
      // direction (e.g. "$50 per WETH"); convert based on orderType.
      // Trigger price is the rung's exchange rate × 1e18 — same scaling
      // as the rest of the codebase (priceScaledFromAmounts / minPriceScaled).
      const triggerPrice = BigInt(Math.round(rung.priceHuman * 1e18));
      // Estimate minAmountOut given the rung price + slippage. Direction
      // matches orderType inferred above: SELL → amountOut = amountIn × price,
      // BUY → amountOut = amountIn / price. Slippage shaves a few bps off
      // either way; the on-chain swap re-enforces this via the aggregator.
      const minOutEstimate =
        orderType === 'LIMIT_SELL'
          ? BigInt(Math.floor(Number(rung.amountRaw) * rung.priceHuman * minAmountOutPct))
          : BigInt(Math.floor((Number(rung.amountRaw) / rung.priceHuman) * minAmountOutPct));

      const result = await submit({
        orderType,
        tokenIn: form.tokenIn,
        tokenOut: form.tokenOut,
        amountIn: rung.amountRaw.toString(),
        minAmountOut: minOutEstimate.toString(),
        triggerPrice: triggerPrice.toString(),
        deadlineHours: form.deadlineHours,
        feeBps: 30,
        ladderId,
        ladderRungIndex: i,
      });
      if (!result) {
        toast.dismiss(toastId);
        if (createdCount > 0) {
          toast.error(
            `Ladder partial: ${createdCount}/${rungs.length} rungs created. Cancel them via the Orders tab if not wanted.`,
            { duration: 8000 },
          );
        } else {
          toast.error('Ladder cancelled at first rung');
        }
        return;
      }
      createdCount++;
    }
    toast.dismiss(toastId);
    toast.success(`Ladder created: ${rungs.length} rungs`);
    setForm((f) => ({ ...f, totalAmountHuman: '' }));
  };

  const formDisabled = !enabled || isSubmitting;
  const inputClass =
    'w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400 focus:border-cyan-500 focus:outline-none disabled:opacity-50';

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-400">
            Send (tokenIn)
          </label>
          <select
            disabled={formDisabled}
            value={form.tokenIn}
            onChange={(e) => setForm({ ...form, tokenIn: e.target.value })}
            className={inputClass}
          >
            {tokens.map((t) => (
              <option key={t.address} value={t.address}>
                {t.symbol}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={() => {
            // Two scenarios handled by leaving the Suggest signature alone:
            //   - User typed start/end manually (signature is null already):
            //     the inverted values below preserve their work across the
            //     swap, since the invalidation effect won't fire without a
            //     signature.
            //   - User came from Suggest (signature is set): the swap flips
            //     tokenIn/tokenOut, which makes currentSuggestInputs differ
            //     from the stored signature, so the effect wipes start/end
            //     anyway. Live quote for the new direction isn't an exact
            //     1/old reciprocal (pool depth asymmetry, probe size), so
            //     forcing a re-Suggest gives the user a clean range.
            setForm((p) => {
              const s = parseFloat(p.startPriceHuman || '0');
              const e = parseFloat(p.endPriceHuman || '0');
              const invStart = Number.isFinite(e) && e > 0 ? trimToSigFigs(1 / e, 6) : '';
              const invEnd = Number.isFinite(s) && s > 0 ? trimToSigFigs(1 / s, 6) : '';
              return {
                ...p,
                tokenIn: p.tokenOut,
                tokenOut: p.tokenIn,
                startPriceHuman: invStart,
                endPriceHuman: invEnd,
              };
            });
          }}
          disabled={formDisabled}
          className="mb-1 rounded-lg border border-slate-700 px-2 py-1.5 text-slate-300 hover:bg-slate-800 disabled:opacity-50"
          title="Swap direction (inverts start/end prices)"
        >
          ⇄
        </button>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-400">
            Receive (tokenOut)
          </label>
          <select
            disabled={formDisabled}
            value={form.tokenOut}
            onChange={(e) => setForm({ ...form, tokenOut: e.target.value })}
            className={inputClass}
          >
            {tokens.map((t) => (
              <option key={t.address} value={t.address}>
                {t.symbol}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Live market rate — click to flip how all prices read (global). */}
      <button
        type="button"
        onClick={toggleFlipped}
        title="Click to flip how prices are shown everywhere (display only)"
        className="block w-full rounded-lg border border-cyan-900/40 bg-cyan-950/30 px-4 py-3 text-center transition hover:border-cyan-700/50"
      >
        <div className="text-xs uppercase tracking-wider text-slate-400">Now</div>
        <div className="mt-0.5 font-mono text-lg text-cyan-100">
          {currentRate !== null
            ? `1 ${baseSym} ≈ ${formatAssetPrice(orient.displayInverse ? 1 / currentRate : currentRate)} ${quoteSym}`
            : 'Loading live rate…'}
          <span className="ml-2 text-slate-500" aria-hidden>⇄</span>
        </div>
      </button>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleSuggest}
          disabled={!suggestEnabled}
          title={
            suggestEnabled
              ? 'Auto-fill prices (±10% around current) and a rung count sized to your amount'
              : 'Waiting for live rate…'
          }
          className="rounded-lg border border-cyan-700/50 bg-cyan-950/40 px-3 py-1.5 text-xs text-cyan-200 hover:border-cyan-500 hover:bg-cyan-900/40 disabled:opacity-40"
        >
          ✨ Suggest defaults
        </button>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-400">
          Total amount ({tokenIn.symbol})
        </label>
        <input
          type="text"
          inputMode="decimal"
          disabled={formDisabled}
          value={form.totalAmountHuman}
          onChange={(e) => setForm({ ...form, totalAmountHuman: e.target.value })}
          placeholder="0.0"
          className={inputClass}
        />
        {amountPerRungRaw > 0n && form.numRungs > 0 && form.distribution === 'equal' && (
          <p className="mt-1 text-xs text-slate-500">
            Per rung: {formatSmart(Number(formatUnits(amountPerRungRaw, tokenIn.decimals)))} {tokenIn.symbol}
          </p>
        )}
        {belowMinCoverage && (
          <p className="mt-1 text-xs text-rose-400">
            Minimum recommended for {form.numRungs} rungs: ~${formatSmart(minTotalUsd)} (≈ $
            {formatSmart(minPerRungUsd)}/rung). Below that, fee per rung may not
            cover keeper gas → rungs can sit unfilled even when price hits.
          </p>
        )}
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-400">
          Number of rungs (2-10)
        </label>
        <input
          type="number"
          min={2}
          max={10}
          disabled={formDisabled}
          value={rungsInputRaw}
          onChange={(e) => setRungsInputRaw(e.target.value)}
          onBlur={() => {
            const parsed = parseInt(rungsInputRaw, 10);
            const clamped = Number.isFinite(parsed)
              ? Math.max(2, Math.min(10, parsed))
              : form.numRungs;
            setForm({ ...form, numRungs: clamped });
            setRungsInputRaw(String(clamped));
          }}
          className={inputClass}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-400">
            Amount distribution
          </label>
          <div className="flex gap-1">
            {(
              [
                { v: 'equal', label: 'Equal', hint: 'All rungs same size' },
                { v: 'front', label: 'Front', hint: 'More on early rungs' },
                { v: 'back', label: 'Back', hint: 'More on late rungs' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.v}
                type="button"
                disabled={formDisabled}
                onClick={() => setForm({ ...form, distribution: opt.v })}
                title={opt.hint}
                className={`flex-1 rounded-lg border px-2 py-1.5 text-xs disabled:opacity-50 ${
                  form.distribution === opt.v
                    ? 'border-cyan-500 bg-cyan-500/15 text-cyan-200'
                    : 'border-slate-800 bg-slate-950 text-slate-300'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-400">
            Price spacing
          </label>
          <div className="flex gap-1">
            {(
              [
                { v: 'linear', label: 'Linear', hint: 'Equal price steps' },
                { v: 'geometric', label: 'Geometric', hint: 'Equal % steps (constant ratio)' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.v}
                type="button"
                disabled={formDisabled}
                onClick={() => setForm({ ...form, spacing: opt.v })}
                title={opt.hint}
                className={`flex-1 rounded-lg border px-2 py-1.5 text-xs disabled:opacity-50 ${
                  form.spacing === opt.v
                    ? 'border-cyan-500 bg-cyan-500/15 text-cyan-200'
                    : 'border-slate-800 bg-slate-950 text-slate-300'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs font-medium uppercase tracking-wider text-slate-400">
          Rung prices
        </span>
        <span className="text-xs text-slate-400">
          showing {quoteSym}/{baseSym}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs text-slate-500">
            Start ({quoteSym}/{baseSym})
          </label>
          <input
            type="text"
            inputMode="decimal"
            disabled={formDisabled}
            value={startInputRaw}
            onChange={(e) => setStartInputRaw(e.target.value)}
            onBlur={() => {
              setForm({ ...form, startPriceHuman: fromDisplay(startInputRaw) });
              setSuggestSignature(null);
            }}
            placeholder="e.g. 50.00"
            className={inputClass}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-slate-500">
            End ({quoteSym}/{baseSym})
          </label>
          <input
            type="text"
            inputMode="decimal"
            disabled={formDisabled}
            value={endInputRaw}
            onChange={(e) => setEndInputRaw(e.target.value)}
            onBlur={() => {
              setForm({ ...form, endPriceHuman: fromDisplay(endInputRaw) });
              setSuggestSignature(null);
            }}
            placeholder="e.g. 80.00"
            className={inputClass}
          />
        </div>
      </div>

      {actionDescription && (
        <div className="rounded-md border border-cyan-900/40 bg-cyan-950/20 px-3 py-2 text-sm text-cyan-200">
          {actionDescription}
        </div>
      )}

      {/* Rung preview */}
      {rungs.length > 0 && (
        <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-sm">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="font-medium text-slate-200">Preview ({rungs.length} rungs)</span>
            {currentRate !== null && (
              <span className="text-xs text-slate-400">
                Now:{' '}
                <span className="font-mono text-slate-200">
                  {formatAssetPrice(orient.displayInverse ? 1 / currentRate : currentRate)}{' '}
                  {quoteSym}/{baseSym}
                </span>
              </span>
            )}
          </div>
          <div className="space-y-1 font-mono text-xs">
            {rungs.map((r, i) => {
              // Colour comparison runs in CANONICAL direction always —
              // distance-from-current is the same regardless of view flip.
              // The displayed price is the flipped one, but the tier
              // (above/below market) is invariant.
              const positionColor =
                currentRate === null
                  ? 'text-slate-300'
                  : r.priceHuman > currentRate
                    ? 'text-emerald-300/90'
                    : r.priceHuman < currentRate
                      ? 'text-amber-300/90'
                      : 'text-cyan-300';
              const displayedPrice = orient.displayInverse ? 1 / r.priceHuman : r.priceHuman;
              // Distance from current price in DISPLAYED direction so the
              // sign matches what the user reads on the row: BUY ladder
              // (flipped USDC/WETH) gets negative % (= cheaper); SELL
              // ladder (canonical USDC/WETH) gets positive % (= higher).
              const currentDisplayed =
                currentRate !== null
                  ? orient.displayInverse ? 1 / currentRate : currentRate
                  : null;
              const deltaPct =
                currentDisplayed !== null && currentDisplayed > 0
                  ? ((displayedPrice - currentDisplayed) / currentDisplayed) * 100
                  : null;
              const deltaStr =
                deltaPct !== null
                  ? `${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}%`
                  : '';
              return (
                <div key={i} className="flex justify-between">
                  <span className="text-slate-500">Rung {i + 1}</span>
                  <span className={positionColor}>
                    {formatSmart(Number(formatUnits(r.amountRaw, tokenIn.decimals)))} {tokenIn.symbol} @{' '}
                    {formatSmart(displayedPrice)} {quoteSym}/{baseSym}
                    {deltaStr && (
                      <span className="ml-2 text-slate-500">({deltaStr})</span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-400">
            Slippage tolerance (%)
          </label>
          <input
            type="number"
            step="0.1"
            min="0"
            max="10"
            disabled={formDisabled}
            value={form.slippagePct}
            onChange={(e) => setForm({ ...form, slippagePct: Number(e.target.value) || 0.5 })}
            className={inputClass}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-400">
            Deadline (hours)
          </label>
          <input
            type="number"
            min={1}
            disabled={formDisabled}
            value={form.deadlineHours}
            onChange={(e) =>
              setForm({ ...form, deadlineHours: Math.max(1, Number(e.target.value) || 720) })
            }
            className={inputClass}
          />
        </div>
      </div>

      {showApprove ? (
        <div className="space-y-1.5">
          <button
            type="button"
            disabled={approval.isApproving}
            onClick={() => {
              void approval.approve(totalAmountRaw + otherCommitted).catch(() => {});
            }}
            className="w-full rounded-lg bg-amber-500 px-4 py-2.5 text-sm font-medium text-slate-950 hover:bg-amber-400 disabled:opacity-50"
          >
            {approval.isApproving
              ? 'Approving…'
              : `Approve ${formatSmart(Number(formatUnits(totalAmountRaw + otherCommitted, tokenIn.decimals)))} ${tokenIn.symbol} (exact)`}
          </button>
          <button
            type="button"
            disabled={approval.isApproving}
            onClick={() => setApproveModalOpen(true)}
            className="block w-full text-center text-xs text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline disabled:opacity-50"
          >
            Approve unlimited instead (advanced)
          </button>
        </div>
      ) : (
        <button
          type="submit"
          disabled={formDisabled || validationError !== null}
          className="w-full rounded-lg bg-cyan-500 px-4 py-2.5 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
        >
          {!enabled
            ? 'Sign-in first'
            : isSubmitting
              ? 'Signing ladder…'
              : validationError
                ? validationError
                : `Create ladder (${rungs.length} signatures)`}
        </button>
      )}

      <p className="pt-1 text-center text-xs text-slate-500">
        Limit orders are tools, not promises — they may not fill if price never
        reaches your level, and execution depends on pool liquidity. Always do
        your own due diligence.
      </p>

      <ApproveUnlimitedModal
        open={approveModalOpen}
        onClose={() => setApproveModalOpen(false)}
        tokenSymbol={tokenIn.symbol}
        orderKindLabel="ladder"
        chainId={chainId}
        onConfirm={async () => {
          setApproveModalOpen(false);
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
