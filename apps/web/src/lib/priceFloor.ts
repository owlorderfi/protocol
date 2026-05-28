/**
 * Price display + maker-signed floor helpers.
 *
 * ONE fixed display orientation across the whole app — no per-pair flip,
 * no Market/Swap toggle. A pair is always shown with the less-fundamental
 * asset priced in the more-fundamental one (numéraire rank: stable > BTC >
 * ETH > alt), i.e. "1 WETH = X USDC" whether the swap is USDC→WETH or
 * WETH→USDC. This killed a whole class of bugs where the displayed number
 * and its unit label came from different orientations, or a mutable flip
 * desynced typed values from the live rate.
 *
 * The single source of truth is `displayPrice(canonical, tokens)`: it
 * returns the value AND its unit together, so they can never disagree.
 * Everything that shows a price funnels through it; nothing does its own
 * 1/x or builds its own label.
 */

/**
 * Numéraire rank — LOWER = more fundamental = the QUOTE currency. The
 * higher-ranked (less fundamental) token is the BASE that gets priced.
 * New tokens default to rank 3 (alt).
 */
const DISPLAY_STABLE_SYMBOLS = new Set([
  'USDC', 'USDT', 'DAI', 'BUSD', 'USDP', 'USDS', 'FRAX', 'LUSD',
]);
const BTC_SYMBOLS = new Set(['WBTC', 'TBTC', 'BTCB', 'CBBTC', 'BTC', 'RENBTC', 'SBTC']);
const ETH_SYMBOLS = new Set(['WETH', 'ETH', 'STETH', 'WSTETH', 'RETH', 'CBETH']);

function numeraireRank(sym: string): number {
  const s = sym.toUpperCase();
  if (DISPLAY_STABLE_SYMBOLS.has(s)) return 0;
  if (BTC_SYMBOLS.has(s)) return 1;
  if (ETH_SYMBOLS.has(s)) return 2;
  return 3;
}

interface PairTokens {
  tokenInSym: string;
  tokenInAddr: string;
  tokenOutSym: string;
  tokenOutAddr: string;
}

/**
 * Is tokenIn the BASE (the priced asset)? BASE = less fundamental = higher
 * numéraire rank; ties break on a deterministic address sort so the
 * direction is stable across renders. This single decision drives both
 * `displayPrice` and `displayedToCanonical`, so they can't diverge.
 */
function baseIsTokenIn(t: PairTokens): boolean {
  const rankIn = numeraireRank(t.tokenInSym);
  const rankOut = numeraireRank(t.tokenOutSym);
  if (rankIn !== rankOut) return rankIn > rankOut;
  return t.tokenInAddr.toLowerCase() < t.tokenOutAddr.toLowerCase();
}

export interface DisplayedPrice {
  /** Value in the fixed orientation: QUOTE units per 1 BASE. */
  value: number;
  /** The priced asset (less fundamental), e.g. "WETH". */
  baseSym: string;
  /** The numéraire it's priced in (more fundamental), e.g. "USDC". */
  quoteSym: string;
  /** "{quoteSym}/{baseSym}", e.g. "USDC/WETH". */
  unit: string;
  /**
   * True when the displayed value is `1 / canonical` (base = tokenOut). A
   * canonical minimum (floor) then reads as a maximum in the displayed
   * direction, so a "stop" condition flips from "drops below" to "rises above".
   */
  inverted: boolean;
}

/**
 * Orient a CANONICAL price (tokenOut per tokenIn, human units) into the
 * display direction. Returns value + unit together.
 *
 *   canonical = tokenOut/tokenIn
 *   base = tokenIn  → quote/base = tokenOut/tokenIn = canonical
 *   base = tokenOut → quote/base = tokenIn/tokenOut = 1/canonical
 *
 * `flipped` is the single global view toggle: it inverts which token is the
 * base (purely a render choice — it never touches stored/canonical values),
 * so the user can read the pair the other way around consistently app-wide.
 */
export function displayPrice(args: { canonical: number; flipped?: boolean } & PairTokens): DisplayedPrice {
  const { canonical, flipped = false } = args;
  const inIsBase = flipped ? !baseIsTokenIn(args) : baseIsTokenIn(args);
  const baseSym = inIsBase ? args.tokenInSym : args.tokenOutSym;
  const quoteSym = inIsBase ? args.tokenOutSym : args.tokenInSym;
  const value = inIsBase ? canonical : canonical > 0 ? 1 / canonical : 0;
  return { value, baseSym, quoteSym, unit: `${quoteSym}/${baseSym}`, inverted: !inIsBase };
}

/**
 * Inverse of `displayPrice`: convert a value the user typed in the displayed
 * orientation (QUOTE per BASE) back to canonical (tokenOut per tokenIn).
 * Must use the SAME `flipped` the input was shown under.
 */
export function displayedToCanonical(displayed: number, t: PairTokens, flipped = false): number {
  const inIsBase = flipped ? !baseIsTokenIn(t) : baseIsTokenIn(t);
  if (inIsBase) return displayed;
  return displayed > 0 ? 1 / displayed : 0;
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
