import { useState } from 'react';
import { Header } from './components/Header';
import { OrdersList } from './components/OrdersList';
import { CreateOrderForm } from './components/CreateOrderForm';
import { WrapPanel } from './components/WrapPanel';
import { CreateDcaForm } from './components/CreateDcaForm';
import { CreateTwapForm } from './components/CreateTwapForm';
import { CreateLadderForm } from './components/CreateLadderForm';
import { ScheduledOrdersList } from './components/ScheduledOrdersList';
import { Tabs } from './components/Tabs';
import { TestnetToggle } from './components/TestnetToggle';
import { WalletSummary } from './components/WalletSummary';
import { AdminInfoPanel, AdminFeesPanel } from './components/AdminPanel';
import { LegalDisclaimer } from './components/LegalDisclaimer';
import { ActiveTokenProvider } from './lib/ActiveTokenContext';
import { AdminChainProvider } from './lib/AdminChainContext';
import { useAuth } from './lib/AuthContext';
import { useAdminWhoami } from './hooks/useAdmin';
import { useOrders } from './hooks/useOrders';
import { useScheduledOrders } from './hooks/useScheduledOrders';
import { env, getRouterForChain } from './lib/env';
import { useChainId } from 'wagmi';

export function App() {
  const { isAuthed } = useAuth();
  const chainId = useChainId();
  // Track the currently-active tab so the orders sections (and the
  // wrap / admin special-cases) can render the right content.
  // Defaults to 'limit' — the localStorage-backed Tabs widget will
  // fire onActiveChange after mount with the stored value, so this
  // is just the pre-mount fallback.
  const [activeTab, setActiveTab] = useState<string>('limit');
  // Override switch — when on, the orders area shows every list
  // regardless of which tab is active. Useful for users who want to
  // see everything at a glance.
  const [viewAll, setViewAll] = useState<boolean>(false);
  // Owner gate for the optional Admin tab. Cheap probe — only the
  // connected chain's owner answers true, everyone else (and anon
  // visitors) sees the tab hidden.
  const whoami = useAdminWhoami(chainId, isAuthed);
  const isOwner = whoami.data?.isOwner === true;
  // Footer reflects the wallet's active chain. If the wallet is on a
  // chain we haven't configured a router for, show "unsupported" —
  // never silently fall back to the default-chain router (that would
  // mislead the user into thinking orders would route somewhere they
  // won't).
  let routerLabel: string;
  try {
    const r = getRouterForChain(chainId);
    routerLabel = `${r.slice(0, 8)}…${r.slice(-6)}`;
  } catch {
    routerLabel = 'not configured on this chain';
  }

  // Three distinct layouts depending on which tab is active:
  //  - swap-style (limit/dca/twap) → vertical: form full-width with
  //    internal 2-col split (inputs left, preview+action right),
  //    then orders list(s) full-width below.
  //  - wrap → narrow right-column form, no orders (action-only flow)
  //  - admin → wide left = info panel, narrow right = fees + actions
  const isAdminTab = activeTab === 'admin';
  const isWrapTab = activeTab === 'wrap';
  // Else branch in JSX below covers swap (limit/dca/twap) — no
  // explicit flag needed.

  // Active-order counts per tab — surfaced as a small badge so the
  // operator knows at a glance which tabs have something in flight
  // on the connected chain. Scoped to chainId because switching the
  // wallet to another chain should swap the badge counts too (orders
  // are per-chain). DCA vs TWAP is the same intervalSec >= 3600
  // heuristic ScheduledOrdersList uses for its kindBadge — the day
  // we add a real `kind` column on the order, both swap to it together.
  const limitOrders = useOrders(isAuthed);
  const scheduledOrders = useScheduledOrders(isAuthed);
  // Split OPEN orders the same way the tab lists do: standalone limits
  // (ladderId null) feed the Limit badge, ladder rungs (ladderId set)
  // feed the Ladder badge. Counting all OPEN for Limit would double-count
  // ladder rungs that live under the Ladder tab's list.
  const openOrders = (limitOrders.data ?? []).filter(
    (o) => o.chainId === chainId && o.status === 'OPEN',
  );
  const limitActiveCount = openOrders.filter((o) => o.ladderId === null).length;
  const ladderActiveCount = openOrders.filter((o) => o.ladderId !== null).length;
  const scheduledActive = (scheduledOrders.data ?? []).filter(
    (o) => o.chainId === chainId && o.status === 'ACTIVE',
  );
  const dcaActiveCount = scheduledActive.filter((o) => o.intervalSec >= 3600).length;
  const twapActiveCount = scheduledActive.filter((o) => o.intervalSec < 3600).length;

  const tabSpecs = [
    {
      id: 'limit',
      label: 'Limit',
      content: <CreateOrderForm enabled={isAuthed} />,
      badge: limitActiveCount > 0 ? String(limitActiveCount) : undefined,
    },
    {
      id: 'dca',
      label: 'DCA',
      content: <CreateDcaForm enabled={isAuthed} />,
      badge: dcaActiveCount > 0 ? String(dcaActiveCount) : undefined,
    },
    {
      id: 'twap',
      label: 'TWAP',
      content: <CreateTwapForm enabled={isAuthed} />,
      badge: twapActiveCount > 0 ? String(twapActiveCount) : undefined,
    },
    {
      id: 'ladder',
      label: 'Ladder',
      content: <CreateLadderForm enabled={isAuthed} />,
      badge: ladderActiveCount > 0 ? String(ladderActiveCount) : undefined,
    },
    { id: 'wrap',  label: 'Wrap',  content: <WrapPanel enabled={isAuthed} /> },
    // Admin only visible when the connected wallet is the on-chain
    // owner (UI gate + API OwnerOnlyGuard defense in depth).
    ...(isOwner
      ? [{ id: 'admin', label: 'Admin', content: <AdminFeesPanel enabled={isAuthed} /> }]
      : []),
  ];

  return (
    <ActiveTokenProvider>
    <AdminChainProvider>
    <div className="min-h-screen">
      <Header />
      {/* Marketing surfaces (hero tagline, Features grid, Pricing card) now
          live on the static landing page at / — the app at /app is the tool,
          not the pitch. See apps/web/landing/. */}
      <main className="mx-auto max-w-6xl space-y-8 px-6 py-10">
        {/* Wallet snapshot stays on the swap tabs (relevant to the
            order being composed) and on wrap (balance of native vs
            wrapped). Hidden on Admin tab — operator wants the full
            canvas for ops cards, not their own wallet. */}
        {!isAdminTab && <WalletSummary enabled={isAuthed} />}

        {isAdminTab ? (
          // Admin: wide info panel + narrow tab content (fees + actions).
          // Same 2-col grid as the legacy layout, kept on this tab only.
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_400px]">
            <AdminInfoPanel enabled={isAuthed} />
            <Tabs
              storageKey="polyorder.activeTab"
              onActiveChange={setActiveTab}
              tabs={tabSpecs}
            />
          </div>
        ) : (
          // Wrap + swap tabs (limit/dca/twap): tabs full-width on top,
          // form below also full-width so the tab strip stays the same
          // size on every tab (operator complained that Wrap was
          // shrinking the bar inside the narrow column).
          // Wrap tab skips the orders section since wrap/unwrap is
          // action-only — nothing relevant to scroll through below.
          <>
            <Tabs
              storageKey="polyorder.activeTab"
              onActiveChange={setActiveTab}
              tabs={tabSpecs}
            />
            {isWrapTab ? null : (

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">
                  {viewAll
                    ? 'My orders'
                    : activeTab === 'limit'
                      ? 'My limit orders'
                      : activeTab === 'dca'
                        ? 'My DCA orders'
                        : activeTab === 'twap'
                          ? 'My TWAP orders'
                          : 'My orders'}
                </h2>
                <button
                  type="button"
                  onClick={() => setViewAll((v) => !v)}
                  className="text-xs text-slate-400 hover:text-cyan-300"
                  title={viewAll ? 'Show only the active tab\'s orders' : 'Show every list at once'}
                >
                  {viewAll ? 'Tab view' : 'View all tabs'}
                </button>
              </div>

              {viewAll && (
                <h3 className="text-sm font-semibold text-slate-300 pt-2">LIMIT</h3>
              )}
              {(viewAll || activeTab === 'limit') && (
                <OrdersList enabled={isAuthed} ladderFilter="standalone" />
              )}

              {viewAll ? (
                <>
                  <h3 className="text-sm font-semibold text-slate-300 pt-2">DCA</h3>
                  <ScheduledOrdersList enabled={isAuthed} kindFilter="dca" />
                  <h3 className="text-sm font-semibold text-slate-300 pt-2">TWAP</h3>
                  <ScheduledOrdersList enabled={isAuthed} kindFilter="twap" />
                  <h3 className="text-sm font-semibold text-slate-300 pt-2">LADDER</h3>
                  <OrdersList enabled={isAuthed} ladderFilter="ladder" />
                </>
              ) : activeTab === 'dca' ? (
                <ScheduledOrdersList enabled={isAuthed} kindFilter="dca" />
              ) : activeTab === 'twap' ? (
                <ScheduledOrdersList enabled={isAuthed} kindFilter="twap" />
              ) : activeTab === 'ladder' ? (
                <OrdersList enabled={isAuthed} ladderFilter="ladder" />
              ) : null}
            </div>
            )}
          </>
        )}

        <footer className="border-t border-slate-800 pt-6 text-sm text-slate-500">
          <div className="flex flex-wrap items-center gap-4">
            <span>API: {env.apiUrl}</span>
            <span>Chain: {chainId}</span>
            <span>Router: {routerLabel}</span>
            <span aria-hidden>·</span>
            <TestnetToggle />
          </div>
        </footer>
      </main>
      {/* Legal band lives OUTSIDE <main> so it spans full width and
          stays anchored to the page bottom regardless of viewport
          content height. First-visit modal is owned by the same
          component (gated on a localStorage ack flag). */}
      <LegalDisclaimer />
    </div>
    </AdminChainProvider>
    </ActiveTokenProvider>
  );
}
