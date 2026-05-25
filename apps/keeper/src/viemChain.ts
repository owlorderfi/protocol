/**
 * Resolve a viem `Chain` object for any chainId in the shared registry.
 *
 * Mirrors apps/web/src/lib/viemChain.ts but server-side. Server doesn't
 * need the LAN-hostname rewrite for Anvil (it's local).
 *
 * Strategy:
 *   1. If wagmi/viem ships a built-in, use it (richer multicall etc.)
 *   2. Otherwise synthesize via defineChain() from CHAINS[chainId]
 *
 * Adding a new chain = update the shared registry. No edit here unless
 * you want to wire up a viem built-in for richer metadata.
 */

import { defineChain, type Chain } from 'viem';
import {
  polygon,
  polygonAmoy,
  baseSepolia,
  optimismSepolia,
} from 'viem/chains';
import { CHAINS, ChainId, type ChainIdType } from '@owlorderfi/shared';

const KNOWN_VIEM_CHAINS: Partial<Record<ChainIdType, Chain>> = {
  [ChainId.POLYGON]: polygon,
  [ChainId.AMOY]: polygonAmoy,
  [ChainId.BASE_SEPOLIA]: baseSepolia,
  [ChainId.OPTIMISM_SEPOLIA]: optimismSepolia,
};

export function getViemChain(chainId: number): Chain {
  const known = KNOWN_VIEM_CHAINS[chainId as ChainIdType];
  if (known) return known;
  const info = CHAINS[chainId as ChainIdType];
  if (!info) {
    throw new Error(
      `getViemChain: unknown chainId ${chainId}. Add it to the shared CHAINS registry first.`,
    );
  }
  return defineChain({
    id: info.id,
    name: info.name,
    nativeCurrency: info.nativeCurrency,
    rpcUrls: { default: { http: info.rpcUrls } },
    blockExplorers: info.blockExplorer
      ? { default: { name: 'Explorer', url: info.blockExplorer } }
      : undefined,
    testnet: info.isTestnet,
  });
}
