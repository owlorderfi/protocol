import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { polygonAmoy, polygon } from 'wagmi/chains';
import { http, defineChain } from 'viem';
import { env } from './env';

// LAN IP of the dev server so Rabby on a Windows machine can reach Anvil
// (not 127.0.0.1, which would mean the Windows host).
const ANVIL_RPC = `http://${typeof window !== 'undefined' ? window.location.hostname : '127.0.0.1'}:8545`;

const anvilLocal = defineChain({
  id: 31337,
  name: 'Anvil (Polygon Fork)',
  nativeCurrency: { name: 'Polygon', symbol: 'POL', decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_RPC] } },
});

function pickChains() {
  if (env.chainId === 31337) return [anvilLocal] as const;
  if (env.chainId === 137) return [polygon] as const;
  return [polygonAmoy] as const;
}

export const wagmiConfig = getDefaultConfig({
  appName: 'Polyorder',
  projectId: env.walletConnectProjectId,
  chains: pickChains(),
  transports: {
    [anvilLocal.id]: http(ANVIL_RPC),
    [polygon.id]: http(),
    [polygonAmoy.id]: http(),
  },
  ssr: false,
});
