/**
 * Chain-aware read client + Uniswap V3 address lookup.
 *
 * Both `useMarketPrice` and `usePoolTwap` need to read from Uniswap V3
 * on the chain the wallet is currently connected to. Callers pass the
 * active chainId (typically from wagmi's useChainId hook). Per-chain
 * clients + Uniswap address lookups are memoized so swapping back and
 * forth between chains in the UI doesn't re-build them every render.
 */

import { createPublicClient, http, type PublicClient } from 'viem';
import {
  type ChainIdType,
  requireUniswapV3,
  type UniswapV3Deployment,
} from '@owlorderfi/shared';
import { getViemChain } from './viemChain';

/**
 * Per-chain RPC URL override via VITE_CHAIN_<id>_RPC env var. Lets the
 * operator point a chain at a paid endpoint (Alchemy / Infura) when
 * the public default rate-limits. Falls back to whatever viem's chain
 * builtin or our registry returns.
 */
function rpcUrl(chainId: number): string {
  const override = (import.meta.env as Record<string, string | undefined>)[
    `VITE_CHAIN_${chainId}_RPC`
  ];
  if (override) return override;
  return getViemChain(chainId).rpcUrls.default.http[0];
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
    chain: getViemChain(chainId),
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
