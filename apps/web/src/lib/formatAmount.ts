/**
 * Smart-decimal formatter for token amounts.
 *
 * Fixed-decimal (.toFixed(4)) is fine for stables and ETH-sized values
 * but collapses to "0.0000" for sub-cent crypto amounts (e.g. 0.000004
 * WETH = ~$0.01 worth). This adaptively picks the decimal count to
 * surface ~6 significant digits regardless of magnitude:
 *
 *   1234.567890         → "1,234.5679"
 *   1.234567            → "1.2346"
 *   0.004723286901...   → "0.00472329"
 *   0.00000409          → "0.00000409"
 *   < ~1e-18 / NaN / 0  → "0"
 *
 * Use this anywhere a small WETH/WBTC amount might be rendered (DCA
 * slice sizes, TWAP per-slice estimates, scheduled-order receipts).
 */
export function formatSmart(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '0';
  if (Math.abs(value) >= 1) {
    return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  // 6 significant digits → 5 after the leading non-zero digit.
  const decimals = Math.max(0, Math.min(18, 5 - magnitude));
  return value.toLocaleString(undefined, { maximumFractionDigits: decimals });
}
