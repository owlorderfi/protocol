import { getConfig } from './config';
import { sendDiscordAlert } from './alerts';
import { log } from './logger';

/**
 * Global failure-rate kill switch (hardening plan A.13).
 *
 * Records "serious" execution failures — submitted-tx reverts and
 * tx-submission errors — in a sliding window. When the count in the window
 * crosses BREAKER_FAILURE_THRESHOLD the breaker TRIPS: the poller pauses all
 * execution (no price RPC, no tx) and a Discord alert fires once. While
 * paused no new failures accrue, so the window drains and the breaker
 * auto-recovers (with hysteresis) once it falls back to half the threshold.
 *
 * What is NOT recorded: benign skips that spend no gas and are normal market
 * behaviour — slippage-gate aborts, gas-spike skips, re-quote RPC blips.
 * Counting those would trip the breaker during ordinary volatility. The
 * signal we want is "txs are actually failing / being rejected", which is
 * the gas-drain + systemic-problem indicator the breaker exists to catch.
 *
 * Per-process singleton (one keeper = one chain, same scope as nonceManager),
 * so the breaker is naturally per-chain: a flood on OP doesn't pause Base.
 */
class CircuitBreaker {
  // Append-only, time-ordered epoch-ms timestamps of recent failures.
  private failures: number[] = [];
  private tripped = false;

  /** Record a serious failure (submitted-tx revert or tx-submission error). */
  recordFailure(): void {
    this.failures.push(Date.now());
  }

  // Drop the leading run of timestamps older than the window. failures is
  // time-ordered (push only appends now()), so one forward scan suffices.
  private prune(windowMs: number): void {
    const cutoff = Date.now() - windowMs;
    let i = 0;
    while (i < this.failures.length && this.failures[i]! < cutoff) i++;
    if (i > 0) this.failures.splice(0, i);
  }

  /** Failures within the current window. */
  count(): number {
    const config = getConfig();
    this.prune(config.BREAKER_WINDOW_MINUTES * 60_000);
    return this.failures.length;
  }

  isTripped(): boolean {
    return this.tripped;
  }

  /**
   * Re-evaluate and return whether execution should pause. The poller calls
   * this every cycle (even while paused, so recovery is detected). Trips at
   * the threshold; recovers once the window drains to ≤ half the threshold
   * — the gap is hysteresis so a count hovering at the line can't flap the
   * breaker open/closed every tick.
   */
  shouldPause(): boolean {
    const config = getConfig();
    const n = this.count();
    const threshold = config.BREAKER_FAILURE_THRESHOLD;

    if (!this.tripped && n >= threshold) {
      this.tripped = true;
      log.error(
        `[breaker] TRIPPED — ${n} failures in ${config.BREAKER_WINDOW_MINUTES}m ` +
          `(threshold ${threshold}). Pausing execution on chain ${config.CHAIN_ID}.`,
      );
      void sendDiscordAlert(
        `🛑 **OwlOrderFi keeper circuit breaker TRIPPED** (chain ${config.CHAIN_ID})\n` +
          `• ${n} execution failures in the last ${config.BREAKER_WINDOW_MINUTES} min ` +
          `(threshold ${threshold})\n` +
          `• Execution PAUSED — auto-resumes once failures drain.\n` +
          `• Check: RPC health, contract paused, a bad order spamming reverts?`,
        config.ALERT_DISCORD_WEBHOOK,
      ).catch(() => {});
    } else if (this.tripped && n <= Math.floor(threshold / 2)) {
      this.tripped = false;
      log.warn(
        `[breaker] RECOVERED — failures drained to ${n}. Resuming execution on chain ${config.CHAIN_ID}.`,
      );
      void sendDiscordAlert(
        `✅ **OwlOrderFi keeper circuit breaker recovered** (chain ${config.CHAIN_ID}) — ` +
          `failures drained to ${n}, execution resumed.`,
        config.ALERT_DISCORD_WEBHOOK,
      ).catch(() => {});
    }

    return this.tripped;
  }
}

export const circuitBreaker = new CircuitBreaker();
