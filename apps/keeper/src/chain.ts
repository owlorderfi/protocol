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
