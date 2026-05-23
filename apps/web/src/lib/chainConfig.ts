/**
 * Chain-aware read client + Uniswap V3 address lookup.
 *
 * Both `useMarketPrice` and `usePoolTwap` need to read from Uniswap V3
 * on the chain the wallet is currently connected to. Callers pass the
 * active chainId (typically from wagmi's useChainId hook). Per-chain
 * clients + Uniswap address lookups are memoized so swapping back and
 * forth between chains in the UI doesn't re-build them every render.
 */

import { createPublicClient, defineChain, http, type PublicClient } from 'viem';
import { polygon, polygonAmoy, baseSepolia } from 'viem/chains';
import {
  type ChainIdType,
  requireUniswapV3,
  type UniswapV3Deployment,
} from '@polyorder/shared';

const anvilLocal = defineChain({
  id: 31337,
  name: 'Anvil (Polygon Fork)',
  nativeCurrency: { name: 'Polygon', symbol: 'POL', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
});

function resolveViemChain(chainId: number) {
  if (chainId === 137) return polygon;
  if (chainId === 80002) return polygonAmoy;
  if (chainId === 84532) return baseSepolia;
  if (chainId === 31337) return anvilLocal;
  throw new Error(`chainConfig: unsupported chainId ${chainId}`);
}

function rpcUrl(chainId: number): string {
  // Anvil: derive from page host so the LAN works (not 127.0.0.1, which
  // would mean the user's own browser machine).
  if (chainId === 31337) {
    return `http://${typeof window !== 'undefined' ? window.location.hostname : '127.0.0.1'}:8545`;
  }
  // Escape hatch: explicit override via env (used by the old polygon-mainnet
  // ribbon-display behaviour). Otherwise pick the viem default.
  const override = import.meta.env.VITE_POLYGON_RPC as string | undefined;
  if (override && chainId === 137) return override;
  const chain = resolveViemChain(chainId);
  return chain.rpcUrls.default.http[0];
}

// One client per chainId — keep them cached so chain switching doesn't
// rebuild a fresh client for every hook re-render.
const clientCache = new Map<number, PublicClient>();
const uniswapCache = new Map<number, UniswapV3Deployment>();

/** Read-only public client for the given chain. Memoized per chainId. */
export function getReadClient(chainId: number): PublicClient {
  const cached = clientCache.get(chainId);
  if (cached) return cached;
  const client = createPublicClient({
    chain: resolveViemChain(chainId),
    transport: http(rpcUrl(chainId)),
  }) as PublicClient;
  clientCache.set(chainId, client);
  return client;
}

/** Uniswap V3 deployment for the given chain. Throws if no official V3 exists. */
export function getUniswapV3(chainId: number): UniswapV3Deployment {
  const cached = uniswapCache.get(chainId);
  if (cached) return cached;
  const dep = requireUniswapV3(chainId as ChainIdType);
  uniswapCache.set(chainId, dep);
  return dep;
}
