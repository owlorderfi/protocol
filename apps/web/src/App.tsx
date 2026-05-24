import { useState } from 'react';
import { Header } from './components/Header';
import { OrdersList } from './components/OrdersList';
import { CreateOrderForm } from './components/CreateOrderForm';
import { WrapPanel } from './components/WrapPanel';
import { CreateDcaForm } from './components/CreateDcaForm';
import { CreateTwapForm } from './components/CreateTwapForm';
import { ScheduledOrdersList } from './components/ScheduledOrdersList';
import { Tabs } from './components/Tabs';
import { Features } from './components/Features';
import { PricingPanel } from './components/PricingPanel';
import { WalletSummary } from './components/WalletSummary';
import { AdminInfoPanel, AdminFeesPanel } from './components/AdminPanel';
import { ActiveTokenProvider } from './lib/ActiveTokenContext';
import { AdminChainProvider } from './lib/AdminChainContext';
import { useAuth } from './lib/AuthContext';
import { useAdminWhoami } from './hooks/useAdmin';
import { env, getRouterForChain } from './lib/env';
import { useChainId } from 'wagmi';

export function App() {
  const { isAuthed } = useAuth();
  const chainId = useChainId();
  // Track the currently-active right-column tab so the left-column lists
  // can scope themselves to it. Defaults to 'limit' — the localStorage-
  // backed Tabs widget will fire onActiveChange after mount with the
  // stored value, so this is just the pre-mount fallback.
  const [activeTab, setActiveTab] = useState<string>('limit');
  // Override switch — when on, the left column shows every list
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

  // When admin tab is active the left column hands off to the
  // operator info panel (more space than the cramped right column).
  const isAdminTab = activeTab === 'admin';
  // The Wrap tab is action-only (deposit / withdraw native); the
  // user's orders aren't relevant to that flow, so hide the "My
  // orders" heading + lists — left column collapses to empty.
  const isWrapTab = activeTab === 'wrap';

  return (
    <ActiveTokenProvider>
    <AdminChainProvider>
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-6xl space-y-8 px-6 py-10">
        {/* Live snapshot of the user's wallet vs. what's already
            reserved by their active orders. Top-of-page so it's the
            first thing they see when composing or reviewing.
            Hidden on Admin tab — operator wants the full wide canvas
            for keeper / reserve / keepers cards, not their own wallet. */}
        {!isAdminTab && <WalletSummary enabled={isAuthed} />}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_400px]">
          <div className="space-y-4">
            {isAdminTab ? (
              // Admin panel takes over the left column when the
              // operator tab is active — gives the wide column to
              // the info cards (keeper, reserve, keepers) and keeps
              // the narrow right tab for the fees actions.
              <AdminInfoPanel enabled={isAuthed} />
            ) : isWrapTab ? (
              // Wrap tab: nothing on the left. The wrap form on the
              // right is the entire interaction.
              null
            ) : (
              <>
                {/* List visibility follows the active tab — keep the page
                    focused on what the user is doing. Toggle to "View all"
                    to see every list at once. */}
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
                    {viewAll ? 'Tab view' : 'View all'}
                  </button>
                </div>

                {/* Limit orders panel — visible when on Order tab OR view-all.
                    In view-all we wrap with a "LIMIT" header for symmetry
                    with the DCA / TWAP sections below. */}
                {viewAll && (
                  <h3 className="text-sm font-semibold text-slate-300 pt-2">LIMIT</h3>
                )}
                {(viewAll || activeTab === 'limit') && (
                  <OrdersList enabled={isAuthed} />
                )}

                {/* Scheduled (DCA + TWAP) panels. In view-all both render;
                    otherwise we filter to match the active tab. */}
                {viewAll ? (
                  <>
                    <h3 className="text-sm font-semibold text-slate-300 pt-2">DCA</h3>
                    <ScheduledOrdersList enabled={isAuthed} kindFilter="dca" />
                    <h3 className="text-sm font-semibold text-slate-300 pt-2">TWAP</h3>
                    <ScheduledOrdersList enabled={isAuthed} kindFilter="twap" />
                  </>
                ) : activeTab === 'dca' ? (
                  <ScheduledOrdersList enabled={isAuthed} kindFilter="dca" />
                ) : activeTab === 'twap' ? (
                  <ScheduledOrdersList enabled={isAuthed} kindFilter="twap" />
                ) : null}
              </>
            )}
          </div>
          <Tabs
            storageKey="polyorder.activeTab"
            onActiveChange={setActiveTab}
            tabs={[
              { id: 'limit', label: 'Limit', content: <CreateOrderForm enabled={isAuthed} /> },
              { id: 'dca', label: 'DCA', content: <CreateDcaForm enabled={isAuthed} /> },
              { id: 'twap', label: 'TWAP', content: <CreateTwapForm enabled={isAuthed} /> },
              { id: 'wrap', label: 'Wrap', content: <WrapPanel enabled={isAuthed} /> },
              // Admin tab shows up only when the connected wallet is
              // the on-chain owner of the active chain — both this
              // gate AND the API's OwnerOnlyGuard must agree before
              // the dashboard is reachable. Tab content is just the
              // fees actions; info cards live in the wide left column.
              ...(isOwner
                ? [{ id: 'admin', label: 'Admin', content: <AdminFeesPanel enabled={isAuthed} /> }]
                : []),
            ]}
          />
        </div>

        <PricingPanel />

        <Features />

        <footer className="border-t border-slate-800 pt-6 text-sm text-slate-500">
          <div className="flex flex-wrap gap-4">
            <span>API: {env.apiUrl}</span>
            <span>Chain: {chainId}</span>
            <span>Router: {routerLabel}</span>
          </div>
        </footer>
      </main>
    </div>
    </AdminChainProvider>
    </ActiveTokenProvider>
  );
}
