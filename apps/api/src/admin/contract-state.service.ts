import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPublicClient,
  http,
  fallback,
  getAddress,
  parseAbiItem,
  parseEventLogs,
  type Address,
} from 'viem';
import { CHAINS, type ChainIdType, isSupportedChainId } from '@owlorderfi/shared';

/** A router event parsed from a log, before timestamp resolution. */
type ParsedEntry = {
  eventName: string;
  blockNumber: bigint;
  transactionHash: `0x${string}`;
  args: Record<string, unknown>;
};

/** A parsed event with its block timestamp resolved — what we cache. */
type CachedEvent = ParsedEntry & { timestamp: number };

/**
 * Read-only view into the LimitOrderRouter on each chain. Multicalls
 * grouped logically (contract-wide state vs per-token fees vs per-keeper
 * status) so the admin dashboard can fetch each panel independently
 * without one slow chain wedging unrelated reads.
 *
 * No caching layer here — let the controller decide TTL per endpoint
 * (paused/feeRecipient barely change, fees move every executeOrder,
 * keeper balances move every gas spend). tanstack-query on the frontend
 * picks the right cadence.
 *
 * RPC client is created per request — viem's generic types around
 * cached clients fight TypeScript. Allocation cost is trivial vs the
 * RPC round-trip these endpoints already pay.
 */
@Injectable()
export class ContractStateService {
  private readonly logger = new Logger(ContractStateService.name);

  // Router ops events surfaced in the admin forensic feed. Kept inline
  // so a router-side event rename forces a touch here.
  private static readonly ROUTER_EVENTS = [
    parseAbiItem('event KeeperRefilled(address indexed keeper, uint256 amount, uint256 windowRemaining)'),
    parseAbiItem('event FeesSwept(address indexed token, uint256 amount, address indexed to)'),
    parseAbiItem('event KeeperReserveAccumulated(address indexed token, uint256 added, uint256 newTotal, uint256 target)'),
    parseAbiItem('event FeesAccumulated(address indexed token, uint256 amount, uint256 newTotal)'),
  ] as const;

  // Per-chain incremental event cache. Cold start backfills to a bounded
  // floor; subsequent polls only forward-scan the new tail. Seeded once
  // per process (lost on restart by design — a rare cheap re-backfill),
  // so the heavy archive pagination stops hammering the RPC every 30s.
  private readonly eventCache = new Map<number, { events: CachedEvent[]; lastScanned: bigint }>();
  private static readonly MAX_CACHED_EVENTS = 500;

  // Trimmed ABI — only what this service reads. Keeping it inline so
  // a router-side ABI change forces a touch here too (no chance of
  // silently calling a removed function).
  private static readonly ROUTER_READ_ABI = [
    { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
    { type: 'function', name: 'feeRecipient', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
    { type: 'function', name: 'keeperReserveTargetWei', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'maxKeeperRefillPerDayWei', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'refilledInCurrentWindow', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'refillWindowDay', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'nativeWrappedToken', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
    { type: 'function', name: 'accumulatedFees', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'sweepThreshold', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'authorizedKeepers', stateMutability: 'view', inputs: [{ name: 'keeper', type: 'address' }], outputs: [{ type: 'bool' }] },
  ] as const;

  // Multicall3 — same canonical address on Base + Polygon (and ~every
  // EVM chain). Lets the admin reads collapse a burst of eth_call reads
  // into ONE round-trip, so a browser hard-refresh (which clears the
  // frontend's tanstack cache and re-fires every read at once) no longer
  // hammers the rate-limited public RPC.
  private static readonly MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;
  private static readonly MULTICALL3_ABI = [
    { type: 'function', name: 'getEthBalance', stateMutability: 'view', inputs: [{ name: 'addr', type: 'address' }], outputs: [{ type: 'uint256' }] },
  ] as const;

  constructor(private readonly config: ConfigService) {}

  async getContractState(chainId: number): Promise<{
    paused: boolean;
    feeRecipient: Address;
    keeperReserveTargetWei: string;
    maxKeeperRefillPerDayWei: string;
    refilledInCurrentWindow: string;
    refillWindowDay: number;
    nativeWrappedToken: Address;
    accumulatedReserve: string;
  }> {
    const router = this.resolveRouter(chainId);
    const client = this.getClient(chainId);
    const abi = ContractStateService.ROUTER_READ_ABI;

    // The seven contract-wide reads in ONE multicall round-trip (was 7
    // separate eth_calls — a rate-limit magnet under a hard-refresh
    // burst). allowFailure:false → throws on any failure, preserving the
    // previous Promise.all error semantics.
    const [
      paused,
      feeRecipient,
      reserveTarget,
      maxRefillPerDay,
      refilledWindow,
      refillDay,
      nativeWrapped,
    ] = await client.multicall({
      allowFailure: false,
      contracts: [
        { address: router, abi, functionName: 'paused' },
        { address: router, abi, functionName: 'feeRecipient' },
        { address: router, abi, functionName: 'keeperReserveTargetWei' },
        { address: router, abi, functionName: 'maxKeeperRefillPerDayWei' },
        { address: router, abi, functionName: 'refilledInCurrentWindow' },
        { address: router, abi, functionName: 'refillWindowDay' },
        { address: router, abi, functionName: 'nativeWrappedToken' },
      ],
    });

    // Reserve currently held = accumulatedFees[nativeWrappedToken].
    // Only meaningful when nativeWrapped is configured (zero = reserve
    // mechanism disabled). One extra read, only when needed.
    let accumulatedReserve = 0n;
    if (nativeWrapped !== '0x0000000000000000000000000000000000000000') {
      accumulatedReserve = await client.readContract({
        address: router,
        abi,
        functionName: 'accumulatedFees',
        args: [nativeWrapped],
      });
    }

    return {
      paused,
      feeRecipient: getAddress(feeRecipient),
      keeperReserveTargetWei: reserveTarget.toString(),
      maxKeeperRefillPerDayWei: maxRefillPerDay.toString(),
      refilledInCurrentWindow: refilledWindow.toString(),
      refillWindowDay: Number(refillDay),
      nativeWrappedToken: getAddress(nativeWrapped),
      accumulatedReserve: accumulatedReserve.toString(),
    };
  }

  async getFeesForTokens(
    chainId: number,
    tokens: Address[],
  ): Promise<Array<{ token: Address; accumulated: string; sweepThreshold: string }>> {
    if (tokens.length === 0) return [];
    if (tokens.length > 50) {
      throw new Error(`Too many tokens: ${tokens.length} > 50 cap`);
    }
    const router = this.resolveRouter(chainId);
    const client = this.getClient(chainId);
    const abi = ContractStateService.ROUTER_READ_ABI;

    // 2N reads (accumulatedFees + sweepThreshold per token) in ONE
    // multicall instead of 2N eth_calls — this is the panel the operator
    // saw stuck on "Loading…" because the burst tripped the rate limit.
    const flat = await client.multicall({
      allowFailure: false,
      contracts: tokens.flatMap((token) => [
        { address: router, abi, functionName: 'accumulatedFees', args: [token] } as const,
        { address: router, abi, functionName: 'sweepThreshold', args: [token] } as const,
      ]),
    });
    return tokens.map((token, i) => ({
      token: getAddress(token),
      accumulated: (flat[i * 2] as bigint).toString(),
      sweepThreshold: (flat[i * 2 + 1] as bigint).toString(),
    }));
  }

  async getKeepersStatus(
    chainId: number,
    addresses: Address[],
  ): Promise<Array<{ address: Address; authorized: boolean; balanceWei: string }>> {
    if (addresses.length === 0) return [];
    if (addresses.length > 20) {
      throw new Error(`Too many keeper addresses: ${addresses.length} > 20 cap`);
    }
    const router = this.resolveRouter(chainId);
    const client = this.getClient(chainId);
    const abi = ContractStateService.ROUTER_READ_ABI;
    const mc3 = ContractStateService.MULTICALL3;
    const mc3Abi = ContractStateService.MULTICALL3_ABI;

    // authorizedKeepers (N) + native balances (N, via Multicall3's own
    // getEthBalance) in ONE multicall — was 2N round-trips. Balances go
    // through Multicall3.getEthBalance so they batch with the auth reads
    // instead of N separate eth_getBalance calls.
    const flat = await client.multicall({
      allowFailure: false,
      contracts: [
        ...addresses.map(
          (addr) => ({ address: router, abi, functionName: 'authorizedKeepers', args: [addr] }) as const,
        ),
        ...addresses.map(
          (addr) => ({ address: mc3, abi: mc3Abi, functionName: 'getEthBalance', args: [addr] }) as const,
        ),
      ],
    });
    const n = addresses.length;
    return addresses.map((addr, i) => ({
      address: getAddress(addr),
      authorized: flat[i] as boolean,
      balanceWei: (flat[n + i] as bigint).toString(),
    }));
  }

  /**
   * Recent ops events from the router — last N events (default 100)
   * across the contract's history. INCREMENTAL: the first call per
   * process backfills to a bounded floor (heavy, once); later calls
   * forward-scan only the new tail since `lastScanned` (one cheap
   * getLogs). This is what stops the 30s poll from re-paginating deep
   * archive every time — which is exactly what tripped publicnode's new
   * archive paywall + rate limit.
   *
   * Returns entries newest-first with block timestamps resolved.
   */
  async getRecentEvents(
    chainId: number,
    targetCount: number = 100,
  ): Promise<
    Array<{
      eventName: string;
      blockNumber: number;
      timestamp: number;
      txHash: `0x${string}`;
      args: Record<string, string>;
    }>
  > {
    const router = this.resolveRouter(chainId);
    const client = this.getEventsClient(chainId);
    const pageSize = this.eventsPageSize(chainId);

    const latest = await client.getBlockNumber();
    let entry = this.eventCache.get(chainId);

    if (!entry) {
      // COLD: one-time backward backfill to a bounded floor.
      const events = await this.backfillEvents(client, router, latest, pageSize);
      entry = { events, lastScanned: latest };
      this.eventCache.set(chainId, entry);
    } else if (latest > entry.lastScanned) {
      // WARM: forward-scan only the new tail (usually a handful of blocks).
      const fresh = await this.scanForward(client, router, entry.lastScanned + 1n, latest, pageSize);
      if (fresh.length > 0) entry.events.push(...fresh); // tail is newer → oldest-first preserved
      entry.lastScanned = latest;
    }
    // latest <= lastScanned (no new blocks / shallow reorg): serve cache.

    // Bound retained history — we only ever return ≤ targetCount.
    if (entry.events.length > ContractStateService.MAX_CACHED_EVENTS) {
      entry.events = entry.events.slice(-ContractStateService.MAX_CACHED_EVENTS);
    }

    const recent = entry.events.slice(-targetCount).reverse(); // newest-first
    return recent.map((e) => ({
      eventName: e.eventName,
      blockNumber: Number(e.blockNumber),
      timestamp: e.timestamp,
      txHash: e.transactionHash,
      // Serialize bigints → strings for JSON wire compatibility.
      args: Object.fromEntries(
        Object.entries(e.args).map(([k, v]) => [
          k,
          typeof v === 'bigint' ? v.toString() : String(v),
        ]),
      ),
    }));
  }

  /**
   * One getLogs page + parse to our event set. parseEventLogs filters
   * out any non-matching logs, so even an address-only query would be
   * safe — but we keep the topic filter to minimise data transferred.
   */
  private async getLogsPage(
    client: ReturnType<typeof this.getEventsClient>,
    router: Address,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<ParsedEntry[]> {
    const logs = await client.getLogs({
      address: router,
      events: ContractStateService.ROUTER_EVENTS as never,
      fromBlock,
      toBlock,
    });
    return parseEventLogs({ abi: ContractStateService.ROUTER_EVENTS as never, logs }) as unknown as ParsedEntry[];
  }

  /** Resolve block timestamps (parallel getBlock per unique block). */
  private async resolveTimestamps(
    client: ReturnType<typeof this.getEventsClient>,
    entries: ParsedEntry[],
  ): Promise<CachedEvent[]> {
    const uniqueBlocks = [...new Set(entries.map((e) => e.blockNumber))];
    const blockMap = new Map<bigint, number>();
    await Promise.all(
      uniqueBlocks.map(async (bn) => {
        const block = await client.getBlock({ blockNumber: bn });
        blockMap.set(bn, Number(block.timestamp));
      }),
    );
    return entries.map((e) => ({ ...e, timestamp: blockMap.get(e.blockNumber) ?? 0 }));
  }

  /**
   * COLD backfill — page backward from `latest` to a bounded floor.
   * Stops on MAX_EMPTY_STREAK consecutive empty pages (past the oldest
   * event) or MAX_PAGES (hard cap on how far "all time" reaches back).
   */
  private async backfillEvents(
    client: ReturnType<typeof this.getEventsClient>,
    router: Address,
    latest: bigint,
    pageSize: bigint,
  ): Promise<CachedEvent[]> {
    const MAX_PAGES = 200;       // bounded lookback (pageSize × 200 blocks)
    const MAX_EMPTY_STREAK = 3;  // stop this many empty pages past oldest event
    let toBlock = latest;
    let collected: ParsedEntry[] = [];
    let emptyStreak = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const fromBlock = toBlock >= pageSize ? toBlock - pageSize + 1n : 0n;
      const parsed = await this.getLogsPage(client, router, fromBlock, toBlock);
      if (parsed.length === 0) {
        emptyStreak++;
        if (emptyStreak >= MAX_EMPTY_STREAK) break;
      } else {
        emptyStreak = 0;
        collected = [...parsed, ...collected]; // prepend older page → oldest-first
      }
      if (fromBlock === 0n) break;
      toBlock = fromBlock - 1n;
    }
    return this.resolveTimestamps(client, collected);
  }

  /**
   * WARM forward-scan over the new tail [fromBlock..toBlock]. Usually one
   * small page; chunked by pageSize and bounded by MAX_PAGES in case the
   * process sat idle long enough for a large gap to accumulate.
   */
  private async scanForward(
    client: ReturnType<typeof this.getEventsClient>,
    router: Address,
    fromBlock: bigint,
    toBlock: bigint,
    pageSize: bigint,
  ): Promise<CachedEvent[]> {
    const MAX_PAGES = 300;
    let cursor = fromBlock;
    let collected: ParsedEntry[] = [];
    for (let page = 0; page < MAX_PAGES && cursor <= toBlock; page++) {
      const end = cursor + pageSize - 1n > toBlock ? toBlock : cursor + pageSize - 1n;
      const parsed = await this.getLogsPage(client, router, cursor, end);
      collected = [...collected, ...parsed]; // ascending → keep oldest-first
      cursor = end + 1n;
    }
    return this.resolveTimestamps(client, collected);
  }

  // ─── Helpers (duplicated from OwnerService — could extract to a
  // shared ChainRpcResolver if a third consumer appears) ─────────────

  private getClient(chainId: number) {
    return this.makeClient(chainId, this.resolveRpcList(chainId));
  }

  /**
   * Separate client for events queries — uses `CHAIN_<id>_EVENTS_RPC`
   * if set, else the main `CHAIN_<id>_RPC` list. Both are full fallback
   * lists. The FIRST entry must be archive-capable: `eth_getLogs` over
   * historical ranges is gated by some free providers (publicnode now
   * returns -32602 "Archive requests require a personal token"). viem's
   * fallback only rotates on transport errors, NOT on an app-level
   * JSON-RPC error like that one — so a broken-archive provider listed
   * first would NOT be skipped. Keep a working archive RPC first (e.g.
   * drpc on Base, Infura on Polygon); the rest are resilience backups.
   */
  private getEventsClient(chainId: number) {
    return this.makeClient(chainId, this.resolveEventsRpcList(chainId));
  }

  /**
   * Build a viem client over a FALLBACK of all configured RPCs (mirrors
   * the keeper's transport posture). A single provider rate-limiting or
   * failing transport-side rotates to the next instead of wedging the
   * whole admin panel — the previous single-RPC client turned one
   * publicnode hiccup into a dead Admin tab.
   */
  private makeClient(chainId: number, rpcs: string[]) {
    if (!isSupportedChainId(chainId)) {
      throw new Error(`Unsupported chainId ${chainId}`);
    }
    if (rpcs.length === 0) {
      throw new Error(`No RPC configured for chain ${chainId}`);
    }
    const chain = CHAINS[chainId as ChainIdType];
    // fallback() is valid with a single transport too, so no length branch.
    const transport = fallback(rpcs.map((u) => http(u, { retryCount: 1, timeout: 8_000 })));
    return createPublicClient({
      chain: {
        id: chain.id,
        name: chain.name,
        nativeCurrency: chain.nativeCurrency,
        rpcUrls: { default: { http: rpcs } },
        // Advertise Multicall3 so client.multicall() resolves the address
        // without us threading it through every call site.
        contracts: { multicall3: { address: ContractStateService.MULTICALL3 } },
      } as never,
      transport,
    });
  }

  private resolveRouter(chainId: number): Address {
    const perChain = this.config.get<string>(`CHAIN_${chainId}_ROUTER`);
    if (perChain && /^0x[a-fA-F0-9]{40}$/.test(perChain)) {
      return perChain as Address;
    }
    const legacy = this.config.get<string>('LIMIT_ORDER_ROUTER_ADDRESS');
    if (legacy && /^0x[a-fA-F0-9]{40}$/.test(legacy)) {
      return legacy as Address;
    }
    throw new Error(`No router configured for chain ${chainId}`);
  }

  /** Full RPC fallback list: env `CHAIN_<id>_RPC` (comma list), then the
   *  registry defaults as a last-resort backstop. De-duped, order kept. */
  private resolveRpcList(chainId: number): string[] {
    const out: string[] = [];
    const push = (u?: string) => {
      const t = u?.trim();
      if (t && !out.includes(t)) out.push(t);
    };
    const perChain = this.config.get<string>(`CHAIN_${chainId}_RPC`);
    if (perChain) perChain.split(',').forEach(push);
    const info = CHAINS[chainId as ChainIdType];
    info?.rpcUrls?.forEach(push);
    if (out.length === 0) throw new Error(`No RPC configured for chain ${chainId}`);
    return out;
  }

  /** Events RPC list: env `CHAIN_<id>_EVENTS_RPC` (comma) if set, else
   *  the main list. First entry MUST be archive-capable (see getEventsClient). */
  private resolveEventsRpcList(chainId: number): string[] {
    const override = this.config.get<string>(`CHAIN_${chainId}_EVENTS_RPC`);
    if (override) {
      const list = override.split(',').map((s) => s.trim()).filter(Boolean);
      if (list.length > 0) return list;
    }
    return this.resolveRpcList(chainId);
  }

  /** Per-chain eth_getLogs page size. Larger = fewer round-trips on the
   *  one-time backfill, but must stay within the FIRST events provider's
   *  range cap (drpc/Infura ≈ 10k; CDP = 1k). Env-tunable; safe default. */
  private eventsPageSize(chainId: number): bigint {
    const raw = this.config.get<string>(`CHAIN_${chainId}_EVENTS_PAGE_SIZE`);
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    if (Number.isFinite(n) && n >= 100 && n <= 10_000) return BigInt(n);
    return 2_000n;
  }

}
