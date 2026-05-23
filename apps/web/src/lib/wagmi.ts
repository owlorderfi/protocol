import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { polygonAmoy, polygon, baseSepolia } from 'wagmi/chains';
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

const CHAIN_BY_ID = {
  31337: anvilLocal,
  137: polygon,
  80002: polygonAmoy,
  84532: baseSepolia,
} as const;

// Enable every chain for which the env has a router configured. The
// wallet can switch between them via RainbowKit's built-in selector;
// orders + balances follow the active chain. Default chain (used at
// first paint before the wallet reports its chain) is env.chainId.
function pickChains() {
  const supported = env.chainIds.filter((id): id is keyof typeof CHAIN_BY_ID => id in CHAIN_BY_ID);
  if (supported.length === 0) {
    throw new Error(
      `None of the configured chains (${env.chainIds.join(', ')}) are known to viem. ` +
        `Add them to CHAIN_BY_ID in wagmi.ts.`,
    );
  }
  // Ensure default chain is first — RainbowKit highlights it on initial connect.
  const sorted = supported.sort((a, b) => (a === env.chainId ? -1 : b === env.chainId ? 1 : 0));
  return sorted.map((id) => CHAIN_BY_ID[id]) as unknown as readonly [typeof polygon, ...(typeof polygon)[]];
}

export const wagmiConfig = getDefaultConfig({
  appName: 'Polyorder',
  projectId: env.walletConnectProjectId,
  chains: pickChains(),
  transports: {
    [anvilLocal.id]: http(ANVIL_RPC),
    [polygon.id]: http(),
    [polygonAmoy.id]: http(),
    [baseSepolia.id]: http(),
  },
  ssr: false,
});
