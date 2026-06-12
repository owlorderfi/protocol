/**
 * Pins the slippage-bound math shared by the web (deriving minAmountOut to
 * sign) and the API (enforcing it at creation — audit finding #2). The
 * critical invariant: the web's MAX slippage clamp must equal the API's
 * floor, so a legitimately-capped web order is never falsely rejected by
 * the server-side bound, and anything looser IS rejected.
 *
 * (Lives under apps/api because @owlorderfi/shared has no test runner; the
 * functions under test are pure and live in shared/utils/orderMath.)
 */

import { describe, it, expect } from 'vitest';
import {
  computeExpectedAmountOut,
  applySlippage,
  minAmountOutFloor,
  MAX_SLIPPAGE_BPS,
} from '@owlorderfi/shared';

const MAX_PCT = Number(MAX_SLIPPAGE_BPS) / 100; // 1000 bps → 10%

describe('computeExpectedAmountOut', () => {
  it('LIMIT_SELL: expectedOut = amountIn × triggerPrice (decimals applied)', () => {
    // 1 WETH (18 dec) at 2000 USDC (6 dec) per WETH → 2000 USDC.
    const out = computeExpectedAmountOut({
      orderType: 'LIMIT_SELL',
      amountInRaw: 10n ** 18n,
      triggerPriceScaled: 2000n * 10n ** 18n,
      tokenInDecimals: 18,
      tokenOutDecimals: 6,
    });
    expect(out).toBe(2000n * 10n ** 6n);
  });

  it('LIMIT_BUY: expectedOut = amountIn / triggerPrice', () => {
    // Spend 2000 USDC, trigger = 2000 USDC per WETH → 1 WETH.
    const out = computeExpectedAmountOut({
      orderType: 'LIMIT_BUY',
      amountInRaw: 2000n * 10n ** 6n,
      triggerPriceScaled: 2000n * 10n ** 18n,
      tokenInDecimals: 6,
      tokenOutDecimals: 18,
    });
    expect(out).toBe(10n ** 18n);
  });

  it('returns 0 for invalid inputs', () => {
    expect(
      computeExpectedAmountOut({
        orderType: 'LIMIT_SELL',
        amountInRaw: 0n,
        triggerPriceScaled: 1n,
        tokenInDecimals: 18,
        tokenOutDecimals: 6,
      }),
    ).toBe(0n);
  });
});

describe('slippage bound consistency (web clamp ↔ API floor)', () => {
  const expectedOut = 2000n * 10n ** 6n;

  it('web slippage at the MAX clamp equals the API floor exactly', () => {
    // A user who maxes the (now-clamped) web slippage input must land
    // EXACTLY on the API floor — never one wei below, or the API would
    // reject the very order the form just produced.
    expect(applySlippage(expectedOut, MAX_PCT)).toBe(minAmountOutFloor(expectedOut));
  });

  it('tighter slippage stays at or above the floor (accepted)', () => {
    for (const pct of [0, 0.1, 0.5, 1, 2, 5, MAX_PCT]) {
      expect(applySlippage(expectedOut, pct) >= minAmountOutFloor(expectedOut)).toBe(true);
    }
  });

  it('slippage beyond the max sits below the floor (rejected by the API)', () => {
    // e.g. an attacker / non-web client signing a 20% floor.
    const loose = applySlippage(expectedOut, MAX_PCT + 10);
    expect(loose < minAmountOutFloor(expectedOut)).toBe(true);
  });

  it('floor is 0 for a non-positive expectedOut (bound skipped)', () => {
    expect(minAmountOutFloor(0n)).toBe(0n);
  });
});
