import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * Single global price-VIEW toggle. Default (false) = the fixed numéraire
 * orientation ("1 WETH = X USDC"); flipped (true) shows every price the
 * other way round ("1 USDC = X WETH").
 *
 * This is PURELY a display transform — `displayPrice(..., flipped)` applies
 * a 1/x at render time and nothing else. It never touches stored/canonical
 * values or what gets signed. One app-wide boolean (NOT per-pair) so the
 * whole UI — forms + order tables — always reads in the same direction and
 * can't desync. Sticky across sessions (localStorage), like a user setting.
 */
const STORAGE_KEY = 'polyorder.priceFlip';

interface PriceFlipValue {
  flipped: boolean;
  toggleFlipped: () => void;
}

const PriceFlipContext = createContext<PriceFlipValue | null>(null);

function readInitial(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function PriceFlipProvider({ children }: { children: ReactNode }) {
  const [flipped, setFlipped] = useState<boolean>(readInitial);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, flipped ? '1' : '0');
    } catch {
      // ignore (private mode / storage disabled)
    }
  }, [flipped]);

  const value = useMemo<PriceFlipValue>(
    () => ({ flipped, toggleFlipped: () => setFlipped((v) => !v) }),
    [flipped],
  );

  return <PriceFlipContext.Provider value={value}>{children}</PriceFlipContext.Provider>;
}

export function usePriceFlip(): PriceFlipValue {
  const ctx = useContext(PriceFlipContext);
  if (!ctx) throw new Error('usePriceFlip used outside <PriceFlipProvider>');
  return ctx;
}
