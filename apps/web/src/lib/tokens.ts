// Token registry per chainId.
//
// For Phase 1 we use Polygon Amoy addresses. None of them have real liquidity
// on Amoy, but the keeper runs in dry-run mode so trigger logic works against
// mock prices ($1 each). Replace with real Polygon mainnet addresses + a
// proper token-list fetch (e.g. 1inch /tokens) in Phase 2.

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

const REGISTRY: Record<number, TokenInfo[]> = {
  80002: AMOY_TOKENS,
  137: POLYGON_TOKENS,
  // Anvil fork of Polygon mainnet — same contract addresses
  31337: POLYGON_TOKENS,
};

/**
 * Per-chain native + wrapped pair. Used by the wrap/unwrap panel. Both
 * sides follow the WETH9 ABI (deposit()/withdraw(uint256)) so the hook
 * doesn't need a chain-specific implementation.
 */
export interface WrappedNative {
  address: `0x${string}`;
  wrappedSymbol: string; // e.g. WPOL
  nativeSymbol: string;  // e.g. POL
  decimals: number;
}

export const WRAPPED_NATIVE: Record<number, WrappedNative> = {
  137: {
    address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    wrappedSymbol: 'WPOL',
    nativeSymbol: 'POL',
    decimals: 18,
  },
  31337: {
    address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    wrappedSymbol: 'WPOL',
    nativeSymbol: 'POL',
    decimals: 18,
  },
};

/** Returns a block-explorer tx URL for the chain, or null if none (e.g. local Anvil). */
export function txExplorerUrl(chainId: number, txHash: string): string | null {
  if (chainId === 137) return `https://polygonscan.com/tx/${txHash}`;
  if (chainId === 80002) return `https://amoy.polygonscan.com/tx/${txHash}`;
  return null; // 31337 (Anvil) and unknown chains
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
