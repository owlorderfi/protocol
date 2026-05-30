/**
 * Show-testnets preference: a localStorage flag that filters which
 * chains the wagmi config exposes to RainbowKit.
 *
 * Smart default — when the user has expressed no preference yet:
 *
 *   - If any configured chain is mainnet (i.e. has a router AND is not
 *     marked `isTestnet` in the registry), hide testnets. The chain
 *     switcher leads with real-money chains, which is what a launched
 *     project wants.
 *   - If NO mainnet is configured (pre-Etapa-2 state today), show
 *     everything — otherwise new visitors would see an empty switcher
 *     and a "no chain configured" wall on first connect.
 *
 * The default flips automatically the moment `VITE_CHAIN_8453_ROUTER`
 * (or any other mainnet chain router) lands in apps/web/.env, without
 * a code change. Users who explicitly toggled have their localStorage
 * pref preserved across the transition.
 */

import { CHAINS, type ChainIdType } from '@owlorderfi/shared';

const TESTNET_PREF_LS_KEY = 'polyorder.showTestnets';

export function isTestnetChainId(id: number): boolean {
  return CHAINS[id as ChainIdType]?.isTestnet ?? false;
}

function readPref(): boolean | null {
  if (typeof window === 'undefined') return null;
  const v = localStorage.getItem(TESTNET_PREF_LS_KEY);
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

/**
 * Decide whether to expose testnets, given the chain IDs we have routers for.
 * User preference (when set) always wins; otherwise apply the smart default.
 */
export function shouldShowTestnets(configuredChainIds: readonly number[]): boolean {
  const pref = readPref();
  if (pref !== null) return pref;
  // No explicit pref. Hide testnets only IF a mainnet is configured;
  // otherwise we'd present an empty switcher pre-Etapa-2.
  const hasMainnet = configuredChainIds.some((id) => !isTestnetChainId(id));
  return !hasMainnet;
}

/** Returns whatever the user has saved (or null when no preference exists). */
export function getStoredPref(): boolean | null {
  return readPref();
}

export function setShowTestnets(value: boolean): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(TESTNET_PREF_LS_KEY, String(value));
}
