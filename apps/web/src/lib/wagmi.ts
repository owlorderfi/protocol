import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { polygonAmoy, polygon } from 'wagmi/chains';
import { http } from 'viem';
import { env } from './env';

// Override Amoy's RPC to point at our local Anvil fork when running on chainId 80002.
// MetaMask still uses its own RPC for queries; this just ensures wagmi's reads hit Anvil.
const amoyLocal = {
  ...polygonAmoy,
  rpcUrls: {
    default: { http: ['http://127.0.0.1:8545'] },
  },
} as const;

export const wagmiConfig = getDefaultConfig({
  appName: 'Polyorder',
  projectId: env.walletConnectProjectId,
  chains: env.chainId === 80002 ? [amoyLocal] : [polygon],
  transports: {
    [amoyLocal.id]: http('http://127.0.0.1:8545'),
    [polygon.id]: http(),
  },
  ssr: false,
});
