// Token registry per chainId.
//
// Manual list per chain — keep it small (~5 tokens) and stable. Long-tail
// tokens / dynamic discovery via a token-list fetch is Phase 2.
// WRAPPED_NATIVE and explorer URLs are derived from the shared CHAINS
// registry; only the curated token list per chain lives here.

import { CHAINS, type ChainIdType } from '@owlorderfi/shared';

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

// IMPORTANT ordering invariant: several create-form defaults read
// `getTokens(chainId)[0]` / `[1]` as the initial tokenIn / tokenOut.
// Keep USDC at index 0 and WETH at index 1 on every chain — otherwise
// the default pair silently flips (e.g. USDC→USDT instead of USDC→WETH)
// which surprises users and breaks `classifyPair` heuristics that
// assume a stable/asset shape. Add new tokens after index 1.
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
  {
    address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    symbol: 'USDT',
    name: 'Tether USD',
    decimals: 6,
    iconColor: 'bg-emerald-600',
  },
  {
    address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
    symbol: 'DAI',
    name: 'Dai Stablecoin',
    decimals: 18,
    iconColor: 'bg-yellow-500',
  },
  {
    address: '0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39',
    symbol: 'LINK',
    name: 'Chainlink',
    decimals: 18,
    iconColor: 'bg-sky-600',
  },
  {
    address: '0xD6DF932A45C0f255f85145f286eA0b292B21C90B',
    symbol: 'AAVE',
    name: 'Aave',
    decimals: 18,
    iconColor: 'bg-fuchsia-600',
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

// See ordering invariant comment on POLYGON_TOKENS above — USDC at [0],
// WETH at [1]. LINK third since Chainlink's faucet drops LINK directly
// to testnet wallets — likely what an operator has to test pairs.
const ARBITRUM_SEPOLIA_TOKENS: TokenInfo[] = [
  {
    address: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    symbol: 'USDC',
    name: 'USD Coin (Arbitrum Sepolia)',
    decimals: 6,
    iconColor: 'bg-blue-500',
  },
  {
    address: '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73',
    symbol: 'WETH',
    name: 'Wrapped Ether (Arbitrum Sepolia)',
    decimals: 18,
    iconColor: 'bg-violet-500',
  },
  {
    address: '0xb1D4538B4571d411F07960EF2838Ce337FE1E80E',
    symbol: 'LINK',
    name: 'Chainlink (Arbitrum Sepolia)',
    decimals: 18,
    iconColor: 'bg-sky-600',
  },
];

// See ordering invariant comment on POLYGON_TOKENS above — USDC stays
// at [0], WETH stays at [1], new tokens go after.
const BASE_TOKENS: TokenInfo[] = [
  {
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    symbol: 'USDC',
    name: 'USD Coin (native)',
    decimals: 6,
    iconColor: 'bg-blue-500',
  },
  {
    address: '0x4200000000000000000000000000000000000006',
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    iconColor: 'bg-violet-500',
  },
  {
    // Coinbase wrapped BTC — Base's native BTC representation. There is
    // NO official WBTC on Base; cbBTC is the canonical choice with deep
    // Uniswap V3 liquidity.
    address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
    symbol: 'cbBTC',
    name: 'Coinbase Wrapped BTC',
    decimals: 8,
    iconColor: 'bg-amber-500',
  },
  {
    // Tether on Base — bridged via OP-stack canonical bridge. Liquid on
    // Uniswap V3 against USDC + WETH pools.
    address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
    symbol: 'USDT',
    name: 'Tether USD',
    decimals: 6,
    iconColor: 'bg-emerald-600',
  },
];

const REGISTRY: Record<number, TokenInfo[]> = {
  80002: AMOY_TOKENS,
  137: POLYGON_TOKENS,
  8453: BASE_TOKENS,
  84532: BASE_SEPOLIA_TOKENS,
  421614: ARBITRUM_SEPOLIA_TOKENS,
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
