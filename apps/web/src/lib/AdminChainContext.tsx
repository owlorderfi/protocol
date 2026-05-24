import { createContext, useContext, useState, type ReactNode } from 'react';
import { useChainId } from 'wagmi';
import { env } from './env';

interface AdminChainValue {
  chainId: number;
  setChainId: (id: number) => void;
}

const AdminChainContext = createContext<AdminChainValue | null>(null);

/**
 * Shared chain selector for the admin dashboard. Two visual panels
 * (info card panel on the left + fees actions panel on the right tab)
 * both need to read the same selected chain — passing through props
 * means lifting state to App.tsx and prop-drilling through Tabs, which
 * is uglier than a tiny context.
 *
 * Default = wallet's current chain; first configured chain as fallback
 * (matches the original AdminPanel internal default).
 */
export function AdminChainProvider({ children }: { children: ReactNode }) {
  const walletChainId = useChainId();
  const fallback = env.chainIds[0]!;
  const [chainId, setChainId] = useState<number>(walletChainId ?? fallback);
  return (
    <AdminChainContext.Provider value={{ chainId, setChainId }}>
      {children}
    </AdminChainContext.Provider>
  );
}

export function useAdminChain(): AdminChainValue {
  const ctx = useContext(AdminChainContext);
  if (!ctx) {
    throw new Error('useAdminChain must be used inside <AdminChainProvider>');
  }
  return ctx;
}
