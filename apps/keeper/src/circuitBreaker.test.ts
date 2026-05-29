import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Breaker reads only these config fields; mock to fixed test values
// (threshold 4, window 1 min) so we don't need the full keeper env.
vi.mock('./config', () => ({
  getConfig: () => ({
    BREAKER_FAILURE_THRESHOLD: 4,
    BREAKER_WINDOW_MINUTES: 1,
    CHAIN_ID: 84532,
    ALERT_DISCORD_WEBHOOK: undefined,
  }),
}));
vi.mock('./alerts', () => ({ sendDiscordAlert: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./logger', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Fresh singleton per test — the breaker holds module-level state.
async function freshBreaker() {
  vi.resetModules();
  return (await import('./circuitBreaker')).circuitBreaker;
}

describe('circuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays closed below the threshold', async () => {
    const cb = await freshBreaker();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure(); // 3 < 4
    expect(cb.shouldPause()).toBe(false);
    expect(cb.isTripped()).toBe(false);
  });

  it('trips at the threshold', async () => {
    const cb = await freshBreaker();
    for (let i = 0; i < 4; i++) cb.recordFailure();
    expect(cb.shouldPause()).toBe(true);
    expect(cb.isTripped()).toBe(true);
  });

  it('prunes failures older than the window', async () => {
    const cb = await freshBreaker();
    for (let i = 0; i < 4; i++) cb.recordFailure();
    expect(cb.count()).toBe(4);
    vi.setSystemTime(61_000); // past the 1-min window
    expect(cb.count()).toBe(0);
  });

  it('holds the trip through the hysteresis band, recovers at half', async () => {
    const cb = await freshBreaker();
    for (let i = 0; i < 4; i++) cb.recordFailure(); // t=0, trip
    expect(cb.shouldPause()).toBe(true);

    // Two more failures at t=40s — within the window.
    vi.setSystemTime(40_000);
    cb.recordFailure();
    cb.recordFailure();

    // At t=61s the four t=0 failures have aged out; two remain. 3 would still
    // hold (hysteresis band), but 2 == floor(4/2) → recover.
    vi.setSystemTime(61_000);
    expect(cb.count()).toBe(2);
    expect(cb.shouldPause()).toBe(false);
    expect(cb.isTripped()).toBe(false);
  });
});
