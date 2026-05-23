/**
 * "Why Polyorder" pitch surface. Goes below the action grid so it doesn't
 * compete with the form, but visible on first scroll so prospects see the
 * value prop without reading docs.
 *
 * Conventions enforced here:
 *   - tick (✓) for features that ARE live and functional today
 *   - dot (○) for features that are planned / partially shipped — never
 *     claim something we don't actually deliver
 *
 * If you're about to add a ✓ here, verify the feature works end-to-end
 * first. The credibility of the rest of the list rides on it.
 */

interface Feature {
  status: 'live' | 'soon';
  title: string;
  body: string;
}

const FEATURES: Feature[] = [
  { status: 'live', title: 'Self-custody',          body: 'Funds stay in your wallet between trades. The router holds nothing.' },
  { status: 'live', title: 'No KYC',                body: 'Connect a wallet, sign-in once, trade. Nothing else asked.' },
  { status: 'live', title: 'Signed orders',         body: 'Your minAmountOut is signed off-chain — the contract enforces it on-chain.' },
  { status: 'live', title: 'Smart trigger',         body: 'Volatility-aware suggestions (σ + trend) compute a fair price for you.' },
  { status: 'live', title: 'Best-rate routing',     body: 'Quotes 4 Uniswap V3 fee tiers + multi-hop paths, picks the highest output.' },
  { status: 'live', title: 'Adaptive slippage',     body: 'Recommendation scales with the pool\'s recent σ. Warning if you go too tight or too wide.' },
  { status: 'live', title: 'Tiered fees',           body: 'Default 30 bps; drops to 15 bps for larger orders. Lower than most centralized desks.' },
  { status: 'live', title: 'Always cancellable',    body: 'Free off-chain cancel. If the keeper got there first, an on-chain cancel kills the nonce.' },
  { status: 'live', title: 'Emergency pause',       body: 'Operator can halt execution in seconds via a hardware wallet if something looks off.' },
  { status: 'live', title: 'Smart-account ready',   body: 'EIP-7702 delegated EOAs (Rabby, etc.) supported through a dedicated unwrap path.' },
  { status: 'live', title: 'Open source',           body: 'Code on GitHub, deploy records committed, no surprises.' },
  { status: 'soon', title: 'Private mempool',       body: 'Per-chain MEV protection via private RPCs (FastLane on Polygon, etc.) — being evaluated; sandwich risk today is bounded by your slippage cap.' },
  { status: 'soon', title: 'Recurring DCA',         body: 'Dollar-cost averaging on a schedule. Tab is already visible — implementation lands in Phase 5.' },
];

export function Features() {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/30 p-6">
      <h2 className="mb-4 text-base font-semibold text-slate-200">Why Polyorder</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f) => (
          <div key={f.title} className="flex gap-3">
            <span
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                f.status === 'live'
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : 'bg-slate-700/40 text-slate-400'
              }`}
              aria-label={f.status === 'live' ? 'Live today' : 'Planned'}
            >
              {f.status === 'live' ? '✓' : '○'}
            </span>
            <div>
              <div className="text-sm font-medium text-slate-200">{f.title}</div>
              <p className="text-xs text-slate-400">{f.body}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
