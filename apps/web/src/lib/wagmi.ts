import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { fallback, http, type Chain } from 'viem';
import { unstable_connector } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { ChainId } from '@owlorderfi/shared';
import { env } from './env';
import { getViemChain } from './viemChain';
import { isTestnetChainId, shouldShowTestnets } from './testnetPref';

// Per-chain server-side RPC proxy hosted on our domain (Caddy injects the
// upstream API key — see ops/ops/Caddyfile `handle /rpc/<chain>` blocks).
// undefined means "no proxy configured for this chain" → fallback skips
// straight to the public endpoint. Adding a new chain: add a Caddy block
// and a row here.
const PROXIED_RPC: Partial<Record<number, string>> = {
  [ChainId.BASE]: 'https://owlorderfi.com/rpc/base',
  [ChainId.POLYGON]: 'https://owlorderfi.com/rpc/polygon',
};

/**
 * Build the read transport for a chain as a fallback chain:
 *
 *   1. The connected wallet's INJECTED provider (MetaMask, Rabby, Brave,
 *      Frame — anything that exposes window.ethereum). Routes reads
 *      through that wallet's own RPC, so we don't burn quota on those
 *      users and they get better privacy (their wallet's RPC sees their
 *      queries — not ours). Does NOT cover Coinbase Wallet via its
 *      dedicated connector, WalletConnect deep-linked sessions, or
 *      RainbowKit smart-wallet sessions — for those users layer 1
 *      throws immediately and the cascade falls straight to layer 2.
 *      Acceptable: those users still get keyless proxy + public.
 *   2. Our same-origin reverse proxy on owlorderfi.com/rpc/<chain>
 *      (when configured for this chain). Caddy injects the upstream API
 *      key server-side — the key never lives in the JS bundle. Used by
 *      pre-wallet visitors (who land on the form before connecting) and
 *      as a catch when the wallet's RPC errors or rate-limits.
 *   3. The chain's public RPC (from viem's built-in or the shared
 *      registry). Last-ditch fallback so the site still works if our
 *      server is down. Rate-limited and sometimes a few blocks stale,
 *      but never an auth-required hard failure.
 *
 * viem's fallback transport retries the next layer when one returns an
 * RPC error or rejects entirely. unstable_connector errors when no
 * wallet is connected, which fallback handles transparently — visitors
 * just see proxy → public without ever touching the wallet layer.
 */
function buildTransport(chainId: number) {
  const layers = [
    unstable_connector(injected),
    ...(PROXIED_RPC[chainId] ? [http(PROXIED_RPC[chainId]!)] : []),
    http(), // chain default (viem built-in or chains.ts rpcUrls[0])
  ];
  return fallback(layers);
}

// Enable every chain that has a router configured in env, filtered by the
// user's "show testnets" preference (see testnetPref.ts for the default
// logic). The wallet switches between them via RainbowKit's built-in
// selector; orders + balances follow the active chain. Default chain
// (used at first paint before the wallet reports its chain) is
// env.chainId — kept first in the list when present.
//
// Adding a new chain = configure VITE_CHAIN_<id>_ROUTER in apps/web/.env
// (and add a registry entry if needed). No edit here.
function pickChains(): readonly [Chain, ...Chain[]] {
  const showTestnets = shouldShowTestnets(env.chainIds);
  let ids = env.chainIds.filter((id) => showTestnets || !isTestnetChainId(id));

  // Belt: if the filter removes everything (e.g., user picked "hide" but
  // no mainnet is configured — shouldn't happen with the smart default,
  // but a stale localStorage flag from an earlier session could trigger
  // it), fall back to the unfiltered list so the switcher is never empty.
  if (ids.length === 0) ids = [...env.chainIds];

  ids = ids.sort((a, b) =>
    a === env.chainId ? -1 : b === env.chainId ? 1 : 0,
  );
  const chains = ids.map(getViemChain);
  if (chains.length === 0) {
    throw new Error('No chains configured — set at least one VITE_CHAIN_<id>_ROUTER.');
  }
  return chains as [Chain, ...Chain[]];
}

const chains = pickChains();

// Build the transports map from the same chain list — each chain gets
// its own hybrid fallback (see buildTransport above for layering).
const transports: Record<number, ReturnType<typeof buildTransport>> = {};
for (const c of chains) {
  transports[c.id] = buildTransport(c.id);
}

export const wagmiConfig = getDefaultConfig({
  appName: 'OwlOrderFi',
  projectId: env.walletConnectProjectId,
  chains,
  transports,
  ssr: false,
});
