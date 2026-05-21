import { getAddress } from 'viem';
import { OrderStatus } from '@prisma/client';
import { ORDER_TYPE_TO_UINT8 } from '@polyorder/shared';
import { getConfig } from './config';
import { getDb } from './db';
import { createClients } from './chain';
import {
  getTokenPricesUSD,
  computeCurrentPriceScaled,
  isTriggerConditionMet,
  parseOrderType,
} from './price';
import { getSwapCalldata } from './aggregator';
import { log } from './logger';

// Minimal ABI — only executeOrder is needed
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

  // ─── 1. Price check ────────────────────────────────────────────
  let triggered: boolean;
  try {
    const prices = await getTokenPricesUSD([order.tokenIn, order.tokenOut]);
    const priceIn = prices[order.tokenIn.toLowerCase()];
    const priceOut = prices[order.tokenOut.toLowerCase()];

    if (priceIn == null || priceOut == null) {
      log.warn(`${tag} Price unavailable for tokens, skipping`);
      return;
    }

    const currentPrice = computeCurrentPriceScaled(orderTypeStr, priceIn, priceOut);
    const triggerPrice = BigInt(order.triggerPrice);
    triggered = isTriggerConditionMet(orderTypeStr, currentPrice, triggerPrice);

    if (!triggered) {
      log.debug(`${tag} Not triggered (cur=${currentPrice} trigger=${triggerPrice})`);
      return;
    }
    log.info(`${tag} TRIGGERED ${orderTypeStr} cur=${currentPrice} trigger=${triggerPrice}`);
  } catch (err) {
    log.error(`${tag} Price check failed:`, err);
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

  // ─── 4. Get aggregator calldata ────────────────────────────────
  let swapData: Awaited<ReturnType<typeof getSwapCalldata>>;
  try {
    swapData = await getSwapCalldata({
      tokenIn: order.tokenIn,
      tokenOut: order.tokenOut,
      amountIn: order.amountIn,
      routerAddress: config.LIMIT_ORDER_ROUTER_ADDRESS,
      minAmountOut: order.minAmountOut,
    });
    log.info(`${tag} Swap calldata fetched, estimatedOut=${swapData.estimatedOutput}`);
  } catch (err) {
    log.error(`${tag} Aggregator calldata failed:`, err);
    await releaseLock(`Aggregator error: ${String(err).slice(0, 400)}`);
    return;
  }

  // ─── 5. Submit tx ──────────────────────────────────────────────
  const { walletClient, publicClient, account, chain } = createClients();

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
    });
    log.info(`${tag} Tx submitted: ${txHash}`);
  } catch (err) {
    log.error(`${tag} Tx submission failed:`, err);
    await releaseLock(`Tx error: ${String(err).slice(0, 400)}`);
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
      await db.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.FILLED,
          filledAt: new Date(),
          filledAmountOut: swapData.estimatedOutput.toString(),
        },
      });
      log.info(`${tag} FILLED in block ${receipt.blockNumber}`);
    } else {
      await db.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.FAILED,
          failureReason: 'Transaction reverted on-chain',
        },
      });
      log.error(`${tag} Tx REVERTED: ${txHash}`);
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
