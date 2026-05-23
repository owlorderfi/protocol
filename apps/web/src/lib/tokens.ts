// Token registry per chainId.
//
// Manual list per chain — keep it small (~5 tokens) and stable. Long-tail
// tokens / dynamic discovery via a token-list fetch is Phase 2.
// WRAPPED_NATIVE and explorer URLs are derived from the shared CHAINS
// registry; only the curated token list per chain lives here.

import { CHAINS, type ChainIdType } from '@polyorder/shared';

export interface TokenInfo {
  address: `0x${string}`;
  symbol: string;
  name: string;
  decimals: number;
  // 2-char icon fallback when no real logo is provided
  iconColor: string;
}

const AMOY_TOKENS: TokenInfo[] = [
  {
    address: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
    symbol: 'USDC',
    name: 'USD Coin (Amoy)',
    decimals: 6,
    iconColor: 'bg-blue-500',
  },
  {
    address: '0xb0F8E96d52caC8c87bB7AE19a8A93a9bf67de10b',
    symbol: 'WETH',
    name: 'Wrapped Ether (Amoy)',
    decimals: 18,
    iconColor: 'bg-violet-500',
  },
];

const POLYGON_TOKENS: TokenInfo[] = [
  {
    address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    symbol: 'USDC',
    name: 'USD Coin (native)',
    decimals: 6,
    iconColor: 'bg-blue-500',
  },
  {
    address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    iconColor: 'bg-violet-500',
  },
  {
    // Same contract address as the old WMATIC — Polygon rebranded MATIC to
    // POL in Sept 2024 and the token was renamed in place to WPOL.
    address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    symbol: 'WPOL',
    name: 'Wrapped POL',
    decimals: 18,
    iconColor: 'bg-purple-500',
  },
  {
    address: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6',
    symbol: 'WBTC',
    name: 'Wrapped Bitcoin',
    decimals: 8,
    iconColor: 'bg-amber-500',
  },
];

const BASE_SEPOLIA_TOKENS: TokenInfo[] = [
  {
    address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    symbol: 'USDC',
    name: 'USD Coin (Base Sepolia)',
    decimals: 6,
    iconColor: 'bg-blue-500',
  },
  {
    address: '0x4200000000000000000000000000000000000006',
    symbol: 'WETH',
    name: 'Wrapped Ether (Base Sepolia)',
    decimals: 18,
    iconColor: 'bg-violet-500',
  },
];

const REGISTRY: Record<number, TokenInfo[]> = {
  80002: AMOY_TOKENS,
  137: POLYGON_TOKENS,
  84532: BASE_SEPOLIA_TOKENS,
  // Anvil fork of Polygon mainnet — same contract addresses
  31337: POLYGON_TOKENS,
};

/**
 * Per-chain native + wrapped pair. Used by the wrap/unwrap panel. Both
 * sides follow the WETH9 ABI (deposit()/withdraw(uint256)) so the hook
 * doesn't need a chain-specific implementation.
 *
 * Derived dynamically from the shared CHAINS registry — adding a new
 * chain in chains.ts automatically exposes its wrapped native here,
 * no edit required.
 */
export interface WrappedNative {
  address: `0x${string}`;
  wrappedSymbol: string; // e.g. WPOL, WETH
  nativeSymbol: string;  // e.g. POL, ETH
  decimals: number;
}

/**
 * Lookup wrapped-native metadata for a chain. Returns undefined when the
 * chain has no wrappedNative in the registry (caller should hide the
 * Wrap/Unwrap UI in that case).
 */
export function getWrappedNative(chainId: number): WrappedNative | undefined {
  const info = CHAINS[chainId as ChainIdType];
  if (!info?.wrappedNative) return undefined;
  return {
    address: info.wrappedNative,
    // Convention: wrapped symbol is "W" + native symbol. Holds for every
    // canonical WETH9-style wrapper deployed today (WETH, WPOL, WBNB,
    // WAVAX, etc.). Override here per-chain if any future deployment
    // breaks the convention.
    wrappedSymbol: `W${info.nativeCurrency.symbol}`,
    nativeSymbol: info.nativeCurrency.symbol,
    decimals: info.nativeCurrency.decimals,
  };
}

/** Returns a block-explorer tx URL for the chain, or null if none (e.g. local Anvil). */
export function txExplorerUrl(chainId: number, txHash: string): string | null {
  // Drives from shared chain registry — adding a new chain only requires
  // updating packages/shared/constants/chains.ts, not this file.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = (CHAINS as any)[chainId]?.blockExplorer;
  if (!base) return null; // Anvil (empty string) and unknown chains
  return `${base}/tx/${txHash}`;
}

export function getTokens(chainId: number): TokenInfo[] {
  return REGISTRY[chainId] ?? [];
}

export function findToken(chainId: number, address: string): TokenInfo | undefined {
  const lower = address.toLowerCase();
  return getTokens(chainId).find((t) => t.address.toLowerCase() === lower);
}

/** Returns symbol if known, otherwise a shortened address. */
export function tokenLabel(chainId: number, address: string): string {
  const t = findToken(chainId, address);
  if (t) return t.symbol;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
