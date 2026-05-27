/**
 * Token-bucket + concurrency-cap limiter for RPC calls.
 *
 * The keeper bursts RPC traffic when multiple orders are processed
 * concurrently — within one poll cycle a fan-out of 5 orders × ~7
 * sequential RPC calls each can land 35 requests in a few hundred ms.
 * Alchemy's free testnet tier (25 rps hard cap per app) starts dropping
 * requests with -32602 / 429 once we cross. Without throttling the
 * keeper would either retry the dropped ones (compounding the burst)
 * or treat them as chain errors (mis-classifying transient blips).
 *
 * Two independent gates per acquire():
 *   - token bucket: refills `rps` tokens/second up to `burst` capacity.
 *     Smooths sustained traffic. Burst capacity absorbs short spikes.
 *   - concurrency: max `maxConcurrent` requests in-flight at any moment.
 *     Caps p99 latency under load — without it a slow RPC could pile
 *     up dozens of pending requests while the bucket stays empty.
 *
 * Both must allow before a caller proceeds. release() must be paired
 * with every acquire() (we wire this in chain.ts via try/finally
 * around the inner transport's request call).
 *
 * Per-process instance is enough — each chain runs its own keeper
 * process (polyorder-keeper@<chainId>.service), and Alchemy's rate cap
 * is per-app (one app per chain), so cross-chain coordination isn't
 * needed.
 *
 * Known limitations (acceptable for current scale):
 *   - acquire() has no AbortSignal hook: if a caller is GC'd while
 *     queued, its waiter still resolves later and increments inFlight
 *     with no paired release. Possible slow concurrency leak under
 *     sustained cancellation pressure; not observed in practice
 *     because viem's request path always pairs the try/finally.
 *   - Token refill uses floating-point arithmetic (rps/10 per tick).
 *     For integer rps this is exact (15/10 = 1.5, sums cleanly), but
 *     a non-integer config could accumulate IEEE-754 drift over time.
 *     Stick with integer rps in env.
 */
export class RateLimiter {
  private tokens: number;
  private inFlight = 0;
  private waiters: Array<() => void> = [];
  private readonly refillTimer: NodeJS.Timeout;

  constructor(
    private readonly rps: number,
    private readonly burst: number,
    private readonly maxConcurrent: number,
  ) {
    this.tokens = burst;
    // Refill at 10 Hz — fine-grained enough to feel smooth at 15 rps,
    // coarse enough that timer overhead is negligible. unref() so the
    // process can exit during graceful shutdown.
    this.refillTimer = setInterval(() => {
      this.tokens = Math.min(this.burst, this.tokens + this.rps / 10);
      this.drain();
    }, 100);
    this.refillTimer.unref();
  }

  /**
   * Wait until a token AND a concurrency slot are available, then
   * consume both. Callers MUST pair with release() (use try/finally).
   */
  acquire(): Promise<void> {
    if (this.tryConsume()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    this.inFlight -= 1;
    this.drain();
  }

  private tryConsume(): boolean {
    if (this.tokens >= 1 && this.inFlight < this.maxConcurrent) {
      this.tokens -= 1;
      this.inFlight += 1;
      return true;
    }
    return false;
  }

  private drain(): void {
    while (this.waiters.length > 0 && this.tryConsume()) {
      const waiter = this.waiters.shift()!;
      waiter();
    }
  }
}
