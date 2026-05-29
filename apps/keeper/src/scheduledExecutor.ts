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
  BaseError,
  ContractFunctionRevertedError,
  encodeFunctionData,
  getAddress,
  parseEventLogs,
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
import { checkBreakEven } from './breakeven';
import { nonceManager } from './nonceManager';
import { circuitBreaker } from './circuitBreaker';
import { ROUTER_ERRORS_ABI } from './routerErrors';

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
  {
    type: 'event',
    name: 'ScheduledOrderExecuted',
    inputs: [
      { name: 'orderHash', type: 'bytes32', indexed: true },
      { name: 'maker', type: 'address', indexed: true },
      { name: 'keeper', type: 'address', indexed: true },
      { name: 'sliceIndex', type: 'uint16', indexed: false },
      { name: 'amountIn', type: 'uint256', indexed: false },
      // Net amount the maker received AFTER the protocol fee — same
      // semantic as the limit-order `OrderExecuted.amountOut` field.
      // Use this instead of the keeper's pre-swap Quoter estimate
      // (the estimate can drift wildly on thin testnet pools where a
      // small trade moves the pool well past the quote).
      { name: 'amountOut', type: 'uint256', indexed: false },
      { name: 'fee', type: 'uint256', indexed: false },
    ],
  },
  ...ROUTER_ERRORS_ABI,
] as const;

/**
 * Decide whether a slice failure should block all future retries for
 * this (orderId, sliceIndex) slot. Used to set the `permanent` flag on
 * the FAILED row.
 *
 * Permanent (don't retry — maker action required):
 *   - InvalidSignature / SignerMismatch (wallet rotated, schema drift)
 *   - OrderExpired / ScheduledExpired (signed validity passed)
 *   - NonceAlreadyUsed (maker cancelled via cancelOrder — sets nonce used)
 *   - ScheduledExhausted (already executed maxSlices on-chain)
 *   - Insufficient maker balance / allowance (top-up needed)
 *
 * Transient (retry after SCHEDULED_RETRY_BACKOFF_SEC):
 *   - BREAK_EVEN_SKIP (gas vs fee math — gas will eventually drop)
 *   - GasTooHigh (cap exceeded by current market)
 *   - InsufficientOutput (slippage hit — next quote may land inside)
 *   - Generic execution reverts (could be transient liquidity)
 *   - RPC errors, timeouts, network blips
 *
 * Default: transient. False positives (retrying a permanent failure)
 * waste a few RPC calls; false negatives (permanently dropping a
 * recoverable slice) silently break the user's TWAP — strongly favour
 * the former.
 *
 * Matches on decoded error names from ROUTER_ERRORS_ABI (lowercased).
 * Do NOT match the bare word 'signature' — viem's diagnostic prefix
 * "reverted with the following signature: 0x..." contains it and
 * would mark every undecoded revert as permanent (real incident:
 * slice 9 of e33731f8 on Arb, 2026-05-27 — actually InsufficientOutput,
 * classified permanent because diagnostic text contained "signature").
 */
function classifyFailure(err: unknown): { permanent: boolean } {
  if (err instanceof GasTooHighError) return { permanent: false };
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes('break_even_skip')) return { permanent: false };
  // A.12: a zero on-chain floor is a config error the maker must fix
  // (re-sign with a floor) — never retriable.
  if (msg.includes('no_price_floor')) return { permanent: true };
  if (msg.includes('invalidsignature') || msg.includes('signermismatch')) {
    return { permanent: true };
  }
  if (msg.includes('orderexpired') || msg.includes('scheduledexpired')) {
    return { permanent: true };
  }
  if (msg.includes('noncealreadyused') || msg.includes('scheduledexhausted')) {
    return { permanent: true };
  }
  // ERC20 fund-side errors bubble through AggregatorCallFailed wrapper
  // ("ERC20: insufficient allowance" / "transfer amount exceeds balance").
  if (msg.includes('insufficient') && (msg.includes('balance') || msg.includes('allowance'))) {
    return { permanent: true };
  }
  // InsufficientOutput on a scheduled order is the MAKER'S floor
  // (minPriceScaled), not aggregator-side slippage. See
  // contracts/src/LimitOrderRouter.sol:751-759 — the contract checks
  // received < (amountIn * minPriceScaled) AFTER the swap completes.
  // The aggregator's own slippage gate surfaces as AggregatorCallFailed,
  // not here. So this branch fires when the market drifted past the
  // maker's signed minimum and retrying won't help until the trend
  // reverses (could be hours/days). Kept transient anyway so the
  // retry-cap loop handles it: 15 attempts × 60s backoff ≈ 15 min
  // before Discord escalation gives the maker a chance to react.
  // TODO: route InsufficientOutput straight to permanent to skip the
  // 15-min RPC waste — left as future work to avoid being overly
  // aggressive while testnet quirks shake out.
  if (msg.includes('insufficientoutput')) return { permanent: false };
  return { permanent: false };
}

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
    const { permanent } = classifyFailure(err);
    log.error(`${tag} Slice ${sliceIndex} FAILED${permanent ? ' (permanent)' : ' (retriable)'}: ${msg}`);
    await db.scheduledExecution.update({
      where: { id: executionId },
      data: {
        status: ScheduledExecutionStatus.FAILED,
        failureReason: msg.slice(0, 500),
        permanent,
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

  // ─── A.12: refuse a slice with no on-chain price floor ────────
  // minPriceScaled=0 makes the contract skip its post-swap floor check
  // (LimitOrderRouter.sol:751), leaving the keeper's RPC-derived minOut as
  // the only guard — a lying/compromised RPC could fill at any price. The
  // current UI can't emit 0, but an order signed via the API directly (or a
  // legacy one) could; classifyFailure marks NO_PRICE_FLOOR permanent so we
  // don't burn the 15-retry loop on it. Maker must re-sign with a floor.
  if (BigInt(order.minPriceScaled) === 0n) {
    throw new Error(
      'NO_PRICE_FLOOR: scheduled order has minPriceScaled=0 (no on-chain floor) — ' +
        'refusing to execute; re-create the order with a price floor',
    );
  }

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
  const { walletClient, publicClient, txClient, account, chain } = createClients();

  // ─── 4a. Break-even gate ─────────────────────────────────────
  // Refuse to broadcast a slice whose protocol fee can't cover the
  // gas it will burn. Protects the keeper operator from losing money
  // on small slices during gas spikes. The frontend has a parallel
  // MIN_SLICE_USD check that catches "design-time" mistakes; this
  // catches "execution-time" surprises (gas spiked since signing).
  // Estimate gas via probe-without-broadcast on the SAME calldata
  // we're about to ship.
  let estimatedGasUnits: bigint;
  try {
    estimatedGasUnits = await publicClient.estimateContractGas({
      address: config.LIMIT_ORDER_ROUTER_ADDRESS,
      abi: SCHEDULED_ROUTER_ABI,
      functionName: 'executeScheduledOrder',
      args: [
        {
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
        },
        order.signature as Hex,
        swapData.aggregator,
        swapData.calldata,
      ],
      account,
    });
  } catch (err) {
    // estimateGas itself can fail (e.g., simulator can't model the
    // pool state). Skip the break-even check rather than abort —
    // the global gas cap below still protects.
    log.warn(`${tag} Break-even gas estimate failed (${(err as Error).message}); skipping check`);
    estimatedGasUnits = 250_000n; // conservative fallback for accounting
  }

  // Get a fresh gas price for the check. We'll fetch it again later
  // for the actual broadcast — this one is just for the math.
  const earlyGas = await computeGasPricing(publicClient).catch(() => null);
  if (earlyGas !== null) {
    const [tokenInSymbol, tokenOutSymbol] = await Promise.all([
      getErc20Symbol(tokenIn),
      getErc20Symbol(tokenOut),
    ]);
    const amountInHuman = Number(amountInRaw) / 10 ** tokenInDecimals;
    const amountOutHuman = Number(quote.amountOut) / 10 ** tokenOutDecimals;
    const be = checkBreakEven({
      chainId: config.CHAIN_ID,
      feeBps: order.feeBps,
      amountInHuman,
      amountOutHuman,
      tokenInSymbol,
      tokenOutSymbol,
      estimatedGasUnits,
      gasPriceWei: earlyGas.maxFeePerGas,
    });
    if (be.priced) {
      log.info(
        `${tag} Break-even: fee $${be.feeUsd!.toFixed(4)} vs gas $${be.gasUsd.toFixed(4)} (${
          be.profitable ? 'OK' : 'SKIP'
        })`,
      );
    }
    if (!be.profitable) {
      throw new Error(`BREAK_EVEN_SKIP: ${be.reason}`);
    }
  }

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
  // Acquire nonce via the shared manager. Previously this path let
  // viem auto-fetch the nonce on each writeContract — fine in isolation
  // but racy when a limit-order fill (executor.ts) or refill
  // (refill.ts) submits concurrently from the same signer address.
  // Both pre-fetched the same "next" nonce from the chain and only
  // the first to land got mined; the rest reverted with "nonce too
  // low". The manager serializes the counter so concurrent submitters
  // get distinct values.
  const txNonce = await nonceManager.getNext(txClient, account.address);
  let txHash: Hex;
  try {
    txHash = await walletClient.writeContract({
      address: config.LIMIT_ORDER_ROUTER_ADDRESS,
      abi: SCHEDULED_ROUTER_ABI,
      functionName: 'executeScheduledOrder',
      chain,
      args: [orderArg, order.signature as Hex, swapData.aggregator, swapData.calldata],
      account,
      nonce: Number(txNonce),
      ...(gasLimit !== undefined ? { gas: gasLimit } : {}),
      ...(gas !== null
        ? { maxFeePerGas: gas.maxFeePerGas, maxPriorityFeePerGas: gas.maxPriorityFeePerGas }
        : {}),
    });
  } catch (err) {
    // Same nonce-rewind heuristic as executor.ts / refill.ts: only
    // resync when we're confident the tx never broadcast. Walking the
    // cause chain for ContractFunctionRevertedError catches the
    // pre-broadcast simulation-revert case without false-positive on
    // RPC-level errors wrapped in the same outer class.
    const errMsg = (err as Error).message ?? String(err);
    const preBroadcastRevert =
      err instanceof BaseError &&
      err.walk((e) => e instanceof ContractFunctionRevertedError) instanceof
        ContractFunctionRevertedError;
    const safeToResync =
      errMsg.includes('nonce too low') ||
      errMsg.includes('replacement transaction underpriced') ||
      errMsg.includes('invalid sender') ||
      errMsg.includes('insufficient funds') ||
      errMsg.includes('exceeds block gas limit') ||
      preBroadcastRevert;
    if (safeToResync) {
      await nonceManager.resync(txClient, account.address).catch((e) => {
        log.error(`${tag} Nonce resync failed: ${(e as Error).message}`);
      });
    } else {
      log.warn(
        `${tag} Skipping nonce resync — error may indicate post-broadcast failure; leaving counter at ${txNonce + 1n}`,
      );
    }
    // Global breaker signal — same as the limit path's tx-submission catch.
    circuitBreaker.recordFailure();
    throw err;
  }

  // Stamp the tx hash right away so a crash mid-receipt-wait doesn't lose it.
  await db.scheduledExecution.update({
    where: { id: executionId },
    data: { txHash },
  });
  log.info(`${tag} Tx submitted: ${txHash} nonce=${txNonce}`);

  // ─── 6. Wait for receipt + parse result ───────────────────────
  // txClient (primary-RPC-only) for receipt — must match the endpoint
  // that accepted our send to avoid visibility-gap replacements. See
  // F4/F5 in docs/pre-mainnet-hardening-plan.md.
  const receipt = await txClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') {
    // Gas spent on a revert — strongest breaker signal (mirrors executor.ts).
    circuitBreaker.recordFailure();
    throw new Error(`Tx reverted on-chain (block ${receipt.blockNumber})`);
  }

  // ─── 7. Persist FILLED + bump parent counters ─────────────────
  // Pull actual on-chain net amount + fee from the ScheduledOrderExecuted
  // log. The keeper's pre-swap Quoter estimate (`quote.amountOut`) can
  // drift wildly from what the aggregator actually delivered, especially
  // on thin testnet pools where:
  //   - a 0.02 WETH trade moves the pool past the quote tick
  //   - the swap was routed through a different tier than quoted
  //   - the pool received MEV / sandwich activity between quote and submit
  // Historic UI display ("Avg: 1 WETH = 42.6 USDC" while live market was
  // 11) was caused by trusting the stale estimate forever.
  //
  // Fall back to the estimate ONLY if the log isn't present (shouldn't
  // happen on success — the contract always emits — but defensive in
  // case of an out-of-spec receipt).
  const events = parseEventLogs({
    abi: SCHEDULED_ROUTER_ABI,
    eventName: 'ScheduledOrderExecuted',
    logs: receipt.logs,
  });
  const ev = events[0];
  const actualAmountOut = ev ? ev.args.amountOut : quote.amountOut;
  const feeAmount = ev ? ev.args.fee : 0n;

  // The parent counters mirror on-chain state — source of truth is the
  // contract, but caching here lets the UI render without a chain read.
  await db.$transaction([
    db.scheduledExecution.update({
      where: { id: executionId },
      data: {
        status: ScheduledExecutionStatus.FILLED,
        amountIn: amountInRaw.toString(),
        amountOut: actualAmountOut.toString(),
        feeAmount: feeAmount.toString(),
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
  log.info(
    `${tag} ✅ Slice ${sliceIndex} FILLED in block ${receipt.blockNumber} netOut=${actualAmountOut} fee=${feeAmount}`,
  );
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

const ERC20_SYMBOL_ABI = [
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
] as const;

const SYMBOL_CACHE: Record<string, string> = {};

async function getErc20Symbol(address: Address): Promise<string> {
  const { publicClient } = createClients();
  const chainId = publicClient.chain?.id ?? 0;
  const key = `${chainId}:${address.toLowerCase()}`;
  if (key in SYMBOL_CACHE) return SYMBOL_CACHE[key];
  try {
    const symbol = await publicClient.readContract({
      address,
      abi: ERC20_SYMBOL_ABI,
      functionName: 'symbol',
    });
    SYMBOL_CACHE[key] = symbol;
    return symbol;
  } catch {
    // Some legacy tokens have bytes32 symbol or no symbol — fall back
    // to address-prefix so the break-even check just skips (no stable
    // match) rather than crashing the executor.
    SYMBOL_CACHE[key] = address.slice(0, 6);
    return SYMBOL_CACHE[key];
  }
}
