import { getAddress, parseEventLogs } from 'viem';
import { OrderStatus } from '@prisma/client';
import { ORDER_TYPE_TO_UINT8 } from '@polyorder/shared';
import { getConfig } from './config';
import { getDb } from './db';
import { createClients } from './chain';
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

  // ─── 4. Build Uniswap V3 swap calldata ─────────────────────────
  // Reuse the route the quote came from so execution hits the same pools.
  const swapData = buildSwapCalldata({
    tokenIn: getAddress(order.tokenIn),
    tokenOut: getAddress(order.tokenOut),
    route: quote.route,
    amountInRaw: BigInt(order.amountIn),
    minAmountOutRaw: BigInt(order.minAmountOut),
    recipient: config.LIMIT_ORDER_ROUTER_ADDRESS,
  });
  log.info(`${tag} Swap calldata built — route=${describeRoute(quote.route)}`);

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
