/**
 * Toggle whether testnets are exposed in the wallet chain switcher.
 *
 * Wagmi config is built once at app boot (see lib/wagmi.ts), so flipping
 * the preference requires a reload to take effect. We do the reload
 * inline on click — the alternative (rebuild the config dynamically)
 * would mean re-wrapping WagmiProvider, which is far more invasive than
 * the once-per-decision UX cost of a refresh.
 *
 * The label reflects current state (Show vs Hide) using the same default
 * logic the wagmi config uses, so a user with no saved preference still
 * sees an honest label.
 */

import { env } from '../lib/env';
import { setShowTestnets, shouldShowTestnets } from '../lib/testnetPref';

export function TestnetToggle() {
  const currentlyVisible = shouldShowTestnets(env.chainIds);
  const toggle = () => {
    setShowTestnets(!currentlyVisible);
    window.location.reload();
  };
  return (
    <button
      type="button"
      onClick={toggle}
      className="text-slate-500 underline-offset-2 hover:text-cyan-300 hover:underline"
    >
      {currentlyVisible ? 'Hide testnets' : 'Show testnets'}
    </button>
  );
}
