import cron from 'node-cron';
import { OrderStatus } from '@prisma/client';
import { getConfig } from './config';
import { getDb } from './db';
import { createClients } from './chain';
import { processOrder, tryReplaceStuckTx, type DbOrder } from './executor';
import { log } from './logger';

/**
 * Run up to `maxConcurrent` async tasks in parallel, pulling from a shared queue.
 * Workers pick items until the queue is empty.
 */
async function runConcurrent(
  items: DbOrder[],
  maxConcurrent: number,
  fn: (item: DbOrder) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(maxConcurrent, items.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      await fn(item).catch((err) =>
        log.error(`[poller] Unhandled error for order ${item.id}:`, err),
      );
    }
  });
  await Promise.all(workers);
}

async function pollOrders(): Promise<void> {
  const config = getConfig();
  const db = getDb();
  const now = new Date();

  const orders = await db.order.findMany({
    where: {
      chainId: config.CHAIN_ID,
      status: OrderStatus.OPEN,
      deadline: { gt: now },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (orders.length === 0) return;
  log.debug(`[poller] ${orders.length} open order(s) to check`);

  await runConcurrent(orders as DbOrder[], config.MAX_CONCURRENT_ORDERS, processOrder);
}

async function sweepExpired(): Promise<void> {
  const config = getConfig();
  const db = getDb();

  const { count } = await db.order.updateMany({
    where: {
      chainId: config.CHAIN_ID,
      status: OrderStatus.OPEN,
      deadline: { lte: new Date() },
    },
    data: { status: OrderStatus.EXPIRED },
  });

  if (count > 0) log.info(`[poller] Marked ${count} order(s) EXPIRED`);
}

/**
 * Replace stuck pending txs with bumped-gas versions.
 *
 * Targets orders that are EXECUTING with a tx hash and have been so for
 * longer than TX_REPLACE_AFTER_SEC but less than STUCK_EXECUTING_MINUTES
 * (so we attempt replacement BEFORE giving up via the recovery sweep).
 *
 * Runs once per cron tick; idempotent because tryReplaceStuckTx checks
 * the on-chain state before each attempt.
 */
async function sweepReplaceStuckTxs(): Promise<void> {
  const config = getConfig();
  const db = getDb();
  const now = Date.now();
  const upperBound = new Date(now - config.TX_REPLACE_AFTER_SEC * 1000);
  const lowerBound = new Date(now - config.STUCK_EXECUTING_MINUTES * 60_000);

  const candidates = await db.order.findMany({
    where: {
      chainId: config.CHAIN_ID,
      status: OrderStatus.EXECUTING,
      executingAt: { lte: upperBound, gte: lowerBound },
      txHash: { not: null },
    },
  });

  if (candidates.length === 0) return;
  log.info(
    `[replace-sweep] ${candidates.length} order(s) pending > ${config.TX_REPLACE_AFTER_SEC}s — attempting replacement`,
  );

  for (const o of candidates) {
    await tryReplaceStuckTx(o as DbOrder & { txHash: string | null });
  }
}

/**
 * Recover orders stuck in EXECUTING for too long.
 *
 *   no txHash      → keeper crashed between lock and tx submission; safe to re-OPEN
 *   has txHash     → query the receipt on-chain:
 *                       success      → mark FILLED
 *                       reverted     → mark FAILED
 *                       still pending → leave alone (might confirm soon)
 *
 * Without this, a single keeper crash leaves orders permanently in EXECUTING.
 */
async function sweepStuckExecuting(): Promise<void> {
  const config = getConfig();
  const db = getDb();
  const cutoff = new Date(Date.now() - config.STUCK_EXECUTING_MINUTES * 60_000);

  const stuck = await db.order.findMany({
    where: {
      chainId: config.CHAIN_ID,
      status: OrderStatus.EXECUTING,
      executingAt: { lte: cutoff },
    },
  });

  if (stuck.length === 0) return;
  log.warn(`[sweeper] ${stuck.length} order(s) stuck in EXECUTING > ${config.STUCK_EXECUTING_MINUTES}m`);

  // No on-chain calls needed for orders without txHash — just re-open them.
  const noTxHash = stuck.filter((o) => !o.txHash);
  if (noTxHash.length > 0) {
    await db.order.updateMany({
      where: { id: { in: noTxHash.map((o) => o.id) } },
      data: {
        status: OrderStatus.OPEN,
        executingAt: null,
        failureReason: 'Recovered by sweeper: lock acquired but no tx submitted',
      },
    });
    log.info(`[sweeper] Re-opened ${noTxHash.length} order(s) with no txHash`);
  }

  const withTxHash = stuck.filter((o) => !!o.txHash);
  if (withTxHash.length === 0) return;

  const { publicClient } = createClients();

  for (const o of withTxHash) {
    const tag = `[sweeper:${o.id.slice(0, 8)}]`;
    try {
      const receipt = await publicClient
        .getTransactionReceipt({ hash: o.txHash as `0x${string}` })
        .catch(() => null);

      if (!receipt) {
        log.debug(`${tag} Tx ${o.txHash} still pending — leaving EXECUTING`);
        continue;
      }

      if (receipt.status === 'success') {
        await db.order.update({
          where: { id: o.id },
          data: {
            status: OrderStatus.FILLED,
            filledAt: new Date(),
            failureReason: 'Recovered by sweeper: receipt found post-timeout',
          },
        });
        log.info(`${tag} Recovered → FILLED (block ${receipt.blockNumber})`);
      } else {
        await db.order.update({
          where: { id: o.id },
          data: {
            status: OrderStatus.FAILED,
            failureReason: 'Recovered by sweeper: tx reverted on-chain',
          },
        });
        log.warn(`${tag} Recovered → FAILED (reverted)`);
      }
    } catch (err) {
      log.error(`${tag} Sweep check failed:`, err);
    }
  }
}

export function startPoller(): void {
  const config = getConfig();
  const intervalSec = config.POLL_INTERVAL_SECONDS;

  // node-cron supports 6-field expressions (with seconds): ss mm hh dom mon dow
  const cronExpr =
    intervalSec < 60
      ? `*/${intervalSec} * * * * *` // e.g. every 2 seconds
      : `0 */${Math.floor(intervalSec / 60)} * * * *`; // every N minutes

  cron.schedule(cronExpr, async () => {
    try {
      await pollOrders();
    } catch (err) {
      log.error('[poller] Poll cycle error:', err);
    }
  });

  // Expiry sweep every minute
  cron.schedule('0 * * * * *', async () => {
    try {
      await sweepExpired();
    } catch (err) {
      log.error('[poller] Expiry sweep error:', err);
    }
  });

  // Tx-replacement sweep every 15 seconds — replaces pending txs that are
  // taking too long with bumped-gas versions.
  cron.schedule('*/15 * * * * *', async () => {
    try {
      await sweepReplaceStuckTxs();
    } catch (err) {
      log.error('[poller] Replace sweep error:', err);
    }
  });

  // Stuck-EXECUTING sweeper every minute — last-resort recovery.
  cron.schedule('30 * * * * *', async () => {
    try {
      await sweepStuckExecuting();
    } catch (err) {
      log.error('[poller] Stuck-executing sweep error:', err);
    }
  });

  log.info(
    `[keeper] Poller started — interval=${intervalSec}s, ` +
      `maxConcurrent=${config.MAX_CONCURRENT_ORDERS}, ` +
      `stuckThreshold=${config.STUCK_EXECUTING_MINUTES}m, ` +
      `dryRun=${config.DRY_RUN}`,
  );
}
