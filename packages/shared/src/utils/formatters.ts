/**
 * Bigint <-> human-readable string conversions for token amounts.
 * We work with bigint internally for precision; strings on the wire (JSON).
 */

/**
 * Convert raw wei (or any base unit) into human-readable string with decimals.
 *
 * @example
 * formatUnits("1000000000000000000", 18) → "1"
 * formatUnits("1234500000000000000", 18) → "1.2345"
 */
export function formatUnits(rawValue: bigint | string, decimals: number): string {
  const value = typeof rawValue === 'string' ? BigInt(rawValue) : rawValue;
  if (decimals < 0) throw new Error('decimals must be non-negative');

  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const fraction = value % divisor;

  if (fraction === 0n) return whole.toString();

  const fractionStr = fraction.toString().padStart(decimals, '0');
  const trimmed = fractionStr.replace(/0+$/, '');
  return `${whole.toString()}.${trimmed}`;
}

/**
 * Convert human-readable decimal string to bigint base units.
 *
 * @example
 * parseUnits("1", 18) → 1000000000000000000n
 * parseUnits("1.5", 18) → 1500000000000000000n
 */
export function parseUnits(humanValue: string, decimals: number): bigint {
  if (decimals < 0) throw new Error('decimals must be non-negative');

  const trimmed = humanValue.trim();
  if (!/^[0-9]+(\.[0-9]+)?$/.test(trimmed)) {
    throw new Error(`Invalid numeric string: "${humanValue}"`);
  }

  const [whole = '0', fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) {
    throw new Error(`Too many decimals: "${humanValue}" exceeds ${decimals} decimal places`);
  }

  const paddedFraction = fraction.padEnd(decimals, '0');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(paddedFraction);
}

/**
 * Shorten an Ethereum address for display (0x1234...abcd).
 */
export function shortenAddress(address: string, chars = 4): string {
  if (address.length < 2 + chars * 2) return address;
  return `${address.slice(0, 2 + chars)}...${address.slice(-chars)}`;
}

/**
 * Calculate price scaled by 10^18 from human-readable values.
 * Used for triggerPrice on orders.
 *
 * @example
 * computePriceScaled(0.45, 18) → 450000000000000000n
 */
export function computePriceScaled(price: number | string, scale = 18): bigint {
  return parseUnits(String(price), scale);
}
