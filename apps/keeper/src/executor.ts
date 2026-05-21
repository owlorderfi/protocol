import { getAddress, parseEventLogs } from 'viem';
import { OrderStatus } from '@prisma/client';
import { ORDER_TYPE_TO_UINT8 } from '@polyorder/shared';
import { getConfig } from './config';
import { getDb } from './db';
import { createClients, computeGasPricing, bumpGas } from './chain';
import { nonceManager } from './nonceManager';
import { metrics } from './metrics';
import { isPairDead, markPairDead } from './poolCache';
import { isTriggerConditionMet, parseOrderType } from './price';
import { getUniswapQuote, buildSwapCalldata, describeRoute, routeFeeForDb } from './uniswap';
import { log } from './logger';

// Token decimals registry — keeper needs to know decimals for price math.
// Mirrors apps/web/src/lib/tokens.ts. Phase 3: pull from on-chain or a shared
// package once we have more than a handful of pairs.
const TOKEN_DECIMALS: Record<string, number> = {
  '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': 6, // USDC native
  '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619': 18, // WETH
  '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270': 18, // WMATIC
  '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6': 8, // WBTC
};

function getDecimals(address: string): number {
  const dec = TOKEN_DECIMALS[address.toLowerCase()];
  if (dec === undefined) throw new Error(`Unknown token decimals for ${address}`);
  return dec;
}

// Minimal ABI — only what the keeper sends + the event it parses back.
const ROUTER_ABI = [
  {
    type: 'function',
    name: 'executeOrder',
    inputs: [
      {
        name: 'order',
        type: 'tuple',
        components: [
          { name: 'maker', type: 'address' },
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'minAmountOut', type: 'uint256' },
          { name: 'orderType', type: 'uint8' },
          { name: 'triggerPrice', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
        ],
      },
      { name: 'signature', type: 'bytes' },
      { name: 'aggregator', type: 'address' },
      { name: 'swapCalldata', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    name: 'OrderExecuted',
    inputs: [
      { name: 'orderHash', type: 'bytes32', indexed: true },
      { name: 'maker', type: 'address', indexed: true },
      { name: 'keeper', type: 'address', indexed: true },
      { name: 'tokenIn', type: 'address', indexed: false },
      { name: 'tokenOut', type: 'address', indexed: false },
      { name: 'amountIn', type: 'uint256', indexed: false },
      // Net amount the maker received (after protocol fee). Use this for
      // filledAmountOut, not the Quoter's pre-fee estimate.
      { name: 'amountOut', type: 'uint256', indexed: false },
      { name: 'fee', type: 'uint256', indexed: false },
      { name: 'orderType', type: 'uint8', indexed: false },
    ],
  },
] as const;

export interface DbOrder {
  id: string;
  chainId: number;
  maker: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  minAmountOut: string;
  triggerPrice: string;
  orderType: string;
  nonce: string;
  signature: string;
  deadline: Date;
}

/**
 * Try to replace a stuck pending tx with a bumped-gas equivalent.
 *
 * - Reads the existing tx by hash. If mined or dropped, returns 'mined'/'gone'.
 * - If still pending, submits a new tx at the SAME nonce with gas bumped by
 *   `GAS_BUMP_PCT`. Polygon (and most EVMs) require ≥10% bump on both
 *   maxFee + priority.
 * - On success, updates Order.txHash to the new hash so the sweeper tracks
 *   the right tx going forward.
 */
export async function tryReplaceStuckTx(
  order: DbOrder & { txHash: string | null },
): Promise<'replaced' | 'mined' | 'gone' | 'skipped'> {
  const config = getConfig();
  const tag = `[replace:${order.id.slice(0, 8)}]`;
  if (!order.txHash) return 'skipped';

  const { publicClient, walletClient, account, chain } = createClients();

  const tx = await publicClient
    .getTransaction({ hash: order.txHash as `0x${string}` })
    .catch(() => null);

  if (!tx) {
    log.warn(`${tag} Tx ${order.txHash} not found on chain — dropped from mempool`);
    return 'gone';
  }
  if (tx.blockNumber !== null) {
    log.info(`${tag} Tx already mined in block ${tx.blockNumber} — no replacement needed`);
    return 'mined';
  }

  // Still pending. Bump gas and resubmit with the SAME nonce.
  const existingGas = {
    maxFeePerGas: tx.maxFeePerGas ?? 0n,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? 0n,
  };
  // Assumption: every keeper-submitted tx is EIP-1559 (we set maxFeePerGas
  // explicitly in processOrder). A legacy Type-0 tx would have maxFeePerGas
  // null, which we treat here as "unreadable" and skip rather than risk a
  // malformed replacement.
  if (existingGas.maxFeePerGas === 0n) {
    log.warn(`${tag} Cannot read original tx gas (legacy tx?) — skipping replacement`);
    return 'skipped';
  }

  const bumped = bumpGas(existingGas, config.GAS_BUMP_PCT);
  let orderTypeStr: ReturnType<typeof parseOrderType>;
  try {
    orderTypeStr = parseOrderType(order.orderType);
  } catch (err) {
    log.error(`${tag} Bad orderType in DB — cannot rebuild tx`, err);
    return 'skipped';
  }

  // Rebuild the swap calldata from current pool state (cheaper than caching).
  let quote: Awaited<ReturnType<typeof getUniswapQuote>>;
  try {
    quote = await getUniswapQuote({
      orderType: orderTypeStr,
      chainId: config.CHAIN_ID,
      tokenIn: getAddress(order.tokenIn),
      tokenOut: getAddress(order.tokenOut),
      amountInRaw: BigInt(order.amountIn),
      tokenInDecimals: getDecimals(order.tokenIn),
      tokenOutDecimals: getDecimals(order.tokenOut),
    });
  } catch (err) {
    log.error(`${tag} Quote failed during replacement — abandoning`, err);
    return 'skipped';
  }

  const swapData = buildSwapCalldata({
    tokenIn: getAddress(order.tokenIn),
    tokenOut: getAddress(order.tokenOut),
    route: quote.route,
    amountInRaw: BigInt(order.amountIn),
    minAmountOutRaw: BigInt(order.minAmountOut),
    recipient: config.LIMIT_ORDER_ROUTER_ADDRESS,
  });

  try {
    const newTxHash = await walletClient.writeContract({
      address: config.LIMIT_ORDER_ROUTER_ADDRESS,
      abi: ROUTER_ABI,
      functionName: 'executeOrder',
      chain,
      args: [
        {
          maker: getAddress(order.maker),
          tokenIn: getAddress(order.tokenIn),
          tokenOut: getAddress(order.tokenOut),
          amountIn: BigInt(order.amountIn),
          minAmountOut: BigInt(order.minAmountOut),
          orderType: ORDER_TYPE_TO_UINT8[orderTypeStr],
          triggerPrice: BigInt(order.triggerPrice),
          deadline: BigInt(Math.floor(order.deadline.getTime() / 1000)),
          nonce: BigInt(order.nonce),
        },
        order.signature as `0x${string}`,
        swapData.aggregator,
        swapData.calldata,
      ],
      account,
      nonce: tx.nonce,
      maxFeePerGas: bumped.maxFeePerGas,
      maxPriorityFeePerGas: bumped.maxPriorityFeePerGas,
    });
    await getDb().order.update({
      where: { id: order.id },
      data: { txHash: newTxHash },
    });
    log.info(
      `${tag} Replaced ${order.txHash} → ${newTxHash} ` +
        `(nonce ${tx.nonce}, gas +${config.GAS_BUMP_PCT}%)`,
    );
    return 'replaced';
  } catch (err) {
    log.error(`${tag} Replacement submit failed`, err);
    return 'skipped';
  }
}

export async function processOrder(order: DbOrder): Promise<void> {
  const config = getConfig();
  const db = getDb();
  const tag = `[order:${order.id.slice(0, 8)}]`;

  // Validate orderType up-front so we fail loud instead of submitting a bad tx
  let orderTypeStr: ReturnType<typeof parseOrderType>;
  try {
    orderTypeStr = parseOrderType(order.orderType);
  } catch (err) {
    log.error(`${tag} ${(err as Error).message} — marking FAILED`);
    await db.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.FAILED, failureReason: (err as Error).message },
    });
    return;
  }

  // ─── 1. Price check via Uniswap V3 ─────────────────────────────
  // Skip pairs recently marked dead — saves ~6 RPC calls per poll cycle on
  // pair sums that have zero liquidity at any fee tier. Re-checks after TTL
  // in case a pool was added since.
  const tokenInAddr = getAddress(order.tokenIn);
  const tokenOutAddr = getAddress(order.tokenOut);
  if (isPairDead(tokenInAddr, tokenOutAddr)) {
    log.debug(`${tag} Pair marked dead (no route), skipping`);
    return;
  }

  let quote: Awaited<ReturnType<typeof getUniswapQuote>>;
  try {
    quote = await getUniswapQuote({
      orderType: orderTypeStr,
      chainId: config.CHAIN_ID,
      tokenIn: tokenInAddr,
      tokenOut: tokenOutAddr,
      amountInRaw: BigInt(order.amountIn),
      tokenInDecimals: getDecimals(order.tokenIn),
      tokenOutDecimals: getDecimals(order.tokenOut),
    });

    const triggerPrice = BigInt(order.triggerPrice);
    const triggered = isTriggerConditionMet(orderTypeStr, quote.currentPriceScaled, triggerPrice);

    if (!triggered) {
      log.debug(
        `${tag} Not triggered (cur=${quote.currentPriceScaled} trigger=${triggerPrice})`,
      );
      return;
    }
    log.info(
      `${tag} TRIGGERED ${orderTypeStr} cur=${quote.currentPriceScaled} trigger=${triggerPrice} estOut=${quote.amountOut} route=${describeRoute(quote.route)}`,
    );
    metrics.ordersTriggered.inc();
  } catch (err) {
    log.error(`${tag} Price check failed:`, err);
    metrics.errorsByStage.inc({ stage: 'quote' });
    // The quote helper throws "No Uniswap V3 route found" when nothing at all
    // resolved. Cache that so we don't pound the same dead pair every 2s.
    if (err instanceof Error && err.message.includes('No Uniswap V3 route')) {
      markPairDead(tokenInAddr, tokenOutAddr);
      log.warn(`${tag} Marked pair dead for 5 min — no Uniswap route at any tier`);
    }
    return;
  }

  // ─── 2. Atomic lock: OPEN → EXECUTING ─────────────────────────
  // Single-statement updateMany with status filter is row-locked by Postgres,
  // so concurrent workers can't both lock. Exactly one gets count===1.
  const lockResult = await db.order.updateMany({
    where: { id: order.id, status: OrderStatus.OPEN },
    data: { status: OrderStatus.EXECUTING, executingAt: new Date() },
  });
  if (lockResult.count !== 1) {
    log.warn(`${tag} Lock not acquired (status changed) — skipping`);
    return;
  }

  // Releases the EXECUTING lock by reverting status + clearing executingAt.
  const releaseLock = async (failureReason: string): Promise<void> => {
    await db.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.OPEN, executingAt: null, failureReason },
    });
  };

  // ─── 3. Skip aggregator + tx in dry-run ────────────────────────
  // Moved BEFORE the aggregator call so dry-run actually works without an API key.
  if (config.DRY_RUN) {
    log.info(`${tag} DRY_RUN — trigger confirmed, skipping aggregator + tx. Releasing lock.`);
    await db.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.OPEN, executingAt: null },
    });
    return;
  }

  // ─── 3.5. Slippage gate — re-quote, abort if pool moved adversely ──
  // The initial trigger quote happened before lock + DRY_RUN. The pool can
  // move in between. If the re-quote would put us within SLIPPAGE_GATE_BUFFER_BPS
  // of the signed minAmountOut, the tx is likely to revert on the contract's
  // slippage check — skip and try again next cycle to save gas.
  const minOutRaw = BigInt(order.minAmountOut);
  try {
    const recheck = await getUniswapQuote({
      orderType: orderTypeStr,
      chainId: config.CHAIN_ID,
      tokenIn: getAddress(order.tokenIn),
      tokenOut: getAddress(order.tokenOut),
      amountInRaw: BigInt(order.amountIn),
      tokenInDecimals: getDecimals(order.tokenIn),
      tokenOutDecimals: getDecimals(order.tokenOut),
    });
    const buffer = (minOutRaw * BigInt(config.SLIPPAGE_GATE_BUFFER_BPS)) / 10_000n;
    if (recheck.amountOut < minOutRaw + buffer) {
      log.warn(
        `${tag} Slippage gate: recheck=${recheck.amountOut} < min=${minOutRaw} + ${config.SLIPPAGE_GATE_BUFFER_BPS}bps buffer (${buffer}) — aborting submit`,
      );
      metrics.errorsByStage.inc({ stage: 'slippage_gate' });
      await releaseLock('Slippage gate: pool moved below buffer, will retry');
      return;
    }
    // Use the recheck quote's route — it may have changed if best route flipped.
    quote = recheck;
  } catch (err) {
    // No band-aid: if the re-quote failed we genuinely don't know the
    // current pool state. Submitting with the (possibly stale) initial
    // quote risks paying gas for a revert. Abort and try next cycle.
    log.error(`${tag} Re-quote failed at slippage gate — aborting submit (will retry)`, err);
    metrics.errorsByStage.inc({ stage: 'slippage_gate_recheck' });
    await releaseLock(`Slippage gate recheck failed: ${String(err).slice(0, 300)}`);
    return;
  }

  // ─── 4. Build Uniswap V3 swap calldata ─────────────────────────
  const swapData = buildSwapCalldata({
    tokenIn: getAddress(order.tokenIn),
    tokenOut: getAddress(order.tokenOut),
    route: quote.route,
    amountInRaw: BigInt(order.amountIn),
    minAmountOutRaw: minOutRaw,
    recipient: config.LIMIT_ORDER_ROUTER_ADDRESS,
  });
  log.info(`${tag} Swap calldata built — route=${describeRoute(quote.route)}`);

  // ─── 5. Submit tx ──────────────────────────────────────────────
  const { walletClient, publicClient, account, chain } = createClients();

  // EIP-1559 gas pricing with configurable headroom over current baseFee.
  const gas = await computeGasPricing(publicClient).catch(() => null);

  // Reserve a nonce locally so parallel processOrder() calls don't all
  // race on getTransactionCount and collide. Resync on submit failure.
  const txNonce = await nonceManager.getNext(publicClient, account.address);

  let txHash: `0x${string}`;
  try {
    txHash = await walletClient.writeContract({
      address: config.LIMIT_ORDER_ROUTER_ADDRESS,
      abi: ROUTER_ABI,
      functionName: 'executeOrder',
      chain,
      args: [
        {
          maker: getAddress(order.maker),
          tokenIn: getAddress(order.tokenIn),
          tokenOut: getAddress(order.tokenOut),
          amountIn: BigInt(order.amountIn),
          minAmountOut: BigInt(order.minAmountOut),
          orderType: ORDER_TYPE_TO_UINT8[orderTypeStr],
          triggerPrice: BigInt(order.triggerPrice),
          deadline: BigInt(Math.floor(order.deadline.getTime() / 1000)),
          nonce: BigInt(order.nonce),
        },
        order.signature as `0x${string}`,
        swapData.aggregator,
        swapData.calldata,
      ],
      account,
      nonce: Number(txNonce),
      ...(gas !== null
        ? { maxFeePerGas: gas.maxFeePerGas, maxPriorityFeePerGas: gas.maxPriorityFeePerGas }
        : {}),
    });
    log.info(
      `${tag} Tx submitted: ${txHash} nonce=${txNonce}` +
        (gas !== null
          ? ` maxFee=${(Number(gas.maxFeePerGas) / 1e9).toFixed(2)}gwei priority=${(Number(gas.maxPriorityFeePerGas) / 1e9).toFixed(2)}gwei`
          : ''),
    );
    metrics.txSubmitted.inc();
  } catch (err) {
    const errMsg = String(err);
    log.error(`${tag} Tx submission failed (nonce ${txNonce}): ${errMsg.slice(0, 200)}`);
    metrics.errorsByStage.inc({ stage: 'submit' });
    // Only resync the nonce when we're confident the tx never actually
    // broadcast. RPC timeouts or "internal server error" could mean the
    // tx made it to the mempool but the response got lost — resyncing
    // there would rewind the counter and cause a collision when the
    // pending tx eventually mines. Heuristic: only treat known
    // pre-broadcast errors as nonce-not-consumed.
    const safeToResync =
      errMsg.includes('nonce too low') ||
      errMsg.includes('replacement transaction underpriced') ||
      errMsg.includes('invalid sender') ||
      errMsg.includes('insufficient funds') ||
      errMsg.includes('exceeds block gas limit');
    if (safeToResync) {
      await nonceManager.resync(publicClient, account.address);
    } else {
      log.warn(
        `${tag} Skipping nonce resync — error may indicate post-broadcast failure; leaving counter at ${txNonce + 1n}`,
      );
    }
    await releaseLock(`Tx error: ${errMsg.slice(0, 400)}`);
    return;
  }

  // Persist txHash immediately so a crash during receipt wait doesn't lose it.
  // The sweeper uses this to resolve stuck EXECUTING orders.
  await db.order.update({
    where: { id: order.id },
    data: { txHash },
  });

  // ─── 6. Wait for receipt ───────────────────────────────────────
  try {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: 120_000,
    });

    if (receipt.status === 'success') {
      // Pull the actual net amount + protocol fee from the OrderExecuted log
      // instead of trusting the Quoter's pre-fee estimate. Falls back to the
      // estimate if (for any reason) the event isn't present.
      const events = parseEventLogs({
        abi: ROUTER_ABI,
        eventName: 'OrderExecuted',
        logs: receipt.logs,
      });
      const ev = events[0];
      const netOut = ev ? ev.args.amountOut : quote.amountOut;
      const feeAmount = ev ? ev.args.fee : 0n;

      await db.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.FILLED,
          filledAt: new Date(),
          filledAmountOut: netOut.toString(),
          // For multihop fills we record the first hop's fee. UI shows
          // "via X% pool" which is a slight simplification — full route
          // is in the keeper log via describeRoute().
          feeTier: routeFeeForDb(quote.route),
          feeAmount: feeAmount.toString(),
        },
      });
      log.info(
        `${tag} FILLED in block ${receipt.blockNumber} netOut=${netOut} fee=${feeAmount}`,
      );
      metrics.ordersByStatus.inc({ status: 'filled' });
      metrics.lastFillAt = Date.now();
    } else {
      await db.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.FAILED,
          failureReason: 'Transaction reverted on-chain',
        },
      });
      log.error(`${tag} Tx REVERTED: ${txHash}`);
      metrics.ordersByStatus.inc({ status: 'failed' });
    }
  } catch (err) {
    // Receipt timeout — leave EXECUTING. txHash is already persisted, so the
    // stuck-order sweeper will resolve this on a later cycle by polling the chain.
    log.error(`${tag} Receipt wait failed (tx=${txHash}):`, err);
    await db.order.update({
      where: { id: order.id },
      data: { failureReason: `Receipt timeout: ${String(err).slice(0, 400)}` },
    });
  }
}
