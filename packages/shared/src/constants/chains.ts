/**
 * Supported chains for Polyorder.
 * Currently: Polygon PoS mainnet + Amoy testnet.
 */

export const ChainId = {
  POLYGON: 137,
  AMOY: 80002,
} as const;

export type ChainIdType = (typeof ChainId)[keyof typeof ChainId];

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
  },
  [ChainId.AMOY]: {
    id: ChainId.AMOY,
    name: 'Polygon Amoy',
    shortName: 'amoy',
    nativeCurrency: { name: 'Polygon', symbol: 'POL', decimals: 18 },
    rpcUrls: ['https://rpc-amoy.polygon.technology'],
    blockExplorer: 'https://amoy.polygonscan.com',
    isTestnet: true,
  },
};

export const SUPPORTED_CHAIN_IDS = Object.values(ChainId);

export function isSupportedChainId(chainId: number): chainId is ChainIdType {
  return SUPPORTED_CHAIN_IDS.includes(chainId as ChainIdType);
}

export function getChainInfo(chainId: ChainIdType): ChainInfo {
  return CHAINS[chainId];
}
