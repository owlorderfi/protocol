import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useChainId } from 'wagmi';
import { CHAINS, type ChainIdType } from '@owlorderfi/shared';
import { useAuth } from '../lib/AuthContext';
import { ChainBadge } from './ChainBadge';
import owlLogo from '../assets/owl-logo.png';

export function Header() {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { isAuthed, isLoggingIn, loginError, login, logout, mismatch } = useAuth();
  // Resolve chain info for the prominent header pill. Falls back to a
  // neutral "Chain N" label when the wallet's connected to something
  // outside our registry — better to surface the mismatch than silently
  // pretend the chain is known.
  const chainInfo = CHAINS[chainId as ChainIdType];
  const chainName = chainInfo?.name ?? `Chain ${chainId}`;
  const chainSupported = chainInfo !== undefined;

  return (
    <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2">
          <img
            src={owlLogo}
            alt="OwlOrderFi"
            className="h-8 w-8 object-contain"
          />
          <h1 className="text-xl font-semibold tracking-tight">OwlOrderFi</h1>
          <span className="ml-2 rounded-full bg-slate-800 px-2 py-0.5 text-xs uppercase tracking-wider text-slate-400">
            beta
          </span>
          {/* Persistent "you are here" chain marker — operator complaint
              was that the only chain hint was RainbowKit's tiny icon next
              to the wallet button, easy to miss when switching tabs.
              Hidden when wallet's not connected (no chain selected). */}
          {isConnected && (
            <span
              className={`ml-3 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm ${
                chainSupported
                  ? 'border-slate-700 bg-slate-800/70 text-slate-200'
                  : 'border-amber-700 bg-amber-950/40 text-amber-200'
              }`}
              title={chainSupported
                ? `Connected to ${chainName} (chain ${chainId})`
                : `Wallet is on chain ${chainId} — OwlOrderFi has no router configured here, orders can't be created until you switch.`}
            >
              <ChainBadge chainId={chainId} size="md" />
              <span className="font-medium">
                {chainSupported ? chainName : `Unsupported chain ${chainId}`}
              </span>
            </span>
          )}
        </div>

        {/* Tagline was here — moved to a centered hero in App.tsx, just
            below the header. The chain pill + wallet button now take the
            space and the tagline gets the breathing room a tagline needs. */}

        <div className="flex items-center gap-3">
          {isConnected && !isAuthed && !mismatch && (
            <button
              onClick={login}
              disabled={isLoggingIn}
              className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
            >
              {isLoggingIn ? 'Signing…' : 'Sign-in with wallet'}
            </button>
          )}

          {mismatch && (
            <button
              onClick={login}
              className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-amber-400"
            >
              Re-sign for new account
            </button>
          )}

          {isAuthed && (
            <button
              onClick={logout}
              className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
            >
              Sign out
            </button>
          )}

          <ConnectButton showBalance={false} chainStatus="icon" />
        </div>
      </div>

      {loginError && (
        <div className="border-t border-rose-900/50 bg-rose-950/40 px-6 py-2 text-sm text-rose-300">
          {loginError}
        </div>
      )}
    </header>
  );
}
