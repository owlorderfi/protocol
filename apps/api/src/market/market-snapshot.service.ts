/**
 * Pool spot snapshotter — feeds the longer-horizon (1h) trend signal used
 * by the web's Smart Suggest. Snapshots the canonical spot price (tokenOut
 * per tokenIn, ×1e18, LIMIT_SELL orientation) for a small set of "highly
 * traded" pairs on each mainnet chain, every 5 minutes. Retention 7 days,
 * pruned daily.
 *
 * The set is hardcoded here for now — it's a small handful of pairs that
 * Smart Suggest is most likely to query. When the tokens registry moves
 * to packages/shared (currently web-only), the snapshot set can derive
 * from CHAINS + tokens registry directly. Until then, manual sync.
 *
 * Why 5 min: smallest granularity Smart Suggest's drift math benefits
 * from at 1h horizon (12 samples = enough to be robust against single-
 * sample noise; finer grain would multiply storage with no UX win).
 * Why 7d retention: Smart Suggest only reads back ≤4h; the extra margin
 * lets us add a UI ribbon (1h / 4h / 24h trend) without re-tuning
 * retention. See PoolSpotSnapshot model docstring.
 *
 * Failure mode: snapshot per pair runs in try/catch; one bad pool (no
 * direct pool, RPC blip) doesn't abort the others. Logs at warn level
 * for one-off failures; persistent failures show up in the row gap.
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { CHAINS, ChainId, type ChainIdType } from '@owlorderfi/shared';
import type { Address } from 'viem';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { MarketService } from './market.service.js';

interface PairSpec {
  chainId: ChainIdType;
  tokenIn: Address;
  tokenInDecimals: number;
  tokenOut: Address;
  tokenOutDecimals: number;
  /** Operator-facing label for logs, e.g. "USDC/WETH on Base". */
  label: string;
}

/**
 * Curated snapshot set. Snapshotting tokenIn=USDC, tokenOut=<asset> gives
 * canonical = asset per USDC, which is "how much asset for 1 USDC" — fine
 * for trend purposes (we compute % change, direction irrelevant).
 *
 * Add a pair: append a row here AND make sure the tokens are listed in
 * apps/web/src/lib/tokens.ts (otherwise the UI's Smart Suggest can't
 * consume the snapshot anyway).
 */
const SNAPSHOT_PAIRS: PairSpec[] = [
  // Base mainnet (chain 8453)
  {
    chainId: ChainId.BASE,
    tokenIn: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
    tokenInDecimals: 6,
    tokenOut: '0x4200000000000000000000000000000000000006', // WETH
    tokenOutDecimals: 18,
    label: 'USDC/WETH on Base',
  },
  {
    chainId: ChainId.BASE,
    tokenIn: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
    tokenInDecimals: 6,
    tokenOut: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', // cbBTC
    tokenOutDecimals: 8,
    label: 'USDC/cbBTC on Base',
  },
  // Polygon mainnet (chain 137)
  {
    chainId: ChainId.POLYGON,
    tokenIn: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // USDC
    tokenInDecimals: 6,
    tokenOut: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', // WETH
    tokenOutDecimals: 18,
    label: 'USDC/WETH on Polygon',
  },
  {
    chainId: ChainId.POLYGON,
    tokenIn: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // USDC
    tokenInDecimals: 6,
    tokenOut: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // WPOL
    tokenOutDecimals: 18,
    label: 'USDC/WPOL on Polygon',
  },
  {
    chainId: ChainId.POLYGON,
    tokenIn: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // USDC
    tokenInDecimals: 6,
    tokenOut: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', // WBTC
    tokenOutDecimals: 8,
    label: 'USDC/WBTC on Polygon',
  },
];

/** Snapshot every 5 minutes (aligned to the wall-clock 00/05/10/...). */
const SNAPSHOT_INTERVAL_MS = 5 * 60_000;
/** Prune snapshots older than this. 7d gives Smart Suggest's ≤4h window
 *  generous headroom and leaves room for a future UI trend ribbon. */
const RETENTION_DAYS = 7;
/** Daily cleanup cadence — runs at process start then once per 24h. */
const CLEANUP_INTERVAL_MS = 24 * 60 * 60_000;
/** Gap between sequential per-pair snapshots within a batch. Was
 *  Promise.all() — fired all 5 in parallel against the same RPC and the
 *  Polygon Infura free tier rate-limited 1-2 of every batch with
 *  "HTTP request failed". Sequential with a small breather drops the
 *  concurrent-call peak to 1, costs ~1.5s per batch (5 × ~300ms), and
 *  fits comfortably in the 5-min budget. */
const INTER_PAIR_DELAY_MS = 250;

@Injectable()
export class MarketSnapshotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketSnapshotService.name);
  // Both timers stored so onModuleDestroy can clear EVERY pending handle
  // (the snapshot loop is now a self-realigning setTimeout chain rather
  // than setInterval — see scheduleNextSnapshot — so the active handle
  // changes between fires; this field tracks whichever one is pending).
  private snapshotTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly market: MarketService,
  ) {}

  onModuleInit(): void {
    // Skip snapshotting on testnets — Smart Suggest gates the 1h drift on
    // mainnet anyway, and testnet pool prices are arbitrary (faucet-funded,
    // not real markets).
    const mainnetPairs = SNAPSHOT_PAIRS.filter(
      (p) => CHAINS[p.chainId] && !CHAINS[p.chainId].isTestnet,
    );
    if (mainnetPairs.length === 0) {
      this.logger.warn('No mainnet pairs configured for snapshotting — skipping');
      return;
    }
    this.logger.log(
      `snapshotter starting — ${mainnetPairs.length} mainnet pairs every ${SNAPSHOT_INTERVAL_MS / 60_000}min`,
    );

    // Schedule the first run aligned to the next 5-min wall-clock boundary
    // so snapshots across restarts/instances fall on the same timestamps.
    this.scheduleNextSnapshot();

    // Cleanup runs immediately on boot (catches up if process was down
    // through a normal cleanup window) and then once per 24h.
    void this.pruneOldSnapshots();
    this.cleanupTimer = setInterval(() => {
      void this.pruneOldSnapshots();
    }, CLEANUP_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    // Both fields can hold either a setTimeout or setInterval handle;
    // clearTimeout works for both (Node's timeout/interval handles are
    // interchangeable for cleanup purposes).
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  /**
   * Self-realigning snapshot schedule. setInterval drifts forward by tens
   * of ms per tick under event-loop pressure, which over hours can push
   * snapshots a second or more past their boundary — eventually risking
   * skipping a full 5-min slot. Each fire re-computes the time until the
   * next boundary and schedules a fresh setTimeout, so drift can't
   * accumulate. The handle is stored in `snapshotTimer` so module destroy
   * always has something to cancel (closing the audit-flagged leak where
   * the initial setTimeout had no stored handle).
   */
  private scheduleNextSnapshot(): void {
    const now = Date.now();
    const msUntilNextBoundary = SNAPSHOT_INTERVAL_MS - (now % SNAPSHOT_INTERVAL_MS);
    this.snapshotTimer = setTimeout(() => {
      void this.snapshotAll();
      // Chain the next one — keeps the timer field populated continuously
      // so onModuleDestroy can always cancel a pending fire.
      this.scheduleNextSnapshot();
    }, msUntilNextBoundary);
  }

  private async snapshotAll(): Promise<void> {
    const ts = new Date();
    // Round to the 5-minute boundary so concurrent writes from two API
    // instances (if we ever scale horizontally) collide on the same PK
    // instead of producing two near-duplicate rows.
    ts.setSeconds(0, 0);
    ts.setMinutes(Math.floor(ts.getMinutes() / 5) * 5);

    let ok = 0;
    let failed = 0;
    const activePairs = SNAPSHOT_PAIRS.filter((p) => !CHAINS[p.chainId]?.isTestnet);
    // Sequential with a small breather between pairs. Was Promise.all and
    // we observed 1-2 HTTP failures per batch on Polygon — Infura free
    // tier rate-limits the 4th/5th concurrent call. Sequential drops the
    // peak concurrency to 1 and the RPC layer + viem fallback chain
    // recover gracefully between requests. Batch total stays well under
    // the 5-min budget (~1-2s for 5 pairs + delays).
    for (const pair of activePairs) {
      try {
        const result = await this.market.getQuote({
          chainId: pair.chainId,
          tokenIn: pair.tokenIn,
          tokenOut: pair.tokenOut,
          orderType: 'LIMIT_SELL',
          tokenInDecimals: pair.tokenInDecimals,
          tokenOutDecimals: pair.tokenOutDecimals,
        });
        if (result.priceScaled === '0') {
          this.logger.warn(`${pair.label}: quote returned 0, skipping`);
          failed++;
        } else {
          // upsert: if the 5-min boundary already has a row (e.g. process
          // restart fired snapshot twice on same boundary), overwrite.
          await this.prisma.poolSpotSnapshot.upsert({
            where: {
              chainId_tokenIn_tokenOut_ts: {
                chainId: pair.chainId,
                tokenIn: pair.tokenIn.toLowerCase(),
                tokenOut: pair.tokenOut.toLowerCase(),
                ts,
              },
            },
            create: {
              chainId: pair.chainId,
              tokenIn: pair.tokenIn.toLowerCase(),
              tokenOut: pair.tokenOut.toLowerCase(),
              priceScaled: result.priceScaled,
              ts,
            },
            update: { priceScaled: result.priceScaled },
          });
          ok++;
        }
      } catch (err) {
        // One bad pool shouldn't kill the whole batch. Logged so
        // persistent failures show up in operator monitoring.
        this.logger.warn(
          `${pair.label}: snapshot failed (${(err as Error).message.slice(0, 120)})`,
        );
        failed++;
      }
      // Pause before the next pair so we don't burst into the RPC. Skip
      // the delay after the last pair to keep batch latency tight.
      if (pair !== activePairs[activePairs.length - 1]) {
        await new Promise<void>((resolve) => setTimeout(resolve, INTER_PAIR_DELAY_MS));
      }
    }
    this.logger.debug(`snapshot batch ${ts.toISOString()}: ok=${ok} failed=${failed}`);
  }

  private async pruneOldSnapshots(): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60_000);
    try {
      const result = await this.prisma.poolSpotSnapshot.deleteMany({
        where: { ts: { lt: cutoff } },
      });
      if (result.count > 0) {
        this.logger.log(`pruned ${result.count} snapshots older than ${RETENTION_DAYS}d`);
      }
    } catch (err) {
      this.logger.error(
        `prune failed: ${(err as Error).message.slice(0, 200)}`,
      );
    }
  }
}
