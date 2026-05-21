import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon, polygonAmoy } from 'viem/chains';
import { getConfig } from './config';

type SupportedChain = typeof polygon | typeof polygonAmoy;

function resolveChain(chainId: number): SupportedChain {
  if (chainId === 137) return polygon;
  if (chainId === 80002) return polygonAmoy;
  // Anvil forks Amoy, so chainId is 80002 even on localhost
  throw new Error(`Unsupported chainId: ${chainId}. Supported: 137 (Polygon), 80002 (Amoy)`);
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
