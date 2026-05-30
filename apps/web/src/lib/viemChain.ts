/**
 * Resolve a viem `Chain` object for any chainId in the shared registry.
 *
 * Strategy:
 *   1. If wagmi/viem ships a built-in for the chain, use it (gives us
 *      proper multicall addresses, block-explorer integration, etc.)
 *   2. Otherwise, synthesize a Chain via defineChain() from the values
 *      in CHAINS[chainId]. Adding a new chain requires no edit here —
 *      just a registry entry — until viem adds a built-in (at which
 *      point you bump KNOWN_VIEM_CHAINS to use the richer object).
 *
 * Anvil is handled specially: the RPC URL is derived from the page's
 * hostname so wallets on the LAN (Rabby on a Windows laptop, etc.)
 * can reach the dev fork without hardcoding 127.0.0.1.
 */

import { defineChain, type Chain } from 'viem';
import {
  polygon,
  polygonAmoy,
  base,
  baseSepolia,
  arbitrumSepolia,
  optimismSepolia,
} from 'viem/chains';
import { CHAINS, ChainId, type ChainIdType } from '@owlorderfi/shared';

const KNOWN_VIEM_CHAINS: Partial<Record<ChainIdType, Chain>> = {
  [ChainId.POLYGON]: polygon,
  [ChainId.AMOY]: polygonAmoy,
  [ChainId.BASE]: base,
  [ChainId.BASE_SEPOLIA]: baseSepolia,
  [ChainId.ARBITRUM_SEPOLIA]: arbitrumSepolia,
  [ChainId.OPTIMISM_SEPOLIA]: optimismSepolia,
  // Add wagmi/viem built-ins here as new mainnets come online:
  //   [ChainId.ARBITRUM]: arbitrum,
  //   [ChainId.OPTIMISM]: optimism,
};

function anvilRpc(): string {
  return `http://${typeof window !== 'undefined' ? window.location.hostname : '127.0.0.1'}:8545`;
}

export function getViemChain(chainId: number): Chain {
  const known = KNOWN_VIEM_CHAINS[chainId as ChainIdType];
  if (known) return known;
  const info = CHAINS[chainId as ChainIdType];
  if (!info) {
    throw new Error(
      `getViemChain: unknown chainId ${chainId}. Add it to the shared CHAINS registry first.`,
    );
  }
  // Anvil dev fork — rewrite RPC to page-host so the LAN reaches it.
  const rpcUrls = info.id === ChainId.ANVIL_LOCAL ? [anvilRpc()] : info.rpcUrls;
  return defineChain({
    id: info.id,
    name: info.name,
    nativeCurrency: info.nativeCurrency,
    rpcUrls: { default: { http: rpcUrls } },
    blockExplorers: info.blockExplorer
      ? { default: { name: 'Explorer', url: info.blockExplorer } }
      : undefined,
    testnet: info.isTestnet,
  });
}
