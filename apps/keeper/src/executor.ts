import { BaseError, ContractFunctionRevertedError, getAddress, parseEventLogs } from 'viem';
import { OrderStatus } from '@prisma/client';
import { ORDER_TYPE_TO_UINT8 } from '@owlorderfi/shared';
import { getConfig } from './config';
import { getDb } from './db';
import { createClients, computeGasPricing, computeGasPricingForReplace, GasTooHighError } from './chain';
import { nonceManager } from './nonceManager';
import { metrics } from './metrics';
import { isPairDead, markPairDead } from './poolCache';
import { isTriggerConditionMet, parseOrderType } from './price';
import { ROUTER_ERRORS_ABI } from './routerErrors';
import { getUniswapQuote, getSpotPriceScaled, buildSwapCalldata, describeRoute, routeFeeForDb } from './uniswap';
import { sendDiscordAlert } from './alerts';
import { circuitBreaker } from './circuitBreaker';
import { log } from './logger';

// ─── Per-poll spot-price memo ────────────────────────────────────────
// The trigger check answers "is this pair past the order's trigger?" — a
// per-PAIR question on the SPOT price, not per-order and not amount-aware.
// We use the pool's slot0 marginal price (amount-independent): a fixed
// probe is fine for USDC but slips badly for a 1-WETH/1-WBTC amount-quote
// on thin pools. Keyed by (pair, orderType) so a whole ladder — rungs of
// different amounts — shares ONE slot0 read per poll, and so the keeper's
// trigger matches the UI's displayed spot (same shared decoder). We cache
// the in-flight Promise so concurrently-polled orders dedupe. Cleared each
// poll. The precise, per-amount quote — and the real slippage check vs the
// signed minAmountOut — happens at the execution slippage gate.
type SpotParams = Parameters<typeof getSpotPriceScaled>[0];
const spotPriceCache = new Map<string, Promise<bigint>>();

export function clearTriggerQuoteCache(): void {
  spotPriceCache.clear();
}

function getSpot(params: SpotParams): Promise<bigint> {
  const key = `${params.tokenIn.toLowerCase()}|${params.tokenOut.toLowerCase()}|${params.orderType}`;
  const hit = spotPriceCache.get(key);
  if (hit) return hit;
  const p = getSpotPriceScaled(params);
  spotPriceCache.set(key, p);
  return p;
}

// Token decimals registry — keeper needs to know decimals for price math.
// Token decimals cache, keyed by `<chainId>:<addressLower>` so two chains
// with the same address (e.g. WETH on Base 0x4200… vs Optimism 0x4200…)
// don't collide. Populated on first miss via ERC20 decimals() and held
// for the rest of the process lifetime. Cost: one ~50ms RPC roundtrip per
// new (chain, token) pair seen, then free forever.
const DECIMALS_CACHE: Record<string, number> = {};

const DECIMALS_ABI = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const;

async function getDecimals(address: string): Promise<number> {
  const { publicClient } = createClients();
  const chainId = publicClient.chain?.id ?? 0;
  const key = `${chainId}:${address.toLowerCase()}`;
  if (key in DECIMALS_CACHE) return DECIMALS_CACHE[key];
  // First miss for this (chain, token) — fetch from chain + cache.
  const decimals = await publicClient.readContract({
    address: address as `0x${string}`,
    abi: DECIMALS_ABI,
    functionName: 'decimals',
  });
  DECIMALS_CACHE[key] = decimals;
  return decimals;
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
          { name: 'feeBps', type: 'uint16' },
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
  ...ROUTER_ERRORS_ABI,
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
  feeBps: number;
  nonce: string;
  signature: string;
  deadline: Date;
  retryCount: number;
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

  const { publicClient, txClient, walletClient, account, chain } = createClients();

  // Use txClient (primary RPC only) for our own-tx lookup. If we used
  // the fallback publicClient and it hit a non-Alchemy RPC that hasn't
  // seen the tx yet, we'd treat the tx as "gone" and skip replacement
  // — see F4/F5 in docs/pre-mainnet-hardening-plan.md for full context.
  const tx = await txClient
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

  // Re-quote the market when bumping so a gas spike since the original
  // submit doesn't leave us replacing at a still-uncompetitive price.
  let bumped: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  try {
    bumped = await computeGasPricingForReplace(publicClient, existingGas);
  } catch (err) {
    if (err instanceof GasTooHighError) {
      log.warn(`${tag} ${err.message} — leaving tx pending, will retry next cycle`);
      return 'skipped';
    }
    throw err;
  }
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
      tokenInDecimals: await getDecimals(order.tokenIn),
      tokenOutDecimals: await getDecimals(order.tokenOut),
    });
  } catch (err) {
    log.error(`${tag} Quote failed during replacement — abandoning`, err);
    return 'skipped';
  }

  const swapData = buildSwapCalldata({
    chainId: config.CHAIN_ID,
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
          feeBps: order.feeBps,
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

  // Trace entry so we can pair it against the poller's "open order(s) to
  // check" log when an order seems to skip evaluation (see investigation
  // 2026-05-22 of a USDC/WBTC order with a 42s silent gap).
  log.debug(`${tag} processOrder start`);

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

  try {
    // Trigger check on the pool's SPOT price (amount-independent),
    // memoized per poll per (pair, orderType). Matches the UI's displayed
    // spot exactly (shared decoder). The precise per-amount quote + the
    // real slippage check happen at the execution slippage gate below.
    const spotScaled = await getSpot({
      orderType: orderTypeStr,
      chainId: config.CHAIN_ID,
      tokenIn: tokenInAddr,
      tokenOut: tokenOutAddr,
      tokenInDecimals: await getDecimals(order.tokenIn),
      tokenOutDecimals: await getDecimals(order.tokenOut),
    });

    const triggerPrice = BigInt(order.triggerPrice);
    const triggered = isTriggerConditionMet(orderTypeStr, spotScaled, triggerPrice);

    if (!triggered) {
      log.debug(`${tag} Not triggered (spot=${spotScaled} trigger=${triggerPrice})`);
      return;
    }
    log.info(`${tag} TRIGGERED ${orderTypeStr} spot=${spotScaled} trigger=${triggerPrice}`);
    metrics.ordersTriggered.inc();
  } catch (err) {
    log.error(`${tag} Price check failed:`, err);
    metrics.errorsByStage.inc({ stage: 'quote' });
    // No direct pool at all → cache as dead so we don't re-probe every poll.
    if (err instanceof Error && err.message.includes('No Uniswap V3 route')) {
      markPairDead(tokenInAddr, tokenOutAddr);
      log.warn(`${tag} Marked pair dead for 5 min — no direct pool for spot`);
    }
    return;
  }

  // Reassigned by the slippage gate below before any use (buildSwapCalldata).
  let quote: Awaited<ReturnType<typeof getUniswapQuote>>;

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

  // Releases the EXECUTING lock after a transient failure (slippage gate,
  // gas spike, re-quote error). Bumps retryCount + stamps lastFailedAt so
  // the poller can back off LIMIT_RETRY_BACKOFF_SEC between attempts. Once
  // retryCount reaches LIMIT_MAX_RETRIES we stop reverting to OPEN and
  // escalate to FAILED — past this point we're churning RPC on an order the
  // pool keeps rejecting (typically a slippage gate that won't soften
  // without maker action: re-sign with more slippage room, or cancel).
  const releaseLock = async (failureReason: string): Promise<void> => {
    const nextCount = order.retryCount + 1;
    const capped = nextCount >= config.LIMIT_MAX_RETRIES;
    await db.order.update({
      where: { id: order.id },
      data: {
        status: capped ? OrderStatus.FAILED : OrderStatus.OPEN,
        executingAt: null,
        retryCount: nextCount,
        lastFailedAt: new Date(),
        failureReason: capped
          ? `${failureReason} (gave up after ${nextCount} attempts)`
          : failureReason,
      },
    });
    if (capped) {
      log.error(`${tag} Escalated to FAILED after ${nextCount} transient retries: ${failureReason}`);
      metrics.ordersByStatus.inc({ status: 'failed' });
      void sendDiscordAlert(
        `Limit order ${order.id.slice(0, 8)} gave up after ${nextCount} retries on chain ${config.CHAIN_ID}: ${failureReason}`,
        config.ALERT_DISCORD_WEBHOOK,
      ).catch(() => {});
    }
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
      tokenInDecimals: await getDecimals(order.tokenIn),
      tokenOutDecimals: await getDecimals(order.tokenOut),
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
    chainId: config.CHAIN_ID,
    tokenIn: getAddress(order.tokenIn),
    tokenOut: getAddress(order.tokenOut),
    route: quote.route,
    amountInRaw: BigInt(order.amountIn),
    minAmountOutRaw: minOutRaw,
    recipient: config.LIMIT_ORDER_ROUTER_ADDRESS,
  });
  log.info(`${tag} Swap calldata built — route=${describeRoute(quote.route)}`);

  // ─── 5. Submit tx ──────────────────────────────────────────────
  const { walletClient, publicClient, txClient, account, chain } = createClients();

  // EIP-1559 gas pricing with configurable headroom over current baseFee.
  // If gas exceeds MAX_FEE_PER_GAS_GWEI (gas war), release the lock and
  // retry next poll cycle when conditions may have cooled. .catch returns
  // null for other (RPC) failures, which is the legacy "submit without
  // explicit gas" fallback path the writeContract handles.
  let gas: Awaited<ReturnType<typeof computeGasPricing>> | null = null;
  try {
    gas = await computeGasPricing(publicClient);
  } catch (err) {
    if (err instanceof GasTooHighError) {
      log.warn(`${tag} ${err.message} — releasing lock, will retry`);
      metrics.errorsByStage.inc({ stage: 'gas_too_high' });
      await releaseLock(`Gas spike: ${err.message}`);
      return;
    }
    // RPC error or similar — let writeContract fall back to its own gas estimation.
  }

  // Reserve a nonce locally so parallel processOrder() calls don't all
  // race on getTransactionCount and collide. Resync on submit failure.
  // Use txClient — nonce manager needs a consistent view of pending-tx
  // state, see F4 in pre-mainnet-hardening-plan.md.
  // MUST release the lock if this throws: getTransactionCount is an RPC
  // call, and if the write endpoint is down/capped (e.g. Alchemy CU
  // limit) it errors here — without releasing, the order sits EXECUTING
  // until the 5-min sweeper, looping forever. Releasing lets it retry
  // next poll once the RPC recovers.
  let txNonce: bigint;
  try {
    txNonce = await nonceManager.getNext(txClient, account.address);
  } catch (err) {
    const errMsg = String(err);
    log.error(`${tag} Nonce fetch failed — releasing lock, will retry: ${errMsg.slice(0, 200)}`);
    metrics.errorsByStage.inc({ stage: 'nonce' });
    await releaseLock(`Nonce fetch failed: ${errMsg.slice(0, 400)}`);
    return;
  }

  // Build the typed args once — reused for both estimateGas and writeContract.
  const executeArgs = [
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
      feeBps: order.feeBps,
    },
    order.signature as `0x${string}`,
    swapData.aggregator,
    swapData.calldata,
  ] as const;

  // Explicit gas limit with headroom. viem's writeContract auto-estimates
  // when no `gas` is given, but the estimate is exact-fit — for Uniswap V3
  // swaps the pool state can shift between estimation and execution,
  // pushing actual usage above the estimate and reverting with OOG. We
  // pre-estimate ourselves and add GAS_LIMIT_HEADROOM_MULT (default 1.3)
  // of safety. On L2s gas is cheap; overpaying 30% on the limit costs
  // ~$0.0003 which is nothing compared to a failed tx that costs the same
  // and leaves the order unfilled.
  let gasLimit: bigint | undefined;
  try {
    const estimated = await publicClient.estimateContractGas({
      address: config.LIMIT_ORDER_ROUTER_ADDRESS,
      abi: ROUTER_ABI,
      functionName: 'executeOrder',
      args: executeArgs,
      account,
    });
    gasLimit = (estimated * BigInt(Math.floor(config.GAS_LIMIT_HEADROOM_MULT * 100))) / 100n;
    log.debug(`${tag} Gas estimate ${estimated} → limit ${gasLimit} (mul ${config.GAS_LIMIT_HEADROOM_MULT})`);
  } catch (err) {
    log.warn(`${tag} estimateContractGas failed — falling back to viem auto-estimate: ${(err as Error).message}`);
    // Let writeContract estimate without headroom. Better than refusing to
    // submit, but the tx may OOG if the swap path is particularly hot.
  }

  let txHash: `0x${string}`;
  try {
    txHash = await walletClient.writeContract({
      address: config.LIMIT_ORDER_ROUTER_ADDRESS,
      abi: ROUTER_ABI,
      functionName: 'executeOrder',
      chain,
      args: executeArgs,
      account,
      nonce: Number(txNonce),
      ...(gasLimit !== undefined ? { gas: gasLimit } : {}),
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
    //
    // viem runs an eth_call simulation inside writeContract before
    // broadcasting; a contract revert at that stage wraps a
    // ContractFunctionRevertedError in the cause chain and the tx
    // never leaves the client. Without this branch, repeated reverts
    // (e.g. a malformed order sitting OPEN in the DB) silently advance
    // the local nonce counter, and later real submissions land at
    // nonces the chain never sees — they sit in "queued" forever.
    // See session log 2026-05-22.
    //
    // We walk the cause chain instead of string-matching the outer
    // ContractFunctionExecutionError class name: viem wraps RPC-level
    // failures (timeouts, malformed responses) in the same outer error,
    // so matching by class name would mis-classify post-broadcast
    // ambiguity as "definitely never sent" and rewind the nonce on a
    // tx that actually made it to the mempool.
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
      await nonceManager.resync(txClient, account.address);
    } else {
      log.warn(
        `${tag} Skipping nonce resync — error may indicate post-broadcast failure; leaving counter at ${txNonce + 1n}`,
      );
    }
    await releaseLock(`Tx error: ${errMsg.slice(0, 400)}`);
    // Feeds the global breaker: a flood of tx-submission failures (bad order
    // spamming reverts, RPC/contract gone bad) trips the kill switch.
    circuitBreaker.recordFailure();
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
    // Receipt poll on txClient (primary-RPC-only) so we hit the same
    // endpoint that accepted our send. See F4 in hardening-plan.md.
    const receipt = await txClient.waitForTransactionReceipt({
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
      // Gas was spent on this revert — the strongest breaker signal.
      circuitBreaker.recordFailure();
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
