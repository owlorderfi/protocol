import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount } from 'wagmi';
import { useAuth } from '../lib/AuthContext';

export function Header() {
  const { isConnected } = useAccount();
  const { isAuthed, isLoggingIn, loginError, login, logout, mismatch } = useAuth();

  return (
    <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-fuchsia-500 to-cyan-400" />
          <h1 className="text-xl font-semibold tracking-tight">OwlOrderFi</h1>
          <span className="ml-2 rounded-full bg-slate-800 px-2 py-0.5 text-xs uppercase tracking-wider text-slate-400">
            beta
          </span>
        </div>

        {/* Tagline — sits in the middle of the bar on wide viewports,
            hides on small ones so the connect button doesn't fight for
            space. Same gradient as the standalone Hero used to render. */}
        <div className="hidden flex-1 px-6 text-center md:block">
          <span className="bg-gradient-to-r from-fuchsia-400 to-cyan-300 bg-clip-text text-sm font-semibold tracking-tight text-transparent">
            Smart swaps with limit, DCA &amp; TWAP
          </span>
          <span className="ml-2 text-sm text-slate-400">· Self-custody · Multichain</span>
        </div>

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
