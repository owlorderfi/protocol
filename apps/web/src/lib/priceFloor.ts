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

export type Side = 'natural' | 'flipped' | 'unknown';

export interface PairOrientation {
  /** 'natural' = "1 tokenIn = X tokenOut" (swap direction).
   *  'flipped' = "1 tokenOut = Y tokenIn" (user-toggled inverse).
   *  'unknown' = symbols missing — caller should fall back to raw display. */
  side: Side;
  /** The "1 X" leg of the displayed ratio. */
  assetSym: string | null;
  /** The "= Y" leg. */
  quoteSym: string | null;
}

export function classifyPair(inSym: string, outSym: string): PairOrientation {
  if (!inSym || !outSym) {
    return { side: 'unknown', assetSym: null, quoteSym: null };
  }
  // Natural display follows the swap: "1 tokenIn = X tokenOut".
  return { side: 'natural', assetSym: inSym, quoteSym: outSym };
}

/**
 * View-only inversion of the display direction. "1 USDC = 0.028 WETH"
 * becomes "1 WETH = 35.7 USDC" — same on-chain `minPriceScaled`, other
 * perspective. Use when the user clicks ⇄.
 */
export function flipDisplay(orient: PairOrientation, floor: FloorComputation): {
  orient: PairOrientation;
  floor: FloorComputation;
} {
  if (orient.side === 'unknown') return { orient, floor };
  const inv = (p: number | null) => (p === null || p === 0 ? null : 1 / p);
  return {
    orient: {
      side: orient.side === 'natural' ? 'flipped' : 'natural',
      assetSym: orient.quoteSym,
      quoteSym: orient.assetSym,
    },
    floor: {
      minPriceScaled: floor.minPriceScaled, // unchanged — same on-chain threshold
      currentAssetPrice: inv(floor.currentAssetPrice),
      thresholdAssetPrice: inv(floor.thresholdAssetPrice),
    },
  };
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
