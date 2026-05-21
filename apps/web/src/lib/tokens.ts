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

const REGISTRY: Record<number, TokenInfo[]> = {
  80002: AMOY_TOKENS,
  // 137: POLYGON_MAINNET_TOKENS,   // Phase 2
};

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
