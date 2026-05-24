import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPublicClient,
  http,
  getAddress,
  parseAbiItem,
  parseEventLogs,
  type Address,
} from 'viem';
import { CHAINS, type ChainIdType, isSupportedChainId } from '@owlorderfi/shared';

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

    // Fire the seven contract-wide reads in parallel. None depend on
    // each other so a Promise.all is fine (each adds one RPC round-
    // trip; multicall would batch to one but is per-chain config we
    // don't want to maintain yet — see plan doc).
    const [
      paused,
      feeRecipient,
      reserveTarget,
      maxRefillPerDay,
      refilledWindow,
      refillDay,
      nativeWrapped,
    ] = await Promise.all([
      client.readContract({ address: router, abi: ContractStateService.ROUTER_READ_ABI, functionName: 'paused' }),
      client.readContract({ address: router, abi: ContractStateService.ROUTER_READ_ABI, functionName: 'feeRecipient' }),
      client.readContract({ address: router, abi: ContractStateService.ROUTER_READ_ABI, functionName: 'keeperReserveTargetWei' }),
      client.readContract({ address: router, abi: ContractStateService.ROUTER_READ_ABI, functionName: 'maxKeeperRefillPerDayWei' }),
      client.readContract({ address: router, abi: ContractStateService.ROUTER_READ_ABI, functionName: 'refilledInCurrentWindow' }),
      client.readContract({ address: router, abi: ContractStateService.ROUTER_READ_ABI, functionName: 'refillWindowDay' }),
      client.readContract({ address: router, abi: ContractStateService.ROUTER_READ_ABI, functionName: 'nativeWrappedToken' }),
    ]);

    // Reserve currently held = accumulatedFees[nativeWrappedToken].
    // Only meaningful when nativeWrapped is configured (zero = reserve
    // mechanism disabled).
    let accumulatedReserve = 0n;
    if (nativeWrapped !== '0x0000000000000000000000000000000000000000') {
      accumulatedReserve = await client.readContract({
        address: router,
        abi: ContractStateService.ROUTER_READ_ABI,
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

    // 2N round-trips. With 4-8 tokens this is fine; if it grows we'll
    // switch to multicall.
    const results = await Promise.all(
      tokens.map(async (token) => {
        const [accumulated, threshold] = await Promise.all([
          client.readContract({
            address: router,
            abi: ContractStateService.ROUTER_READ_ABI,
            functionName: 'accumulatedFees',
            args: [token],
          }),
          client.readContract({
            address: router,
            abi: ContractStateService.ROUTER_READ_ABI,
            functionName: 'sweepThreshold',
            args: [token],
          }),
        ]);
        return {
          token: getAddress(token),
          accumulated: accumulated.toString(),
          sweepThreshold: threshold.toString(),
        };
      }),
    );
    return results;
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

    const results = await Promise.all(
      addresses.map(async (addr) => {
        const [authorized, balance] = await Promise.all([
          client.readContract({
            address: router,
            abi: ContractStateService.ROUTER_READ_ABI,
            functionName: 'authorizedKeepers',
            args: [addr],
          }),
          client.getBalance({ address: addr }),
        ]);
        return {
          address: getAddress(addr),
          authorized,
          balanceWei: balance.toString(),
        };
      }),
    );
    return results;
  }

  /**
   * Recent ops events from the router — last N events (default 100)
   * across the contract's full history. Paginates backwards through
   * 2000-block windows (most RPCs cap eth_getLogs at this) until
   * either the target count is reached or we hit consecutive empty
   * pages (≈ past the deploy block / quiet period).
   *
   * RPC cost: 1 getBlockNumber + N getLogs (one per page) + M getBlock
   * (unique block numbers for timestamps). Hard-capped at MAX_PAGES so
   * a brand-new contract with zero history doesn't spin forever; hard-
   * capped on empty-streak so a long gap-then-events case stops early.
   *
   * Returns parsed entries with block timestamps resolved (parallel
   * getBlock per unique blockNumber).
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
    const client = this.getClient(chainId);

    const events = [
      parseAbiItem('event KeeperRefilled(address indexed keeper, uint256 amount, uint256 windowRemaining)'),
      parseAbiItem('event FeesSwept(address indexed token, uint256 amount, address indexed to)'),
      parseAbiItem('event KeeperReserveAccumulated(address indexed token, uint256 added, uint256 newTotal, uint256 target)'),
      parseAbiItem('event FeesAccumulated(address indexed token, uint256 amount, uint256 newTotal)'),
    ] as const;

    type ParsedEntry = {
      eventName: string;
      blockNumber: bigint;
      transactionHash: `0x${string}`;
      args: Record<string, unknown>;
    };

    const PAGE_SIZE = 2000n; // most RPCs' eth_getLogs hard cap
    const MAX_PAGES = 100;   // 200k blocks back ≈ 4-5 days on Base; safety
    const MAX_EMPTY_STREAK = 3; // stop after this many empty pages

    const latest = await client.getBlockNumber();
    let toBlock = latest;
    let collected: ParsedEntry[] = [];
    let emptyStreak = 0;

    for (let page = 0; page < MAX_PAGES && collected.length < targetCount; page++) {
      const fromBlock = toBlock > PAGE_SIZE ? toBlock - PAGE_SIZE + 1n : 0n;

      const logs = await client.getLogs({
        address: router,
        events: events as never,
        fromBlock,
        toBlock,
      });

      const parsed = parseEventLogs({
        abi: events as never,
        logs,
      }) as unknown as ParsedEntry[];

      if (parsed.length === 0) {
        emptyStreak++;
        if (emptyStreak >= MAX_EMPTY_STREAK) break;
      } else {
        emptyStreak = 0;
        // Prepend older page to keep array oldest-first (getLogs returns
        // ascending within a page, and we paginate descending across pages).
        collected = [...parsed, ...collected];
      }

      if (fromBlock === 0n) break;       // reached genesis-ish
      toBlock = fromBlock - 1n;          // continue strictly earlier
    }

    // Last N reversed → newest first.
    const recent = collected.slice(-targetCount).reverse();

    // Parallel timestamp resolution.
    const uniqueBlocks = [...new Set(recent.map((e) => e.blockNumber))];
    const blockMap = new Map<bigint, number>();
    await Promise.all(
      uniqueBlocks.map(async (bn) => {
        const block = await client.getBlock({ blockNumber: bn });
        blockMap.set(bn, Number(block.timestamp));
      }),
    );

    return recent.map((e) => ({
      eventName: e.eventName,
      blockNumber: Number(e.blockNumber),
      timestamp: blockMap.get(e.blockNumber) ?? 0,
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

  // ─── Helpers (duplicated from OwnerService — could extract to a
  // shared ChainRpcResolver if a third consumer appears) ─────────────

  private getClient(chainId: number) {
    if (!isSupportedChainId(chainId)) {
      throw new Error(`Unsupported chainId ${chainId}`);
    }
    const rpc = this.resolveRpc(chainId);
    const chain = CHAINS[chainId as ChainIdType];
    return createPublicClient({
      chain: { id: chain.id, name: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: { default: { http: [rpc] } } } as never,
      transport: http(rpc, { retryCount: 1, timeout: 5_000 }),
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

  private resolveRpc(chainId: number): string {
    const perChain = this.config.get<string>(`CHAIN_${chainId}_RPC`);
    if (perChain) {
      const first = perChain.split(',')[0]?.trim();
      if (first) return first;
    }
    const info = CHAINS[chainId as ChainIdType];
    const first = info?.rpcUrls?.[0];
    if (first) return first;
    throw new Error(`No RPC configured for chain ${chainId}`);
  }

}
