/**
 * Supported chains for OwlOrderFi.
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
  BASE: 8453,
  BASE_SEPOLIA: 84532,
  ARBITRUM_SEPOLIA: 421614,
  OPTIMISM_SEPOLIA: 11155420,
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
   *
   * Ordering is NOT semantically meaningful — historical entries vary
   * between [USDC, WETH] (Polygon) and [WETH, USDC] (OP-stack chains).
   * Anyone needing the USD anchor must use `usdReferenceToken` below,
   * not `hubTokens[0]`.
   */
  hubTokens: `0x${string}`[];
  /**
   * Canonical USD-stable token on this chain used as the reference for
   * USD pricing (gas USD, slice USD, dust filter). Must point to the
   * deepest USDC pool's stable side. Required for any chain where the
   * keeper enforces USD-based gating (i.e. `minLimitOrderUsd` is set);
   * undefined is acceptable on testnets where the break-even gate is
   * bypassed.
   */
  usdReferenceToken?: `0x${string}`;
  /**
   * Fee tier (in 1/1_000_000) used for the inner hop when going through a
   * hub. 500 (0.05%) is the most liquid tier on hub pools on every chain.
   */
  hopFee: number;
  /**
   * Fee tiers to probe when computing direct routes. Standard Uniswap V3
   * deploys [100, 500, 3000, 10000]; forks (PancakeSwap V3, SushiSwap)
   * vary. Default applied by getFeeTiers() when omitted.
   */
  feeTiers?: number[];
}

/** Standard Uniswap V3 fee tiers used when a deployment doesn't override. */
export const DEFAULT_UNISWAP_V3_FEE_TIERS = [100, 500, 3000, 10000] as const;

/** Resolve fee tiers for a chain — explicit override or the V3 standard. */
export function getFeeTiers(deployment: UniswapV3Deployment): readonly number[] {
  return deployment.feeTiers ?? DEFAULT_UNISWAP_V3_FEE_TIERS;
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
   * Minimum cushion (basis points) the keeper requires above the signed
   * `minAmountOut` before submitting a tx. Pre-flight check absorbs the
   * ~2 second window between gate-check and inclusion — anything that
   * would land below `minOut + buffer` is aborted off-chain instead of
   * burning gas for an on-chain revert.
   *
   * Calibrated per chain: deeper mainnet pools (Base, Polygon) can run
   * tighter cushions because price moves over 2s are tiny; thin testnet
   * pools warrant a generous default to avoid retry spam.
   *
   * Pair this with the frontend slippage suggestion (orderMath / form):
   * user-side slippage tolerance must be >= keeper buffer + a small market
   * margin, or the gate aborts every poll cycle.
   *
   * Default applied by consumers when this is undefined: 50 bps. Set
   * explicitly per chain where a different value is appropriate.
   */
  keeperSlippageBufferBps?: number;
  /**
   * Minimum USD value of a limit order before the keeper bothers to
   * execute. Skips dust / spam orders below this floor with a clear
   * failure reason so the user sees why (and doesn't waste a polling
   * slot). Undefined → no minimum (default; appropriate for testnets
   * where small amounts are how you debug).
   *
   * For mainnet a floor of $0.10 is enough to filter trivial dust
   * without paternalising legitimate-but-small smoke tests.
   */
  minLimitOrderUsd?: number;
  /**
   * Coarse USD estimate for the chain's native token, used by the web
   * frontend to display a live gas-cost indicator + break-even minimum
   * order size to the user (so they understand why a small order on a
   * spike-gas chain isn't being submitted). NOT consulted by the keeper —
   * the keeper does dynamic Uniswap pool spot queries for actual gating.
   * Refresh in source when market drifts > ~30% from the stored value.
   * Undefined → web skips the gas indicator on this chain (acceptable for
   * testnets where gas is meaningless).
   */
  nativeUsdEstimate?: number;
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
    // Same-origin proxy first (Caddy handles fallback to publicnode/drpc/Infura/
    // Alchemy server-side), then viem default (drpc) for any visitor whose
    // wallet RPC + our proxy both fail. See apps/web/src/lib/wagmi.ts.
    rpcUrls: ['https://owlorderfi.com/rpc/polygon', 'https://polygon-bor-rpc.publicnode.com'],
    blockExplorer: 'https://polygonscan.com',
    isTestnet: false,
    // 30 bps — Polygon's USDC/WPOL Uniswap V3 pool is thinner than Base's
    // USDC/WETH, so the keeper needs a touch more cushion for the
    // gate-to-inclusion window. Tighten when fill data shows we can.
    keeperSlippageBufferBps: 30,
    // Dust filter: Polygon gas (~30 gwei × $0.30 POL ≈ $0.001) means the
    // break-even threshold is ~$0.05. Set the dust floor an order below,
    // since legitimate test orders on Polygon are smaller than on Base.
    minLimitOrderUsd: 0.02,
    // POL ~$0.30 as of 2026-05-31. Drives the web's gas indicator UI;
    // keeper uses dynamic pool spot, not this. Refresh when POL moves
    // > ~30% from this estimate.
    nativeUsdEstimate: 0.30,
    wrappedNative: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // WPOL
    uniswapV3: {
      quoterV2:     '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
      swapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
      factory:      '0x1F98431c8aD98523631AE4a59f267346ea31F984',
      hubTokens: [
        '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // USDC (native)
        '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', // WETH
      ],
      usdReferenceToken: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // USDC (native Circle)
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
      usdReferenceToken: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // USDC (Circle testnet)
      hopFee: 500,
    },
  },

  [ChainId.ARBITRUM_SEPOLIA]: {
    id: ChainId.ARBITRUM_SEPOLIA,
    name: 'Arbitrum Sepolia',
    shortName: 'arbitrum-sepolia',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://sepolia-rollup.arbitrum.io/rpc'],
    blockExplorer: 'https://sepolia.arbiscan.io',
    isTestnet: true,
    // Arbitrum Sepolia WETH — different address than OP-stack chains
    // (Arbitrum is Nitro, not OP-stack; no canonical 0x4200… predeploy).
    wrappedNative: '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73',
    uniswapV3: {
      // Source: https://docs.uniswap.org/contracts/v3/reference/deployments/arbitrum-deployments
      quoterV2:     '0x2779a0CC1c3e0E44D2542EC3e79e3864Ae93Ef0B',
      swapRouter02: '0x101F443B4d1b059569D643917553c771E1b9663E',
      factory:      '0x248AB79Bbb9bC29bB72f7Cd42F17e054Fc40188e',
      hubTokens: [
        '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73', // WETH
        '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', // USDC (Circle testnet)
      ],
      usdReferenceToken: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', // USDC (Circle testnet)
      hopFee: 500,
    },
  },

  [ChainId.OPTIMISM_SEPOLIA]: {
    id: ChainId.OPTIMISM_SEPOLIA,
    name: 'Optimism Sepolia',
    shortName: 'optimism-sepolia',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://sepolia.optimism.io'],
    blockExplorer: 'https://sepolia-optimism.etherscan.io',
    isTestnet: true,
    // OP-stack predeploy WETH9 — identical address on every OP-stack
    // chain (Optimism, Base, Mode, Zora…). Confirms shared OP-stack
    // genesis between mainnet OP/Base and their Sepolia counterparts.
    wrappedNative: '0x4200000000000000000000000000000000000006',
    uniswapV3: {
      // Source: https://docs.uniswap.org/contracts/v3/reference/deployments/optimism-deployments
      // (Optimism Sepolia section, verified 2026-05-25)
      quoterV2:     '0xC5290058841028F1614F3A6F0F5816cAd0df5E27',
      swapRouter02: '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4',
      factory:      '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',
      hubTokens: [
        '0x4200000000000000000000000000000000000006', // WETH (predeploy)
        '0x5fd84259d66Cd46123540766Be93DFE6D43130D7', // USDC (Circle testnet)
      ],
      usdReferenceToken: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7', // USDC (Circle testnet)
      hopFee: 500,
    },
  },

  [ChainId.BASE]: {
    id: ChainId.BASE,
    name: 'Base',
    shortName: 'base',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    // Default public RPC. For production keeper-side ops, prefer a
    // paid/private endpoint via CHAIN_8453_RPC env to avoid rate
    // limits and inclusion latency during congestion. The public URL
    // here is the fallback for the frontend + occasional dev work.
    rpcUrls: ['https://mainnet.base.org'],
    blockExplorer: 'https://basescan.org',
    isTestnet: false,
    // 15 bps — Base mainnet's Uniswap V3 USDC/WETH pool is deep enough
    // that the ~2 second gate-to-inclusion window moves price by a few
    // bps at most. 50 (the testnet default) was hard-rejecting orders
    // signed at sensible user-side slippage tolerances (0.5%).
    keeperSlippageBufferBps: 15,
    // Dust filter: orders smaller than this in USD are silently rejected
    // by the keeper. At $0.10 the protocol fee (30 bps = $0.0003) doesn't
    // even cover RPC overhead — almost certainly spam or a misconfigured
    // automation. Real users place $5+ test orders; this just keeps the
    // log noise + execution slots free of trivially-small intents.
    minLimitOrderUsd: 0.1,
    // ETH ~$2025 as of 2026-05-31. Refresh when ETH moves > ~30%.
    nativeUsdEstimate: 2025,
    // WETH9 is the OP-stack predeploy — same address on every OP-stack
    // chain (Optimism, Base, Mode, etc.).
    wrappedNative: '0x4200000000000000000000000000000000000006',
    uniswapV3: {
      // Source: https://docs.uniswap.org/contracts/v3/reference/deployments/base-deployments
      quoterV2:     '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
      swapRouter02: '0x2626664c2603336E57B271c5C0b26F421741e481',
      factory:      '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
      hubTokens: [
        '0x4200000000000000000000000000000000000006', // WETH (predeploy)
        '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC (Circle native)
      ],
      usdReferenceToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC (Circle native)
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
    // ⚠️ ASSUMPTION: Anvil is forking Polygon mainnet (the canonical
    // `scripts/bootstrap-anvil.sh` does `anvil --fork-url polygon-rpc`).
    // The Uniswap V3 addresses + wrappedNative below are Polygon-mainnet
    // values, valid only under that fork. Running Anvil with a different
    // fork-url (e.g., Base mainnet) silently returns wrong addresses — the
    // keeper would call non-contract addresses and all quotes fail.
    // If you ever fork another chain, add an ANVIL_<CHAIN>_FORK ChainId.
    wrappedNative: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    uniswapV3: {
      quoterV2:     '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
      swapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
      factory:      '0x1F98431c8aD98523631AE4a59f267346ea31F984',
      hubTokens: [
        '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // USDC (native)
        '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', // WETH
      ],
      usdReferenceToken: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // USDC (Polygon-fork)
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
