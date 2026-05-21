import { describe, it, expect } from 'vitest';
import { isTriggerConditionMet, parseOrderType, type OrderTypeStr } from './price';

const ONE_E18 = 10n ** 18n;

describe('isTriggerConditionMet', () => {
  const cases: Array<[OrderTypeStr, bigint, bigint, boolean]> = [
    // [type, currentPrice, triggerPrice, expected]
    ['LIMIT_BUY', 1900n * ONE_E18, 2000n * ONE_E18, true],   // asset cheap → buy
    ['LIMIT_BUY', 2100n * ONE_E18, 2000n * ONE_E18, false],
    ['LIMIT_BUY', 2000n * ONE_E18, 2000n * ONE_E18, true],   // boundary

    ['LIMIT_SELL', 3100n * ONE_E18, 3000n * ONE_E18, true],  // asset expensive → sell
    ['LIMIT_SELL', 2900n * ONE_E18, 3000n * ONE_E18, false],
    ['LIMIT_SELL', 3000n * ONE_E18, 3000n * ONE_E18, true],

    ['STOP_LOSS', 1400n * ONE_E18, 1500n * ONE_E18, true],
    ['STOP_LOSS', 1600n * ONE_E18, 1500n * ONE_E18, false],

    ['TAKE_PROFIT', 5100n * ONE_E18, 5000n * ONE_E18, true],
    ['TAKE_PROFIT', 4900n * ONE_E18, 5000n * ONE_E18, false],
  ];

  it.each(cases)('%s cur=%s trigger=%s → %s', (type, cur, trig, expected) => {
    expect(isTriggerConditionMet(type, cur, trig)).toBe(expected);
  });
});

describe('parseOrderType', () => {
  it('accepts all 4 valid types', () => {
    expect(parseOrderType('LIMIT_BUY')).toBe('LIMIT_BUY');
    expect(parseOrderType('LIMIT_SELL')).toBe('LIMIT_SELL');
    expect(parseOrderType('STOP_LOSS')).toBe('STOP_LOSS');
    expect(parseOrderType('TAKE_PROFIT')).toBe('TAKE_PROFIT');
  });

  it('rejects invalid', () => {
    expect(() => parseOrderType('BAD')).toThrow(/Invalid orderType/);
    expect(() => parseOrderType('')).toThrow();
  });
});
