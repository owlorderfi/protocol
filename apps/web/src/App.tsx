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
import { useAuth } from './lib/AuthContext';
import { env, getRouterForChain } from './lib/env';
import { useChainId } from 'wagmi';

export function App() {
  const { isAuthed } = useAuth();
  const chainId = useChainId();
  // Track the currently-active right-column tab so the left-column lists
  // can scope themselves to it. Defaults to 'order' — the localStorage-
  // backed Tabs widget will fire onActiveChange after mount with the
  // stored value, so this is just the pre-mount fallback.
  const [activeTab, setActiveTab] = useState<string>('order');
  // Override switch — when on, the left column shows every list
  // regardless of which tab is active. Useful for users who want to
  // see everything at a glance.
  const [viewAll, setViewAll] = useState<boolean>(false);
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

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-6xl space-y-8 px-6 py-10">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_400px]">
          <div className="space-y-4">
            {/* List visibility follows the active tab — keep the page
                focused on what the user is doing. Toggle to "View all"
                to see every list at once. */}
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">
                {viewAll
                  ? 'My orders'
                  : activeTab === 'order'
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

            {/* Limit orders panel — visible when on Order tab OR view-all. */}
            {(viewAll || activeTab === 'order') && (
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
          </div>
          <Tabs
            storageKey="polyorder.activeTab"
            onActiveChange={setActiveTab}
            tabs={[
              { id: 'order', label: 'Order', content: <CreateOrderForm enabled={isAuthed} /> },
              { id: 'dca', label: 'DCA', content: <CreateDcaForm enabled={isAuthed} /> },
              { id: 'twap', label: 'TWAP', content: <CreateTwapForm enabled={isAuthed} /> },
              { id: 'wrap', label: 'Wrap', content: <WrapPanel enabled={isAuthed} /> },
            ]}
          />
        </div>

        <PricingPanel />

        <Features />

        <footer className="border-t border-slate-800 pt-6 text-xs text-slate-500">
          <div className="flex flex-wrap gap-4">
            <span>API: {env.apiUrl}</span>
            <span>Chain: {chainId}</span>
            <span>Router: {routerLabel}</span>
          </div>
        </footer>
      </main>
    </div>
  );
}
