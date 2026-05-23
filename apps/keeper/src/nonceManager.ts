import type { Address } from 'viem';
import { log } from './logger';

// We only ever call `getTransactionCount` here — a method that doesn't
// depend on chain-specific block fields. Using a wide structural type
// avoids TypeScript variance errors when the keeper's union of chains
// grows (Polygon + BaseSepolia have different block shapes, which
// breaks assignability to viem's strict PublicClient<TChain>).
type AnyPublicClient = {
  getTransactionCount(args: { address: Address; blockTag: 'pending' }): Promise<number>;
};

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
  // out the same nonce to two parallel callers. The chain stores results
  // in the promise itself (not in a shared `result` variable) so concurrent
  // callers can't observe each other's intermediate state.
  private lock: Promise<bigint | void> = Promise.resolve();

  async getNext(publicClient: AnyPublicClient, address: Address): Promise<bigint> {
    const previous = this.lock;
    const task: Promise<bigint> = (async () => {
      // Wait for any in-flight resync/getNext to complete first. Failures
      // there are visible here; we explicitly catch so this call gets a
      // clean shot at fetching the nonce.
      await previous.catch(() => undefined);
      if (this.next === null) {
        try {
          this.next = BigInt(
            await publicClient.getTransactionCount({ address, blockTag: 'pending' }),
          );
          log.debug(`[nonce] Initial sync from chain: ${this.next}`);
        } catch (err) {
          // Re-throw so the caller knows the RPC failed. The lock chain
          // sees the rejection and lets the next caller try again.
          throw new Error(`getTransactionCount failed: ${(err as Error).message}`);
        }
      }
      const value = this.next;
      this.next++;
      return value;
    })();
    this.lock = task;
    return task;
  }

  /**
   * Re-read the nonce from the chain. Call this after a submit failure so the
   * next caller doesn't reuse a wasted nonce.
   *
   * Caveat: if the underlying tx was actually broadcast and is still pending
   * (RPC timeout after acceptance), this rewinds the counter and a subsequent
   * getNext may hand out a nonce that ends up colliding. Caller should
   * differentiate "broadcast failed" from "submit returned an error but the
   * tx may have shipped" — for the latter, prefer NOT to resync.
   */
  async resync(publicClient: AnyPublicClient, address: Address): Promise<void> {
    const previous = this.lock;
    const task: Promise<void> = (async () => {
      await previous.catch(() => undefined);
      const fresh = BigInt(
        await publicClient.getTransactionCount({ address, blockTag: 'pending' }),
      );
      log.warn(`[nonce] Resync ${this.next ?? '?'} → ${fresh}`);
      this.next = fresh;
    })();
    this.lock = task;
    return task;
  }
}

/** Process-wide instance — keeper has one signer, one counter. */
export const nonceManager = new NonceManager();
