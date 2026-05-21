import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  computeCurrentPriceScaled,
  isTriggerConditionMet,
  parseOrderType,
  getTokenPricesUSD,
  _resetPriceCache,
  type OrderTypeStr,
} from './price';

// getConfig() is imported by price.ts; stub it so we don't need a real .env
vi.mock('./config', () => ({
  getConfig: () => ({
    DATABASE_URL: 'postgresql://test',
    CHAIN_ID: 137,
    RPC_URL: 'http://localhost:8545',
    KEEPER_PRIVATE_KEY: ('0x' + '11'.repeat(32)) as `0x${string}`,
    LIMIT_ORDER_ROUTER_ADDRESS: ('0x' + 'aa'.repeat(20)) as `0x${string}`,
    ONEINCH_API_KEY: 'test-key',
    POLL_INTERVAL_SECONDS: 2,
    MAX_CONCURRENT_ORDERS: 5,
    STUCK_EXECUTING_MINUTES: 5,
    DRY_RUN: true,
    LOG_LEVEL: 'error' as const,
  }),
}));

const ONE_E18 = 10n ** 18n;

describe('computeCurrentPriceScaled', () => {
  it('LIMIT_BUY uses tokenOut/tokenIn ratio (price of tokenOut in tokenIn units)', () => {
    // Buying ETH ($3000) with USDC ($1) → tokenOut=ETH, tokenIn=USDC
    // currentPrice should be 3000 (USDC per ETH)
    const result = computeCurrentPriceScaled('LIMIT_BUY', 1, 3000);
    expect(result).toBe(3000n * ONE_E18);
  });

  it('LIMIT_SELL uses tokenIn/tokenOut ratio (price of tokenIn in tokenOut units)', () => {
    // Selling ETH ($3000) for USDC ($1) → tokenIn=ETH, tokenOut=USDC
    // currentPrice should be 3000 (USDC per ETH)
    const result = computeCurrentPriceScaled('LIMIT_SELL', 3000, 1);
    expect(result).toBe(3000n * ONE_E18);
  });

  it('STOP_LOSS uses same formula as LIMIT_SELL', () => {
    const result = computeCurrentPriceScaled('STOP_LOSS', 1500, 1);
    expect(result).toBe(1500n * ONE_E18);
  });

  it('TAKE_PROFIT uses same formula as LIMIT_SELL', () => {
    const result = computeCurrentPriceScaled('TAKE_PROFIT', 5000, 1);
    expect(result).toBe(5000n * ONE_E18);
  });

  it('throws on zero or negative prices', () => {
    expect(() => computeCurrentPriceScaled('LIMIT_BUY', 0, 1)).toThrow();
    expect(() => computeCurrentPriceScaled('LIMIT_BUY', 1, -5)).toThrow();
  });

  it('handles sub-dollar ratios', () => {
    // tokenIn worth $0.50, tokenOut worth $1 → ratio 0.5
    const result = computeCurrentPriceScaled('LIMIT_SELL', 0.5, 1);
    expect(result).toBe(ONE_E18 / 2n);
  });
});

describe('isTriggerConditionMet', () => {
  const cases: Array<[OrderTypeStr, bigint, bigint, boolean]> = [
    // [type, currentPrice, triggerPrice, expected]
    ['LIMIT_BUY', 1900n * ONE_E18, 2000n * ONE_E18, true],   // ETH below target → buy
    ['LIMIT_BUY', 2100n * ONE_E18, 2000n * ONE_E18, false],  // ETH above target → don't buy
    ['LIMIT_BUY', 2000n * ONE_E18, 2000n * ONE_E18, true],   // boundary → trigger

    ['LIMIT_SELL', 3100n * ONE_E18, 3000n * ONE_E18, true],  // ETH above target → sell
    ['LIMIT_SELL', 2900n * ONE_E18, 3000n * ONE_E18, false], // ETH below target → hold
    ['LIMIT_SELL', 3000n * ONE_E18, 3000n * ONE_E18, true],  // boundary → trigger

    ['STOP_LOSS', 1400n * ONE_E18, 1500n * ONE_E18, true],   // ETH below stop → sell
    ['STOP_LOSS', 1600n * ONE_E18, 1500n * ONE_E18, false],  // ETH above stop → hold

    ['TAKE_PROFIT', 5100n * ONE_E18, 5000n * ONE_E18, true], // ETH above target → take profit
    ['TAKE_PROFIT', 4900n * ONE_E18, 5000n * ONE_E18, false],// ETH below target → hold
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

describe('getTokenPricesUSD cache', () => {
  beforeEach(() => {
    _resetPriceCache();
    vi.restoreAllMocks();
  });

  it('hits the API once for repeated identical requests within TTL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': '1.0',
          '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb': '3000.0',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const addrs = [
      '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    ];

    const first = await getTokenPricesUSD(addrs);
    const second = await getTokenPricesUSD(addrs);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']).toBe(1);
    expect(first['0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']).toBe(3000);
  });

  it('only fetches missing tokens on partial cache hit', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ '0xaa': '1.0' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ '0xbb': '2.0' }), { status: 200 }),
      );

    await getTokenPricesUSD(['0xAA']);
    await getTokenPricesUSD(['0xAA', '0xBB']);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // 2nd call should only have requested 0xbb, not 0xaa
    const secondCallUrl = fetchSpy.mock.calls[1][0] as string;
    expect(secondCallUrl).toContain('0xbb');
    expect(secondCallUrl).not.toContain('0xaa');
  });
});
