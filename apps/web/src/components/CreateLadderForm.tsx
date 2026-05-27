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
import { useEffect } from 'react';
import { useChainId } from 'wagmi';
import toast from 'react-hot-toast';
import { parseUnits, formatUnits, type OrderType } from '@owlorderfi/shared';
import { useCreateOrder } from '../hooks/useCreateOrder';
import { useSessionForm } from '../hooks/useSessionForm';
import { findToken, getTokens } from '../lib/tokens';
import { formatSmart } from '../lib/formatAmount';
import { useTokenBalance } from '../hooks/useTokenBalance';
import { useTokenApproval } from '../hooks/useTokenApproval';
import { useOutstandingCommitment } from '../hooks/useOutstandingCommitment';
import { useActiveToken } from '../lib/ActiveTokenContext';

interface Props {
  enabled: boolean;
}

interface FormState {
  // orderType is INFERRED from start vs end price ordering (see derivation
  // below). Kept off the form so the user only sees the inputs that actually
  // change behaviour: tokens + prices + amount.
  tokenIn: string;
  tokenOut: string;
  totalAmountHuman: string;
  numRungs: number;
  startPriceHuman: string; // price at rung 0 (closest to current market)
  endPriceHuman: string;   // price at rung N-1 (furthest from current)
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
    slippagePct: 0.5,
    deadlineHours: 24 * 30, // 30 days
  });

  const tokenIn = findToken(chainId, form.tokenIn)!;
  const tokenOut = findToken(chainId, form.tokenOut)!;
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

  const rungs: Array<{ priceHuman: number; amountRaw: bigint }> = [];
  if (
    Number.isFinite(startPrice) &&
    Number.isFinite(endPrice) &&
    startPrice > 0 &&
    endPrice > 0 &&
    startPrice !== endPrice &&
    form.numRungs >= 2 &&
    amountPerRungRaw > 0n
  ) {
    for (let i = 0; i < form.numRungs; i++) {
      const t = i / (form.numRungs - 1);
      const priceHuman = startPrice + (endPrice - startPrice) * t;
      rungs.push({ priceHuman, amountRaw: amountPerRungRaw });
    }
  }

  // Plain-language description of what's about to happen. Reads off
  // the actual ladder parameters so the user can sanity-check that
  // the form matches their intent — no jargon, no toggle to second-guess.
  const actionDescription = (() => {
    if (rungs.length === 0) return null;
    const direction = startPrice < endPrice ? 'rises' : 'drops';
    return (
      `Send ${formatSmart(Number(formatUnits(totalAmountRaw, tokenIn.decimals)))} ${tokenIn.symbol} ` +
      `across ${rungs.length} rungs, receive ${tokenOut.symbol} as the rate ${direction} ` +
      `from ${formatSmart(startPrice)} to ${formatSmart(endPrice)} ${tokenOut.symbol}/${tokenIn.symbol}.`
    );
  })();

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
      // CreateOrderForm: useMarketPrice/computePriceFromQuote convention.
      // For LIMIT_SELL: triggerPrice = tokenOut_human/tokenIn_human × 1e18
      // For LIMIT_BUY:  triggerPrice = tokenIn_human/tokenOut_human × 1e18
      // The trigger value the user typed IS already in their natural
      // direction (e.g. "$50 per WETH"); convert based on orderType.
      // Trigger price is the rung's exchange rate × 1e18 — same scaling
      // as the rest of the codebase (computePriceFromQuote / minPriceScaled).
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
      <div className="grid grid-cols-2 gap-3">
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
        {amountPerRungRaw > 0n && form.numRungs > 0 && (
          <p className="mt-1 text-xs text-slate-500">
            Per rung: {formatSmart(Number(formatUnits(amountPerRungRaw, tokenIn.decimals)))} {tokenIn.symbol}
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
          value={form.numRungs}
          onChange={(e) =>
            setForm({ ...form, numRungs: Math.max(2, Math.min(10, Number(e.target.value) || 4)) })
          }
          className={inputClass}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-400">
            Start price ({tokenOut.symbol}/{tokenIn.symbol})
          </label>
          <input
            type="text"
            inputMode="decimal"
            disabled={formDisabled}
            value={form.startPriceHuman}
            onChange={(e) => setForm({ ...form, startPriceHuman: e.target.value })}
            placeholder="e.g. 50.00"
            className={inputClass}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-400">
            End price ({tokenOut.symbol}/{tokenIn.symbol})
          </label>
          <input
            type="text"
            inputMode="decimal"
            disabled={formDisabled}
            value={form.endPriceHuman}
            onChange={(e) => setForm({ ...form, endPriceHuman: e.target.value })}
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
          <div className="mb-2 font-medium text-slate-200">Preview ({rungs.length} rungs)</div>
          <div className="space-y-1 font-mono text-xs text-slate-300">
            {rungs.map((r, i) => (
              <div key={i} className="flex justify-between">
                <span className="text-slate-500">Rung {i + 1}</span>
                <span>
                  {formatSmart(Number(formatUnits(r.amountRaw, tokenIn.decimals)))} {tokenIn.symbol} @{' '}
                  {formatSmart(r.priceHuman)} {tokenOut.symbol}/{tokenIn.symbol}
                </span>
              </div>
            ))}
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
        <button
          type="button"
          disabled={approval.isApproving}
          onClick={() => { void approval.approve(totalAmountRaw).catch(() => {}); }}
          className="w-full rounded-lg bg-amber-500 px-4 py-2.5 text-sm font-medium text-slate-950 hover:bg-amber-400 disabled:opacity-50"
        >
          {approval.isApproving
            ? 'Approving…'
            : `Approve ${formatSmart(Number(formatUnits(totalAmountRaw, tokenIn.decimals)))} ${tokenIn.symbol} for ladder`}
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
              ? 'Signing ladder…'
              : validationError
                ? validationError
                : `Create ladder (${rungs.length} signatures)`}
        </button>
      )}
    </form>
  );
}
