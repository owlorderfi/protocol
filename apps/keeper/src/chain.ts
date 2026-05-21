import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon, polygonAmoy } from 'viem/chains';
import { getConfig } from './config';

const anvilLocal = defineChain({
  id: 31337,
  name: 'Anvil (Polygon Fork)',
  nativeCurrency: { name: 'Polygon', symbol: 'POL', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
});

type SupportedChain = typeof polygon | typeof polygonAmoy | typeof anvilLocal;

function resolveChain(chainId: number): SupportedChain {
  if (chainId === 137) return polygon;
  if (chainId === 80002) return polygonAmoy;
  if (chainId === 31337) return anvilLocal;
  throw new Error(`Unsupported chainId: ${chainId}. Supported: 137, 80002, 31337`);
}

export function createClients() {
  const config = getConfig();
  const chain = resolveChain(config.CHAIN_ID);
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
 * Compute EIP-1559 gas pricing for a fresh tx submission.
 *
 *   maxPriorityFeePerGas = viem's network suggestion (or override)
 *   maxFeePerGas        = (baseFee × HEADROOM_MULT) + maxPriorityFeePerGas
 *
 * The headroom multiplier (>1) absorbs base-fee bumps on next blocks.
 * Default 1.5 gives ~5 blocks of cushion under EIP-1559's max 12.5%/block rise.
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
  return { maxFeePerGas, maxPriorityFeePerGas: priority };
}

/**
 * Apply a percent bump to an existing tx's gas — used by the replacement
 * path so the new tx outbids the stuck one in the mempool.
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
