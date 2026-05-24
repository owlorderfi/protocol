import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicClient, http, getAddress, type Address } from 'viem';
import { CHAINS, type ChainIdType, isSupportedChainId } from '@owlorderfi/shared';

/**
 * Resolves and caches the on-chain `owner()` address of the
 * LimitOrderRouter for each configured chain.
 *
 * Source of truth = contract (not env), so the cache survives an
 * `transferOwnership()` happening between deploys without an API
 * restart. Refresh policy: TTL-based re-read (default 5 min). Cheap
 * — a single eth_call per chain, no event subscriptions to manage.
 *
 * Cache miss / first call triggers an on-demand fetch. Failures
 * bubble up so the OwnerOnlyGuard fails closed (no access until the
 * RPC is reachable + the contract responds).
 */
@Injectable()
export class OwnerService {
  private readonly logger = new Logger(OwnerService.name);
  private readonly ttlMs: number;
  // chainId → { owner, fetchedAt(ms) }
  private cache = new Map<number, { owner: Address; fetchedAt: number }>();

  private static readonly OWNER_ABI = [
    {
      type: 'function',
      name: 'owner',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'address' }],
    },
  ] as const;

  constructor(private readonly config: ConfigService) {
    this.ttlMs = Number(this.config.get<string>('OWNER_CACHE_TTL_SEC') ?? 300) * 1000;
  }

  /**
   * Get the cached owner address for a chain, refetching if past TTL.
   * Throws if the chain isn't supported or the router/RPC isn't
   * configured — the guard relies on this throw to fail closed.
   */
  async getOwner(chainId: number): Promise<Address> {
    if (!isSupportedChainId(chainId)) {
      throw new Error(`Unsupported chainId ${chainId}`);
    }
    const cached = this.cache.get(chainId);
    if (cached && Date.now() - cached.fetchedAt < this.ttlMs) {
      return cached.owner;
    }
    return await this.refetch(chainId);
  }

  private async refetch(chainId: number): Promise<Address> {
    const router = this.resolveRouter(chainId);
    const rpc = this.resolveRpc(chainId);
    const chain = CHAINS[chainId as ChainIdType];

    const client = createPublicClient({
      chain: { id: chain.id, name: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: { default: { http: [rpc] } } } as never,
      transport: http(rpc, { retryCount: 1, timeout: 5_000 }),
    });

    const owner = await client.readContract({
      address: router,
      abi: OwnerService.OWNER_ABI,
      functionName: 'owner',
    });

    const checksummed = getAddress(owner);
    this.cache.set(chainId, { owner: checksummed, fetchedAt: Date.now() });
    this.logger.log(`Resolved owner for chain ${chainId}: ${checksummed}`);
    return checksummed;
  }

  /**
   * Invalidate cache entry — call after a known ownership transfer if
   * you don't want to wait for TTL. Currently unused (TTL is short
   * enough that operators rarely care), exposed for ops hooks.
   */
  invalidate(chainId?: number): void {
    if (chainId === undefined) {
      this.cache.clear();
    } else {
      this.cache.delete(chainId);
    }
  }

  // ─── Helpers — duplicate of the orders-service pattern; could be
  // extracted to a shared chain-config module later when a third
  // consumer shows up.

  private resolveRouter(chainId: number): Address {
    const perChain = this.config.get<string>(`CHAIN_${chainId}_ROUTER`);
    if (perChain && /^0x[a-fA-F0-9]{40}$/.test(perChain)) {
      return perChain as Address;
    }
    const legacy = this.config.get<string>('LIMIT_ORDER_ROUTER_ADDRESS');
    if (legacy && /^0x[a-fA-F0-9]{40}$/.test(legacy)) {
      return legacy as Address;
    }
    throw new Error(
      `No router configured for chain ${chainId} (CHAIN_${chainId}_ROUTER missing)`,
    );
  }

  private resolveRpc(chainId: number): string {
    const perChain = this.config.get<string>(`CHAIN_${chainId}_RPC`);
    if (perChain) {
      // Per-chain may be a comma-separated fallback list; for a single
      // eth_call we just use the first one. No fallback needed for
      // ownership lookups — RPC failure is fine (the guard fails closed).
      const first = perChain.split(',')[0]?.trim();
      if (first) return first;
    }
    // Default to the chain's public RPC from shared config.
    const info = CHAINS[chainId as ChainIdType];
    const first = info?.rpcUrls?.[0];
    if (first) return first;
    throw new Error(`No RPC configured for chain ${chainId}`);
  }
}
