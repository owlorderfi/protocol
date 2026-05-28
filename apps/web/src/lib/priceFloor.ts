/**
 * Helpers for displaying the maker-signed `minPriceScaled` hard floor.
 *
 * KISS convention: display direction === swap direction. A pair
 * `USDC → WETH` renders as "1 USDC = X WETH"; `WETH → USDC` renders
 * as "1 WETH = X USDC". User can click ⇄ to flip the view; the
 * maker-signed `minPriceScaled` is unchanged, only the human-facing
 * labels invert.
 *
 * Tolerance % is direction-agnostic: "Stop if execution rate drops by
 * more than X% below current". For SELL-side trades (e.g. WETH → USDC)
 * this maps 1:1 to "WETH price dropped X%". For BUY-side (USDC → WETH)
 * the user-mental-model is slightly off (an X% drop in WETH-per-USDC
 * rate means WETH became ~X/(1−X)% more expensive) — accepted trade-
 * off for the simpler model and uniform math.
 *
 * Previously we hardcoded a `QUOTE_SYMBOLS` list to detect stables and
 * always render with the asset on the left ("1 WETH = X USDC" even on
 * a SELL). That worked for testnet majors but doesn't scale — every
 * new stable (EURC, sDAI, GHO, …) would need a config patch. Dropped.
 */

/**
 * How prices are oriented for display across the whole app:
 *   - 'swap':   pure math, follows the trade — "1 tokenIn = X tokenOut".
 *               Flips with the swap direction; zero convention.
 *   - 'market': numéraire hierarchy — the less-fundamental asset is
 *               priced in the more-fundamental one (USD > BTC > ETH >
 *               alts). "1 WETH = 3000 USDC", "1 WETH = 0.065 WBTC",
 *               constant regardless of swap direction.
 */
export type PriceConvention = 'swap' | 'market';

/**
 * Numéraire rank — LOWER = more fundamental = preferred QUOTE currency.
 * The higher-ranked (less fundamental) token becomes the BASE that gets
 * priced. New tokens default to rank 3 (alt); promote BTC/ETH-likes or
 * add stables to DISPLAY_STABLE_SYMBOLS as the token list grows.
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

export interface OrientedPair {
  /** Numerator symbol in the displayed "{numerSym}/{denomSym}" ratio. */
  numerSym: string;
  /** Denominator symbol. */
  denomSym: string;
  /**
   * Whether the displayed value is `1 / canonical`, where canonical is
   * the form/order's internal `tokenOut per tokenIn`. Callers convert:
   *   displayed = displayInverse ? 1 / canonical : canonical
   */
  displayInverse: boolean;
}

/**
 * Resolve display orientation for a pair under the chosen convention,
 * with a transient per-pair `flipped` toggle on top. This is what makes
 * every form + the orders table render a pair in the SAME direction.
 *
 *   - 'swap':   base = tokenIn, quote = tokenOut → "1 tokenIn = X tokenOut".
 *   - 'market': base = higher numéraire rank (less fundamental), quote =
 *               lower rank → "1 WETH = X USDC" / "1 WETH = X WBTC".
 *
 * Ties (same rank, e.g. USDC/USDT) fall back to a deterministic address
 * sort so the direction is stable across renders. `flipped` inverts
 * whatever the convention picked.
 */
export function orientPair(args: {
  tokenInSym: string;
  tokenInAddr: string;
  tokenOutSym: string;
  tokenOutAddr: string;
  flipped: boolean;
  convention: PriceConvention;
}): OrientedPair {
  const { tokenInSym, tokenInAddr, tokenOutSym, tokenOutAddr, flipped, convention } = args;

  let baseAddr: string;
  let baseSym: string;
  let quoteSym: string;
  if (convention === 'swap') {
    // Pure swap direction: base = what you give (tokenIn).
    baseSym = tokenInSym; quoteSym = tokenOutSym; baseAddr = tokenInAddr;
  } else {
    // Market: less-fundamental (higher rank) token is the base.
    const rankIn = numeraireRank(tokenInSym);
    const rankOut = numeraireRank(tokenOutSym);
    let inIsBase: boolean;
    if (rankIn !== rankOut) {
      inIsBase = rankIn > rankOut;
    } else {
      // Same rank — deterministic tiebreak by address.
      inIsBase = tokenInAddr.toLowerCase() < tokenOutAddr.toLowerCase();
    }
    baseSym = inIsBase ? tokenInSym : tokenOutSym;
    quoteSym = inIsBase ? tokenOutSym : tokenInSym;
    baseAddr = inIsBase ? tokenInAddr : tokenOutAddr;
  }

  const baseIsTokenIn = baseAddr.toLowerCase() === tokenInAddr.toLowerCase();
  // canonical = tokenOut per tokenIn. "quote per base" equals canonical
  // only when base IS tokenIn (so quote is tokenOut); otherwise invert.
  const standardInverse = !baseIsTokenIn;
  const displayInverse = flipped ? !standardInverse : standardInverse;
  // Standard view shows "quote/base"; flipped shows "base/quote".
  const numerSym = flipped ? baseSym : quoteSym;
  const denomSym = flipped ? quoteSym : baseSym;
  return { numerSym, denomSym, displayInverse };
}


export interface FloorComputation {
  /** Maker-signed value, ready for the EIP-712 message. "0" = no floor. */
  minPriceScaled: string;
  /** Current price in natural display direction (tokenOut human per 1
   *  tokenIn human). Null when no quote loaded. */
  currentAssetPrice: number | null;
  /** Floor (tolerance-adjusted) in the same direction. Null when
   *  tolerancePct=0 (off) or no quote. */
  thresholdAssetPrice: number | null;
}

/**
 * Derive the maker-signed floor from a current market quote and a
 * tolerance preset. Single formula, no buy/sell branch:
 *
 *   minPriceScaled = currentPriceScaled × (10_000 − tolBps) / 10_000
 *
 * Meaning: "stop when the swap's execution rate drops more than X%
 * below what it is now". The semantic is direction-agnostic — works
 * whether the maker is buying or selling, with the user-mental-model
 * mapping handled at the UI label level (see file header).
 *
 * tolerancePct=0 is treated as "off" (no floor). The contract skips
 * the post-swap minOut check when minPriceScaled is 0.
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
  // subtraction. Clamp to "100% drop" = floor at zero = effectively
  // no floor. Same outcome as the tolerancePct=0 branch above.
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
