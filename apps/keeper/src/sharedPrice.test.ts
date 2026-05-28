import { describe, it, expect } from 'vitest';
import { spotPriceScaledFromSqrtX96, priceScaledFromAmounts } from '@owlorderfi/shared';

// These lock the orientation/decimal behaviour of the shared price decoders
// that the keeper's trigger and the API's display quote both rely on — the
// drift this refactor exists to prevent. They live here (not packages/shared)
// only because the shared package has no test runner of its own yet; move
// them once it gains vitest.

const PRICE_SCALE = 10n ** 18n;
const Q96 = 1n << 96n;

describe('spotPriceScaledFromSqrtX96', () => {
  it('decodes a 1:1 pool (equal decimals) to exactly 1e18', () => {
    expect(
      spotPriceScaledFromSqrtX96({
        sqrtPriceX96: Q96,
        tokenInIsToken0: true,
        tokenInDecimals: 18,
        tokenOutDecimals: 18,
        orderType: 'LIMIT_SELL',
      }),
    ).toBe(PRICE_SCALE);
  });

  it('returns 0n for a zero / invalid sqrtPriceX96', () => {
    expect(
      spotPriceScaledFromSqrtX96({
        sqrtPriceX96: 0n,
        tokenInIsToken0: true,
        tokenInDecimals: 18,
        tokenOutDecimals: 18,
        orderType: 'LIMIT_SELL',
      }),
    ).toBe(0n);
  });

  it('orients BUY/STOP as the inverse of SELL/TAKE_PROFIT', () => {
    const base = {
      sqrtPriceX96: Q96 * 2n,
      tokenInIsToken0: true,
      tokenInDecimals: 18,
      tokenOutDecimals: 6,
    } as const;
    const sell = spotPriceScaledFromSqrtX96({ ...base, orderType: 'LIMIT_SELL' });
    const take = spotPriceScaledFromSqrtX96({ ...base, orderType: 'TAKE_PROFIT' });
    const buy = spotPriceScaledFromSqrtX96({ ...base, orderType: 'LIMIT_BUY' });
    const stop = spotPriceScaledFromSqrtX96({ ...base, orderType: 'STOP_LOSS' });

    expect(take).toBe(sell); // TAKE_PROFIT shares the canonical orientation
    expect(stop).toBe(buy); // STOP_LOSS shares the inverse orientation
    // buy is the reciprocal of sell: sell * buy ≈ PRICE_SCALE^2 (here exact).
    expect(sell * buy).toBe(PRICE_SCALE * PRICE_SCALE);
  });
});

describe('priceScaledFromAmounts', () => {
  // 1 WETH (1e18, 18 dec) → 3000 USDC (3000e6, 6 dec).
  const swap = {
    amountInRaw: 10n ** 18n,
    amountOutRaw: 3000n * 10n ** 6n,
    tokenInDecimals: 18,
    tokenOutDecimals: 6,
  } as const;

  it('computes canonical tokenOut-per-tokenIn for SELL', () => {
    expect(priceScaledFromAmounts({ ...swap, orderType: 'LIMIT_SELL' })).toBe(3000n * PRICE_SCALE);
  });

  it('computes the inverse tokenIn-per-tokenOut for BUY', () => {
    expect(priceScaledFromAmounts({ ...swap, orderType: 'LIMIT_BUY' })).toBe(PRICE_SCALE / 3000n);
  });

  it('STOP_LOSS matches BUY, TAKE_PROFIT matches SELL', () => {
    expect(priceScaledFromAmounts({ ...swap, orderType: 'STOP_LOSS' })).toBe(
      priceScaledFromAmounts({ ...swap, orderType: 'LIMIT_BUY' }),
    );
    expect(priceScaledFromAmounts({ ...swap, orderType: 'TAKE_PROFIT' })).toBe(
      priceScaledFromAmounts({ ...swap, orderType: 'LIMIT_SELL' }),
    );
  });

  it('guards zero amounts', () => {
    expect(priceScaledFromAmounts({ ...swap, amountInRaw: 0n, orderType: 'LIMIT_SELL' })).toBe(0n);
    expect(priceScaledFromAmounts({ ...swap, amountOutRaw: 0n, orderType: 'LIMIT_SELL' })).toBe(0n);
  });
});
