/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_CHAIN_ID: string;
  readonly VITE_LIMIT_ORDER_ROUTER_ADDRESS: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID: string;
  readonly VITE_POLYGON_RPC?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
