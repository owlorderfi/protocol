import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useChainId, useChains } from 'wagmi';
import { CHAINS, type ChainIdType } from '@owlorderfi/shared';
import { useAuth } from '../lib/AuthContext';
import { ChainBadge } from './ChainBadge';
import owlLogo from '../assets/owl-logo.png';

export function Header() {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const configuredChains = useChains();
  const { isAuthed, isLoggingIn, loginError, login, logout, mismatch } = useAuth();
  // chainSupported drives the "Unsupported chain" warning pill.
  const chainInfo = CHAINS[chainId as ChainIdType];
  const chainSupported = chainInfo !== undefined;
  // RainbowKit hides its chain switcher pill when wagmi is configured with
  // a single chain (sensible — nothing to switch to), but that leaves the
  // user with no visual cue of which network they're actually on. When
  // that happens we render our own pill and tell RainbowKit to keep its
  // chain status off (chainStatus="none"). With ≥2 chains RainbowKit's
  // built-in switcher handles it cleanly, so we hide ours to avoid dupes.
  const useCustomChainPill = configuredChains.length === 1;

  return (
    <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2">
          {/* Brand mark doubles as the back-link to the landing page at /.
              Anchor (not router Link) because the landing is a separate
              static document served by Caddy — a hard navigation is exactly
              what we want here, not an SPA route push. */}
          <a
            href="/"
            title="Back to OwlOrderFi home"
            className="flex items-center gap-2 transition hover:opacity-90"
          >
            <img
              src={owlLogo}
              alt="OwlOrderFi"
              className="h-8 w-8 object-contain"
            />
            <h1 className="text-xl font-semibold tracking-tight">OwlOrderFi</h1>
            <span className="ml-2 rounded-full bg-slate-800 px-2 py-0.5 text-xs uppercase tracking-wider text-slate-400">
              beta
            </span>
          </a>
          {/* Unsupported-chain warning — only shown when wallet is on a
              chain we don't have a router for. Normal-case chain name
              lives next to the chain dropdown via RainbowKit's
              chainStatus="full" below, so no redundant pill here. */}
          {isConnected && !chainSupported && (
            <span
              className="ml-3 inline-flex items-center gap-2 rounded-full border border-amber-700 bg-amber-950/40 px-3 py-1 text-sm text-amber-200"
              title={`Wallet is on chain ${chainId} — OwlOrderFi has no router configured here, orders can't be created until you switch.`}
            >
              <ChainBadge chainId={chainId} size="md" />
              <span className="font-medium">Unsupported chain {chainId}</span>
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

          {useCustomChainPill && isConnected && chainSupported && (
            <span
              className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-800/40 px-3 py-1 text-sm text-slate-200"
              title={`Connected to ${chainInfo?.name}`}
            >
              <ChainBadge chainId={chainId} size="md" />
              <span className="font-medium">{chainInfo?.name}</span>
            </span>
          )}

          <ConnectButton
            showBalance={false}
            chainStatus={useCustomChainPill ? 'none' : 'full'}
          />
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
