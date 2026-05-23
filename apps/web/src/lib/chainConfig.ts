/**
 * Chain-aware read client + Uniswap V3 address lookup.
 *
 * Both `useMarketPrice` and `usePoolTwap` need to read from Uniswap V3
 * on the chain the user is operating against (env.chainId). Hardcoding
 * Polygon here was the source of "Loading market price…" hanging on
 * every non-Polygon chain. Single source of truth now: shared chain
 * registry + viem chain object + a memoized public client.
 */

import { createPublicClient, defineChain, http, type PublicClient } from 'viem';
import { polygon, polygonAmoy, baseSepolia } from 'viem/chains';
import {
  type ChainIdType,
  requireUniswapV3,
  type UniswapV3Deployment,
} from '@polyorder/shared';
import { env } from './env';

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

let cachedClient: PublicClient | null = null;
let cachedUniswap: UniswapV3Deployment | null = null;

/** Read-only public client for env.chainId. Memoized for the page lifetime. */
export function getReadClient(): PublicClient {
  if (!cachedClient) {
    cachedClient = createPublicClient({
      chain: resolveViemChain(env.chainId),
      transport: http(rpcUrl(env.chainId)),
    }) as PublicClient;
  }
  return cachedClient;
}

/** Uniswap V3 deployment addresses for env.chainId. Throws if chain has no V3. */
export function getUniswapV3(): UniswapV3Deployment {
  if (!cachedUniswap) {
    cachedUniswap = requireUniswapV3(env.chainId as ChainIdType);
  }
  return cachedUniswap;
}
