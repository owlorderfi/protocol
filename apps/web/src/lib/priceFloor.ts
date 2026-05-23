/**
 * Helpers for computing + displaying the maker-signed `minPriceScaled`
 * hard floor in user-intuitive terms.
 *
 * The contract stores minPriceScaled as "tokenOut human per 1 tokenIn human
 * × 1e18" — mathematically clean but unreadable to a user who thinks in
 * "1 ETH = $2100". This module bridges the two: it picks a familiar
 * quoting direction (asset priced in the stablecoin side of the pair) and
 * derives the right minPriceScaled from a "% tolerance" preset, accounting
 * for whether the maker is buying or selling the volatile asset.
 *
 * Direction matters because the preset semantic flips:
 *   - BUYING the asset (tokenOut is volatile, tokenIn is stable):
 *       tolerance = "max % the asset price can RISE from current"
 *       → minPriceScaled = currentScaled * 100 / (100 + tolPct)
 *   - SELLING the asset (tokenIn is volatile, tokenOut is stable):
 *       tolerance = "max % the asset price can DROP from current"
 *       → minPriceScaled = currentScaled * (100 - tolPct) / 100
 *
 * Without this flip the DCA buyer sees "−20%" presets that secretly mean
 * "stop if ETH rises by 25%" — the exact UX confusion this module fixes.
 */

const QUOTE_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'USDP', 'USDS', 'FRAX', 'LUSD']);

export type Side = 'buy' | 'sell' | 'unknown';

export interface PairOrientation {
  /** 'buy' = maker is buying the asset; 'sell' = maker is selling it. */
  side: Side;
  /** Symbol of the volatile leg (e.g. 'WETH'), or null when both sides
   *  are stable / both non-stable (no clear quote direction). */
  assetSym: string | null;
  /** Symbol of the stable / quote leg (e.g. 'USDC'). */
  quoteSym: string | null;
}

export function classifyPair(inSym: string, outSym: string): PairOrientation {
  const inIsStable = QUOTE_SYMBOLS.has(inSym);
  const outIsStable = QUOTE_SYMBOLS.has(outSym);
  // Both stable → no meaningful asset/quote split; the floor concept
  // doesn't apply (a 5% USDC/USDT divergence is depeg territory, not
  // something users size positions around).
  if (inIsStable && outIsStable) return { side: 'unknown', assetSym: null, quoteSym: null };
  if (inIsStable) return { side: 'buy', assetSym: outSym, quoteSym: inSym };
  if (outIsStable) return { side: 'sell', assetSym: inSym, quoteSym: outSym };
  // Both non-stable (e.g. WETH/WBTC): default to "asset = tokenOut" so the
  // floor matches the swap direction. The display can be flipped at view
  // time via flipDisplay() without re-signing — same threshold, other side.
  return { side: 'buy', assetSym: outSym, quoteSym: inSym };
}

/**
 * View-only inversion of the asset/quote perspective. Returns the same
 * floor expressed from the opposite side — e.g. "1 WETH > 290 USDC" ↔
 * "1 USDC < 0.00345 WETH". The maker-signed `minPriceScaled` is unchanged
 * (it's still the same threshold); only the human-facing labels flip.
 *
 * Use when the user prefers seeing the price in the other token's terms.
 */
export function flipDisplay(orient: PairOrientation, floor: FloorComputation): {
  orient: PairOrientation;
  floor: FloorComputation;
} {
  if (orient.side === 'unknown') return { orient, floor };
  const inv = (p: number | null) => (p === null || p === 0 ? null : 1 / p);
  return {
    orient: {
      side: orient.side === 'buy' ? 'sell' : 'buy',
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
  /** Current asset price in quote units (e.g. 2100 for "$2100 per ETH").
   *  Null when orientation is unknown or quote not loaded. */
  currentAssetPrice: number | null;
  /** Threshold asset price after applying the tolerance preset. Null when
   *  no floor is set / orientation is unknown. */
  thresholdAssetPrice: number | null;
}

/**
 * Derive the maker-signed floor + the human-facing threshold from a current
 * quote (priceScaled = tokenOut_human / tokenIn_human × 1e18) and a
 * tolerance preset (% of asset-price drift the maker still accepts).
 */
export function computeFloor(params: {
  currentPriceScaled: bigint | null;
  tolerancePct: number;
  side: Side;
}): FloorComputation {
  const { currentPriceScaled, tolerancePct, side } = params;

  if (tolerancePct === 0 || !currentPriceScaled || side === 'unknown') {
    // Either the maker opted out, or we can't form a sensible asset price.
    // In both cases, sign "0" so the contract skips the floor check.
    const current = currentPriceScaled
      ? assetPriceFromScaled(currentPriceScaled, side)
      : null;
    return { minPriceScaled: '0', currentAssetPrice: current, thresholdAssetPrice: null };
  }

  // The math diverges by side. See file header for the derivation.
  const tolBps = BigInt(tolerancePct * 100);
  const minScaled =
    side === 'buy'
      ? (currentPriceScaled * 10_000n) / (10_000n + tolBps)
      : (currentPriceScaled * (10_000n - tolBps)) / 10_000n;

  return {
    minPriceScaled: minScaled.toString(),
    currentAssetPrice: assetPriceFromScaled(currentPriceScaled, side),
    thresholdAssetPrice: assetPriceFromScaled(minScaled, side),
  };
}

/**
 * Convert a `tokenOut/tokenIn × 1e18` scaled value into a human asset price
 * (asset in quote units). For 'buy' the asset is tokenOut so the natural
 * "1 asset = X quote" is the RECIPROCAL of the scaled ratio.
 */
function assetPriceFromScaled(scaled: bigint, side: Side): number | null {
  if (scaled <= 0n) return null;
  const human = Number(scaled) / 1e18;
  if (!Number.isFinite(human) || human === 0) return null;
  return side === 'buy' ? 1 / human : human;
}

/** Format an asset price with sensible precision for typical crypto magnitudes. */
export function formatAssetPrice(p: number): string {
  if (p >= 100) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  return p.toPrecision(4);
}
