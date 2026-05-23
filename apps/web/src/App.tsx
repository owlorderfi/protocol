import { Header } from './components/Header';
import { OrdersList } from './components/OrdersList';
import { CreateOrderForm } from './components/CreateOrderForm';
import { WrapPanel } from './components/WrapPanel';
import { DcaPlaceholder } from './components/DcaPlaceholder';
import { Tabs } from './components/Tabs';
import { Features } from './components/Features';
import { useAuth } from './lib/AuthContext';
import { env, getRouterForChain } from './lib/env';
import { useChainId } from 'wagmi';

export function App() {
  const { isAuthed } = useAuth();
  const chainId = useChainId();
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
            <h2 className="text-lg font-semibold">My orders</h2>
            <OrdersList enabled={isAuthed} />
          </div>
          <Tabs
            storageKey="polyorder.activeTab"
            tabs={[
              { id: 'order', label: 'Order', content: <CreateOrderForm enabled={isAuthed} /> },
              { id: 'wrap', label: 'Wrap', content: <WrapPanel enabled={isAuthed} /> },
              { id: 'dca', label: 'DCA', content: <DcaPlaceholder />, disabled: true, badge: 'Soon' },
            ]}
          />
        </div>

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
