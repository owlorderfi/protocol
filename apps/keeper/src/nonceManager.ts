import type { PublicClient, Address } from 'viem';
import { log } from './logger';

/**
 * Local nonce counter for parallel tx submissions.
 *
 * The naive flow (no explicit nonce, viem reads getTransactionCount per call)
 * races when multiple processOrder() coroutines call writeContract within the
 * same RPC roundtrip: they all see the same "next" nonce from the chain and
 * only the first one mines; the rest revert with "nonce too low".
 *
 * This module wraps a single in-memory counter behind a promise chain — calls
 * to getNext() are serialized so concurrent callers each get a unique value.
 * On submit failure the caller should resync(), because the nonce we handed
 * out wasn't actually consumed on chain.
 */
export class NonceManager {
  private next: bigint | null = null;
  // Serialize all reads/writes through a single promise chain so we never hand
  // out the same nonce to two parallel callers.
  private lock: Promise<void> = Promise.resolve();

  async getNext(publicClient: PublicClient, address: Address): Promise<bigint> {
    let result: bigint = 0n;
    this.lock = this.lock.then(async () => {
      if (this.next === null) {
        this.next = BigInt(
          await publicClient.getTransactionCount({ address, blockTag: 'pending' }),
        );
        log.debug(`[nonce] Initial sync from chain: ${this.next}`);
      }
      result = this.next;
      this.next++;
    });
    await this.lock;
    return result;
  }

  /**
   * Re-read the nonce from the chain. Call this after a submit failure so the
   * next caller doesn't reuse a wasted nonce.
   */
  async resync(publicClient: PublicClient, address: Address): Promise<void> {
    this.lock = this.lock.then(async () => {
      const fresh = BigInt(
        await publicClient.getTransactionCount({ address, blockTag: 'pending' }),
      );
      log.warn(`[nonce] Resync ${this.next ?? '?'} → ${fresh}`);
      this.next = fresh;
    });
    await this.lock;
  }
}

/** Process-wide instance — keeper has one signer, one counter. */
export const nonceManager = new NonceManager();
