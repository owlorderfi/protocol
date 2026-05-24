/**
 * Tiny global-ish state for "which token the user is currently
 * orchestrating". Forms write to it on tokenIn change; the wallet
 * summary widget reads it to keep its dropdown in sync. The user
 * can still override the widget's dropdown manually — that
 * override is local to the widget and doesn't push back to the
 * form (intentional: inspecting another token's balance shouldn't
 * silently retarget the order being composed).
 *
 * Tucked into a thin Context instead of prop-drilling because the
 * forms (children of <Tabs>) and the wallet summary (sibling of
 * the orders panel) sit in different subtrees of App.tsx.
 */
import { createContext, useContext, useState, type ReactNode } from 'react';

interface Ctx {
  activeTokenIn: `0x${string}` | undefined;
  setActiveTokenIn: (addr: `0x${string}` | undefined) => void;
}

const ActiveTokenContext = createContext<Ctx | undefined>(undefined);

export function ActiveTokenProvider({ children }: { children: ReactNode }) {
  const [activeTokenIn, setActiveTokenIn] = useState<`0x${string}` | undefined>(undefined);
  return (
    <ActiveTokenContext.Provider value={{ activeTokenIn, setActiveTokenIn }}>
      {children}
    </ActiveTokenContext.Provider>
  );
}

export function useActiveToken(): Ctx {
  const ctx = useContext(ActiveTokenContext);
  if (!ctx) {
    throw new Error('useActiveToken must be used within ActiveTokenProvider');
  }
  return ctx;
}
