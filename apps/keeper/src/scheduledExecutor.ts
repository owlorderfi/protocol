/**
 * Per-slice execution of a scheduled order (DCA / TWAP).
 *
 * Mirrors the shape of executor.ts but for the contract's
 * `executeScheduledOrder` function. The poller hands us due
 * scheduled orders; we attempt one slice each, persist the result.
 *
 * Idempotence: we INSERT into scheduled_executions with the slice
 * index as part of a UNIQUE (scheduledOrderId, sliceIndex) constraint.
 * A double-poll racing to execute the same slice will fail at INSERT
 * — the second caller catches the unique-violation and skips. No
 * double-charging the maker.
 *
 * Status transitions on success:
 *   - If slicesExecuted == maxSlices  → status = COMPLETED
 *   - Else                            → stays ACTIVE
 *   (EXPIRED is set by a separate sweep that doesn't touch this path.)
 */

import {
  encodeFunctionData,
  getAddress,
  type Address,
  type Hex,
} from 'viem';
import {
  ScheduledOrder as DbScheduledOrder,
  ScheduledOrderStatus,
  ScheduledExecutionStatus,
} from '@prisma/client';
import { getDb } from './db';
import { createClients, computeGasPricing, GasTooHighError } from './chain';
import { getUniswapQuote, buildSwapCalldata, routeFeeForDb } from './uniswap';
import { getConfig } from './config';
import { metrics } from './metrics';
import { log } from './logger';

// Minimal ABI for executeScheduledOrder + its event. Matches phase 1b
// of the contract exactly. Field order must NOT drift from the
// Solidity struct + EIP-712 typehash.
const SCHEDULED_ROUTER_ABI = [
  {
    type: 'function',
    name: 'executeScheduledOrder',
    inputs: [
      {
        name: 'order',
        type: 'tuple',
        components: [
          { name: 'maker', type: 'address' },
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountPerSlice', type: 'uint256' },
          { name: 'intervalSec', type: 'uint64' },
          { name: 'startTime', type: 'uint64' },
          { name: 'endTime', type: 'uint64' },
          { name: 'maxSlices', type: 'uint16' },
          { name: 'maxSlippageBps', type: 'uint16' },
          { name: 'minPriceScaled', type: 'uint256' },
          { name: 'feeBps', type: 'uint16' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint64' },
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

export async function processScheduledSlice(order: DbScheduledOrder): Promise<void> {
  const tag = `[scheduled:${order.id.slice(0, 8)}]`;
  const config = getConfig();
  const db = getDb();
  const sliceIndex = order.slicesExecuted;

  // ─── 1. Reserve the slot ──────────────────────────────────────
  // Idempotency anchor — UNIQUE constraint catches concurrent polls.
  let executionId: string;
  try {
    const reserved = await db.scheduledExecution.create({
      data: {
        scheduledOrderId: order.id,
        sliceIndex,
        status: ScheduledExecutionStatus.PENDING,
      },
    });
    executionId = reserved.id;
  } catch (err) {
    // Unique-violation = another worker just reserved this slice.
    // Silently bail; the other worker owns the execution.
    log.debug(`${tag} Slice ${sliceIndex} already reserved by another worker — skip`);
    return;
  }

  log.info(`${tag} Reserved slice ${sliceIndex} (${order.endTime ? 'TWAP' : 'DCA'})`);

  // Wrap remaining work so any failure marks the execution FAILED
  // instead of leaving it as PENDING forever.
  try {
    await runSlice(order, executionId, sliceIndex, tag);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`${tag} Slice ${sliceIndex} FAILED: ${msg}`);
    await db.scheduledExecution.update({
      where: { id: executionId },
      data: {
        status: ScheduledExecutionStatus.FAILED,
        failureReason: msg.slice(0, 500),
      },
    });
    metrics.errorsByStage.inc({ stage: 'scheduled_execute' });
  }

  // After a slice (success or fail), decide whether the order is done.
  await maybeMarkCompleted(order.id);
}

async function runSlice(
  order: DbScheduledOrder,
  executionId: string,
  sliceIndex: number,
  tag: string,
): Promise<void> {
  const config = getConfig();
  const db = getDb();

  // ─── 2. Build quote via existing Uniswap V3 quoter ────────────
  const orderTypeStr = order.tokenIn < order.tokenOut ? 'LIMIT_SELL' : 'LIMIT_BUY';
  // The trigger/price logic doesn't apply here, but getUniswapQuote
  // wants an orderType for the price-direction it returns. Either
  // works for our purpose (we ignore the returned price), pick one.
  const tokenIn = getAddress(order.tokenIn);
  const tokenOut = getAddress(order.tokenOut);
  const amountInRaw = BigInt(order.amountPerSlice);

  const [tokenInDecimals, tokenOutDecimals] = await Promise.all([
    getErc20Decimals(tokenIn),
    getErc20Decimals(tokenOut),
  ]);

  const quote = await getUniswapQuote({
    orderType: orderTypeStr,
    chainId: config.CHAIN_ID,
    tokenIn,
    tokenOut,
    amountInRaw,
    tokenInDecimals,
    tokenOutDecimals,
  });

  // ─── 3. Compute per-slice minOut from signed slippage ────────
  // CRITICAL: minOut MUST be in tokenOut units. Earlier draft applied
  // slippage to amountInRaw (tokenIn units), which produced an absurd
  // floor when the two tokens had different decimals (e.g. 6-decimal
  // USDC → 18-decimal WETH made minOut effectively zero, leaving the
  // aggregator with no slippage gate). The right floor is `quote.amountOut`
  // — the freshly computed expected output — times (1 - slippage).
  // The aggregator's own amountOutMinimum check then fires first if
  // execution diverges from the quote by more than maxSlippageBps.
  // The contract-side InsufficientOutput check still uses the broken
  // formula and is effectively a no-op; tracked as TODO for the next
  // contract revision (see docs/dca-twap-implementation-plan.md).
  const minOut =
    (quote.amountOut * BigInt(10_000 - order.maxSlippageBps)) / 10_000n;

  const swapData = buildSwapCalldata({
    chainId: config.CHAIN_ID,
    tokenIn,
    tokenOut,
    route: quote.route,
    amountInRaw,
    minAmountOutRaw: minOut,
    recipient: config.LIMIT_ORDER_ROUTER_ADDRESS,
  });
  log.info(`${tag} Quote ${quote.amountOut} via ${routeFeeForDb(quote.route)}, minOut ${minOut}`);

  // ─── 4. Build executeScheduledOrder call ──────────────────────
  const { walletClient, publicClient, account, chain } = createClients();

  // Gas pricing (EIP-1559)
  let gas: Awaited<ReturnType<typeof computeGasPricing>> | null = null;
  try {
    gas = await computeGasPricing(publicClient);
  } catch (err) {
    if (err instanceof GasTooHighError) {
      throw err; // poller catches → marks FAILED, retries next cycle when gas cools
    }
    // RPC error — fall through to viem auto-estimate
  }

  // Build typed args for both estimateGas + writeContract
  const orderArg = {
    maker: getAddress(order.maker),
    tokenIn,
    tokenOut,
    amountPerSlice: amountInRaw,
    intervalSec: BigInt(order.intervalSec),
    startTime: BigInt(Math.floor(order.startTime.getTime() / 1000)),
    endTime: BigInt(order.endTime ? Math.floor(order.endTime.getTime() / 1000) : 0),
    maxSlices: order.maxSlices,
    maxSlippageBps: order.maxSlippageBps,
    minPriceScaled: BigInt(order.minPriceScaled),
    feeBps: order.feeBps,
    nonce: BigInt(order.nonce),
    deadline: BigInt(Math.floor(order.deadline.getTime() / 1000)),
  } as const;

  // Pre-estimate gas + headroom — same fix as executeOrder (Base
  // Sepolia OOG bug from 2026-05-23).
  let gasLimit: bigint | undefined;
  try {
    const est = await publicClient.estimateContractGas({
      address: config.LIMIT_ORDER_ROUTER_ADDRESS,
      abi: SCHEDULED_ROUTER_ABI,
      functionName: 'executeScheduledOrder',
      args: [orderArg, order.signature as Hex, swapData.aggregator, swapData.calldata],
      account,
    });
    gasLimit = (est * BigInt(Math.floor(config.GAS_LIMIT_HEADROOM_MULT * 100))) / 100n;
  } catch (err) {
    log.warn(`${tag} estimateContractGas failed, fallback to viem auto: ${(err as Error).message}`);
  }

  // ─── 5. Send tx ───────────────────────────────────────────────
  const txHash = await walletClient.writeContract({
    address: config.LIMIT_ORDER_ROUTER_ADDRESS,
    abi: SCHEDULED_ROUTER_ABI,
    functionName: 'executeScheduledOrder',
    chain,
    args: [orderArg, order.signature as Hex, swapData.aggregator, swapData.calldata],
    account,
    ...(gasLimit !== undefined ? { gas: gasLimit } : {}),
    ...(gas !== null
      ? { maxFeePerGas: gas.maxFeePerGas, maxPriorityFeePerGas: gas.maxPriorityFeePerGas }
      : {}),
  });

  // Stamp the tx hash right away so a crash mid-receipt-wait doesn't lose it.
  await db.scheduledExecution.update({
    where: { id: executionId },
    data: { txHash },
  });
  log.info(`${tag} Tx submitted: ${txHash}`);

  // ─── 6. Wait for receipt + parse result ───────────────────────
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') {
    throw new Error(`Tx reverted on-chain (block ${receipt.blockNumber})`);
  }

  // ─── 7. Persist FILLED + bump parent counters ─────────────────
  // The parent counters mirror on-chain state — source of truth is the
  // contract, but caching here lets the UI render without a chain read.
  await db.$transaction([
    db.scheduledExecution.update({
      where: { id: executionId },
      data: {
        status: ScheduledExecutionStatus.FILLED,
        amountIn: amountInRaw.toString(),
        amountOut: quote.amountOut.toString(), // estimate; refined when we parse the event
      },
    }),
    db.scheduledOrder.update({
      where: { id: order.id },
      data: {
        slicesExecuted: { increment: 1 },
        lastExecutedAt: new Date(),
      },
    }),
  ]);
  metrics.txSubmitted.inc();
  log.info(`${tag} ✅ Slice ${sliceIndex} FILLED in block ${receipt.blockNumber}`);
}

/**
 * Transition the order to COMPLETED if maxSlices was bounded AND
 * we've shipped them all. Called after each slice (success or fail).
 * EXPIRED is set by the sweep, not here.
 */
async function maybeMarkCompleted(orderId: string): Promise<void> {
  const db = getDb();
  const order = await db.scheduledOrder.findUnique({ where: { id: orderId } });
  if (!order || order.status !== ScheduledOrderStatus.ACTIVE) return;
  if (order.maxSlices !== 0 && order.slicesExecuted >= order.maxSlices) {
    await db.scheduledOrder.update({
      where: { id: orderId },
      data: { status: ScheduledOrderStatus.COMPLETED },
    });
    log.info(`[scheduled:${orderId.slice(0, 8)}] Order COMPLETED (${order.slicesExecuted}/${order.maxSlices})`);
  }
}

// ─── ERC20 decimals on-chain lookup (per-chain cached) ──────────
// Mirrors the helper in executor.ts but lives here so scheduledExecutor
// stays self-contained. Could be hoisted to a shared util when we add
// a third execution path.
const DECIMALS_CACHE: Record<string, number> = {};
const ERC20_DECIMALS_ABI = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const;

async function getErc20Decimals(address: Address): Promise<number> {
  const { publicClient } = createClients();
  const chainId = publicClient.chain?.id ?? 0;
  const key = `${chainId}:${address.toLowerCase()}`;
  if (key in DECIMALS_CACHE) return DECIMALS_CACHE[key];
  const decimals = await publicClient.readContract({
    address,
    abi: ERC20_DECIMALS_ABI,
    functionName: 'decimals',
  });
  DECIMALS_CACHE[key] = decimals;
  return decimals;
}
