import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { http, type Chain } from 'viem';
import { env } from './env';
import { getViemChain } from './viemChain';
import { isTestnetChainId, shouldShowTestnets } from './testnetPref';

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
// its own http() (uses the chain's default RPC unless overridden).
const transports: Record<number, ReturnType<typeof http>> = {};
for (const c of chains) {
  transports[c.id] = http();
}

export const wagmiConfig = getDefaultConfig({
  appName: 'OwlOrderFi',
  projectId: env.walletConnectProjectId,
  chains,
  transports,
  ssr: false,
});
