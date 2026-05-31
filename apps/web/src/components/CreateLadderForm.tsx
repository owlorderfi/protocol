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
import { parseUnits, formatUnits, type OrderType } from '@owlorderfi/shared';
import { useCreateOrder } from '../hooks/useCreateOrder';
import { useSessionForm } from '../hooks/useSessionForm';
import { findToken, getTokens } from '../lib/tokens';
import { computeExpectedAmountOut, applySlippage } from '../lib/orderMath';
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
  // True while the multi-rung signing loop is running. Each created rung
  // invalidates the orders query, so useOutstandingCommitment grows mid-batch
  // and would otherwise flip the approve button to amber as if more allowance
  // were needed — double-counting the rungs we're signing right now (they're
  // already inside totalAmountRaw). Suppressing approve UI for the whole batch
  // keeps the on-screen state stable; the on-chain allowance already covers
  // every rung. useCreateOrder's per-call isSubmitting can't do this — it
  // toggles false in the gaps between rungs.
  const [batchInProgress, setBatchInProgress] = useState(false);
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

  // Per-rung break-even is enforced dynamically by the keeper (limit-
  // order path with live USD anchors); no static floor or coverage warning
  // here. The suggest button picks rung count from the price granularity
  // alone, not from a USD-budget heuristic.

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
    // Pick a sensible rung count based on price granularity; the keeper
    // enforces per-rung break-even at execution time.
    const suggestedRungs = rungsFromGranularity;

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
    // Illiquid-pool guard (matches the Limit form): a degenerate pool reports
    // a garbage spot, so the rung prices derived from it are meaningless.
    // Outside 1e-9..1e9 = not a real market — block with an honest message.
    if (currentRate !== null && (currentRate > 1e9 || currentRate < 1e-9)) {
      return 'Price unavailable — this pair looks illiquid on this chain';
    }
    if (form.numRungs < 2 || form.numRungs > 10) return 'Rungs must be 2-10';
    if (startPrice <= 0) return 'Enter start price';
    if (endPrice <= 0) return 'Enter end price';
    if (startPrice === endPrice) return 'Start and end prices must differ';
    if (!balance.isLoading && totalAmountRaw > balance.balance) {
      return `Insufficient ${tokenIn.symbol}: have ${formatSmart(Number(formatUnits(balance.balance, tokenIn.decimals)))}, need ${formatSmart(Number(formatUnits(totalAmountRaw, tokenIn.decimals)))}`;
    }
    return null;
  })();

  // Soft warning when total commitment of this ladder + sibling orders
  // exceeds the wallet. Hard-block above only catches "this single ladder
  // > balance"; the cross-order shortfall is amber-only and submit stays
  // open (maker may top up, cancel siblings, or accept partial). Mirrors
  // the DCA/TWAP pattern.
  const shortfallWarning = (() => {
    if (!enabled || balance.isLoading || validationError || totalAmountRaw === 0n) return null;
    const totalReserved = totalAmountRaw + otherCommitted;
    if (totalReserved <= balance.balance) return null;
    const haveH = formatSmart(Number(formatUnits(balance.balance, tokenIn.decimals)));
    const needH = formatSmart(Number(formatUnits(totalAmountRaw, tokenIn.decimals)));
    const reservedH = otherCommitted > 0n
      ? formatSmart(Number(formatUnits(otherCommitted, tokenIn.decimals)))
      : null;
    const deficit = totalReserved - balance.balance;
    const deficitH = formatSmart(Number(formatUnits(deficit, tokenIn.decimals)));
    return reservedH
      ? `Wallet (${haveH}) short by ${deficitH} ${tokenIn.symbol} for this ladder (${needH}) + ${reservedH} reserved by other orders. Some rungs will revert when triggered until you top up.`
      : `Wallet (${haveH}) short by ${deficitH} ${tokenIn.symbol} for this ladder (${needH}). Some rungs will revert when triggered until you top up.`;
  })();

  // Combined commitment for approval sizing: ALL rungs at once
  const showApprove =
    enabled && !validationError && !batchInProgress && approval.needsApproval(totalAmountRaw);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (validationError || rungs.length === 0) return;

    // Generate one ladderId for the whole batch. crypto.randomUUID is
    // available in all modern browsers and Node 19+.
    const ladderId = crypto.randomUUID();

    // Precompute each rung's trigger price + minAmountOut so we can reject a
    // dust rung BEFORE signing anything. triggerPrice is the rung's exchange
    // rate × 1e18 (same scaling as priceScaledFromAmounts / minPriceScaled);
    // the user's typed value is already in their natural direction, encoded by
    // orderType. minAmountOut uses computeExpectedAmountOut, which does the
    // decimal-aware bigint math — the old float `amountRaw × priceHuman`
    // skipped the tokenOut/tokenIn decimal scaling, so a small order like
    // 0.001111 USDC → WETH rounded the minOut to 0 and the contract rejected
    // every keeper attempt with InvalidAmount(). Using bigint also avoids the
    // Number() precision loss on 18-decimal amounts above 2^53.
    const prepared = rungs.map((rung) => {
      const triggerPrice = BigInt(Math.round(rung.priceHuman * 1e18));
      const expectedOut = computeExpectedAmountOut({
        orderType,
        amountInRaw: rung.amountRaw,
        triggerPriceScaled: triggerPrice,
        tokenInDecimals: tokenIn.decimals,
        tokenOutDecimals: tokenOut.decimals,
      });
      return { rung, triggerPrice, minAmountOut: applySlippage(expectedOut, form.slippagePct) };
    });

    const dustRung = prepared.findIndex((p) => p.minAmountOut === 0n);
    if (dustRung !== -1) {
      toast.error(
        `Rung ${dustRung + 1} is too small — its output rounds to 0 after slippage. ` +
          `Increase the total amount or reduce the number of rungs.`,
        { duration: 7000 },
      );
      return;
    }

    // Hold the batch flag for the whole loop so the approve button doesn't
    // flip mid-signing (see batchInProgress). finally guarantees it clears on
    // every exit — success, partial bail, or a thrown error.
    setBatchInProgress(true);
    try {
      let createdCount = 0;
      const toastId = toast.loading(`Signing rung 1/${rungs.length}…`);
      for (let i = 0; i < prepared.length; i++) {
        toast.loading(`Signing rung ${i + 1}/${rungs.length}…`, { id: toastId });
        const { rung, triggerPrice, minAmountOut } = prepared[i];

        const result = await submit({
          orderType,
          tokenIn: form.tokenIn,
          tokenOut: form.tokenOut,
          amountIn: rung.amountRaw.toString(),
          minAmountOut: minAmountOut.toString(),
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
    } finally {
      setBatchInProgress(false);
    }
  };

  const formDisabled = !enabled || isSubmitting || batchInProgress;
  const inputClass =
    'w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400 focus:border-cyan-500 focus:outline-none disabled:opacity-50';

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
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
        </div>
        {currentRate !== null && (
          <div className="mt-0.5 text-xs text-slate-500">
            <span className="font-mono">{o.directionLabel}</span> <span aria-hidden>⇄</span>
          </div>
        )}
      </button>

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
        {/* Per-rung break-even warning removed: the keeper now refuses
            execution dynamically when fee < gas × 1.5 (live USD pricing),
            so a sitting-unfilled rung surfaces with a clear reason on the
            order row instead of being pre-blocked here at a stale floor. */}
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
            {(() => {
              // Per-rung expected output AT each rung's own trigger — that's
              // the rate the user explicitly chose for that rung, so it's
              // the concrete yield to display next to it. Accumulate the
              // sum for the "Total if all fill" line below the list.
              let totalExpected = 0n;
              const rows = rungs.map((r, i) => {
                const positionColor =
                  currentRate === null
                    ? 'text-slate-300'
                    : r.priceHuman > currentRate
                      ? 'text-emerald-300/90'
                      : r.priceHuman < currentRate
                        ? 'text-amber-300/90'
                        : 'text-cyan-300';
                const displayedPrice = orient.displayInverse ? 1 / r.priceHuman : r.priceHuman;
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
                let expectedHuman: string | null = null;
                try {
                  const triggerScaled = BigInt(Math.round(r.priceHuman * 1e18));
                  const exp = computeExpectedAmountOut({
                    orderType,
                    amountInRaw: r.amountRaw,
                    triggerPriceScaled: triggerScaled,
                    tokenInDecimals: tokenIn.decimals,
                    tokenOutDecimals: tokenOut.decimals,
                  });
                  totalExpected += exp;
                  expectedHuman = formatUnits(exp, tokenOut.decimals);
                } catch {
                  // Skip — row still renders without the yield hint.
                }
                return (
                  <div key={i} className="flex justify-between">
                    <span className="text-slate-500">Rung {i + 1}</span>
                    <span className={positionColor}>
                      {formatSmart(Number(formatUnits(r.amountRaw, tokenIn.decimals)))} {tokenIn.symbol} @{' '}
                      {formatSmart(displayedPrice)} {quoteSym}/{baseSym}
                      {deltaStr && (
                        <span className="ml-2 text-slate-500">({deltaStr})</span>
                      )}
                      {expectedHuman && (
                        <span className="ml-2 text-slate-400">
                          → ≈ {formatSmart(Number(expectedHuman))} {tokenOut.symbol}
                        </span>
                      )}
                    </span>
                  </div>
                );
              });
              return (
                <>
                  {rows}
                  {totalExpected > 0n && (
                    <div
                      className="mt-1 flex justify-between border-t border-slate-800 pt-1 text-slate-400"
                      title={`Worst-case yield if every rung fills at exactly its trigger price. Real fills usually come in better when the market overshoots the trigger.`}
                    >
                      <span>Total if all rungs fill at triggers</span>
                      <span className="text-slate-200">
                        ≈ {formatSmart(Number(formatUnits(totalExpected, tokenOut.decimals)))} {tokenOut.symbol}
                      </span>
                    </div>
                  )}
                </>
              );
            })()}
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

      {shortfallWarning && (
        <div className="rounded border border-amber-900/50 bg-amber-950/40 p-3 text-sm text-amber-300">
          ⚠️ {shortfallWarning}
        </div>
      )}

      {showApprove ? (
        <div className="space-y-1.5">
          <button
            type="button"
            disabled={approval.isApproving}
            onClick={() => {
              // Always exact: all rungs PLUS the user's existing outstanding
              // commitment on the same token, so this approval doesn't
              // short-change a running DCA/TWAP/limit by stealing its
              // allowance. The "approve unlimited" path is the link below.
              void approval.approve(totalAmountRaw + otherCommitted).catch(() => {});
            }}
            className="w-full rounded-lg bg-amber-500 px-4 py-2.5 text-sm font-medium text-slate-950 hover:bg-amber-400 disabled:opacity-50"
          >
            {approval.isApproving
              ? `Approving ${tokenIn.symbol}…`
              : `1. Approve ${formatSmart(Number(formatUnits(totalAmountRaw + otherCommitted, tokenIn.decimals)))} ${tokenIn.symbol} (exact)`}
          </button>
          <button
            type="button"
            disabled={approval.isApproving}
            onClick={() => setApproveModalOpen(true)}
            className="block w-full text-center text-xs text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline disabled:opacity-50"
          >
            Approve unlimited instead (advanced)
          </button>
          {otherCommitted > 0n && (
            <div className="text-xs text-slate-500">
              Sum = {form.totalAmountHuman || '0'} (all rungs) +{' '}
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
              : isSubmitting || batchInProgress
                ? 'Signing ladder…'
                : validationError
                  ? validationError
                  : `Create ladder (${rungs.length} signatures)`}
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
