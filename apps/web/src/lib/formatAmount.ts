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

/**
 * Round a number to N significant figures and return a plain decimal string
 * with NO locale separators (commas) — suitable for form storage where the
 * value will be parseFloat'd later. Unlike `formatSmart`, this preserves
 * round-trip behaviour: parseFloat(trimToSigFigs(x, 6)) ≈ x.
 *
 *   trimToSigFigs(524.1546907603628, 6) → "524.155"
 *   trimToSigFigs(0.00190914123,    6) → "0.00190914"
 *   trimToSigFigs(1234567.89,       6) → "1234570"
 *
 * Use this when seeding form inputs from a derived number that would
 * otherwise carry float-noise tail (e.g. currentRate × 1.1).
 */
export function trimToSigFigs(value: number, sigFigs = 6): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return '0';
  const exp = Math.floor(Math.log10(Math.abs(value)));
  const factor = Math.pow(10, sigFigs - 1 - exp);
  const rounded = Math.round(value * factor) / factor;
  // Plain-decimal output, never scientific notation. JS String()/toString
  // switch to exponent form outside ~1e-6..1e21 (e.g. a degenerate testnet
  // pool's 1.1e-12 spot), and viem's parseUnits REJECTS exponent strings
  // ("Invalid numeric string"). Callers feed this straight into parseUnits,
  // so expand any exponent form to plain decimal here.
  return toPlainDecimalString(rounded);
}

/**
 * Number → plain-decimal string, never scientific notation. JS `String(n)`
 * uses exponent form for |n| ≥ 1e21 or |n| < 1e-6; this re-expands those so
 * the result is safe to pass to viem `parseUnits`.
 */
export function toPlainDecimalString(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const s = String(n);
  const m = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s);
  if (!m) return s; // already plain decimal
  const sign = m[1];
  const intPart = m[2];
  const fracPart = m[3] ?? '';
  const exp = parseInt(m[4]!, 10);
  const digits = intPart + fracPart;
  // Decimal-point position measured from the start of `digits`.
  const point = intPart.length + exp;
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}
