import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getConfig } from './config';
import { getViemChain } from './viemChain';

export function createClients() {
  const config = getConfig();
  const chain = getViemChain(config.CHAIN_ID);
  const account = privateKeyToAccount(config.KEEPER_PRIVATE_KEY);

  const publicClient = createPublicClient({
    chain,
    transport: http(config.RPC_URL),
  });

  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(config.PRIVATE_RPC_URL ?? config.RPC_URL),
  });

  return { publicClient, walletClient, account, chain };
}

/**
 * Thrown when the computed gas price would exceed `MAX_FEE_PER_GAS_GWEI`.
 * Callers should catch this and release the order back to OPEN so it
 * retries on a future poll when the gas market may have cooled.
 */
export class GasTooHighError extends Error {
  readonly computedGwei: number;
  readonly capGwei: number;
  constructor(computed: bigint, cap: bigint) {
    const computedGwei = Number(computed) / 1e9;
    const capGwei = Number(cap) / 1e9;
    super(`Gas too high: maxFeePerGas=${computedGwei.toFixed(1)} gwei > cap ${capGwei.toFixed(1)} gwei`);
    this.name = 'GasTooHighError';
    this.computedGwei = computedGwei;
    this.capGwei = capGwei;
  }
}

function assertWithinCap(maxFeePerGas: bigint): void {
  const capWei = BigInt(Math.round(getConfig().MAX_FEE_PER_GAS_GWEI * 1e9));
  if (maxFeePerGas > capWei) throw new GasTooHighError(maxFeePerGas, capWei);
}

/**
 * Compute EIP-1559 gas pricing for a fresh tx submission.
 *
 *   maxPriorityFeePerGas = viem's network suggestion (or override)
 *   maxFeePerGas        = (baseFee × HEADROOM_MULT) + maxPriorityFeePerGas
 *
 * The headroom multiplier (>1) absorbs base-fee bumps on next blocks.
 * Default 1.5 gives ~5 blocks of cushion under EIP-1559's max 12.5%/block rise.
 * Throws GasTooHighError if the result exceeds MAX_FEE_PER_GAS_GWEI.
 */
export async function computeGasPricing(
  publicClient: ReturnType<typeof createClients>['publicClient'],
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const config = getConfig();
  const [block, feeEstimate] = await Promise.all([
    publicClient.getBlock(),
    publicClient.estimateFeesPerGas(),
  ]);
  const baseFee = block.baseFeePerGas ?? 0n;
  // Priority-fee fallback comes from config (gwei → wei). 30 gwei is reasonable
  // for Polygon mainnet; for Amoy / Anvil pick something far smaller via env.
  const fallbackPriorityWei = BigInt(Math.round(config.GAS_PRIORITY_FALLBACK_GWEI * 1e9));
  const priority = feeEstimate.maxPriorityFeePerGas ?? fallbackPriorityWei;
  const mult = BigInt(Math.round(config.GAS_HEADROOM_MULT * 100));
  const maxFeePerGas = (baseFee * mult) / 100n + priority;
  assertWithinCap(maxFeePerGas);
  return { maxFeePerGas, maxPriorityFeePerGas: priority };
}

/**
 * Compute the gas to use when replacing a stuck tx. Three constraints
 * must all hold for the replacement to be accepted by the mempool AND
 * actually mine in a reasonable time:
 *
 *   1. ≥ existing × (1 + GAS_BUMP_PCT/100)   — EVM mempool replacement rule
 *   2. ≥ current market headroom price        — otherwise we're still under-bid
 *   3. ≤ MAX_FEE_PER_GAS_GWEI                 — never burn unlimited gas
 *
 * Without (2), submitting at 30 gwei before a spike to 200 gwei would
 * leave us replacing at 36 → 43 → … gwei, all still far below market.
 * The +20% bump only catches up to where YOU were, not to where the
 * market is now.
 */
export async function computeGasPricingForReplace(
  publicClient: ReturnType<typeof createClients>['publicClient'],
  existing: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const config = getConfig();
  const bump = BigInt(100 + config.GAS_BUMP_PCT);
  const bumpedExisting = {
    maxFeePerGas: (existing.maxFeePerGas * bump) / 100n,
    maxPriorityFeePerGas: (existing.maxPriorityFeePerGas * bump) / 100n,
  };
  // Re-quote market so a runaway spike since the original submit doesn't
  // leave us replacing at a price that's still uncompetitive.
  let marketGas: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  try {
    marketGas = await computeGasPricing(publicClient);
  } catch (err) {
    if (err instanceof GasTooHighError) {
      // Market is above our cap. Bump the existing tx as far as the cap
      // allows; if that's still below required +10% on both fields, the
      // replace will be rejected by RPC and we'll try again next cycle.
      const capWei = BigInt(Math.round(config.MAX_FEE_PER_GAS_GWEI * 1e9));
      const capped = {
        maxFeePerGas: bumpedExisting.maxFeePerGas > capWei ? capWei : bumpedExisting.maxFeePerGas,
        maxPriorityFeePerGas: bumpedExisting.maxPriorityFeePerGas,
      };
      assertWithinCap(capped.maxFeePerGas);
      return capped;
    }
    throw err;
  }
  // Pick the higher of "+bump on existing" and "market headroom".
  const result = {
    maxFeePerGas:
      marketGas.maxFeePerGas > bumpedExisting.maxFeePerGas
        ? marketGas.maxFeePerGas
        : bumpedExisting.maxFeePerGas,
    maxPriorityFeePerGas:
      marketGas.maxPriorityFeePerGas > bumpedExisting.maxPriorityFeePerGas
        ? marketGas.maxPriorityFeePerGas
        : bumpedExisting.maxPriorityFeePerGas,
  };
  assertWithinCap(result.maxFeePerGas);
  return result;
}

/**
 * Kept for backwards compat — pure +pct bump without re-quoting market.
 * Prefer computeGasPricingForReplace for the replacement path; this is
 * only useful in tests or for fields that don't need a market refresh.
 */
export function bumpGas(
  existing: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
  pct: number,
): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  // Polygon (and most EVMs) require ≥10% bump on each field. Round up.
  const factor = BigInt(100 + pct);
  return {
    maxFeePerGas: (existing.maxFeePerGas * factor) / 100n,
    maxPriorityFeePerGas: (existing.maxPriorityFeePerGas * factor) / 100n,
  };
}
