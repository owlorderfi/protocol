import { formatEther } from 'viem';
import { sendDiscordAlert } from './alerts';
import { createClients } from './chain';
import { getConfig } from './config';
import { log } from './logger';
import { nonceManager } from './nonceManager';

/**
 * ABI for the contract-side refill function. Mirrors the Solidity
 * signature; we only need `refillKeeper` here so we don't pull in the
 * full ROUTER_ABI from executor.ts (keeps this module self-contained).
 */
const REFILL_ABI = [
  {
    type: 'function',
    name: 'refillKeeper',
    inputs: [{ name: 'maxAmountWei', type: 'uint256' }],
    outputs: [{ name: 'actualAmount', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'accumulatedFees',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'nativeWrappedToken',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
] as const;

/**
 * Per-call throttle: avoids hammering the chain when refills fail
 * back-to-back (e.g. KeeperRefillExceedsCap right after a successful
 * refill, or no accumulated fees yet). Reset on success.
 */
let lastAttemptAt = 0;
const RETRY_BACKOFF_SEC = 3600; // 1h after a failed/skip attempt

/**
 * Cron-safety guard. The default 5-min interval can't overlap with the
 * 60s receipt wait, but operators may tune intervals down — the flag
 * makes that safe regardless. Always pair set/clear with try/finally
 * so a thrown error never wedges the keeper.
 */
let inFlight = false;

/**
 * Check keeper native balance; if below threshold, pull a tranche from
 * the contract's accumulated WETH reserve via refillKeeper. Designed to
 * be safe-to-run-every-N-minutes — bails out cheaply when:
 *
 *   - balance >= threshold (no action needed)
 *   - native wrapped token not configured on the contract (refill
 *     mechanism intentionally disabled by the owner)
 *   - accumulated fees too low to be worth attempting (saves a revert)
 *   - last attempt was a failure within the backoff window
 *   - a previous invocation is still in flight
 *
 * Fires a Discord alert on actual top-up AND on hard failures (chain
 * errors that aren't just "nothing to refill yet"). Logs success at
 * info level for the ops timeline.
 *
 * Nonce: uses the shared `nonceManager` so refill txs don't race
 * concurrent executeOrder/executeScheduledOrder txs from the keeper
 * (both writers share one signer address; without a managed counter
 * they'd silently collide and "nonce too low" one of them).
 */
export async function maybeRefillKeeper(): Promise<void> {
  if (inFlight) {
    log.debug('[refill] previous invocation still in flight — skipping this tick');
    return;
  }
  inFlight = true;
  try {
    await _maybeRefillKeeperInner();
  } finally {
    inFlight = false;
  }
}

async function _maybeRefillKeeperInner(): Promise<void> {
  const config = getConfig();
  const { publicClient, walletClient, account, chain } = createClients();
  const now = Math.floor(Date.now() / 1000);

  if (now - lastAttemptAt < RETRY_BACKOFF_SEC && lastAttemptAt !== 0) {
    log.debug(
      `[refill] in backoff window — last attempt ${now - lastAttemptAt}s ago, ` +
        `next eligible in ${RETRY_BACKOFF_SEC - (now - lastAttemptAt)}s`,
    );
    return;
  }

  // ─── All chain reads in one try/catch so any RPC blip trips the
  // backoff (instead of throwing out and letting the next tick retry
  // immediately, hammering a flaky endpoint).
  let balance: bigint;
  let nativeWrapped: `0x${string}`;
  let accumulated: bigint;
  try {
    balance = await publicClient.getBalance({ address: account.address });
    if (balance >= config.KEEPER_BALANCE_THRESHOLD_WEI) {
      log.debug(
        `[refill] balance ${formatEther(balance)} ETH >= threshold ` +
          `${formatEther(config.KEEPER_BALANCE_THRESHOLD_WEI)} — no refill needed`,
      );
      return;
    }

    nativeWrapped = await publicClient.readContract({
      address: config.LIMIT_ORDER_ROUTER_ADDRESS,
      abi: REFILL_ABI,
      functionName: 'nativeWrappedToken',
    });

    if (nativeWrapped === '0x0000000000000000000000000000000000000000') {
      // Owner deliberately disabled the refill mechanism. Don't alert
      // — this is a config state, not a problem. Just sleep the cycle.
      log.warn(
        `[refill] balance ${formatEther(balance)} ETH below threshold but ` +
          `nativeWrappedToken == 0 on router — refill mechanism disabled by owner. ` +
          `Top up keeper manually or call setNativeWrappedToken().`,
      );
      lastAttemptAt = now;
      return;
    }

    accumulated = await publicClient.readContract({
      address: config.LIMIT_ORDER_ROUTER_ADDRESS,
      abi: REFILL_ABI,
      functionName: 'accumulatedFees',
      args: [nativeWrapped],
    });
  } catch (err) {
    log.error(`[refill] pre-flight RPC error: ${(err as Error).message.slice(0, 200)}`);
    lastAttemptAt = now;
    return;
  }

  if (accumulated === 0n) {
    log.warn(
      `[refill] balance ${formatEther(balance)} ETH below threshold but ` +
        `accumulatedFees[wrapped] == 0 — contract hasn't built reserve yet. ` +
        `Operator should top up keeper manually until fees accrue.`,
    );
    lastAttemptAt = now;
    return;
  }

  // Skip dust pulls: refillKeeper itself costs ~80k gas. Pulling less
  // than KEEPER_REFILL_MIN_WORTH_WEI means a significant fraction of
  // what we pull goes back out as gas — net loss or barely positive.
  // Also burns daily-cap window space on near-nothing. Wait for more
  // fees to accumulate.
  if (accumulated < config.KEEPER_REFILL_MIN_WORTH_WEI) {
    log.info(
      `[refill] accumulated ${formatEther(accumulated)} ETH below min-worth ` +
        `${formatEther(config.KEEPER_REFILL_MIN_WORTH_WEI)} ETH — waiting for more ` +
        `(pulling now would be net-loss after gas).`,
    );
    lastAttemptAt = now;
    return;
  }

  const requested = config.KEEPER_REFILL_TRANCHE_WEI;
  log.info(
    `[refill] balance ${formatEther(balance)} ETH < threshold ` +
      `${formatEther(config.KEEPER_BALANCE_THRESHOLD_WEI)} — ` +
      `requesting ${formatEther(requested)} (contract has ${formatEther(accumulated)} accumulated)`,
  );

  // Acquire nonce via the shared manager so we serialize with concurrent
  // executor.ts / scheduledExecutor.ts writers using the same signer.
  let txNonce: bigint;
  try {
    txNonce = await nonceManager.getNext(publicClient, account.address);
  } catch (err) {
    log.error(`[refill] nonce acquisition failed: ${(err as Error).message.slice(0, 200)}`);
    lastAttemptAt = now;
    return;
  }

  let txHash: `0x${string}`;
  try {
    txHash = await walletClient.writeContract({
      address: config.LIMIT_ORDER_ROUTER_ADDRESS,
      abi: REFILL_ABI,
      functionName: 'refillKeeper',
      chain,
      args: [requested],
      account,
      nonce: Number(txNonce),
    });
    log.info(`[refill] refillKeeper submitted: ${txHash} nonce=${txNonce}`);
  } catch (err) {
    const errMsg = (err as Error).message ?? String(err);
    log.error(`[refill] refillKeeper submit failed (nonce ${txNonce}): ${errMsg.slice(0, 240)}`);
    // Same heuristic as executor.ts: only resync the nonce when we're
    // confident the tx never broadcast. Post-broadcast ambiguity (RPC
    // timeout) must NOT rewind — that would collide once the pending
    // tx mines.
    const safeToResync =
      errMsg.includes('nonce too low') ||
      errMsg.includes('replacement transaction underpriced') ||
      errMsg.includes('invalid sender') ||
      errMsg.includes('insufficient funds') ||
      errMsg.includes('exceeds block gas limit') ||
      errMsg.includes('ContractFunctionExecutionError') ||
      errMsg.includes('reverted with the following');
    if (safeToResync) {
      await nonceManager.resync(publicClient, account.address).catch((e) => {
        log.error(`[refill] nonce resync also failed: ${(e as Error).message}`);
      });
    } else {
      log.warn(
        `[refill] skipping nonce resync — error may indicate post-broadcast failure; ` +
          `leaving counter at ${txNonce + 1n}`,
      );
    }
    void sendDiscordAlert(
      `⚠️ Keeper refill submit FAILED (balance ${formatEther(balance)} ETH): ${errMsg.slice(0, 240)}`,
      config.ALERT_DISCORD_WEBHOOK,
    );
    lastAttemptAt = now;
    return;
  }

  try {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: 60_000,
    });
    if (receipt.status !== 'success') {
      throw new Error(`tx reverted: ${txHash}`);
    }

    const newBalance = await publicClient.getBalance({ address: account.address });
    const delta = newBalance - balance;
    const msg =
      `Keeper refilled +${formatEther(delta)} ETH ` +
      `(was ${formatEther(balance)}, now ${formatEther(newBalance)}). ` +
      `Tx: ${txHash}`;
    log.info(`[refill] ${msg}`);
    void sendDiscordAlert(`✅ ${msg}`, config.ALERT_DISCORD_WEBHOOK);
    lastAttemptAt = 0; // success — reset backoff so next-need is immediate
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    log.error(`[refill] receipt wait / verify failed for ${txHash}: ${msg.slice(0, 240)}`);
    void sendDiscordAlert(
      `⚠️ Keeper refill tx submitted but receipt verify FAILED: ${txHash} — ${msg.slice(0, 200)}`,
      config.ALERT_DISCORD_WEBHOOK,
    );
    lastAttemptAt = now;
  }
}
