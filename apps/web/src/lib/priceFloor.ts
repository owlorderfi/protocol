/**
 * Price display + maker-signed floor helpers.
 *
 * ONE simple, fixed rule: the displayed direction follows the SWAP
 * direction — tokenIn/tokenOut. A USDC→WETH swap shows "USDC/WETH"
 * ("1 WETH = X USDC"); flip the pair to WETH→USDC and it shows "WETH/USDC".
 * No numéraire/"stable" rule, no per-pair state. The global ⇄ toggle just
 * swaps to tokenOut/tokenIn — purely a render choice (1/x), it never touches
 * stored/canonical values or what gets signed.
 *
 * `displayPrice(canonical, tokens, flipped)` is the single source of truth:
 * it returns the value AND its unit together, so they can never disagree.
 * Everything that shows a price funnels through it; nothing does its own
 * 1/x or builds its own label.
 */

interface PairTokens {
  tokenInSym: string;
  tokenInAddr: string;
  tokenOutSym: string;
  tokenOutAddr: string;
}

export interface DisplayedPrice {
  /** Value in the shown orientation: QUOTE units per 1 BASE. */
  value: number;
  /** The asset being priced (the "1 X" leg). */
  baseSym: string;
  /** The unit it's priced in. */
  quoteSym: string;
  /** "{quoteSym}/{baseSym}", e.g. "USDC/WETH" (= tokenIn/tokenOut default). */
  unit: string;
  /**
   * Technical orientation hint independent of the token symbols:
   * "tokenIn / tokenOut" (default) or "tokenOut / tokenIn" (flipped). The
   * symbols are already shown at the swap picker + in the price line, so the
   * hint states the direction itself.
   */
  directionLabel: string;
  /**
   * True when the displayed value is `1 / canonical` (the default,
   * tokenIn/tokenOut direction). A canonical minimum (floor) then reads as a
   * maximum, so a "stop" condition flips from "drops below" to "rises above".
   */
  inverted: boolean;
}

/**
 * Orient a CANONICAL price (tokenOut per tokenIn, human units) for display.
 * The direction is the swap direction, flippable by the global toggle:
 *
 *   default  → unit = tokenIn/tokenOut, value = tokenIn per tokenOut = 1/canonical
 *              (e.g. USDC→WETH shows "1 WETH = X USDC", unit "USDC/WETH")
 *   flipped  → unit = tokenOut/tokenIn, value = tokenOut per tokenIn = canonical
 *
 * `flipped` is the single global view toggle — purely a render choice; it
 * never touches stored/canonical values.
 */
export function displayPrice(args: { canonical: number; flipped?: boolean } & PairTokens): DisplayedPrice {
  const { canonical, flipped = false } = args;
  if (flipped) {
    // tokenOut/tokenIn — base = tokenIn, value = tokenOut per tokenIn = canonical.
    return {
      value: canonical,
      baseSym: args.tokenInSym,
      quoteSym: args.tokenOutSym,
      unit: `${args.tokenOutSym}/${args.tokenInSym}`,
      directionLabel: 'tokenOut / tokenIn',
      inverted: false,
    };
  }
  // Default: tokenIn/tokenOut — base = tokenOut, value = tokenIn per tokenOut = 1/canonical.
  return {
    value: canonical > 0 ? 1 / canonical : 0,
    baseSym: args.tokenOutSym,
    quoteSym: args.tokenInSym,
    unit: `${args.tokenInSym}/${args.tokenOutSym}`,
    directionLabel: 'tokenIn / tokenOut',
    inverted: true,
  };
}

/**
 * Inverse of `displayPrice`: convert a value the user typed in the displayed
 * orientation back to canonical (tokenOut per tokenIn). Must use the SAME
 * `flipped` the input was shown under.
 */
export function displayedToCanonical(displayed: number, _t: PairTokens, flipped = false): number {
  if (flipped) return displayed; // shown as canonical
  return displayed > 0 ? 1 / displayed : 0; // shown as 1/canonical
}

/**
 * Normalize an order-type-oriented price (how triggerPrice / minPriceScaled
 * are stored) to canonical (tokenOut per tokenIn). BUY/STOP store the
 * inverse (tokenIn per tokenOut); SELL/TAKE store canonical. Self-inverse —
 * applying it again converts canonical back to the order-type orientation.
 */
export function toCanonicalPrice(value: number, orderType: string): number {
  if (value <= 0) return value;
  return orderType === 'LIMIT_BUY' || orderType === 'STOP_LOSS' ? 1 / value : value;
}

export interface FloorComputation {
  /** Maker-signed value, ready for the EIP-712 message. "0" = no floor. */
  minPriceScaled: string;
  /** Current price (canonical, human). Null when no quote loaded. */
  currentAssetPrice: number | null;
  /** Floor (tolerance-adjusted), same direction. Null when off / no quote. */
  thresholdAssetPrice: number | null;
}

/**
 * Derive the maker-signed floor from a current canonical quote and a
 * tolerance preset. Orientation-agnostic in scaled space:
 *
 *   minPriceScaled = currentPriceScaled × (10_000 − tolBps) / 10_000
 *
 * tolerancePct=0 is "off" (no floor); the contract skips the post-swap
 * minOut check when minPriceScaled is 0.
 */
export function computeFloor(params: {
  currentPriceScaled: bigint | null;
  tolerancePct: number;
}): FloorComputation {
  const { currentPriceScaled, tolerancePct } = params;

  if (tolerancePct === 0 || !currentPriceScaled || currentPriceScaled <= 0n) {
    const current = currentPriceScaled && currentPriceScaled > 0n
      ? Number(currentPriceScaled) / 1e18
      : null;
    return { minPriceScaled: '0', currentAssetPrice: current, thresholdAssetPrice: null };
  }

  const tolBps = BigInt(Math.round(tolerancePct * 100));
  // Defensive: tolBps > 10_000 (>100%) would underflow the bigint
  // subtraction. Clamp to "100% drop" = floor at zero = effectively no floor.
  const safeTolBps = tolBps >= 10_000n ? 10_000n : tolBps;
  const minScaled = (currentPriceScaled * (10_000n - safeTolBps)) / 10_000n;

  return {
    minPriceScaled: minScaled.toString(),
    currentAssetPrice: Number(currentPriceScaled) / 1e18,
    thresholdAssetPrice: minScaled > 0n ? Number(minScaled) / 1e18 : null,
  };
}

/** Format a price with sensible precision for typical crypto magnitudes. */
export function formatAssetPrice(p: number): string {
  if (p >= 100) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  return p.toPrecision(4);
}
