/**
 * Supported chains for Polyorder.
 *
 * The router contract is chain-agnostic — it works on any EVM chain
 * with an official Uniswap V3 deployment. Adding a new chain is just
 * a new entry in CHAINS below; no code changes downstream.
 *
 * Uniswap V3 addresses sourced from the official deployment registry:
 *   https://docs.uniswap.org/contracts/v3/reference/deployments/
 * Verify any address used for production before broadcasting a deploy.
 */

export const ChainId = {
  POLYGON: 137,
  AMOY: 80002,
  BASE_SEPOLIA: 84532,
  // Local Anvil fork — uses Foundry's default chain-id so it doesn't
  // collide with Polygon (137) in user wallets that refuse to add a
  // second network with an existing chainId.
  ANVIL_LOCAL: 31337,
} as const;

export type ChainIdType = (typeof ChainId)[keyof typeof ChainId];

/** Uniswap V3 protocol addresses for a given chain. */
export interface UniswapV3Deployment {
  /** QuoterV2 — read-only quotes used by the keeper for routing. */
  quoterV2: `0x${string}`;
  /** SwapRouter02 — the router we encode calldata for in execution. */
  swapRouter02: `0x${string}`;
  /** UniswapV3Factory — used to verify a pool exists before quoting. */
  factory: `0x${string}`;
  /**
   * Hub tokens used as intermediate hops when no direct (tokenIn, tokenOut)
   * pool exists or when routing through them yields a better fill. Keep
   * this list short — every entry costs N extra RPC quote calls per order.
   * WETH + USDC cover ~95% of practical routes on every mainstream chain.
   */
  hubTokens: `0x${string}`[];
  /**
   * Fee tier (in 1/1_000_000) used for the inner hop when going through a
   * hub. 500 (0.05%) is the most liquid tier on hub pools on every chain.
   */
  hopFee: number;
}

export interface ChainInfo {
  id: ChainIdType;
  name: string;
  shortName: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  rpcUrls: string[];
  blockExplorer: string;
  isTestnet: boolean;
  /**
   * Address of the wrapped-native ERC20 (WETH9-style contract). Required
   * for any swap that involves the native gas coin on one side.
   */
  wrappedNative?: `0x${string}`;
  /**
   * Uniswap V3 deployment for this chain. Undefined when the chain has
   * no official deployment (e.g., Polygon Amoy uses SushiSwap/QuickSwap
   * instead — the keeper cannot operate there until a fork is added).
   */
  uniswapV3?: UniswapV3Deployment;
}

export const CHAINS: Record<ChainIdType, ChainInfo> = {
  [ChainId.POLYGON]: {
    id: ChainId.POLYGON,
    name: 'Polygon PoS',
    shortName: 'polygon',
    nativeCurrency: { name: 'Polygon', symbol: 'POL', decimals: 18 },
    rpcUrls: ['https://polygon-rpc.com'],
    blockExplorer: 'https://polygonscan.com',
    isTestnet: false,
    wrappedNative: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // WPOL
    uniswapV3: {
      quoterV2:     '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
      swapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
      factory:      '0x1F98431c8aD98523631AE4a59f267346ea31F984',
      hubTokens: [
        '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // USDC (native)
        '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', // WETH
      ],
      hopFee: 500,
    },
  },

  [ChainId.AMOY]: {
    id: ChainId.AMOY,
    name: 'Polygon Amoy',
    shortName: 'amoy',
    nativeCurrency: { name: 'Polygon', symbol: 'POL', decimals: 18 },
    rpcUrls: ['https://rpc-amoy.polygon.technology'],
    blockExplorer: 'https://amoy.polygonscan.com',
    isTestnet: true,
    // No official Uniswap V3 on Amoy — uniswapV3 + wrappedNative
    // intentionally omitted. Reading them in keeper code throws via
    // requireUniswapV3() below.
  },

  [ChainId.BASE_SEPOLIA]: {
    id: ChainId.BASE_SEPOLIA,
    name: 'Base Sepolia',
    shortName: 'base-sepolia',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://sepolia.base.org'],
    blockExplorer: 'https://sepolia.basescan.org',
    isTestnet: true,
    wrappedNative: '0x4200000000000000000000000000000000000006', // WETH
    uniswapV3: {
      quoterV2:     '0xC5290058841028F1614F3A6F0F5816cAd0df5E27',
      swapRouter02: '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4',
      factory:      '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',
      hubTokens: [
        '0x4200000000000000000000000000000000000006', // WETH (wrapped native)
        '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // USDC (testnet)
      ],
      hopFee: 500,
    },
  },

  [ChainId.ANVIL_LOCAL]: {
    id: ChainId.ANVIL_LOCAL,
    name: 'Anvil (Polygon Fork)',
    shortName: 'anvil',
    nativeCurrency: { name: 'Polygon', symbol: 'POL', decimals: 18 },
    rpcUrls: ['http://127.0.0.1:8545'],
    blockExplorer: '',
    isTestnet: true,
    // Anvil forks Polygon mainnet by default, so it inherits all
    // Polygon-mainnet contract state — same addresses work.
    wrappedNative: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    uniswapV3: {
      quoterV2:     '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
      swapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
      factory:      '0x1F98431c8aD98523631AE4a59f267346ea31F984',
      hubTokens: [
        '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // USDC (native)
        '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', // WETH
      ],
      hopFee: 500,
    },
  },
};

export const SUPPORTED_CHAIN_IDS = Object.values(ChainId);

export function isSupportedChainId(chainId: number): chainId is ChainIdType {
  return SUPPORTED_CHAIN_IDS.includes(chainId as ChainIdType);
}

export function getChainInfo(chainId: ChainIdType): ChainInfo {
  return CHAINS[chainId];
}

/**
 * Returns the Uniswap V3 deployment for a chain or throws if the chain
 * has no official deployment. Call this from the keeper / quoter
 * paths so a misconfiguration surfaces as a clear error at boot,
 * not as a cryptic RPC failure later.
 */
export function requireUniswapV3(chainId: ChainIdType): UniswapV3Deployment {
  const info = CHAINS[chainId];
  if (!info.uniswapV3) {
    throw new Error(
      `Chain ${info.name} (${chainId}) has no official Uniswap V3 deployment. ` +
        `Supported: ${Object.values(CHAINS).filter((c) => c.uniswapV3).map((c) => c.shortName).join(', ')}.`,
    );
  }
  return info.uniswapV3;
}

/**
 * Returns the wrapped-native address for a chain or throws. Same
 * fail-loud pattern as requireUniswapV3.
 */
export function requireWrappedNative(chainId: ChainIdType): `0x${string}` {
  const info = CHAINS[chainId];
  if (!info.wrappedNative) {
    throw new Error(
      `Chain ${info.name} (${chainId}) has no wrappedNative address configured.`,
    );
  }
  return info.wrappedNative;
}
