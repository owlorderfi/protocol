/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  /** Default chain — selected at first paint before the wallet reports its chain. */
  readonly VITE_CHAIN_ID: string;
  /** Legacy single-chain router (back-compat). Prefer VITE_CHAIN_<id>_ROUTER. */
  readonly VITE_LIMIT_ORDER_ROUTER_ADDRESS?: string;
  /**
   * Per-chain routers — one VITE_CHAIN_<id>_ROUTER for each chain the build
   * supports. env.ts assembles them into the routers map at load time.
   * Indexed-access type below catches typos at compile time.
   */
  readonly [key: `VITE_CHAIN_${number}_ROUTER`]: string | undefined;
  readonly VITE_WALLETCONNECT_PROJECT_ID: string;
  readonly VITE_POLYGON_RPC?: string;
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_RELEASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
