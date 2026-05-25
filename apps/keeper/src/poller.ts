import cron from 'node-cron';
import { createPublicClient, webSocket } from 'viem';
import { OrderStatus, ScheduledOrderStatus, ScheduledExecutionStatus } from '@prisma/client';
import { getConfig } from './config';
import { getDb } from './db';
import { createClients } from './chain';
import { processOrder, tryReplaceStuckTx, type DbOrder } from './executor';
import { processScheduledSlice } from './scheduledExecutor';
import { metrics } from './metrics';
import { sendDiscordAlert } from './alerts';
import { maybeRefillKeeper } from './refill';
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

  metrics.openOrderCount = orders.length;
  if (orders.length === 0) {
    metrics.lastPollAt = Date.now();
    return;
  }
  // Log id prefixes so we can verify each fetched order actually got
  // processed downstream. Investigated 2026-05-22 where a USDC/WBTC
  // order took 42s to be picked up despite appearing in this list —
  // root cause unknown, this instrumentation will narrow it next time.
  log.debug(
    `[poller] ${orders.length} open order(s) to check: ` +
      orders.map((o) => o.id.slice(0, 8)).join(', '),
  );

  metrics.ordersPolled.inc(orders.length);
  await runConcurrent(orders as DbOrder[], config.MAX_CONCURRENT_ORDERS, processOrder);
  metrics.lastPollAt = Date.now();
}

/**
 * Find scheduled orders due for execution: ACTIVE, on this chain, past
 * startTime, not past endTime, and either never executed OR
 * `lastExecutedAt + intervalSec` has elapsed. Each due order gets one
 * slice attempted via processScheduledSlice (which handles slot
 * reservation, idempotence, FILLED/FAILED persistence on its own).
 */
async function pollScheduled(): Promise<void> {
  const config = getConfig();
  const db = getDb();
  const now = new Date();

  // Pull every ACTIVE order on our chain, then filter the schedule check
  // in JS — Prisma's mapped-where can't express `lastExecutedAt + intervalSec * 1000 ≤ now`
  // directly without raw SQL, and the row count is tiny enough this is cheap.
  const candidates = await db.scheduledOrder.findMany({
    where: {
      chainId: config.CHAIN_ID,
      status: ScheduledOrderStatus.ACTIVE,
      startTime: { lte: now },
      OR: [{ endTime: null }, { endTime: { gt: now } }],
    },
    orderBy: { lastExecutedAt: { sort: 'asc', nulls: 'first' } },
  });

  const due = candidates.filter((o) => {
    if (o.maxSlices !== 0 && o.slicesExecuted >= o.maxSlices) return false;
    if (o.lastExecutedAt === null) return true; // first slice ever
    const nextAt = o.lastExecutedAt.getTime() + o.intervalSec * 1000;
    return now.getTime() >= nextAt;
  });

  if (due.length === 0) return;

  // Retry gate: for each due order, find the latest scheduledExecution
  // for the slot the keeper would attempt next (= slicesExecuted). Skip
  // when a prior FAILED row blocks us:
  //   - `permanent` → never retry; the maker needs to act (re-sign,
  //     top up balance, cancel).
  //   - transient + within SCHEDULED_RETRY_BACKOFF_SEC → wait it out;
  //     re-quoting every 2s during a sustained gas spike just burns RPC.
  // Without this gate, the partial unique index on (orderId, sliceIndex)
  // WHERE status IN ('PENDING','FILLED') would happily let us spam new
  // PENDING rows every tick — correct but wasteful.
  const backoffMs = config.SCHEDULED_RETRY_BACKOFF_SEC * 1000;
  const eligible: typeof due = [];
  for (const o of due) {
    const last = await db.scheduledExecution.findFirst({
      where: { scheduledOrderId: o.id, sliceIndex: o.slicesExecuted },
      orderBy: { executedAt: 'desc' },
    });
    if (!last || last.status !== ScheduledExecutionStatus.FAILED) {
      eligible.push(o);
      continue;
    }
    if (last.permanent) {
      log.debug(
        `[scheduled-poller] ${o.id.slice(0, 8)} slice ${o.slicesExecuted} permanently failed (${last.failureReason ?? '?'}) — skip`,
      );
      continue;
    }
    const ageMs = now.getTime() - last.executedAt.getTime();
    if (ageMs < backoffMs) {
      log.debug(
        `[scheduled-poller] ${o.id.slice(0, 8)} slice ${o.slicesExecuted} in retry backoff (${Math.floor(ageMs / 1000)}s/${config.SCHEDULED_RETRY_BACKOFF_SEC}s)`,
      );
      continue;
    }
    eligible.push(o);
  }

  if (eligible.length === 0) return;
  log.debug(`[scheduled-poller] ${eligible.length} eligible slice(s) of ${due.length} due / ${candidates.length} active orders`);

  // One worker per slice — concurrency capped by MAX_CONCURRENT_ORDERS
  // shared with the limit-order path. The same nonce manager serializes
  // tx submission so we don't collide.
  await Promise.all(
    eligible
      .slice(0, config.MAX_CONCURRENT_ORDERS)
      .map((o) =>
        processScheduledSlice(o).catch((err) =>
          log.error(`[scheduled-poller] Unhandled error for ${o.id}: ${err}`),
        ),
      ),
  );
}

/**
 * Mark ACTIVE scheduled orders EXPIRED when their endTime is in the
 * past. Runs once a minute alongside the limit-order expiry sweep.
 */
async function sweepScheduledExpired(): Promise<void> {
  const config = getConfig();
  const db = getDb();
  const { count } = await db.scheduledOrder.updateMany({
    where: {
      chainId: config.CHAIN_ID,
      status: ScheduledOrderStatus.ACTIVE,
      endTime: { lte: new Date() },
    },
    data: { status: ScheduledOrderStatus.EXPIRED },
  });
  if (count > 0) log.info(`[scheduled-poller] Marked ${count} order(s) EXPIRED`);
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

  // Parallelize with the same MAX_CONCURRENT_ORDERS budget so a backlog of
  // stuck txs doesn't block the sweep for N × RPC roundtrips.
  await runConcurrent(
    candidates as DbOrder[],
    config.MAX_CONCURRENT_ORDERS,
    async (o) => {
      const result = await tryReplaceStuckTx(
        o as DbOrder & { txHash: string | null },
      );
      if (result === 'replaced') metrics.txReplaced.inc();
    },
  );
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

/**
 * Discord alert when the pipeline looks stuck:
 *  - we have OPEN orders waiting
 *  - we've had at least one fill before (so we know the keeper *can* fill)
 *  - too long has passed since that last fill
 *
 * Throttled so a persistent issue doesn't spam — re-alerts at most once per
 * stuck threshold window.
 */
async function checkPipelineStuck(): Promise<void> {
  const config = getConfig();
  if (!config.ALERT_DISCORD_WEBHOOK) return;
  if (metrics.openOrderCount === 0) return;
  if (metrics.lastFillAt === 0) return; // no baseline yet — wait for first fill

  const thresholdMs = config.ALERT_PIPELINE_STUCK_MIN * 60_000;
  const sinceFillMs = Date.now() - metrics.lastFillAt;
  if (sinceFillMs < thresholdMs) return;

  // Throttle so we don't spam every minute while stuck.
  if (metrics.lastAlertAt !== 0 && Date.now() - metrics.lastAlertAt < thresholdMs) return;

  const minSinceFill = Math.floor(sinceFillMs / 60_000);
  const sinceLastPollSec = Math.floor((Date.now() - metrics.lastPollAt) / 1000);
  const message =
    `⚠️ **OwlOrderFi keeper pipeline may be stuck**\n` +
    `• Open orders: \`${metrics.openOrderCount}\`\n` +
    `• Last fill: \`${minSinceFill} min ago\`\n` +
    `• Last poll: \`${sinceLastPollSec}s ago\`\n` +
    `• Tx submitted total: \`${metrics.txSubmitted.get()}\`\n` +
    `• Check: RPC connectivity, gas spike, contract paused?`;

  await sendDiscordAlert(message, config.ALERT_DISCORD_WEBHOOK);
  metrics.lastAlertAt = Date.now();
  log.warn(
    `[alert] Pipeline stuck for ${minSinceFill}m with ${metrics.openOrderCount} open orders — Discord notified`,
  );
}

/**
 * Optional WebSocket subscription to new blocks for sub-cron-tick latency.
 *
 * Watches newHeads and triggers pollOrders() once per block (~2s on
 * Polygon and most L2s; 12s on Ethereum L1 — tune POLL_INTERVAL_SECONDS
 * accordingly for L1 deployments).
 * Reconnect strategy: exponential backoff capped at 60s. If the WS dies, the
 * cron tick keeps going as fallback so latency degrades to ~2s worst case but
 * the keeper doesn't go blind.
 */
function startBlockSubscription(): void {
  const config = getConfig();
  if (!config.WS_RPC_URL) return;

  let backoffMs = 1_000;
  const maxBackoffMs = 60_000;

  const connect = () => {
    try {
      const { chain } = createClients();
      const wsClient = createPublicClient({
        chain,
        transport: webSocket(config.WS_RPC_URL),
      });
      const unwatch = wsClient.watchBlockNumber({
        emitOnBegin: false,
        onBlockNumber: (blockNumber) => {
          backoffMs = 1_000; // healthy block → reset backoff
          log.debug(`[ws] Block ${blockNumber} — immediate poll`);
          pollOrders().catch((err) => log.error('[ws] Immediate poll error:', err));
        },
        onError: (err) => {
          log.error(`[ws] Subscription error, reconnect in ${backoffMs}ms:`, err);
          metrics.errorsByStage.inc({ stage: 'ws_subscription' });
          try {
            unwatch();
          } catch {
            /* may already be torn down */
          }
          setTimeout(connect, backoffMs);
          backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
        },
      });
      log.info(`[ws] Subscribed to ${config.WS_RPC_URL} newHeads`);
    } catch (err) {
      log.error(`[ws] Failed to connect, retry in ${backoffMs}ms:`, err);
      setTimeout(connect, backoffMs);
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    }
  };

  connect();
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
      await sweepScheduledExpired();
    } catch (err) {
      log.error('[poller] Expiry sweep error:', err);
    }
  });

  // Scheduled-order poller — cadence 30s. DCA/TWAP latency isn't
  // critical (slices are minutes-to-days apart), so we save RPC load
  // vs the 2s tick used for limit orders. Order completes on time
  // even with this lag because intervalSec >> 30s in practice.
  cron.schedule('*/30 * * * * *', async () => {
    try {
      await pollScheduled();
    } catch (err) {
      log.error('[scheduled-poller] Poll cycle error:', err);
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

  // Pipeline-stuck Discord alert — every minute, throttled internally.
  cron.schedule('45 * * * * *', async () => {
    try {
      await checkPipelineStuck();
    } catch (err) {
      log.error('[poller] Pipeline check error:', err);
    }
  });

  // Keeper self-refill — checks native balance; pulls from the
  // contract's accumulated WETH reserve when below threshold. Internal
  // throttling so a refill-disabled config or empty reserve doesn't
  // spam every tick. Cadence configurable; default 5 min is plenty
  // since balance drains slowly under normal load.
  const refillIntervalSec = config.KEEPER_REFILL_CHECK_INTERVAL_SEC;
  const refillCron =
    refillIntervalSec < 60
      ? `*/${refillIntervalSec} * * * * *`
      : `0 */${Math.floor(refillIntervalSec / 60)} * * * *`;
  cron.schedule(refillCron, async () => {
    try {
      await maybeRefillKeeper();
    } catch (err) {
      log.error('[poller] Refill check error:', err);
    }
  });

  log.info(
    `[keeper] Poller started — interval=${intervalSec}s, ` +
      `maxConcurrent=${config.MAX_CONCURRENT_ORDERS}, ` +
      `stuckThreshold=${config.STUCK_EXECUTING_MINUTES}m, ` +
      `dryRun=${config.DRY_RUN}`,
  );

  startBlockSubscription();
}
